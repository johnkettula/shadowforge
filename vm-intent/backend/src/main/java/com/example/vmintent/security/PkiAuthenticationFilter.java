package com.example.vmintent.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletRequestWrapper;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.authentication.preauth.PreAuthenticatedAuthenticationToken;
import org.springframework.security.web.util.matcher.IpAddressMatcher;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.cert.X509Certificate;
import java.util.Base64;
import java.util.Collection;
import java.util.List;

/**
 * Signs callers in with a client certificate.
 *
 * Where the certificate comes from:
 *  1. the TLS connection itself (the API runs HTTPS and asks for a client certificate), or
 *  2. if vmintent.security.pki.header is set, a header added by a TLS proxy in front of the API,
 *     accepted only when the connection comes straight from one of the trusted-proxies.
 *
 * The certificate is then checked (dates, trusted CA, revocation) and looked up in the allowlist.
 * A listed certificate signs the caller in as "pki:<name>" with the listed role. Anything else
 * leaves the caller signed out, and the reason is kept for the 401 response.
 */
public class PkiAuthenticationFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(PkiAuthenticationFilter.class);

    /** Request attribute holding why a certificate was refused (shown in the 401 body). */
    public static final String REJECTED = PkiAuthenticationFilter.class.getName() + ".rejected";

    private static final String TLS_ATTRIBUTE = "jakarta.servlet.request.X509Certificate";

    private final PkiCertificateChecker checker;
    private final PkiAllowlist allowlist;
    private final String header;
    private final List<IpAddressMatcher> trustedProxies;

    public PkiAuthenticationFilter(PkiCertificateChecker checker, PkiAllowlist allowlist,
                                   String header, List<String> trustedProxies) {
        this.checker = checker;
        this.allowlist = allowlist;
        this.header = header;
        this.trustedProxies = trustedProxies.stream().map(IpAddressMatcher::new).toList();
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        X509Certificate[] certs = fromTls(req);
        String source = "TLS";
        if (certs == null && header != null && req.getHeader(header) != null && !req.getHeader(header).isBlank()) {
            String peer = connectionAddress(req);
            if (trustedProxies.stream().anyMatch(m -> m.matches(peer))) {
                certs = fromHeader(req.getHeader(header));
                source = "header from " + peer;
                if (certs == null) req.setAttribute(REJECTED, "The forwarded client certificate can't be read.");
            } else {
                log.warn("Ignored {} header from {}: not a trusted proxy", header, peer);
                req.setAttribute(REJECTED, "A client certificate header is only accepted from the API's TLS proxy.");
            }
        }
        if (certs != null && certs.length > 0) {
            signIn(req, certs, source);
        }
        chain.doFilter(req, res);
    }

    private void signIn(HttpServletRequest req, X509Certificate[] certs, String source) {
        X509Certificate cert = certs[0];
        String subject = cert.getSubjectX500Principal().getName();
        try {
            checker.check(certs);
        } catch (PkiCertificateChecker.Rejected e) {
            log.warn("Refused client certificate {} ({}): {}", subject, source, e.getMessage());
            req.setAttribute(REJECTED, e.getMessage());
            return;
        }
        PkiAllowlist.Client client = allowlist.match(cert).orElse(null);
        if (client == null) {
            String fp = PkiAllowlist.sha256Colons(cert);
            log.warn("Client certificate not on the allowlist ({}): subject \"{}\", issuer \"{}\", sha256 {}",
                    source, subject, cert.getIssuerX500Principal().getName(), fp);
            req.setAttribute(REJECTED, "Your client certificate is valid but not on this API's allowlist. "
                    + "Ask the API's administrator to add it: subject \"" + subject + "\", issuer \""
                    + cert.getIssuerX500Principal().getName() + "\", sha256 " + fp + ".");
            return;
        }
        var auth = new PreAuthenticatedAuthenticationToken("pki:" + client.name(), cert,
                List.of(new SimpleGrantedAuthority("ROLE_" + client.role().name())));
        SecurityContext ctx = SecurityContextHolder.createEmptyContext();
        ctx.setAuthentication(auth);
        SecurityContextHolder.setContext(ctx);
        log.debug("Signed in pki:{} as {} ({})", client.name(), client.role(), source);
    }

    private static X509Certificate[] fromTls(HttpServletRequest req) {
        return req.getAttribute(TLS_ATTRIBUTE) instanceof X509Certificate[] c && c.length > 0 ? c : null;
    }

    /**
     * Reads the header formats proxies use: nginx's URL-encoded PEM ($ssl_client_escaped_cert),
     * PEM with its line breaks turned into spaces, or plain base64 DER.
     */
    static X509Certificate[] fromHeader(String value) {
        try {
            String v = value.trim();
            if (v.contains("%")) v = URLDecoder.decode(v, StandardCharsets.UTF_8);
            String b64 = v.replaceAll("-----(BEGIN|END) CERTIFICATE-----", "").replaceAll("\\s", "");
            Collection<X509Certificate> certs = PkiCertificateChecker.readCertificates(Base64.getDecoder().decode(b64));
            return certs.isEmpty() ? null : certs.toArray(new X509Certificate[0]);
        } catch (IllegalArgumentException | GeneralSecurityException e) {
            return null;
        }
    }

    /**
     * The address of the machine that opened the connection. Deliberately not the address that
     * X-Forwarded-For claims (which a "forward-headers-strategy" filter may have swapped in):
     * anyone can send that header.
     */
    static String connectionAddress(HttpServletRequest req) {
        ServletRequest r = req;
        while (r instanceof ServletRequestWrapper w) r = w.getRequest();
        return r.getRemoteAddr();
    }
}
