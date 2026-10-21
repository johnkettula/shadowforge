package com.example.vmintent.security;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.util.List;
import java.util.Map;

/**
 * vmintent.security.* settings.
 *
 * @param mode  "none" (default: no sign-in, for a private sandbox) or "entra" (every API call
 *              needs a Microsoft Entra ID access token)
 * @param entra Entra ID settings, used when mode is "entra"
 */
@ConfigurationProperties(prefix = "vmintent.security")
public record SecurityProperties(String mode, Entra entra) {

    public SecurityProperties {
        mode = mode == null || mode.isBlank() ? "none" : mode.trim().toLowerCase();
        if (entra == null) entra = new Entra(null, List.of(), List.of(), null, null);
    }

    public boolean entraEnabled() {
        return "entra".equals(mode);
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

        private static List<String> clean(List<String> values) {
            return values == null ? List.of()
                    : values.stream().filter(v -> v != null && !v.isBlank()).map(String::trim).toList();
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
}
