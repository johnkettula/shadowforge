package com.example.vmintent.provider.vsphere;

import com.example.vmintent.provider.CloudBackend;
import com.example.vmintent.spec.VmIdentity;
import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.ProviderPlan;
import com.example.vmintent.workflow.Models.VmStatus;
import io.temporal.failure.ApplicationFailure;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * vSphere through vCenter 9 directly: each VM is deployed from a VM template in a content library,
 * placed on the datacenter's cluster (or resource pool / host), folder and datastore, sized with
 * hardware customization, optionally guest-customized, powered on and tagged as vm-intent's.
 *
 * VM IDs look like "vcenter:dc1:app-db-01": the vm-intent datacenter and the VM's name. The name is
 * what makes a create idempotent (vCenter has no client token): a VM with that name in the folder,
 * tagged as ours and with the same spec hash in the key in its notes, is the one we built; one that
 * isn't tagged as ours, or was built for another spec, is never touched.
 */
public class VcenterBackend implements CloudBackend {

    public static final String PREFIX = "vcenter:";
    private static final Logger log = LoggerFactory.getLogger(VcenterBackend.class);

    private final VsphereProperties props;
    private final VcenterClient client;
    private final DeployJournal journal;
    /** Inventory names resolved to vCenter IDs, per datacenter (folders, clusters, datastores, templates). */
    private final Map<String, String> ids = new ConcurrentHashMap<>();

    public VcenterBackend(VsphereProperties props, VcenterClient client, DeployJournal journal) {
        this.props = props;
        this.client = client;
        this.journal = journal;
    }

    public VcenterClient client() {
        return client;
    }

    public static boolean owns(String vmId) {
        return vmId != null && vmId.startsWith(PREFIX);
    }

    @Override
    public boolean handles(String vmId) {
        return owns(vmId);
    }

    record Ref(String dc, String name) {
        String key() {
            return dc + ":" + name;
        }

        String vmId() {
            return PREFIX + dc + ":" + name;
        }
    }

    static Ref ref(String vmId) {
        String rest = vmId.substring(PREFIX.length());
        int i = rest.indexOf(':');
        if (i < 0) throw ApplicationFailure.newNonRetryableFailure("Not a vCenter VM ID: " + vmId, "VmNotFound");
        return new Ref(rest.substring(0, i), rest.substring(i + 1));
    }

    // ------------------------------------------------------------------ plan and build

    public ProviderPlan plan(VmSpec s) {
        VsphereProperties.Datacenter dc = props.datacenter(s.region());
        String where = (dc.datacenter() == null ? "" : dc.datacenter() + " / ")
                + (dc.resourcePool() != null ? "pool " + dc.resourcePool() : dc.host() != null ? "host " + dc.host() : "cluster " + dc.cluster());
        String template = templateName(dc, s);
        String size = s.vcpu() + " vCPU / " + s.memoryGiB() + " GiB, " + datastore(dc, s);
        return new ProviderPlan(where, size, "Content library " + props.vcenter().contentLibrary() + ": " + template,
                "vCenter " + where + ", " + size + ", template " + template);
    }

    static String templateName(VsphereProperties.Datacenter dc, VmSpec s) {
        String os = s.os() == null ? "" : s.os();
        String ver = s.osVersion() == null ? "" : s.osVersion();
        String major = ver.contains(".") ? ver.substring(0, ver.indexOf('.')) : ver;
        for (String k : List.of(os + "-" + ver, os + "-" + major, os)) {
            String t = dc.templates().get(k);
            if (t != null && !t.isBlank()) return t;
        }
        throw ApplicationFailure.newNonRetryableFailure("No VM template is set up for " + os + " " + ver
                + " (vmintent.vsphere.datacenters.<dc>.templates: \"" + os + "-" + ver + "\", \"" + os + "-" + major + "\" or \"" + os + "\")",
                "InvalidSpec");
    }

    static String datastore(VsphereProperties.Datacenter dc, VmSpec s) {
        String tier = s.diskTier() == null ? "standard" : s.diskTier();
        String ds = dc.datastores().getOrDefault(tier, dc.datastores().get("standard"));
        if (ds == null) {
            throw ApplicationFailure.newNonRetryableFailure("No datastore is set up for disk tier '" + tier
                    + "' (vmintent.vsphere.datacenters.<dc>.datastores)", "InvalidSpec");
        }
        return ds;
    }

    private String cached(String key, java.util.function.Supplier<String> lookup) {
        return ids.computeIfAbsent(key, k -> lookup.get());
    }

    private String datacenterFilter(String dcKey, VsphereProperties.Datacenter dc) {
        if (dc.datacenter() == null || dc.datacenter().isBlank()) return null;
        return "datacenters=" + HttpJson.q(cached(dcKey + "/datacenter", () -> client.idOf("datacenter", dc.datacenter(), null)));
    }

    private String folderId(String dcKey) {
        VsphereProperties.Datacenter dc = props.datacenter(dcKey);
        if (dc.folder() == null || dc.folder().isBlank()) return null;
        String filter = datacenterFilter(dcKey, dc);
        return cached(dcKey + "/folder", () -> client.idOf("folder", dc.folder(), "type=VIRTUAL_MACHINE" + (filter == null ? "" : "&" + filter)));
    }

