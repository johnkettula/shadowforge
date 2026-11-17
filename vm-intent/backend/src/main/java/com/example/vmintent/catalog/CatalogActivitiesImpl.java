package com.example.vmintent.catalog;

import com.example.vmintent.audit.DecisionLog;
import com.example.vmintent.catalog.CatalogModels.ActionResult;
import com.example.vmintent.catalog.CatalogModels.Blueprint;
import com.example.vmintent.catalog.CatalogModels.BlueprintRule;
import com.example.vmintent.catalog.CatalogModels.PreparedVm;
import com.example.vmintent.cel.Cel;
import com.example.vmintent.intent.PolicyDefaults;
import com.example.vmintent.provider.VmRegistry;
import com.example.vmintent.provider.vsphere.VsphereRoutes;
import com.example.vmintent.spec.SpecValidator;
import com.example.vmintent.spec.VmIdentity;
import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.CatalogActivities;
import com.example.vmintent.workflow.Models.VmLifecycle;
import com.example.vmintent.workflow.Models.VmRecord;
import com.example.vmintent.workflow.TaskQueues;
import com.example.vmintent.workflow.VmLifecycleWorkflow;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.temporal.activity.Activity;
import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowNotFoundException;
import io.temporal.client.WorkflowUpdateException;
import io.temporal.failure.ApplicationFailure;
import io.temporal.spring.boot.ActivityImpl;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Stream;

/**
 * The catalog actions. Each one that changes something first looks at what is already there, so
 * running it again (a retry, or Resume after a failure) finishes the job instead of doing it twice:
 *
 *   tools.stage   skips a bundle already installed at that version; a half install (no marker) is
 *                 removed and done again
 *   files.copy    skips files already there with the same SHA-256, removes leftover .part files, and
 *                 writes each file under a .part name that is renamed only once it's complete and checked
 *   config.apply  writes only the values that differ, in one atomic file replace
 *
 * Each step also keeps a small journal (in the VM's folder, keyed by run and step) of what was there
 * before its first try, so Tear down puts back exactly that, however many tries the step took.
 */
@Component
@ActivityImpl(taskQueues = TaskQueues.INTENT)
public class CatalogActivitiesImpl implements CatalogActivities {

    /** The step key the workflow adds to every step's settings: "<run>:<step>". */
    public static final String STEP_KEY = "_step";

    private final TargetStore store;
    private final VmRegistry registry;
    private final WorkflowClient client;
    private final DecisionLog decisions;
    private final JdbcClient jdbc;
    /** For blueprint.deploy (VCF Automation). Null when vSphere isn't set up (tests). */
    private final VsphereRoutes vsphere;
    private final ObjectMapper json = new ObjectMapper();

    public CatalogActivitiesImpl(TargetStore store, VmRegistry registry, WorkflowClient client, DecisionLog decisions,
                                 JdbcClient jdbc) {
        this(store, registry, client, decisions, jdbc, null);
    }

    @Autowired
    public CatalogActivitiesImpl(TargetStore store, VmRegistry registry, WorkflowClient client, DecisionLog decisions,
                                 JdbcClient jdbc, VsphereRoutes vsphere) {
        this.store = store;
        this.registry = registry;
        this.client = client;
        this.decisions = decisions;
        this.jdbc = jdbc;
        this.vsphere = vsphere;
    }

    // ------------------------------------------------------------------ blueprint.deploy

    private com.example.vmintent.provider.vsphere.VcfaBackend automation() {
        if (vsphere == null) throw ApplicationFailure.newNonRetryableFailure("VCF Automation isn't set up", "InvalidStep");
        return vsphere.automation();
    }

