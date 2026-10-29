package com.example.vmintent.provider.vsphere;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.util.Map;

/**
 * How vSphere requests are fulfilled (application.yml, vmintent.vsphere). See docs/VSPHERE.md.
 *
 * route, for all of vSphere or per datacenter (dc1, dc2):
 *   simulated       the built-in pretend cloud (the default; nothing real is touched)
 *   vcenter         vCenter 9 directly: deploy from a VM template in a content library
 *   vcf-automation  VCF Automation 9: request a blueprint (cloud template) deployment
 */
@ConfigurationProperties("vmintent.vsphere")
public record VsphereProperties(String route, Vcenter vcenter, Automation automation, Map<String, Datacenter> datacenters) {

    public static final String SIMULATED = "simulated";
    public static final String VCENTER = "vcenter";
    public static final String VCF_AUTOMATION = "vcf-automation";

    public VsphereProperties {
        route = blank(route) ? SIMULATED : route.trim().toLowerCase();
        vcenter = vcenter == null ? new Vcenter(null, null, null, null, null, null, null, 0) : vcenter;
        automation = automation == null ? new Automation(null, null, null, null, null, null, null, null) : automation;
        datacenters = datacenters == null ? Map.of() : datacenters;
    }

    /**
     * @param url            https://vcenter.example.com (no path)
     * @param caFile         PEM file with the CA (or self-signed) certificate vCenter's TLS certificate chains to;
     *                       empty = the JVM's trusted CAs
     * @param contentLibrary the content library holding the VM templates
     * @param tagCategory    VMs vm-intent builds get the tag {tagCategory}/{tag}; the inventory check lists by it
     */
    public record Vcenter(String url, String username, String password, String caFile, String contentLibrary,
                         String tagCategory, String tag, int timeoutSeconds) {
        public Vcenter {
            contentLibrary = blank(contentLibrary) ? "vm-intent-templates" : contentLibrary;
            tagCategory = blank(tagCategory) ? "vm-intent" : tagCategory;
            tag = blank(tag) ? "managed" : tag;
            timeoutSeconds = timeoutSeconds <= 0 ? 20 : timeoutSeconds;
        }

        public boolean configured() {
            return !blank(url) && !blank(username);
        }
    }

    /**
     * @param url        https://vcfa.example.com
     * @param org        the VM Apps organization (tenant) name, for VCF Automation 9 sign-in
     * @param apiToken   an API token (My Account > API Tokens); exchanged for a one-hour access token
     * @param auth       tenant-oauth (VCF Automation 9, the default) or iaas-login (Aria Automation 8.x)
     * @param project    the project blueprints are requested in (name or ID)
     * @param apiVersion the apiVersion query parameter sent with blueprint and deployment calls
     */
    public record Automation(String url, String org, String apiToken, String auth, String caFile, String project,
                             String apiVersion, Integer timeoutSeconds) {
        public Automation {
            auth = blank(auth) ? "tenant-oauth" : auth.trim().toLowerCase();
            apiVersion = blank(apiVersion) ? "2019-09-12" : apiVersion;
            timeoutSeconds = timeoutSeconds == null || timeoutSeconds <= 0 ? 30 : timeoutSeconds;
        }

        public boolean configured() {
            return !blank(url) && !blank(apiToken) && (!"tenant-oauth".equals(auth) || !blank(org));
        }
    }

    /**
     * One vm-intent datacenter (the spec's region: dc1, dc2).
     *
     * @param templates          content library item per OS: keys "ubuntu-24.04", "rhel-9" or "windows"
     *                           (tried in that order: os-version, os-major, os)
     * @param datastores         datastore per disk tier: ssd, standard
     * @param customizationSpecs guest customization spec per OS (optional), e.g. ubuntu: linux-dhcp
     * @param blueprint          blueprint name for the vcf-automation route (or per OS: blueprints)
     * @param blueprintInputs    the blueprint's inputs, with {vcpu} {memoryGiB} {memoryMiB} {memoryMB} {diskGiB}
     *                           {os} {osVersion} {env} {name} {diskTier} filled in; a value that is only a
     *                           number after filling is sent as a number
     */
    public record Datacenter(String route, String datacenter, String cluster, String resourcePool, String host,
                             String folder, Map<String, String> datastores, Map<String, String> templates,
                             Map<String, String> customizationSpecs, String blueprint, Map<String, String> blueprints,
                             String blueprintVersion, Map<String, String> blueprintInputs) {
        public Datacenter {
            datastores = datastores == null ? Map.of() : datastores;
            templates = templates == null ? Map.of() : templates;
            customizationSpecs = customizationSpecs == null ? Map.of() : customizationSpecs;
            blueprints = blueprints == null ? Map.of() : blueprints;
            blueprintInputs = blueprintInputs == null ? Map.of() : blueprintInputs;
        }
    }

    /** The route for a datacenter: its own, or the default. */
    public String routeFor(String dc) {
        Datacenter d = datacenters.get(dc);
        return d == null || blank(d.route()) ? route : d.route().trim().toLowerCase();
    }

    public Datacenter datacenter(String dc) {
        Datacenter d = datacenters.get(dc);
        if (d == null) {
            throw new IllegalStateException("vSphere datacenter '" + dc + "' isn't set up: add vmintent.vsphere.datacenters."
                    + dc + " (see docs/VSPHERE.md)");
        }
        return d;
    }

    static boolean blank(String s) {
        return s == null || s.isBlank();
    }
}
