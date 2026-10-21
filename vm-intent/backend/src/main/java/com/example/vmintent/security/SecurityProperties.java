package com.example.vmintent.security;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * vmintent.security.* settings.
 *
 * @param mode  which sign-in methods are on, comma-separated:
 *              "none" (default: no sign-in, for a private sandbox),
 *              "entra" (Microsoft Entra ID access tokens),
 *              "pki" (client certificates on an allowlist), or "entra,pki" (either one)
 * @param entra Entra ID settings, used when mode includes "entra"
 * @param pki   client-certificate settings, used when mode includes "pki"
 */
@ConfigurationProperties(prefix = "vmintent.security")
public record SecurityProperties(String mode, Entra entra, Pki pki) {

    private static final Set<String> KNOWN = Set.of("none", "entra", "pki");

    public SecurityProperties {
        mode = mode == null || mode.isBlank() ? "none" : mode.trim().toLowerCase();
        for (String m : modes(mode)) {
            if (!KNOWN.contains(m)) {
                throw new IllegalStateException("vmintent.security.mode: unknown value '" + m
                        + "'. Use none, entra, pki or entra,pki.");
            }
        }
        if (entra == null) entra = new Entra(null, List.of(), List.of(), null, null);
        if (pki == null) pki = new Pki(null, null, null, null, List.of());
    }

    private static Set<String> modes(String mode) {
        return Arrays.stream(mode.split("[,+\\s]+")).map(String::trim).filter(s -> !s.isEmpty())
                .collect(Collectors.toSet());
    }

    public boolean entraEnabled() {
        return modes(mode).contains("entra");
    }

    public boolean pkiEnabled() {
        return modes(mode).contains("pki");
    }

    /** True if any sign-in method is on. */
    public boolean enabled() {
        return entraEnabled() || pkiEnabled();
    }

    private static List<String> clean(List<String> values) {
        return values == null ? List.of()
                : values.stream().filter(v -> v != null && !v.isBlank()).map(String::trim).toList();
    }

    /**
     * @param tenantId   your Entra tenant (directory) ID
     * @param audiences  accepted "aud" values: the API's application (client) ID and/or its
     *                   Application ID URI, e.g. ["11111111-...", "api://vm-intent"]
     * @param issuers    accepted "iss" values; empty = the tenant's v2.0 and v1.0 issuers
     * @param jwkSetUri  where the signing keys are; empty = the tenant's standard keys URL
     * @param roleMap    Entra app role or scope value -> vm-intent role (ADMIN, BATCH, REQUESTER,
     *                   READER); empty = the defaults in {@link EntraRoleConverter}
     */
    public record Entra(String tenantId, List<String> audiences, List<String> issuers,
                        String jwkSetUri, Map<String, String> roleMap) {

        public Entra {
            audiences = clean(audiences);
            issuers = clean(issuers);
        }

        public List<String> effectiveIssuers() {
            if (!issuers.isEmpty()) return issuers;
            // v2.0 tokens and v1.0 tokens (the default for many app registrations) have different issuers.
            return List.of("https://login.microsoftonline.com/" + tenantId + "/v2.0",
                    "https://sts.windows.net/" + tenantId + "/");
        }

        public String effectiveJwkSetUri() {
            return jwkSetUri == null || jwkSetUri.isBlank()
                    ? "https://login.microsoftonline.com/" + tenantId + "/discovery/v2.0/keys"
                    : jwkSetUri;
        }
    }

    /**
     * Client certificates (PKI).
     *
     * @param clientsFile    YAML allowlist: which certificates may call, and the role each gets
     *                       (see deploy/pki/pki-clients.example.yml). Re-read when it changes.
     * @param trustedCaFile  PEM file of the CA certificates that may issue client certificates
     *                       (root and/or issuing CAs). Every certificate must chain to one of them.
     * @param crlFile        optional PEM or DER file of certificate revocation lists. When set, a
     *                       revoked client certificate is refused. Re-read when it changes.
     * @param header         optional: name of a header in which a trusted TLS proxy (nginx, a load
     *                       balancer) forwards the client certificate. Empty = off.
     * @param trustedProxies addresses or CIDR ranges allowed to send that header; from anywhere
     *                       else it is ignored
     */
    public record Pki(String clientsFile, String trustedCaFile, String crlFile, String header,
                      List<String> trustedProxies) {

        public Pki {
            clientsFile = blankToNull(clientsFile);
            trustedCaFile = blankToNull(trustedCaFile);
            crlFile = blankToNull(crlFile);
            header = blankToNull(header);
            trustedProxies = clean(trustedProxies);
        }

        private static String blankToNull(String s) {
            return s == null || s.isBlank() ? null : s.trim();
        }
    }
}