    @Override
    public Map<String, Object> startBlueprint(Map<String, Object> with, String actor) {
        String blueprint = text(with.get("blueprint"));
        String name = text(with.get("name"));
        if (blueprint == null || name == null) throw ApplicationFailure.newNonRetryableFailure("blueprint.deploy needs blueprint and name", "InvalidStep");
        Map<String, Object> inputs = new LinkedHashMap<>();
        if (with.get("inputs") instanceof Map<?, ?> m) m.forEach((k, v) -> inputs.put(String.valueOf(k), v));
        String reason = "vm-intent catalog run " + text(with.get(STEP_KEY)) + " for " + actor;
        return automation().startBlueprint(blueprint, text(with.get("version")), name, inputs, reason);
    }

    @Override
    public Map<String, Object> blueprintStatus(String deploymentId) {
        return automation().blueprintStatus(deploymentId);
    }

    // ------------------------------------------------------------------ vm.create

    @Override
    public PreparedVm prepareVm(Map<String, Object> with, List<Blueprint> blueprints, String blueprint,
                                Map<String, Object> params, Map<String, Object> run, String owner) {
        List<String> problems = new ArrayList<>();
        String provider = text(with.get("provider"));
        String region = text(with.get("region"));
        String os = text(with.get("os"));
        Integer vcpu = integer(with.get("vcpu"), "vcpu", problems);
        Integer mem = integer(with.get("memoryGiB"), "memoryGiB", problems);
        String size = text(with.get("size"));
        if (vcpu == null || mem == null) {
            int[] s = PolicyDefaults.SIZES.get(size == null ? "small" : size);
            if (s == null) {
                problems.add("size '" + size + "' isn't one of " + PolicyDefaults.SIZES.keySet());
                s = new int[]{2, 4};
            }
            if (vcpu == null) vcpu = s[0];
            if (mem == null) mem = s[1];
        }
        String env = orElse(text(with.get("env")), "dev");
        Integer disk = integer(with.get("diskGiB"), "diskGiB", problems);
        Integer ttl = integer(with.get("ttlDays"), "ttlDays", problems);
        String name = text(with.get("name"));
        if (name == null) {
            name = run.get("definition") + "-" + sha(String.valueOf(run.get("id"))).substring(0, 6);
        }
        VmSpec spec = new VmSpec(name.toLowerCase(), provider, region, vcpu, mem, os,
                orElse(text(with.get("osVersion")), PolicyDefaults.defaultOsVersion(os)),
                disk != null ? disk : "windows".equals(os) ? 64 : 30,
                orElse(text(with.get("diskTier")), "standard"), env,
                ttl != null ? ttl : PolicyDefaults.defaultTtlDays(env),
                Boolean.parseBoolean(String.valueOf(with.getOrDefault("publicIp", "false"))));
        problems.addAll(SpecValidator.problems(spec));

        Map<String, Object> vars = new LinkedHashMap<>();
        vars.put("spec", json.convertValue(spec, new TypeReference<LinkedHashMap<String, Object>>() {}));
        vars.put("params", params == null ? Map.of() : params);
        vars.put("run", run);
        boolean namedFound = blueprint == null;
        for (Blueprint bp : blueprints == null ? List.<Blueprint>of() : blueprints) {
            boolean applies = bp.name().equals(blueprint);
            namedFound |= applies;
            if (!applies && bp.appliesWhen() != null) {
                try {
                    applies = Cel.compile(bp.appliesWhen(), vars.keySet()).evalBool(vars);
                } catch (Cel.CelException e) {
                    problems.add("blueprint " + bp.name() + ": appliesWhen couldn't be checked: " + e.getMessage());
                }
            }
            if (!applies) continue;
            for (BlueprintRule rule : bp.rules()) {
                try {
                    if (!Cel.compile(rule.check(), vars.keySet()).evalBool(vars)) {
                        problems.add(bp.name() + "/" + rule.name() + ": " + rule.message());
                    }
                } catch (Cel.CelException e) {
                    problems.add(bp.name() + "/" + rule.name() + " couldn't be checked: " + e.getMessage());
                }
            }
        }
        if (!namedFound) problems.add("the blueprint '" + blueprint + "' isn't published (or is retired)");
        VmIdentity.Id id = VmIdentity.of(spec, owner);
        return new PreparedVm(spec, id.hash(), problems, id.cloudName());
    }

