package com.example.vmintent.provider.vsphere;

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
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * vSphere through VCF Automation 9 blueprints (cloud templates). A VM request becomes a blueprint
 * request: the datacenter's blueprint, its newest released version (or the one set), and inputs filled
 * from the spec. The deployment is the VM: its machine resource gives the IP address, and resize, power
 * and snapshot are the machine's day-2 actions.
 *
 * VM IDs look like "vcfa:<deployment ID>". The deployment name is the VM's name, which makes a create
 * idempotent: a retried call finds the deployment it already asked for. It is adopted only when the key in
 * its description has the same spec hash; one without a vm-intent key, or built for another spec, is refused.
 *
 * Also used directly by the catalog's blueprint.deploy step, for blueprints that build more than one VM.
 */
public class VcfaBackend {

    public static final String PREFIX = "vcfa:";
    private static final Logger log = LoggerFactory.getLogger(VcfaBackend.class);
    private static final Pattern PLACEHOLDER = Pattern.compile("\\{([a-zA-Z]+)}");
    private static final Pattern DESCRIPTION_KEY = Pattern.compile("vm-intent build \\([^)]*\\), key (\\S+)");

    /** Day-2 action IDs of a vSphere machine resource. */
    static final String POWER_ON = "Cloud.vSphere.Machine.PowerOn";
    static final String POWER_OFF = "Cloud.vSphere.Machine.PowerOff";
    static final String RESIZE = "Cloud.vSphere.Machine.Resize";
    static final String SNAPSHOT = "Cloud.vSphere.Machine.Snapshot.Create";

    private final VsphereProperties props;
    private final VcfAutomationClient client;

    public VcfaBackend(VsphereProperties props, VcfAutomationClient client) {
        this.props = props;
        this.client = client;
    }

    public VcfAutomationClient client() {
        return client;
    }

    public static boolean owns(String vmId) {
        return vmId != null && vmId.startsWith(PREFIX);
    }

    private static String deploymentId(String vmId) {
        return vmId.substring(PREFIX.length());
    }

    // ------------------------------------------------------------------ the VM route

    static String blueprintFor(VsphereProperties.Datacenter dc, VmSpec s) {
        String b = dc.blueprints().get(s.os());
        if (b == null || b.isBlank()) b = dc.blueprint();
        if (b == null || b.isBlank()) {
            throw ApplicationFailure.newNonRetryableFailure("No blueprint is set up for " + s.os()
                    + " (vmintent.vsphere.datacenters.<dc>.blueprint or .blueprints." + s.os() + ")", "InvalidSpec");
        }
        return b;
    }

    public ProviderPlan plan(VmSpec s) {
        VsphereProperties.Datacenter dc = props.datacenter(s.region());
        String bp = blueprintFor(dc, s);
        String version = dc.blueprintVersion() == null || dc.blueprintVersion().isBlank() ? "newest released version" : "version " + dc.blueprintVersion();
        String project = props.automation().project();
        return new ProviderPlan("project " + project, s.vcpu() + " vCPU / " + s.memoryGiB() + " GiB (blueprint inputs)",
                "Blueprint " + bp + " (" + version + ")", "VCF Automation project " + project + ", blueprint " + bp + " (" + version + ")");
    }

    /** The blueprint's inputs for this spec, from the datacenter's blueprintInputs template. */
    static Map<String, Object> inputsFor(VsphereProperties.Datacenter dc, VmSpec s) {
        Map<String, String> vars = new LinkedHashMap<>();
        vars.put("name", s.name());
        vars.put("vcpu", String.valueOf(s.vcpu()));
        vars.put("memoryGiB", String.valueOf(s.memoryGiB()));
        vars.put("memoryMiB", String.valueOf(s.memoryGiB() * 1024L));
        vars.put("memoryMB", String.valueOf(s.memoryGiB() * 1024L));
        vars.put("diskGiB", String.valueOf(s.diskGiB()));
        vars.put("diskTier", s.diskTier());
        vars.put("os", s.os());
        vars.put("osVersion", s.osVersion());
        vars.put("env", s.env());
        vars.put("ttlDays", String.valueOf(s.ttlDays()));
        Map<String, Object> out = new LinkedHashMap<>();
        dc.blueprintInputs().forEach((k, v) -> out.put(k, coerce(fill(v, vars))));
        return out;
    }