    /** CloudBackend's createVm. The plan isn't needed: the build reads the same settings plan(spec) did. */
    @Override
    public String createVm(VmSpec spec, ProviderPlan plan, String idempotencyKey) {
        return createVm(spec, idempotencyKey);
    }

    public String createVm(VmSpec spec, String idempotencyKey) {
        Ref ref = new Ref(spec.region(), spec.name());
        VsphereProperties.Datacenter dc = props.datacenter(ref.dc());
        Optional<DeployJournal.Entry> started = journal.get(ref.key());
        if (started.isPresent() && idempotencyKey.equals(started.get().idempotencyKey())) return ref.vmId(); // a retried call
        String folder = folderId(ref.dc());
        Optional<VcenterClient.VmSummary> existing = client.findVm(spec.name(), folder);
        if (existing.isPresent()) {
            if (!client.isTagged(existing.get().vm())) {
                throw ApplicationFailure.newNonRetryableFailure("vCenter already has a VM called '" + spec.name()
                        + "' that vm-intent didn't build; choose another name", "InvalidSpec");
            }
            // Ours, but adopted only when built for the same spec. No readable key = built before keys were read: adopted.
            String recorded = recordedKey(client.annotation(existing.get().vm()));
            if (recorded != null && !VmIdentity.sameBuild(recorded, idempotencyKey)) throw builtForAnotherRequest(spec.name());
            journal.found(ref.key(), existing.get().vm(), true);
            return ref.vmId();
        }
        // Not in the inventory yet, but a deploy of this name may still be cloning.
        if (started.isPresent() && started.get().taskId() != null && stillDeploying(started.get().taskId())) {
            if (!VmIdentity.sameBuild(started.get().idempotencyKey(), idempotencyKey)) throw builtForAnotherRequest(spec.name());
            return ref.vmId();
        }
        String filter = datacenterFilter(ref.dc(), dc);
        Map<String, Object> placement = new LinkedHashMap<>();
        if (folder != null) placement.put("folder", folder);
        if (dc.resourcePool() != null && !dc.resourcePool().isBlank()) {
            placement.put("resource_pool", cached(ref.dc() + "/pool", () -> client.idOf("resource-pool", dc.resourcePool(), filter)));
        } else if (dc.host() != null && !dc.host().isBlank()) {
            placement.put("host", cached(ref.dc() + "/host", () -> client.idOf("host", dc.host(), filter)));
        } else if (dc.cluster() != null && !dc.cluster().isBlank()) {
            placement.put("cluster", cached(ref.dc() + "/cluster", () -> client.idOf("cluster", dc.cluster(), filter)));
        }
        String dsName = datastore(dc, spec);
        String ds = cached(ref.dc() + "/ds/" + dsName, () -> client.idOf("datastore", dsName, filter));
        String template = templateName(dc, spec);
        String item = cached("item/" + template, () -> client.libraryItem(props.vcenter().contentLibrary(), template));

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", spec.name());
        body.put("description", "Built by vm-intent (" + spec.env() + "). Key " + idempotencyKey);
        body.put("placement", placement);
        body.put("vm_home_storage", Map.of("datastore", ds));
        body.put("disk_storage", Map.of("datastore", ds));
        body.put("hardware_customization", Map.of(
                "cpu_update", Map.of("num_cpus", spec.vcpu()),
                "memory_update", Map.of("memory", spec.memoryGiB() * 1024L)));
        String gc = dc.customizationSpecs().get(spec.os());
        if (gc != null && !gc.isBlank()) body.put("guest_customization", Map.of("name", gc));
        body.put("powered_on", true);

        String task = client.deployFromTemplate(item, body);
        journal.started(ref.key(), idempotencyKey, task);
        log.info("[vcenter] deploying {} from {} (task {})", spec.name(), template, task);
        return ref.vmId();
    }

    private static final Pattern NOTES_KEY = Pattern.compile("\\bKey (\\S+)");

    /** The build key in a VM's notes ("Built by vm-intent (dev). Key ..."), or null when there is none. */
    static String recordedKey(String notes) {
        Matcher m = NOTES_KEY.matcher(notes == null ? "" : notes);
        return m.find() ? m.group(1) : null;
    }

    private static ApplicationFailure builtForAnotherRequest(String name) {
        return ApplicationFailure.newNonRetryableFailure("vCenter's VM '" + name
                + "' was built by vm-intent for another request; choose another name", "InvalidSpec");
    }

    private boolean stillDeploying(String taskId) {
        return client.task(taskId).filter(t -> !t.failed() && !t.succeeded()).isPresent();
    }

    // ------------------------------------------------------------------ status

    private Optional<VcenterClient.VmSummary> find(Ref ref) {
        return client.findVm(ref.name(), folderId(ref.dc()));
    }