    @Override
    public Map<String, Object> existingVm(String specHash) {
        VmRecord r = registry.get(specHash);
        if (r == null || !("RUNNING".equals(r.state()) || "PROVISIONING".equals(r.state()))) return null;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("state", r.state());
        out.put("name", r.spec().name());
        out.put("provider", r.spec().provider());
        out.put("region", r.spec().region());
        out.put("vcpu", r.spec().vcpu());
        out.put("memoryGiB", r.spec().memoryGiB());
        if (r.result() != null) {
            out.put("vmId", r.result().vmId());
            out.put("ipAddress", r.result().ipAddress());
            out.put("nativeSize", r.result().nativeSize());
            out.put("nativeRegion", r.result().nativeRegion());
        }
        return out;
    }

    // ------------------------------------------------------------------ vm.resize, vm.power, vm.snapshot

    @Override
    public ActionResult changeVm(String action, Map<String, Object> with, String actor) {
        String hash = text(with.get("vm"));
        VmLifecycleWorkflow life = life(hash);
        VmLifecycle now = lifecycle(life, hash);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("vm", hash);
        try {
            switch (action) {
                case "vm.resize" -> {
                    int vcpu = requireInt(with.get("vcpu"), "vcpu");
                    int mem = requireInt(with.get("memoryGiB"), "memoryGiB");
                    out.put("previousVcpu", now.vcpu());
                    out.put("previousMemoryGiB", now.memoryGiB());
                    out.put("vcpu", vcpu);
                    out.put("memoryGiB", mem);
                    boolean change = now.vcpu() != vcpu || now.memoryGiB() != mem;
                    out.put("changed", change);
                    if (change) life.resize(actor, vcpu, mem);
                    return new ActionResult(out, change ? "now " + vcpu + " vCPU / " + mem + " GiB" : "already that size");
                }
                case "vm.power" -> {
                    boolean on = Boolean.parseBoolean(String.valueOf(with.get("on")));
                    boolean wasOn = "ON".equals(now.power());
                    out.put("previousOn", wasOn);
                    out.put("on", on);
                    out.put("changed", on != wasOn);
                    if (on != wasOn) life.power(actor, on);
                    return new ActionResult(out, on == wasOn ? "already " + (on ? "on" : "off") : "powered " + (on ? "on" : "off"));
                }
                case "vm.snapshot" -> {
                    String label = text(with.get("label"));
                    boolean taken = now.snapshots().stream().anyMatch(s -> s.contains("(" + label + ","));
                    out.put("label", label);
                    out.put("changed", !taken);
                    if (!taken) life.snapshot(actor, label);
                    return new ActionResult(out, taken ? "snapshot " + label + " was already taken" : "snapshot " + label + " taken");
                }
                default -> throw ApplicationFailure.newNonRetryableFailure("Not a VM change: " + action, "InvalidStep");
            }
        } catch (WorkflowUpdateException e) {
            throw ApplicationFailure.newNonRetryableFailure("The VM refused: " + rootMessage(e), "InvalidStep");
        }
    }

    // ------------------------------------------------------------------ tools.stage

