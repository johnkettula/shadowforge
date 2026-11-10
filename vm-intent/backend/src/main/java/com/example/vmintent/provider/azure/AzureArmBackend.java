package com.example.vmintent.provider.azure;

import com.example.vmintent.provider.ProviderCatalog;
import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.ProviderPlan;
import com.example.vmintent.workflow.Models.VmStatus;
import com.fasterxml.jackson.databind.JsonNode;
import io.temporal.failure.ApplicationFailure;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Azure through Resource Manager: one tagged Linux VM with its NIC ("name-nic", on the configured subnet) and
 * public IP ("name-pip"). Not used by AzureProvider yet (see docs/AZURE.md).
 *
 * Every call fits an activity's time limit: it moves at most one step with ArmClient's non-blocking begin and
 * get, and throws a retryable "CloudBusy" while Azure is still working, so Temporal's retries do the waiting. It
 * keeps no state: what Azure reports is the state. VM IDs look like "arm:rg-vmintent:app-db-01". A resource is
 * ours only when tagged vm-intent=managed; one that isn't is never changed or removed.
 */
public class AzureArmBackend {

    public static final String PREFIX = "arm:";
    static final String TAG = "vm-intent", MANAGED = "managed", KEY_TAG = "vm-intent-key";
    static final String COMPUTE = "Microsoft.Compute", NETWORK = "Microsoft.Network";
    private static final Logger log = LoggerFactory.getLogger(AzureArmBackend.class);

    record Image(String publisher, String offer, String sku) {
        String ref() {
            return publisher + "/" + offer + "/" + sku;
        }
    }

    /** By "os-version", then "os-major". Linux only: Windows needs a password, which is left for later. */
    static final Map<String, Image> IMAGES = Map.of(
            "ubuntu-24.04", new Image("Canonical", "ubuntu-24_04-lts", "server"),
            "ubuntu-22.04", new Image("Canonical", "0001-com-ubuntu-server-jammy", "22_04-lts-gen2"),
            "debian-12", new Image("Debian", "debian-12", "12-gen2"),
            "rhel-9", new Image("RedHat", "RHEL", "9-lvm-gen2"));

    private final AzureProperties cfg;
    private final AzureVmProperties vm;
    private final ArmClient client;

    public AzureArmBackend(AzureProperties cfg, AzureVmProperties vm, ArmClient client) {
        this.cfg = cfg;
        this.vm = vm;
        this.client = client;
    }

    public static boolean owns(String vmId) {
        return vmId != null && vmId.startsWith(PREFIX);
    }

    // ------------------------------------------------------------------ plan and build

    public ProviderPlan plan(VmSpec s) {
        ProviderPlan p = ProviderCatalog.plan(s);
        String image = "ARM image " + image(s).ref();
        return new ProviderPlan(p.nativeRegion(), p.nativeSize(), image, "azure " + p.nativeRegion() + ", " + p.nativeSize() + ", " + image);
    }

    static Image image(VmSpec s) {
        String ver = s.osVersion() == null ? "" : s.osVersion();
        String major = ver.contains(".") ? ver.substring(0, ver.indexOf('.')) : ver;
        Image i = IMAGES.getOrDefault(s.os() + "-" + ver, IMAGES.get(s.os() + "-" + major));
        if (i == null) throw invalid("No Azure image for " + s.os() + " " + ver + "; Linux images: " + IMAGES.keySet());
        return i;
    }