    public VmStatus describeVm(String vmId) {
        Ref ref = ref(vmId);
        Optional<VcenterClient.VmSummary> vm = find(ref);
        Optional<DeployJournal.Entry> entry = journal.get(ref.key());
        if (vm.isPresent()) {
            if (entry.isEmpty() || !entry.get().tagged()) {
                client.tag(vm.get().vm());
                journal.found(ref.key(), vm.get().vm(), true);
            }
            if (!"POWERED_ON".equals(vm.get().powerState())) {
                return new VmStatus("PENDING", null, ref.name() + " is " + vm.get().powerState().toLowerCase().replace('_', ' '));
            }
            return client.guestIp(vm.get().vm())
                    .map(ip -> new VmStatus("RUNNING", ip, ref.name() + " is running"))
                    .orElseGet(() -> new VmStatus("PENDING", null, ref.name() + " is on; waiting for VMware Tools to report its IP address"));
        }
        if (entry.isEmpty() || entry.get().taskId() == null) {
            return new VmStatus("FAILED", null, "vCenter has no VM called " + ref.name());
        }
        Optional<VcenterClient.TaskInfo> task = client.task(entry.get().taskId());
        if (task.isEmpty()) return new VmStatus("FAILED", null, "vCenter no longer knows the deploy task for " + ref.name());
        if (task.get().failed()) return new VmStatus("FAILED", null, "Deploying " + ref.name() + " failed: " + task.get().error());
        if (task.get().succeeded()) return new VmStatus("FAILED", null, "The deploy finished but " + ref.name() + " isn't there (removed?)");
        return new VmStatus("PENDING", null, "Deploying " + ref.name() + " from its template");
    }

    // ------------------------------------------------------------------ day 2

    private VcenterClient.VmSummary require(Ref ref) {
        return find(ref).orElseThrow(() -> ApplicationFailure.newNonRetryableFailure("vCenter has no VM called " + ref.name(), "VmNotFound"));
    }

    public void deleteVm(String vmId) {
        Ref ref = ref(vmId);
        Optional<VcenterClient.VmSummary> vm = find(ref);
        if (vm.isPresent()) {
            if (!client.isTagged(vm.get().vm())) {
                throw ApplicationFailure.newNonRetryableFailure("Won't remove " + ref.name() + ": it isn't tagged as built by vm-intent", "InvalidSpec");
            }
            if ("POWERED_ON".equals(vm.get().powerState())) client.power(vm.get().vm(), false);
            client.delete(vm.get().vm());
            log.info("[vcenter] removed {}", ref.name());
        } else {
            journal.get(ref.key()).map(DeployJournal.Entry::taskId).filter(t -> t != null).ifPresent(t -> {
                client.task(t).filter(ti -> !ti.failed() && !ti.succeeded()).ifPresent(ti -> client.cancelTask(t));
            });
        }
        journal.forget(ref.key());
    }

    public void resizeVm(String vmId, int vcpu, int memoryGiB) {
        Ref ref = ref(vmId);
        VcenterClient.VmSummary vm = require(ref);
        long mib = memoryGiB * 1024L;
        if (vm.cpuCount() == vcpu && vm.memoryMiB() == mib) return;
        boolean wasOn = "POWERED_ON".equals(vm.powerState());
        if (wasOn) client.power(vm.vm(), false);
        if (vm.cpuCount() != vcpu) client.setCpu(vm.vm(), vcpu);
        if (vm.memoryMiB() != mib) client.setMemoryMiB(vm.vm(), mib);
        if (wasOn) client.power(vm.vm(), true);
    }

    public void setPower(String vmId, boolean on) {
        VcenterClient.VmSummary vm = require(ref(vmId));
        boolean isOn = "POWERED_ON".equals(vm.powerState());
        if (isOn != on) client.power(vm.vm(), on);
    }

    public String snapshotVm(String vmId, String label) {
        VcenterClient.VmSummary vm = require(ref(vmId));
        return "snapshot " + label + " (" + client.snapshot(vm.vm(), label, "Taken by vm-intent") + ")";
    }

    /** Every VM tagged as vm-intent's, in the datacenters routed to vCenter. */
    public List<String> listVmIds() {
        List<String> out = new ArrayList<>();
        Map<String, String> folderToDc = new LinkedHashMap<>();
        for (String dc : props.datacenters().keySet()) {
            if (VsphereProperties.VCENTER.equals(props.routeFor(dc))) folderToDc.put(folderId(dc), dc);
        }
        if (folderToDc.isEmpty()) return out;
        String onlyDc = folderToDc.size() == 1 ? folderToDc.values().iterator().next() : null;
        for (String vm : client.taggedVms()) {
            client.vm(vm).ifPresent(s -> {
                String dc = onlyDc != null ? onlyDc : dcOf(s.name(), folderToDc);
                if (dc != null) out.add(new Ref(dc, s.name()).vmId());
            });
        }
        return out;
    }

    private String dcOf(String name, Map<String, String> folderToDc) {
        for (Map.Entry<String, String> e : folderToDc.entrySet()) {
            if (client.findVm(name, e.getKey()).isPresent()) return e.getValue();
        }
        return null;
    }
}