    @Override
    public ActionResult stageTools(Map<String, Object> with) {
        String hash = requireRunning(text(with.get("vm")));
        String bundle = text(with.get("bundle"));
        String version = text(with.get("version"));
        if (bundle == null || !bundle.matches("[a-z0-9][a-z0-9._-]{0,40}") || version == null || !version.matches("[A-Za-z0-9._-]{1,30}")) {
            throw ApplicationFailure.newNonRetryableFailure("bundle and version: letters, digits, '.', '_' and '-'", "InvalidStep");
        }
        try {
            String installed = store.installedVersion(hash, bundle);
            Journal j = journal(hash, with, Map.of("previousVersion", installed == null ? "" : installed));
            if (version.equals(installed)) {
                return new ActionResult(toolsOut(bundle, version, 0, j), bundle + " " + version + " is already installed");
            }
            Path src = store.bundleSource(bundle, version);
            if (!Files.isDirectory(src)) {
                throw ApplicationFailure.newNonRetryableFailure("Bundle " + bundle + " " + version
                        + " isn't in the file store (bundles/" + bundle + "/" + version + "/)", "NotFound");
            }
            int n = install(hash, bundle, version, src);
            return new ActionResult(toolsOut(bundle, version, n, j), bundle + " " + version + " installed (" + n + " files)"
                    + (installed == null ? "" : ", replacing " + installed));
        } catch (IOException e) {
            throw ApplicationFailure.newFailure("Installing " + bundle + " failed: " + e.getMessage(), "IOError");
        }
    }

    private int install(String hash, String bundle, String version, Path src) throws IOException {
        Path dir = store.toolDir(hash, bundle);
        TargetStore.deleteTree(dir);   // a half install, or the old version
        List<Path> files;
        try (Stream<Path> s = Files.walk(src)) {
            files = s.filter(Files::isRegularFile).sorted().toList();
        }
        for (Path f : files) {
            store.copy(f, dir.resolve(src.relativize(f).toString()));
            heartbeat(f.getFileName().toString());
        }
        store.markInstalled(hash, bundle, version);
        return files.size();
    }