    /**
     * One step: the public IP, then the NIC, then the VM, each started only when the one before is Succeeded
     * (CloudBusy until then). Returns the VM ID once the VM's PUT is started, or when it already exists as ours.
     */
    public String createVm(VmSpec spec, ProviderPlan plan, String idempotencyKey) {
        requireSetUp();
        Image image = image(spec);
        ProviderPlan p = plan(spec);
        if (!p.nativeRegion().equalsIgnoreCase(cfg.location())) {
            throw invalid("Region " + spec.region() + " is Azure " + p.nativeRegion() + ", but vm-intent builds in " + cfg.location());
        }
        String size = (plan != null ? plan : p).nativeSize();
        if (!size.startsWith("Standard_")) throw invalid("No Azure size for " + spec.vcpu() + " vCPU / " + spec.memoryGiB() + " GiB");
        String name = spec.name();
        JsonNode existing = find(path(COMPUTE, "virtualMachines", name));
        if (existing != null) {
            if (!managed(existing)) throw invalid("Azure already has a VM called '" + name + "' that vm-intent didn't build; choose another name");
            return vmId(name);
        }
        Map<String, String> tags = Map.of(TAG, MANAGED, KEY_TAG, idempotencyKey);
        JsonNode pip = ready(path(NETWORK, "publicIPAddresses", name + "-pip"), Map.of("location", cfg.location(), "tags", tags,
                "sku", Map.of("name", "Standard"), "properties", Map.of("publicIPAllocationMethod", "Static")));
        JsonNode nic = ready(path(NETWORK, "networkInterfaces", name + "-nic"), Map.of("location", cfg.location(), "tags", tags,
                "properties", Map.of("ipConfigurations", List.of(Map.of("name", "ipconfig1", "properties", Map.of(
                        "subnet", Map.of("id", vm.subnetId()), "publicIPAddress", Map.of("id", pip.path("id").asText())))))));
        String user = vm.adminUsername();
        client.begin("PUT", path(COMPUTE, "virtualMachines", name), Map.of("location", cfg.location(), "tags", tags, "properties", Map.of(
                "hardwareProfile", Map.of("vmSize", size),
                "storageProfile", Map.of(
                        "imageReference", Map.of("publisher", image.publisher(), "offer", image.offer(), "sku", image.sku(), "version", "latest"),
                        "osDisk", Map.of("createOption", "FromImage", "deleteOption", "Delete", "diskSizeGB", spec.diskGiB(),
                                "managedDisk", Map.of("storageAccountType", "ssd".equals(spec.diskTier()) ? "Premium_LRS" : "StandardSSD_LRS"))),
                "osProfile", Map.of("computerName", name, "adminUsername", user, "linuxConfiguration", Map.of(
                        "disablePasswordAuthentication", true,
                        "ssh", Map.of("publicKeys", List.of(Map.of("path", "/home/" + user + "/.ssh/authorized_keys", "keyData", vm.adminSshPublicKey()))))),
                "networkProfile", Map.of("networkInterfaces", List.of(Map.of("id", nic.path("id").asText()))))));
        log.info("[azure] building VM {} ({}, {})", name, size, image.ref());
        return vmId(name);
    }

    /** The resource when it is ours and Succeeded; else starts its PUT if it is missing and throws CloudBusy. */
    private JsonNode ready(String path, Object body) {
        JsonNode r = find(path);
        String what = path.substring(path.lastIndexOf('/') + 1);
        if (r == null) {
            client.begin("PUT", path, body);
            log.info("[azure] creating {}", what);
            throw busy("Creating " + what);
        }
        if (!managed(r)) throw invalid("Azure already has " + what + " that vm-intent didn't build; choose another name");
        String state = state(r);
        if ("Succeeded".equals(state)) return r;
        if ("Failed".equals(state)) throw ApplicationFailure.newNonRetryableFailure("Creating " + what + " failed in Azure", "CloudError");
        throw busy(what + " is " + state);
    }

    private void requireSetUp() {
        List<String> missing = new ArrayList<>();
        if (!cfg.configured()) missing.add("vmintent.azure tenant-id, client-id, client-secret, subscription-id and resource-group");
        if (AzureProperties.blank(cfg.location())) missing.add("vmintent.azure.location (VMINTENT_AZURE_LOCATION)");
        if (AzureProperties.blank(vm.subnetId())) missing.add("vmintent.azure.subnet-id (VMINTENT_AZURE_SUBNET_ID)");
        if (AzureProperties.blank(vm.adminSshPublicKey())) missing.add("vmintent.azure.admin-ssh-public-key (VMINTENT_AZURE_ADMIN_SSH_PUBLIC_KEY)");
        if (!missing.isEmpty()) throw ApplicationFailure.newNonRetryableFailure("Azure is not set up: missing " + String.join("; ", missing), "NotSetUp");
    }