    static String fill(String template, Map<String, String> vars) {
        Matcher m = PLACEHOLDER.matcher(template);
        StringBuilder sb = new StringBuilder();
        while (m.find()) m.appendReplacement(sb, Matcher.quoteReplacement(vars.getOrDefault(m.group(1), m.group(0))));
        m.appendTail(sb);
        return sb.toString();
    }

    /** "4" -> 4, "true" -> true, anything else stays text. */
    static Object coerce(String v) {
        if (v.matches("-?\\d{1,18}")) return Long.parseLong(v);
        if (v.equals("true") || v.equals("false")) return Boolean.parseBoolean(v);
        return v;
    }

    private String version(VsphereProperties.Datacenter dc, String blueprintId) {
        if (dc.blueprintVersion() != null && !dc.blueprintVersion().isBlank()) return dc.blueprintVersion();
        List<String> released = client.releasedVersions(blueprintId);
        return released.isEmpty() ? null : released.get(0);
    }

    public String createVm(VmSpec spec, String idempotencyKey) {
        VsphereProperties.Datacenter dc = props.datacenter(spec.region());
        Optional<VcfAutomationClient.NamedDeployment> existing = client.findNamedDeployment(spec.name());
        if (existing.isPresent()) {
            // No ownership tag here: the key in the description is what says vm-intent built it, and for which spec.
            String recorded = recordedKey(existing.get().description());
            if (recorded == null) {
                throw ApplicationFailure.newNonRetryableFailure("VCF Automation already has a deployment called '" + spec.name()
                        + "' that vm-intent didn't build; choose another name", "InvalidSpec");
            }
            if (!VmIdentity.sameBuild(recorded, idempotencyKey)) {
                throw ApplicationFailure.newNonRetryableFailure("VCF Automation's deployment '" + spec.name()
                        + "' was built by vm-intent for another request; choose another name", "InvalidSpec");
            }
            return PREFIX + existing.get().id();
        }
        VcfAutomationClient.Blueprint bp = client.blueprint(blueprintFor(dc, spec));
        String version = version(dc, bp.id());
        VcfAutomationClient.Requested r = client.requestDeployment(bp.id(), version, spec.name(), inputsFor(dc, spec),
                "vm-intent build (" + spec.env() + "), key " + idempotencyKey);
        log.info("[vcf-automation] requested {} from blueprint {} {} (deployment {})", spec.name(), bp.name(), version, r.deploymentId());
        return PREFIX + r.deploymentId();
    }

    /** The build key in a deployment's description ("vm-intent build (dev), key ..."), or null when there is none. */
    static String recordedKey(String description) {
        Matcher m = DESCRIPTION_KEY.matcher(description == null ? "" : description);
        return m.find() ? m.group(1) : null;
    }

    public VmStatus describeVm(String vmId) {
        Optional<VcfAutomationClient.Deployment> d = client.deployment(deploymentId(vmId));
        if (d.isEmpty()) return new VmStatus("FAILED", null, "VCF Automation has no deployment " + deploymentId(vmId));
        VcfAutomationClient.Deployment dep = d.get();
        if (dep.failed()) return new VmStatus("FAILED", null, "Deployment " + dep.name() + " " + dep.status()
                + (dep.failure() == null ? "" : ": " + dep.failure()));
        if (dep.inProgress()) return new VmStatus("PENDING", null, "Deployment " + dep.name() + " " + dep.status());
        Optional<VcfAutomationClient.Resource> m = dep.machine();
        if (m.isEmpty()) return new VmStatus("RUNNING", "", "Deployment " + dep.name() + " has no machine");
        if (m.get().address().isBlank()) return new VmStatus("PENDING", null, "Deployment " + dep.name() + " is done; waiting for the machine's address");
        return new VmStatus("RUNNING", m.get().address(), "Deployment " + dep.name() + " " + dep.status());
    }

    public void deleteVm(String vmId) {
        client.deleteDeployment(deploymentId(vmId));
        log.info("[vcf-automation] removing deployment {}", deploymentId(vmId));
    }

    private VcfAutomationClient.Resource machine(String vmId) {
        return client.deployment(deploymentId(vmId)).flatMap(VcfAutomationClient.Deployment::machine)
                .orElseThrow(() -> ApplicationFailure.newNonRetryableFailure("Deployment " + deploymentId(vmId) + " has no machine", "VmNotFound"));
    }

