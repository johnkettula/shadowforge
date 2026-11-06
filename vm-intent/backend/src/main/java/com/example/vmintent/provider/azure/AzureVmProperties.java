package com.example.vmintent.provider.azure;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Configuration;

/**
 * What AzureArmBackend needs to build a Linux VM (application.yml, vmintent.azure; see docs/AZURE.md), kept apart
 * from AzureProperties so that record stays as it is: the full ARM ID of an existing subnet the NICs go on, and the
 * admin user and SSH public key (VMs get no password). From VMINTENT_AZURE_SUBNET_ID, ..._ADMIN_USERNAME and
 * ..._ADMIN_SSH_PUBLIC_KEY. The key is left out of toString().
 */
@ConfigurationProperties("vmintent.azure")
public record AzureVmProperties(String subnetId, String adminUsername, String adminSshPublicKey) {

    public AzureVmProperties {
        adminUsername = AzureProperties.blank(adminUsername) ? "azureuser" : adminUsername.trim();
    }

    @Override
    public String toString() {
        return "AzureVmProperties[subnetId=" + subnetId + ", adminUsername=" + adminUsername
                + ", adminSshPublicKey=" + (AzureProperties.blank(adminSshPublicKey) ? "" : "(set)") + "]";
    }

    @Configuration
    @EnableConfigurationProperties(AzureVmProperties.class)
    public static class Config {
    }
}
