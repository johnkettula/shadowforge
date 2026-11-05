package com.example.vmintent.provider.azure;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Configuration;

/**
 * How vm-intent reaches Azure Resource Manager (application.yml, vmintent.azure). See docs/AZURE.md.
 *
 * The four IDs and the secret come only from environment variables (VMINTENT_AZURE_TENANT_ID, ..._CLIENT_ID,
 * ..._CLIENT_SECRET, ..._SUBSCRIPTION_ID); none is ever written in a file. The secret is left out of toString().
 * clientId is the service principal's; VMs go in resourceGroup and location (e.g. westeurope). loginUrl and
 * managementUrl default to Entra ID and Azure Resource Manager; tests point them at a mock.
 */
@ConfigurationProperties("vmintent.azure")
public record AzureProperties(String tenantId, String clientId, String clientSecret, String subscriptionId,
                              String resourceGroup, String location, String loginUrl, String managementUrl,
                              Integer timeoutSeconds) {

    public static final String LOGIN_URL = "https://login.microsoftonline.com";
    public static final String MANAGEMENT_URL = "https://management.azure.com";

    public AzureProperties {
        loginUrl = blank(loginUrl) ? LOGIN_URL : loginUrl.trim().replaceAll("/+$", "");
        managementUrl = blank(managementUrl) ? MANAGEMENT_URL : managementUrl.trim().replaceAll("/+$", "");
        timeoutSeconds = timeoutSeconds == null || timeoutSeconds <= 0 ? 30 : timeoutSeconds;
    }

    /** True when everything needed to call ARM is set. */
    public boolean configured() {
        return !blank(tenantId) && !blank(clientId) && !blank(clientSecret) && !blank(subscriptionId) && !blank(resourceGroup);
    }

    @Override
    public String toString() {
        return "AzureProperties[tenantId=" + tenantId + ", clientId=" + clientId
                + ", clientSecret=" + (blank(clientSecret) ? "" : "(set)") + ", subscriptionId=" + subscriptionId
                + ", resourceGroup=" + resourceGroup + ", location=" + location + ", loginUrl=" + loginUrl
                + ", managementUrl=" + managementUrl + ", timeoutSeconds=" + timeoutSeconds + "]";
    }

    static boolean blank(String s) {
        return s == null || s.isBlank();
    }

    @Configuration
    @EnableConfigurationProperties(AzureProperties.class)
    public static class Config {
    }
}