    // ------------------------------------------------------------------ status

    /** Reads only. VmNotFound when the VM is gone or isn't ours. */
    public VmStatus describeVm(String vmId) {
        String name = name(vmId);
        JsonNode r = find(path(COMPUTE, "virtualMachines", name) + "?$expand=instanceView");
        if (r == null || !managed(r)) throw ApplicationFailure.newNonRetryableFailure("Azure has no VM " + name + " built by vm-intent", "VmNotFound");
        String state = state(r);
        if ("Failed".equals(state)) {
            String why = "provisioning failed";
            for (JsonNode s : r.path("properties").path("instanceView").path("statuses")) {
                if ("Error".equals(s.path("level").asText())) why = s.path("message").asText(why);
            }
            return new VmStatus("FAILED", null, "Building " + name + " failed: " + why);
        }
        if (!"Succeeded".equals(state)) return new VmStatus("PENDING", null, name + " is " + state);
        JsonNode pip = find(path(NETWORK, "publicIPAddresses", name + "-pip"));
        String ip = pip == null ? null : pip.path("properties").path("ipAddress").asText(null);
        return new VmStatus("RUNNING", ip, name + " is running");
    }

    // ------------------------------------------------------------------ remove

    /** One step: the VM, then the NIC, then the public IP. CloudBusy while a delete runs; returns once all are gone. */
    public void deleteVm(String vmId) {
        String name = name(vmId);
        for (String path : List.of(path(COMPUTE, "virtualMachines", name), path(NETWORK, "networkInterfaces", name + "-nic"),
                path(NETWORK, "publicIPAddresses", name + "-pip"))) {
            JsonNode r = find(path);
            if (r == null) continue;
            String what = path.substring(path.lastIndexOf('/') + 1);
            if (!managed(r)) throw invalid("Won't remove " + what + ": it isn't tagged as built by vm-intent");
            if ("Deleting".equals(state(r))) throw busy("Removing " + what);
            if (client.begin("DELETE", path, null).operationUrl() != null) {
                log.info("[azure] removing {}", what);
                throw busy("Removing " + what);
            }
        }
    }

    // ------------------------------------------------------------------ helpers

    private String path(String provider, String type, String name) {
        return client.resourcePath(provider, type, name);
    }

    private String vmId(String name) {
        return PREFIX + cfg.resourceGroup() + ":" + name;
    }

    /** The VM name in an ID of this backend's resource group; VmNotFound otherwise. */
    private String name(String vmId) {
        String[] p = owns(vmId) ? vmId.split(":", 3) : new String[0];
        if (p.length != 3 || !p[1].equalsIgnoreCase(cfg.resourceGroup()) || p[2].isBlank()) {
            throw ApplicationFailure.newNonRetryableFailure("Not a VM of Azure resource group " + cfg.resourceGroup() + ": " + vmId, "VmNotFound");
        }
        return p[2];
    }

    /** The resource, or null when ARM says it doesn't exist. */
    private JsonNode find(String path) {
        try {
            return client.get(path);
        } catch (ApplicationFailure e) {
            if ("NotFound".equals(e.getType())) return null;
            throw e;
        }
    }

    static boolean managed(JsonNode r) {
        return MANAGED.equals(r.path("tags").path(TAG).asText());
    }

    static String state(JsonNode r) {
        return r.path("properties").path("provisioningState").asText("");
    }

    private static ApplicationFailure busy(String message) {
        return ApplicationFailure.newFailure(message + "; not ready yet", "CloudBusy");
    }

    private static ApplicationFailure invalid(String message) {
        return ApplicationFailure.newNonRetryableFailure(message, "InvalidSpec");
    }
}