    private static Map<String, Object> toolsOut(String bundle, String version, int files, Journal j) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("bundle", bundle);
        out.put("version", version);
        out.put("files", files);
        out.put("previousVersion", j.before().get("previousVersion"));
        return out;
    }

    // ------------------------------------------------------------------ files.copy

    record Copy(String source, Path from, Path to, String vmPath) {}

    @Override
    public ActionResult copyFiles(Map<String, Object> with) {
        String hash = requireRunning(text(with.get("vm")));
        String to = text(with.get("to"));
        try {
            List<Copy> plan = plan(hash, with, true);
            Path root = store.onVm(hash, to);
            int leftovers = store.removeLeftovers(root);
            // What was already there before the first try (with the right content) isn't ours to remove later.
            Map<String, Object> before = new LinkedHashMap<>();
            List<String> preexisting = new ArrayList<>();
            for (Copy c : plan) {
                if (c.from() != null && Files.isRegularFile(c.to()) && TargetStore.sha256(c.to()).equals(TargetStore.sha256(c.from()))) {
                    preexisting.add(c.vmPath());
                }
            }
            before.put("preexisting", preexisting);
            Journal j = journal(hash, with, before);

            int copied = 0, skipped = 0;
            long bytes = 0;
            // Every file is looked at on every try: comparing SHA-256 makes the ones already done quick to skip.
            List<String> done = new ArrayList<>();
            for (int i = 0; i < plan.size(); i++) {
                Copy c = plan.get(i);
                if (c.from() == null) {
                    throw ApplicationFailure.newNonRetryableFailure("files: " + c.source() + " isn't in the file store ("
                            + i + " of " + plan.size() + " files are in place; Resume copies the rest once it's there)", "NotFound");
                }
                TargetStore.CopyOutcome o = store.copy(c.from(), c.to());
                if (o.outcome().equals("copied")) copied++;
                else skipped++;
                bytes += o.bytes();
                done.add(c.vmPath());
                heartbeat(i);
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("to", to);
            out.put("files", done);
            out.put("copied", copied);
            out.put("alreadyThere", skipped);
            out.put("leftoversRemoved", leftovers);
            out.put("bytes", bytes);
            out.put("preexisting", j.before().get("preexisting"));
            return new ActionResult(out, copied + " copied, " + skipped + " already there"
                    + (leftovers > 0 ? ", " + leftovers + " half-copied file(s) from an earlier try removed" : ""));
        } catch (IOException e) {
            throw ApplicationFailure.newFailure("Copy failed: " + e.getMessage(), "IOError");
        }
    }

    /** Source and destination of every file; from = null for a source that isn't there (when allowMissing). */
    private List<Copy> plan(String hash, Map<String, Object> with, boolean allowMissing) throws IOException {
        String to = text(with.get("to"));
        if (to == null) throw ApplicationFailure.newNonRetryableFailure("files.copy needs 'to'", "InvalidStep");
        List<String> sources = new ArrayList<>();
        Object raw = with.get("files");
        if (raw instanceof List<?> l) l.forEach(x -> sources.add(String.valueOf(x)));
        else if (raw != null) sources.add(String.valueOf(raw));
        if (sources.isEmpty()) throw ApplicationFailure.newNonRetryableFailure("files.copy needs at least one file", "InvalidStep");
        String root = to.endsWith("/") ? to : to + "/";
        List<Copy> plan = new ArrayList<>();
        for (String s : sources) {
            Path src;
            try {
                src = store.source(s);
            } catch (IllegalArgumentException e) {
                throw ApplicationFailure.newNonRetryableFailure(e.getMessage(), "InvalidStep");
            }
            if (Files.isDirectory(src)) {
                // A folder: everything in it, keeping the layout under 'to'.
                try (Stream<Path> w = Files.walk(src)) {
                    for (Path f : w.filter(Files::isRegularFile).sorted().toList()) {
                        String rel = src.relativize(f).toString().replace('\\', '/');
                        plan.add(new Copy(s, f, store.onVm(hash, root + rel), root + rel));
                    }
                }
            } else {
                String name = src.getFileName().toString();
                Path from = Files.isRegularFile(src) ? src : null;
                if (from == null && !allowMissing) continue;
                plan.add(new Copy(s, from, store.onVm(hash, root + name), root + name));
            }
        }
        return plan;
    }

    // ------------------------------------------------------------------ config.apply

    @Override
    public ActionResult applyConfig(Map<String, Object> with) {
        String hash = requireRunning(text(with.get("vm")));
        if (!(with.get("settings") instanceof Map<?, ?> raw)) {
            throw ApplicationFailure.newNonRetryableFailure("config.apply needs settings: a map of names to values", "InvalidStep");
        }
        Map<String, Object> want = new LinkedHashMap<>();
        raw.forEach((k, v) -> want.put(String.valueOf(k), v));
        try {
            Map<String, Object> current = store.readConfig(hash);
            Map<String, Object> previous = new LinkedHashMap<>();
            for (String k : want.keySet()) previous.put(k, current.containsKey(k) ? current.get(k) : null);
            Journal j = journal(hash, with, Map.of("previous", previous));
            List<String> changed = new ArrayList<>();
            for (Map.Entry<String, Object> e : want.entrySet()) {
                if (!Objects.equals(current.get(e.getKey()), e.getValue())) {
                    changed.add(e.getKey());
                    current.put(e.getKey(), e.getValue());
                }
            }
            if (!changed.isEmpty()) store.writeConfig(hash, current);
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("changed", changed);
            out.put("unchanged", want.size() - changed.size());
            out.put("previous", j.before().get("previous"));
            return new ActionResult(out, changed.isEmpty() ? "already set" : "set " + String.join(", ", changed));
        } catch (IOException e) {
            throw ApplicationFailure.newFailure("Writing the configuration failed: " + e.getMessage(), "IOError");
        }
    }

    // ------------------------------------------------------------------ check.until

    @Override
    public Map<String, Object> probe(String specHash) {
        VmRecord r = registry.get(specHash);
        Map<String, Object> p = new LinkedHashMap<>();
        boolean running = r != null && "RUNNING".equals(r.state());
        VmLifecycle l = r == null ? null : r.lifecycle();
        String power = l == null ? (running ? "ON" : "OFF") : l.power();
        p.put("state", r == null ? "UNKNOWN" : r.state());
        p.put("reachable", running && "ON".equals(power));
        p.put("power", power);
        p.put("vcpu", l != null ? l.vcpu() : r != null ? r.spec().vcpu() : 0);
        p.put("memoryGiB", l != null ? l.memoryGiB() : r != null ? r.spec().memoryGiB() : 0);
        try {
            p.put("tools", running ? new ArrayList<>(store.installedTools(specHash).keySet()) : List.of());
            p.put("files", running ? store.fileCount(specHash) : 0);
            p.put("config", running ? store.readConfig(specHash) : Map.of());
        } catch (IOException e) {
            throw ApplicationFailure.newFailure("Couldn't look at the VM: " + e.getMessage(), "IOError");
        }
        return p;
    }

    // ------------------------------------------------------------------ undo

    @Override
    @SuppressWarnings("unchecked")
    public String undo(String action, Map<String, Object> with, Map<String, Object> output, String actor) {
        try {
            switch (action) {
                case "vm.create" -> {
                    if (output == null || output.get("specHash") == null) return "nothing to remove (the build rolled itself back)";
                    String hash = String.valueOf(output.get("specHash"));
                    try {
                        life(hash).decommission(actor, "catalog run torn down");
                        TargetStore.deleteTree(store.target(hash));
                        return "removed " + output.get("vmId");
                    } catch (WorkflowNotFoundException e) {
                        VmRecord r = registry.get(hash);
                        return r == null || !"RUNNING".equals(r.state()) ? "already gone" : "no lifecycle to remove it with; remove "
                                + output.get("vmId") + " by hand";
                    } catch (WorkflowUpdateException e) {
                        String m = rootMessage(e);
                        if (m.contains("already") || m.contains("DECOMMISSION")) return "already removed";
                        throw ApplicationFailure.newFailure("The VM refused to be removed: " + m, "UndoFailed");
                    }
                }
                case "vm.resize" -> {
                    if (output == null || !Boolean.TRUE.equals(output.get("changed"))) return "size wasn't changed";
                    String hash = text(with.get("vm"));
                    int v = requireInt(output.get("previousVcpu"), "previousVcpu");
                    int m = requireInt(output.get("previousMemoryGiB"), "previousMemoryGiB");
                    VmLifecycle now = lifecycle(life(hash), hash);
                    if (now.vcpu() == v && now.memoryGiB() == m) return "already back to " + v + " vCPU / " + m + " GiB";
                    life(hash).resize(actor, v, m);
                    return "back to " + v + " vCPU / " + m + " GiB";
                }
                case "vm.power" -> {
                    if (output == null || !Boolean.TRUE.equals(output.get("changed"))) return "power wasn't changed";
                    String hash = text(with.get("vm"));
                    boolean on = Boolean.TRUE.equals(output.get("previousOn"));
                    if ("ON".equals(lifecycle(life(hash), hash).power()) == on) return "already " + (on ? "on" : "off");
                    life(hash).power(actor, on);
                    return "powered " + (on ? "on" : "off") + " again";
                }
                case "tools.stage" -> {
                    String hash = text(with.get("vm"));
                    String bundle = text(with.get("bundle"));
                    Journal j = readJournal(hash, with);
                    String previous = j == null ? null : text(j.before().get("previousVersion"));
                    TargetStore.deleteTree(store.toolDir(hash, bundle));
                    String note = "removed " + bundle;
                    if (previous != null && !previous.equals(text(with.get("version")))) {
                        Path src = store.bundleSource(bundle, previous);
                        if (Files.isDirectory(src)) {
                            install(hash, bundle, previous, src);
                            note = "put " + bundle + " " + previous + " back";
                        } else {
                            note += " (the earlier version " + previous + " isn't in the file store to put back)";
                        }
                    }
                    dropJournal(hash, with);
                    return note;
                }
                case "files.copy" -> {
                    String hash = text(with.get("vm"));
                    Journal j = readJournal(hash, with);
                    List<String> keep = j == null ? List.of() : (List<String>) j.before().getOrDefault("preexisting", List.of());
                    int removed = 0;
                    for (Copy c : plan(hash, with, true)) {
                        if (keep.contains(c.vmPath())) continue;
                        if (Files.deleteIfExists(c.to())) removed++;
                        Files.deleteIfExists(c.to().resolveSibling(c.to().getFileName() + TargetStore.PART));
                    }
                    dropJournal(hash, with);
                    return "deleted " + removed + " file(s)" + (keep.isEmpty() ? "" : ", kept " + keep.size() + " that were there before");
                }
                case "config.apply" -> {
                    String hash = text(with.get("vm"));
                    Journal j = readJournal(hash, with);
                    if (j == null) return "nothing was changed";
                    Map<String, Object> previous = (Map<String, Object>) j.before().getOrDefault("previous", Map.of());
                    Map<String, Object> current = store.readConfig(hash);
                    previous.forEach((k, v) -> {
                        if (v == null) current.remove(k);
                        else current.put(k, v);
                    });
                    store.writeConfig(hash, current);
                    dropJournal(hash, with);
                    return "put back " + previous.keySet();
                }
                case "blueprint.deploy" -> {
                    String id = output == null ? null : text(output.get("deploymentId"));
                    if (id == null) {
                        // Failed before the request was answered: look it up by name in case it was made.
                        id = automation().client().findDeployment(text(with.get("name"))).orElse(null);
                        if (id == null) return "nothing was deployed";
                    }
                    automation().client().deleteDeployment(id);
                    for (int i = 0; i < 120; i++) {
                        Map<String, Object> st = automation().blueprintStatus(id);
                        if ("FAILED".equals(st.get("state")) && String.valueOf(st.get("detail")).contains("has no deployment")) {
                            return "removed deployment " + id;
                        }
                        if ("DELETE_FAILED".equals(st.get("status"))) {
                            throw ApplicationFailure.newFailure("VCF Automation couldn't remove deployment " + id + ": " + st.get("detail"), "UndoFailed");
                        }
                        Activity.getExecutionContext().heartbeat(st.get("status"));
                        try {
                            Thread.sleep(15_000);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                            break;
                        }
                    }
                    throw ApplicationFailure.newFailure("Deployment " + id + " is still being removed after 30 minutes", "UndoFailed");
                }
                default -> {
                    return "nothing to undo";
                }
            }
        } catch (IOException e) {
            throw ApplicationFailure.newFailure("Undo of " + action + " failed: " + e.getMessage(), "IOError");
        }
    }

    // ------------------------------------------------------------------ records

    @Override
    public void saveRun(String workflowId, String runId, String definition, int version, String classification,
                        String requestedBy, String state, boolean finished) {
        jdbc.sql("""
                INSERT INTO catalog_run (workflow_id, run_id, definition, version, classification, requested_by, state, finished_at)
                VALUES (:wf, :run, :def, :ver, :cls, :by, :state, CASE WHEN :fin THEN now() END)
                ON CONFLICT (workflow_id, run_id) DO UPDATE
                   SET state = EXCLUDED.state, updated_at = now(),
                       finished_at = COALESCE(catalog_run.finished_at, EXCLUDED.finished_at)
                """)
                .param("wf", workflowId).param("run", runId).param("def", definition).param("ver", version)
                .param("cls", classification).param("by", requestedBy).param("state", state).param("fin", finished)
                .update();
    }

    @Override
    public void logDecision(String actor, String action, String resource, boolean allowed, String policy, String reason,
                            String classification) {
        decisions.record(actor, null, action, resource, allowed, policy, reason, classification);
    }

    // ------------------------------------------------------------------ journal

    /** What was there before a step's first try. Written once; later tries read it back. */
    record Journal(Map<String, Object> before) {}

    private Journal journal(String hash, Map<String, Object> with, Map<String, Object> beforeNow) throws IOException {
        Journal existing = readJournal(hash, with);
        if (existing != null) return existing;
        Path f = journalFile(hash, with);
        Files.createDirectories(f.getParent());
        Path part = f.resolveSibling(f.getFileName() + TargetStore.PART);
        Files.writeString(part, json.writeValueAsString(beforeNow), StandardCharsets.UTF_8);
        Files.move(part, f, java.nio.file.StandardCopyOption.REPLACE_EXISTING, java.nio.file.StandardCopyOption.ATOMIC_MOVE);
        return new Journal(beforeNow);
    }

    private Journal readJournal(String hash, Map<String, Object> with) throws IOException {
        Path f = journalFile(hash, with);
        if (!Files.isRegularFile(f)) return null;
        return new Journal(json.readValue(f.toFile(), new TypeReference<LinkedHashMap<String, Object>>() {}));
    }

    private void dropJournal(String hash, Map<String, Object> with) throws IOException {
        Files.deleteIfExists(journalFile(hash, with));
    }

    private Path journalFile(String hash, Map<String, Object> with) {
        String key = text(with.get(STEP_KEY));
        if (key == null) key = "manual";
        return store.target(hash).resolve("journal").resolve(sha(key).substring(0, 32) + ".json");
    }

    // ------------------------------------------------------------------ helpers

    private VmLifecycleWorkflow life(String hash) {
        store.target(hash);   // checks it's a spec hash
        return client.newWorkflowStub(VmLifecycleWorkflow.class, VmIdentity.lifecycleWorkflowId(hash));
    }

    private VmLifecycle lifecycle(VmLifecycleWorkflow life, String hash) {
        try {
            return life.status();
        } catch (WorkflowNotFoundException e) {
            throw ApplicationFailure.newNonRetryableFailure("The VM " + hash.substring(0, 12)
                    + "… isn't running (it has no lifecycle)", "NotFound");
        }
    }

    private String requireRunning(String hash) {
        try {
            store.target(hash);
        } catch (IllegalArgumentException e) {
            throw ApplicationFailure.newNonRetryableFailure(e.getMessage(), "InvalidStep");
        }
        VmRecord r = registry.get(hash);
        if (r == null || !"RUNNING".equals(r.state())) {
            throw ApplicationFailure.newNonRetryableFailure("The VM " + hash.substring(0, 12) + "… isn't running"
                    + (r == null ? "" : " (it is " + r.state() + ")"), "NotFound");
        }
        if (r.lifecycle() != null && "OFF".equals(r.lifecycle().power())) {
            throw ApplicationFailure.newFailure("The VM " + r.spec().name() + " is powered off", "Unreachable");
        }
        return hash;
    }

    private static void heartbeat(Object progress) {
        try {
            Activity.getExecutionContext().heartbeat(progress);
        } catch (IllegalStateException | NullPointerException notInActivity) {
            // called outside an activity (tests): nothing to report to
        }
    }

    private static String rootMessage(Throwable e) {
        Throwable t = e;
        while (t.getCause() != null) t = t.getCause();
        return t instanceof ApplicationFailure af ? af.getOriginalMessage() : t.getMessage();
    }

    static String text(Object o) {
        if (o == null) return null;
        String s = String.valueOf(o).trim();
        return s.isEmpty() ? null : s;
    }

    private static String orElse(String s, String dflt) {
        return s == null ? dflt : s;
    }

    private static Integer integer(Object o, String what, List<String> problems) {
        if (o == null || (o instanceof String s && s.isBlank())) return null;
        if (o instanceof Number n) return n.intValue();
        try {
            return Integer.parseInt(String.valueOf(o).trim());
        } catch (NumberFormatException e) {
            problems.add(what + " must be a whole number, not '" + o + "'");
            return null;
        }
    }

    private static int requireInt(Object o, String what) {
        List<String> p = new ArrayList<>();
        Integer v = integer(o, what, p);
        if (v == null) throw ApplicationFailure.newNonRetryableFailure(what + " must be a whole number", "InvalidStep");
        return v;
    }

    static String sha(String s) {
        try {
            return HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
