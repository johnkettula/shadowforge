package com.example.vmintent.security;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.cert.CRL;
import java.security.cert.CertPathValidator;
import java.security.cert.CertPathValidatorException;
import java.security.cert.CertStore;
import java.security.cert.CertificateFactory;
import java.security.cert.CollectionCertStoreParameters;
import java.security.cert.PKIXParameters;
import java.security.cert.PKIXRevocationChecker;
import java.security.cert.TrustAnchor;
import java.security.cert.X509CRL;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Collection;
import java.util.EnumSet;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Checks a client certificate before the allowlist is consulted:
 *  - it is within its validity dates;
 *  - it chains to one of the trusted CAs (trusted-ca-file);
 *  - if a CRL file is set, it is not revoked.
 *
 * The TLS server (or the proxy in front of it) already checks the chain during the handshake;
 * this repeats the check inside the application, and is the only check for certificates that a
 * proxy forwards in a header. Revocation is checked for the client certificate itself, using only
 * the CRLs in the file: nothing is fetched from the network.
 */
public class PkiCertificateChecker {

    private static final Logger log = LoggerFactory.getLogger(PkiCertificateChecker.class);
    private static final long CHECK_EVERY_MS = 10_000;

    /** Why a certificate was refused; the message is safe to show the caller. */
    public static class Rejected extends Exception {
        public Rejected(String message) {
            super(message);
        }
    }

    private final Set<TrustAnchor> anchors;
    private final Set<X509Certificate> anchorCerts;
    private final Path crlFile;
    private volatile List<X509CRL> crls = List.of();
    private volatile long crlMtime = -1;
    private volatile long lastCheck = 0;

    public PkiCertificateChecker(Path trustedCaFile, Path crlFile) {
        try {
            Collection<X509Certificate> cas = readCertificates(Files.readAllBytes(trustedCaFile));
            if (cas.isEmpty()) throw new IllegalStateException("no certificates in " + trustedCaFile);
            anchorCerts = new HashSet<>(cas);
            anchors = new HashSet<>();
            for (X509Certificate ca : cas) anchors.add(new TrustAnchor(ca, null));
            log.info("Trusted client-certificate CAs ({}): {}", trustedCaFile,
                    cas.stream().map(c -> c.getSubjectX500Principal().getName()).toList());
        } catch (IOException | GeneralSecurityException e) {
            throw new IllegalStateException("Can't read the trusted CA file " + trustedCaFile + ": " + e.getMessage(), e);
        }
        this.crlFile = crlFile;
        if (crlFile != null) {
            try {
                loadCrls();
            } catch (IOException | GeneralSecurityException | RuntimeException e) {
                throw new IllegalStateException("Can't read the CRL file " + crlFile + ": " + e.getMessage(), e);
            }
        }
    }

    /** Throws {@link Rejected} unless the certificate (chain[0]) is valid, trusted and not revoked. */
    public void check(X509Certificate[] chain) throws Rejected {
        X509Certificate leaf = chain[0];
        try {
            leaf.checkValidity();
        } catch (GeneralSecurityException e) {
            throw new Rejected("Your client certificate has expired or is not yet valid.");
        }
        // The path the caller sent, without any CA we already trust (the validator adds the anchor).
        List<X509Certificate> path = new ArrayList<>();
        for (X509Certificate c : chain) {
            if (anchorCerts.contains(c)) break;
            path.add(c);
        }
        if (path.isEmpty()) throw new Rejected("A CA certificate can't be used as a client certificate.");
        try {
            CertificateFactory cf = CertificateFactory.getInstance("X.509");
            CertPathValidator validator = CertPathValidator.getInstance("PKIX");
            PKIXParameters params = new PKIXParameters(anchors);
            refreshCrlsIfChanged();
            if (crlFile == null) {
                params.setRevocationEnabled(false);
            } else {
                PKIXRevocationChecker rc = (PKIXRevocationChecker) validator.getRevocationChecker();
                rc.setOptions(EnumSet.of(PKIXRevocationChecker.Option.ONLY_END_ENTITY,
                        PKIXRevocationChecker.Option.PREFER_CRLS, PKIXRevocationChecker.Option.NO_FALLBACK));
                params.addCertPathChecker(rc);
                params.addCertStore(CertStore.getInstance("Collection", new CollectionCertStoreParameters(crls)));
            }
            validator.validate(cf.generateCertPath(path), params);
        } catch (CertPathValidatorException e) {
            if (e.getReason() == CertPathValidatorException.BasicReason.REVOKED) {
                throw new Rejected("Your client certificate has been revoked.");
            }
            if (e.getReason() == CertPathValidatorException.BasicReason.UNDETERMINED_REVOCATION_STATUS) {
                log.warn("No current CRL for {} (issuer {}): {}", leaf.getSubjectX500Principal().getName(),
                        leaf.getIssuerX500Principal().getName(), e.getMessage());
                throw new Rejected("Your client certificate's revocation status can't be checked "
                        + "(the server has no current CRL from its issuer).");
            }
            log.debug("Untrusted client certificate {}: {}", leaf.getSubjectX500Principal().getName(), e.getMessage());
            throw new Rejected("Your client certificate is not issued by a CA this API trusts.");
        } catch (GeneralSecurityException e) {
            throw new Rejected("Your client certificate can't be checked: " + e.getMessage());
        }
    }

    private void refreshCrlsIfChanged() {
        if (crlFile == null) return;
        long now = System.currentTimeMillis();
        if (now - lastCheck < CHECK_EVERY_MS) return;
        lastCheck = now;
        try {
            if (Files.getLastModifiedTime(crlFile).toMillis() != crlMtime) loadCrls();
        } catch (IOException | GeneralSecurityException | RuntimeException e) {
            log.error("Can't read the changed CRL file {} ({}). Keeping the previous CRLs.", crlFile, e.getMessage());
        }
    }

    private synchronized void loadCrls() throws IOException, GeneralSecurityException {
        long mtime = Files.getLastModifiedTime(crlFile).toMillis();
        CertificateFactory cf = CertificateFactory.getInstance("X.509");
        List<X509CRL> list = new ArrayList<>();
        try (InputStream in = new ByteArrayInputStream(Files.readAllBytes(crlFile))) {
            for (CRL crl : cf.generateCRLs(in)) list.add((X509CRL) crl);
        }
        crls = List.copyOf(list);
        crlMtime = mtime;
        log.info("CRL file {}: {} lists, from {}", crlFile, list.size(),
                list.stream().map(c -> c.getIssuerX500Principal().getName()).toList());
    }

    /** Reads every certificate in a PEM (or DER) file. */
    @SuppressWarnings("unchecked")
    static Collection<X509Certificate> readCertificates(byte[] data) throws GeneralSecurityException {
        return (Collection<X509Certificate>) CertificateFactory.getInstance("X.509")
                .generateCertificates(new ByteArrayInputStream(data));
    }
}