    public void resizeVm(String vmId, int vcpu, int memoryGiB) {
        VcfAutomationClient.Resource m = machine(vmId);
        if (m.cpuCount() == vcpu && m.memoryMB() == memoryGiB * 1024L) return;
        client.resourceAction(m.id(), RESIZE, Map.of("cpuCount", vcpu, "totalMemoryMB", memoryGiB * 1024L), "vm-intent resize");
    }

    public void setPower(String vmId, boolean on) {
        VcfAutomationClient.Resource m = machine(vmId);
        boolean isOn = "ON".equalsIgnoreCase(m.powerState()) || "POWERED_ON".equalsIgnoreCase(m.powerState());
        if (isOn != on) client.resourceAction(m.id(), on ? POWER_ON : POWER_OFF, Map.of(), "vm-intent power " + (on ? "on" : "off"));
    }

    public String snapshotVm(String vmId, String label) {
        VcfAutomationClient.Resource m = machine(vmId);
        String req = client.resourceAction(m.id(), SNAPSHOT, Map.of("name", label, "description", "Taken by vm-intent", "includeMemory", false),
                "vm-intent snapshot");
        return "snapshot " + label + " (request " + req + ")";
    }

    public List<String> listVmIds() {
        List<String> out = new ArrayList<>();
        for (String id : client.deploymentIds()) out.add(PREFIX + id);
        return out;
    }

    // ------------------------------------------------------------------ the catalog's blueprint.deploy step

    /**
     * Starts (or finds) a deployment of a blueprint. Partial work: a deployment with this name already
     * there is used if it's running or done; a failed one is removed first, so Resume asks again.
     */
    public Map<String, Object> startBlueprint(String blueprint, String version, String deploymentName, Map<String, Object> inputs, String reason) {
        Optional<String> existing = client.findDeployment(deploymentName);
        if (existing.isPresent()) {
            Optional<VcfAutomationClient.Deployment> d = client.deployment(existing.get());
            if (d.isPresent() && d.get().status().startsWith("DELETE_") && !"DELETE_FAILED".equals(d.get().status())) {
                throw ApplicationFailure.newFailure("Deployment " + deploymentName + " is still being removed", "CloudBusy");
            }
            if (d.isPresent() && !d.get().failed()) {
                return Map.of("deploymentId", existing.get(), "reused", true);
            }
            client.deleteDeployment(existing.get());
            throw ApplicationFailure.newFailure("Deployment " + deploymentName + " had failed; it's being removed before asking again", "CloudBusy");
        }
        VcfAutomationClient.Blueprint bp = client.blueprint(blueprint);
        String v = version == null || version.isBlank() ? client.releasedVersions(bp.id()).stream().findFirst().orElse(null) : version;
        VcfAutomationClient.Requested r = client.requestDeployment(bp.id(), v, deploymentName, inputs, reason);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("deploymentId", r.deploymentId());
        out.put("requestId", r.requestId());
        out.put("blueprint", bp.name());
        out.put("version", v == null ? "current" : v);
        out.put("reused", false);
        return out;
    }

    /** state = IN_PROGRESS | SUCCESSFUL | FAILED, with the deployment's resources and addresses. */
    public Map<String, Object> blueprintStatus(String deploymentId) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("deploymentId", deploymentId);
        Optional<VcfAutomationClient.Deployment> d = client.deployment(deploymentId);
        if (d.isEmpty()) {
            out.put("state", "FAILED");
            out.put("detail", "VCF Automation has no deployment " + deploymentId);
            return out;
        }
        VcfAutomationClient.Deployment dep = d.get();
        out.put("name", dep.name());
        out.put("status", dep.status());
        out.put("state", dep.failed() ? "FAILED" : dep.inProgress() ? "IN_PROGRESS" : "SUCCESSFUL");
        if (dep.failure() != null) out.put("detail", dep.failure());
        List<Map<String, Object>> resources = new ArrayList<>();
        List<String> addresses = new ArrayList<>();
        for (VcfAutomationClient.Resource r : dep.resources()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", r.id());
            m.put("name", r.name());
            m.put("type", r.type());
            if (!r.address().isBlank()) {
                m.put("address", r.address());
                addresses.add(r.address());
            }
            resources.add(m);
        }
        out.put("resources", resources);
        out.put("addresses", addresses);
        return out;
    }
}
