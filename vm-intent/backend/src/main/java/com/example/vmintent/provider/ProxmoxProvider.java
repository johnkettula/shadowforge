package com.example.vmintent.provider;

import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.ProviderPlan;
import com.example.vmintent.workflow.Models.VmStatus;
import com.example.vmintent.workflow.TaskQueues;
import com.fasterxml.jackson.databind.JsonNode;
import io.temporal.failure.ApplicationFailure;
import io.temporal.spring.boot.ActivityImpl;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Proxmox VE adapter for VMs built by cloning a template (QEMU/KVM).
 * Polls "proxmox-q" (create/delete) and "proxmox-read-q" (plan/describe).
 *
 * Set up with VMINTENT_PROXMOX_URL (e.g. https://pve.example:8006), VMINTENT_PROXMOX_TOKEN
 * (user@realm!tokenid=secret), VMINTENT_PROXMOX_NODE (e.g. pve1) and VMINTENT_PROXMOX_TEMPLATE_VMID.
 * Until the URL is set, builds on Proxmox fail with a clear NotSetUp message.
 *
 * The VM ID is Proxmox's numeric VMID as text. createVm is idempotent by VM name: if a VM with the
 * same name already exists on the node, that VM's ID is returned instead of cloning a second one.
 */
@Component
@ActivityImpl(taskQueues = {TaskQueues.PROXMOX, TaskQueues.PROXMOX_READ})
public class ProxmoxProvider implements ProviderActivities {

    /** Failure type when Proxmox is asked for but isn't set up. */
    public static final String NOT_SET_UP = "NotSetUp";

    private final ProxmoxClient client; // null when the URL isn't set
    private final String node;
    private final int templateVmid;

    public ProxmoxProvider(@Value("${vmintent.proxmox.url:}") String url,
                           @Value("${vmintent.proxmox.token:}") String token,
                           @Value("${vmintent.proxmox.node:}") String node,
                           @Value("${vmintent.proxmox.template-vmid:0}") int templateVmid) {
        this.client = url == null || url.isBlank() ? null : new ProxmoxClient(url, token);
        this.node = node == null ? "" : node;
        this.templateVmid = templateVmid;
    }

    @Override
    public ProviderPlan plan(VmSpec spec) {
        return ProviderCatalog.plan(spec);
    }

    @Override
    public String createVm(VmSpec spec, ProviderPlan plan, String idempotencyKey) {
        ProxmoxClient c = requireSetUp();
        int existing = findVmidByName(c, spec.name());
        if (existing >= 0) {
            return String.valueOf(existing);
        }
        int newId = c.get("/cluster/nextid").asInt();
        c.post("/nodes/" + node + "/qemu/" + templateVmid + "/clone",
                Map.of("newid", String.valueOf(newId), "name", spec.name(), "full", "1"));
        return String.valueOf(newId);
    }

    @Override
    public VmStatus describeVm(String vmId) {
        ProxmoxClient c = requireSetUp();
        JsonNode d = c.get(vmPath(vmId) + "/status/current");
        String lock = d.path("lock").asText("");
        if (!lock.isEmpty()) {
            return new VmStatus("PENDING", null, "Proxmox is busy: " + lock);
        }
        String status = d.path("status").asText("");
        if ("running".equals(status)) {
            return new VmStatus("RUNNING", guestIp(c, vmId), "running");
        }
        if ("stopped".equals(status)) {
            return new VmStatus("PENDING", null, "stopped: power it on to start it");
        }
        return new VmStatus("FAILED", null, "Proxmox status: " + status);
    }

    @Override
    public void deleteVm(String vmId) {
        requireSetUp().delete(vmPath(vmId));
    }

    @Override
    public void resizeVm(String vmId, int vcpu, int memoryGiB) {
        requireSetUp().post(vmPath(vmId) + "/config",
                Map.of("cores", String.valueOf(vcpu), "memory", String.valueOf(memoryGiB * 1024)));
    }

    @Override
    public void setPower(String vmId, boolean on) {
        requireSetUp().post(vmPath(vmId) + (on ? "/status/start" : "/status/stop"), Map.of());
    }

    @Override
    public String snapshotVm(String vmId, String label) {
        String snapname = snapshotName(label);
        requireSetUp().post(vmPath(vmId) + "/snapshot", Map.of("snapname", snapname));
        return snapname;
    }

    @Override
    public List<String> listVmIds() {
        List<String> ids = new ArrayList<>();
        if (client == null) {
            return ids; // not set up: nothing to list
        }
        for (JsonNode vm : client.get("/nodes/" + node + "/qemu")) {
            int vmid = vm.path("vmid").asInt(-1);
            if (vmid >= 0 && vmid != templateVmid) {
                ids.add(String.valueOf(vmid));
            }
        }
        return ids;
    }

    /** Proxmox snapshot names: a letter, then letters, digits, '-' or '_'. */
    static String snapshotName(String label) {
        String clean = (label == null ? "" : label).replaceAll("[^A-Za-z0-9_-]", "-");
        if (clean.isEmpty() || !Character.isLetter(clean.charAt(0))) {
            clean = "s" + clean;
        }
        return clean;
    }

    private String vmPath(String vmId) {
        return "/nodes/" + node + "/qemu/" + vmId;
    }

    private int findVmidByName(ProxmoxClient c, String name) {
        for (JsonNode vm : c.get("/nodes/" + node + "/qemu")) {
            if (name != null && name.equals(vm.path("name").asText(""))) {
                return vm.path("vmid").asInt(-1);
            }
        }
        return -1;
    }

    /** The first IPv4 address the guest agent reports, or null when the agent isn't running. */
    private String guestIp(ProxmoxClient c, String vmId) {
        try {
            for (JsonNode iface : c.get(vmPath(vmId) + "/agent/network-get-interfaces").path("result")) {
                if ("lo".equals(iface.path("name").asText())) continue;
                for (JsonNode addr : iface.path("ip-addresses")) {
                    if ("ipv4".equals(addr.path("ip-address-type").asText())) {
                        return addr.path("ip-address").asText();
                    }
                }
            }
        } catch (ApplicationFailure e) {
            // The guest agent isn't running yet; the IP stays unknown until it is.
        }
        return null;
    }

    private ProxmoxClient requireSetUp() {
        if (client == null) {
            throw ApplicationFailure.newNonRetryableFailure("Proxmox isn't set up: set vmintent.proxmox.url, token, node and "
                    + "template-vmid (VMINTENT_PROXMOX_URL, VMINTENT_PROXMOX_TOKEN, VMINTENT_PROXMOX_NODE, "
                    + "VMINTENT_PROXMOX_TEMPLATE_VMID)", NOT_SET_UP);
        }
        return client;
    }
}
