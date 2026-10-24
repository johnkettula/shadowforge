package com.example.vmintent.security;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.yaml.snakeyaml.LoaderOptions;
import org.yaml.snakeyaml.Yaml;
import org.yaml.snakeyaml.constructor.SafeConstructor;

import javax.naming.InvalidNameException;
import javax.naming.ldap.LdapName;
import javax.naming.ldap.Rdn;
import javax.security.auth.x500.X500Principal;
import java.io.IOException;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.cert.CertificateEncodingException;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;

/**
 * The list of client certificates that may call the API, and the role each one gets.
 *
 * The file is YAML:
 *
 *   clients:
 *     - name: ci-pipeline                       # shown in the audit trail as "pki:ci-pipeline"
 *       role: BATCH                             # ADMIN, OPERATOR, AUDITOR, BATCH, REQUESTER or READER
 *       subject: "CN=ci-pipeline,OU=Build,O=Example Corp,C=US"
 *       issuer: "CN=Example Issuing CA 1,O=Example Corp,C=US"   # optional, recommended
 *     - name: reporting
 *       role: READER
 *       sha256: "3A:4F:...:9C"                  # pin one exact certificate instead
 *
 * An entry matches by subject (and issuer, if given), or by the certificate's SHA-256 fingerprint.
 * Distinguished names are compared the way X.500 does (case and spacing don't matter), in either
 * order ("CN=..., O=..., C=US" or "C=US, O=..., CN=...").
 *
 * The file is re-read when it changes, so adding or removing a client needs no restart. If an
 * edited file can't be read, the previous list stays in force and an error is logged.
 */
public class PkiAllowlist {

    private static final Logger log = LoggerFactory.getLogger(PkiAllowlist.class);
    private static final long CHECK_EVERY_MS = 2_000;

    /** One allowed certificate (or family of certificates, when matched by subject). */
    public record Client(String name, ApiAccessRules.Role role, List<X500Principal> subject,
                         List<X500Principal> issuer, String sha256) {

        boolean matches(X509Certificate cert, String certSha256) {
            if (sha256 != null) return sha256.equals(certSha256);
            return subject.contains(cert.getSubjectX500Principal())
                    && (issuer.isEmpty() || issuer.contains(cert.getIssuerX500Principal()));
        }
    }

    private final Path file;
    private volatile List<Client> clients = List.of();
    private volatile long loadedMtime = -1;
    private volatile long lastCheck = 0;

    public PkiAllowlist(Path file) {
        this.file = file;
        try {
            reload();   // a broken file at startup stops the API, rather than starting with no clients
        } catch (IOException | RuntimeException e) {
            throw new IllegalStateException("Can't read the client-certificate allowlist " + file + ": "
                    + e.getMessage(), e);
        }
        log.info("Client-certificate allowlist {}: {} entries", file, clients.size());
    }

    /** The allowlist entry for this certificate, if any. */
    public Optional<Client> match(X509Certificate cert) {
        refreshIfChanged();
        String fp = sha256(cert);
        return clients.stream().filter(c -> c.matches(cert, fp)).findFirst();
    }

    public int size() {
        refreshIfChanged();
        return clients.size();
    }

    private void refreshIfChanged() {
        long now = System.currentTimeMillis();
        if (now - lastCheck < CHECK_EVERY_MS) return;
        lastCheck = now;
        try {
            if (Files.getLastModifiedTime(file).toMillis() != loadedMtime) {
                reload();
                log.info("Client-certificate allowlist changed: now {} entries", clients.size());
            }
        } catch (IOException | RuntimeException e) {
            log.error("Can't read the changed allowlist {} ({}). Keeping the previous {} entries.",
                    file, e.getMessage(), clients.size());
        }
    }

    private synchronized void reload() throws IOException {
        long mtime = Files.getLastModifiedTime(file).toMillis();
        Object doc;
        try (Reader r = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
            doc = new Yaml(new SafeConstructor(new LoaderOptions())).load(r);
        }
        clients = parse(doc);
        loadedMtime = mtime;
    }

    static List<Client> parse(Object doc) {
        if (doc == null) return List.of();
        if (!(doc instanceof Map<?, ?> top)) throw new IllegalArgumentException("expected a 'clients:' list");
        Object list = top.get("clients");
        if (list == null) return List.of();
        if (!(list instanceof List<?> entries)) throw new IllegalArgumentException("'clients' must be a list");
        List<Client> out = new ArrayList<>();
        int i = 0;
        for (Object o : entries) {
            i++;
            if (!(o instanceof Map<?, ?> m)) throw new IllegalArgumentException("entry " + i + " is not a map");
            String name = str(m.get("name"));
            String roleText = str(m.get("role"));
            String subject = str(m.get("subject"));
            String issuer = str(m.get("issuer"));
            String sha = str(m.get("sha256"));
            String where = "entry " + i + (name == null ? "" : " (" + name + ")");
            if (name == null) throw new IllegalArgumentException(where + ": 'name' is required");
            if (roleText == null) throw new IllegalArgumentException(where + ": 'role' is required");
            ApiAccessRules.Role role;
            try {
                role = ApiAccessRules.Role.valueOf(roleText.toUpperCase(Locale.ROOT));
            } catch (IllegalArgumentException e) {
                throw new IllegalArgumentException(where + ": role must be ADMIN, OPERATOR, AUDITOR, BATCH, REQUESTER or READER");
            }
            if (subject == null && sha == null) {
                throw new IllegalArgumentException(where + ": give 'subject' or 'sha256'");
            }
            if (subject != null && sha != null) {
                throw new IllegalArgumentException(where + ": give 'subject' or 'sha256', not both");
            }
            if (subject == null && issuer != null) {
                throw new IllegalArgumentException(where + ": 'issuer' only goes with 'subject'");
            }
            String fp = null;
            if (sha != null) {
                fp = sha.replaceAll("[:\\s]", "").toUpperCase(Locale.ROOT);
                if (!fp.matches("[0-9A-F]{64}")) {
                    throw new IllegalArgumentException(where + ": sha256 must be 64 hex digits");
                }
            }
            out.add(new Client(name, role, names(subject, where), names(issuer, where), fp));
        }
        return Collections.unmodifiableList(out);
    }

    /** The name as written, plus the same name in the opposite order, so either order matches. */
    private static List<X500Principal> names(String dn, String where) {
        if (dn == null) return List.of();
        try {
            X500Principal asWritten = new X500Principal(dn);
            List<Rdn> rdns = new ArrayList<>(new LdapName(asWritten.getName(X500Principal.RFC2253)).getRdns());
            Collections.reverse(rdns);
            X500Principal reversed = new X500Principal(new LdapName(rdns).toString());
            return asWritten.equals(reversed) ? List.of(asWritten) : List.of(asWritten, reversed);
        } catch (IllegalArgumentException | InvalidNameException e) {
            throw new IllegalArgumentException(where + ": can't read the name '" + dn + "'");
        }
    }

    private static String str(Object o) {
        return o == null || o.toString().isBlank() ? null : o.toString().trim();
    }

    /** SHA-256 fingerprint as 64 upper-case hex digits. */
    public static String sha256(X509Certificate cert) {
        try {
            return HexFormat.of().withUpperCase().formatHex(MessageDigest.getInstance("SHA-256").digest(cert.getEncoded()));
        } catch (NoSuchAlgorithmException | CertificateEncodingException e) {
            throw new IllegalStateException(e);
        }
    }

    /** The fingerprint with colons, as openssl prints it. */
    public static String sha256Colons(X509Certificate cert) {
        return sha256(cert).replaceAll("(..)(?!$)", "$1:");
    }
}
