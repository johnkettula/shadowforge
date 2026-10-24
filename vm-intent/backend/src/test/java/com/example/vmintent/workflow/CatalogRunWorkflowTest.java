package com.example.vmintent.workflow;

import com.example.vmintent.catalog.CatalogActivitiesImpl;
import com.example.vmintent.catalog.CatalogModels.Blueprint;
import com.example.vmintent.catalog.CatalogModels.Classification;
import com.example.vmintent.catalog.CatalogModels.Definition;
import com.example.vmintent.catalog.CatalogModels.RunRequest;
import com.example.vmintent.catalog.CatalogModels.RunStatus;
import com.example.vmintent.catalog.CatalogModels.StepState;
import com.example.vmintent.catalog.DefinitionParser;
import com.example.vmintent.catalog.RunInputs;
import com.example.vmintent.catalog.TargetStore;
import com.example.vmintent.provider.ProviderActivities;
import com.example.vmintent.provider.VmRegistry;
import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.VmLifecycle;
import com.example.vmintent.workflow.Models.VmRecord;
import com.example.vmintent.workflow.Models.VmResult;
import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowExecutionAlreadyStarted;
import io.temporal.client.WorkflowOptions;
import io.temporal.client.WorkflowStub;
import io.temporal.client.WorkflowUpdateException;
import io.temporal.testing.TestWorkflowEnvironment;
import io.temporal.worker.Worker;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Catalog runs: steps in order; a failed step stops the run and waits; Resume runs only the failed
 * step again and it picks up its own partial work; Tear down undoes everything; nobody deciding
 * within the wait tears it down. The real actions run against temporary folders.
 */
class CatalogRunWorkflowTest {

    static final Classification C3 = new Classification("C3", "Placeholder - kept 3 years", 3);

    @TempDir
    Path tmp;

    private TestWorkflowEnvironment env;
    private TestFakes.FakeCloud cloud;
    private SpecRecords records;
    private TargetStore store;
    private final List<String> decisions = new CopyOnWriteArrayList<>();
    private final Map<String, String> runStates = new ConcurrentHashMap<>();

    /** Remembers specs too, so the registry view below can answer like the real one. */
    static class SpecRecords extends TestFakes.FakeRecords {
        final Map<String, VmSpec> specs = new ConcurrentHashMap<>();

        @Override
        public void save(String specHash, VmSpec spec, String st, String detail, VmResult result) {
            specs.put(specHash, spec);
            super.save(specHash, spec, st, detail, result);
        }
    }

    /** VmRegistry backed by the fake records instead of Postgres. */
    static class FakeRegistry extends VmRegistry {
        final SpecRecords r;

        FakeRegistry(SpecRecords r) {
            super(null, null);
            this.r = r;
        }

        @Override
        public VmRecord get(String specHash) {
            String st = r.state.get(specHash);
            if (st == null) return null;
            VmLifecycle l = r.lifecycles.get(specHash);
            if (l != null && ("DECOMMISSIONED".equals(l.state()))) st = "DELETED";
            return new VmRecord(specHash, r.specs.get(specHash), st, null, r.results.get(specHash), null, l);
        }
    }

    @BeforeEach
    void setUp() throws Exception {
        env = TestWorkflowEnvironment.newInstance();
        cloud = new TestFakes.FakeCloud();
        records = new SpecRecords();
        store = new TargetStore(tmp.resolve("files").toString(), tmp.resolve("targets").toString());
        CatalogActivitiesImpl catalog = new CatalogActivitiesImpl(store, new FakeRegistry(records),
                env.getWorkflowClient(), null, null) {
            @Override
            public void saveRun(String workflowId, String runId, String definition, int version, String classification,
                                String requestedBy, String state, boolean finished) {
                runStates.put(workflowId, state);
            }

            @Override
            public void logDecision(String actor, String action, String resource, boolean allowed, String policy,
                                    String reason, String classification) {
                decisions.add(actor + " " + action + " " + (allowed ? "ALLOW" : "DENY") + " " + policy);
            }
        };
        Worker intent = env.newWorker(TaskQueues.INTENT);
        intent.registerWorkflowImplementationTypes(CatalogRunWorkflowImpl.class, VmReconcileWorkflowImpl.class,
                VmLifecycleWorkflowImpl.class);
        intent.registerActivitiesImplementations(records, new TestFakes.FakeLink(), catalog);
        for (String p : TaskQueues.PROVIDERS) {
            ProviderActivities view = cloud.view(p);
            env.newWorker(TaskQueues.forProvider(p)).registerActivitiesImplementations(view);
            env.newWorker(TaskQueues.readQueue(p)).registerActivitiesImplementations(view);
        }
        env.start();
    }

    @AfterEach
    void tearDown() {
        env.close();
    }

    // ------------------------------------------------------------------ the tests

    @Test
    void runsEveryStepInOrder() throws Exception {
        CatalogRunWorkflow run = start(webServer(), Map.of("app", "shop"));
        RunStatus s = waitFor(run, "COMPLETED");
        assertEquals(List.of("DONE", "DONE", "DONE", "DONE", "DONE"), states(s));
        String hash = (String) s.steps().get(0).output().get("specHash");
        Path vm = store.target(hash);
        assertTrue(Files.isRegularFile(vm.resolve("fs/srv/www/index.html")));
        assertTrue(Files.isRegularFile(vm.resolve("tools/nginx/.installed")));
        assertTrue(Files.readString(vm.resolve("config.json")).contains("\"app\" : \"shop\""));
        assertEquals("shop-web", records.specs.get(hash).name(), "the name came from ${ params.app + '-web' }");
        assertEquals("COMPLETED", runStates.get(s.runId()));
        assertTrue(records.has("RUN_COMPLETED"));
    }

    @Test
    void aFailedStepWaitsAndResumePicksUpItsOwnPartialWork() throws Exception {
        // The second file isn't in the store yet: the copy does the first three, then fails.
        CatalogRunWorkflow run = start(webServer(), Map.of("app", "blog", "extra", "late.txt"));
        RunStatus s = waitFor(run, "AWAITING_RECOVERY");
        assertEquals("site", s.failedStep());
        assertNotNull(s.recoveryDeadline());
        StepState failed = step(s, "site");
        assertEquals("FAILED", failed.state());
        assertTrue(failed.error().contains("late.txt isn't in the file store"), failed.error());
        String hash = (String) step(s, "create").output().get("specHash");
        Path www = store.target(hash).resolve("fs/srv/www");
        assertTrue(Files.exists(www.resolve("index.html")), "the files before the missing one are in place");

        // Someone puts the file in the store; and a half-copied file is left from a crash.
        Files.writeString(store.filesDir().resolve("late.txt"), "arrived late\n");
        Files.writeString(www.resolve("robots.txt.part"), "half a fi");

        run.resume("ops-anna", "the file is in the store now");
        s = waitFor(run, "COMPLETED");
        StepState site = step(s, "site");
        assertEquals("DONE", site.state());
        assertEquals(2, site.attempts());
        assertEquals(1, ((Number) site.output().get("copied")).intValue(), "only the missing file is copied");
        assertEquals(3, ((Number) site.output().get("alreadyThere")).intValue(), "the ones done before are skipped");
        assertEquals(1, ((Number) site.output().get("leftoversRemoved")).intValue(), "the .part file is cleaned up");
        assertFalse(Files.exists(www.resolve("robots.txt.part")));
        assertEquals(1, step(s, "create").attempts(), "steps before the failed one aren't run again");
        assertEquals(1, cloud.created.get(), "one VM, never a second");
        assertTrue(records.has("RUN_RESUMED ops-anna"));

        // Audit replay: today's code against the recorded history, with nothing done again.
        io.temporal.testing.WorkflowReplayer.replayWorkflowExecution(
                env.getWorkflowClient().fetchHistory(s.runId()), CatalogRunWorkflowImpl.class);
    }

    @Test
    void teardownUndoesEverythingNewestFirst() throws Exception {
        Path vmDirBefore = null;
        CatalogRunWorkflow run = start(webServer(), Map.of("app", "gone", "extra", "never.txt"));
        RunStatus s = waitFor(run, "AWAITING_RECOVERY");
        String hash = (String) step(s, "create").output().get("specHash");
        vmDirBefore = store.target(hash);
        assertTrue(Files.exists(vmDirBefore.resolve("fs/srv/www/index.html")));

        run.teardown("jdoe", "not needed after all");
        s = waitForEnd(run);
        assertEquals("TORN_DOWN", s.state(), s.message());
        assertEquals(List.of("UNDONE", "UNDONE", "UNDONE", "PENDING", "PENDING"), states(s));
        assertEquals("DECOMMISSIONED", records.lifecycles.get(hash).state(), "the VM was removed");
        assertFalse(Files.exists(vmDirBefore.resolve("fs/srv/www/index.html")), "partial files removed");
        assertTrue(s.history().stream().anyMatch(h -> h.contains("Undid site")));
        int site = indexOf(s.history(), "Undid site"), nginx = indexOf(s.history(), "Undid nginx"),
                create = indexOf(s.history(), "Undid create");
        assertTrue(site < nginx && nginx < create, "newest first: " + s.history());
    }

    @Test
    void nobodyDecidingWithinTheWaitTearsItDown() throws Exception {
        // The VM lives longer than the wait, so only the run's own 30-day timer matters here.
        Definition def = parse("""
                kind: Provisioning
                name: idle
                version: 1
                steps:
                  - id: create
                    action: vm.create
                    with: { provider: aws, region: us-east, os: ubuntu, env: test, ttlDays: 90 }
                  - id: site
                    action: files.copy
                    attempts: 1
                    with: { vm: "${ steps.create.specHash }", files: [never.txt], to: /srv }
                """);
        CatalogRunWorkflow run = start(def, Map.of());
        waitFor(run, "AWAITING_RECOVERY");
        env.sleep(Duration.ofDays(29));
        assertEquals("AWAITING_RECOVERY", run.status().state(), "still waiting after 29 days");
        RunStatus s = waitForEnd(run);   // lets the clock run on past 30 days
        assertEquals("TORN_DOWN", s.state());
        assertTrue(s.message().contains("system"), s.message());
        assertTrue(records.has("RUN_TEARDOWN_STARTED system nobody resumed or tore down the run within 30 days"));
    }

    @Test
    void approvalNeedsSomeoneElse() throws Exception {
        Definition def = parse("""
                kind: Provisioning
                name: approved
                version: 1
                inputs:
                  env: { type: string, default: prod }
                steps:
                  - id: ok
                    action: approval.wait
                    when: "params.env == 'prod'"
                    with: { message: "Go ahead?", approvers: [boss, deputy] }
                  - id: create
                    action: vm.create
                    with: { provider: aws, region: us-east, os: ubuntu, env: test, ttlDays: 3 }
                """);
        CatalogRunWorkflow run = start(def, Map.of());
        RunStatus s = waitFor(run, "AWAITING_APPROVAL");
        assertEquals(List.of("boss", "deputy"), s.approval().approvers());
        WorkflowUpdateException own = assertThrows(WorkflowUpdateException.class, () -> run.approve("jdoe", true, null));
        assertTrue(rootMessage(own).contains("someone else"), rootMessage(own));
        WorkflowUpdateException notListed = assertThrows(WorkflowUpdateException.class, () -> run.approve("mallory", true, null));
        assertTrue(rootMessage(notListed).contains("boss, deputy"));
        run.approve("boss", true, "CHG-1");
        s = waitFor(run, "COMPLETED");
        assertEquals("boss", step(s, "ok").output().get("approvedBy"));
        assertTrue(decisions.stream().anyMatch(d -> d.startsWith("boss run.approve ALLOW")));

        // Not prod: the approval step is skipped.
        CatalogRunWorkflow dev = start(def, Map.of("env", "dev"));
        s = waitFor(dev, "COMPLETED");
        assertEquals("SKIPPED", step(s, "ok").state());
    }

    @Test
    void blueprintRulesStopTheBuildBeforeAnythingHappens() throws Exception {
        Blueprint bp = DefinitionParser.parse("""
                kind: Blueprint
                name: small-only
                version: 1
                rules:
                  - name: at-most-four
                    check: "spec.vcpu <= 4"
                    message: At most 4 vCPU here.
                """, DefinitionParser.Context.lenient()).blueprint();
        Definition def = parse("""
                kind: Provisioning
                name: too-big
                version: 1
                blueprint: small-only
                steps:
                  - id: create
                    action: vm.create
                    with: { provider: aws, region: us-east, os: ubuntu, size: large, env: test, ttlDays: 3 }
                """);
        CatalogRunWorkflow run = start(def, Map.of(), List.of(bp));
        RunStatus s = waitFor(run, "AWAITING_RECOVERY");
        assertTrue(step(s, "create").error().contains("small-only/at-most-four: At most 4 vCPU here."), step(s, "create").error());
        assertEquals(1, step(s, "create").attempts(), "a rule failure isn't retried");
        assertEquals(0, cloud.created.get());
    }

    @Test
    void theSameInputsFindTheRunAlreadyGoing() throws Exception {
        Definition def = webServer();
        Map<String, Object> params = RunInputs.check(def, Map.of("app", "twin", "extra", "never.txt")).params();
        start(def, params);
        assertThrows(WorkflowExecutionAlreadyStarted.class, () -> start(def, params));
    }

    // ------------------------------------------------------------------ helpers

    /** Like the built-in web-server definition, with an optional extra file to copy. */
    static Definition webServer() {
        return parse("""
                kind: Provisioning
                name: web
                version: 1
                inputs:
                  app: { type: string, required: true }
                  extra: { type: string, default: "" }
                steps:
                  - id: create
                    action: vm.create
                    with:
                      name: "${ params.app + '-web' }"
                      provider: aws
                      region: us-east
                      os: ubuntu
                      size: small
                      env: test
                      ttlDays: 7
                  - id: nginx
                    action: tools.stage
                    with: { vm: "${ steps.create.specHash }", bundle: nginx, version: "1.27" }
                  - id: site
                    action: files.copy
                    attempts: 1
                    with:
                      vm: "${ steps.create.specHash }"
                      files: "${ params.extra == '' ? ['web'] : ['web', params.extra] }"
                      to: /srv/www
                  - id: settings
                    action: config.apply
                    with: { vm: "${ steps.create.specHash }", settings: { app: "${ params.app }", listen: 80 } }
                  - id: ready
                    action: check.until
                    with:
                      vm: "${ steps.create.specHash }"
                      until: "probe.reachable && 'nginx' in probe.tools && probe.files >= 3 && probe.config.app == params.app"
                      everySeconds: 5
                      timeoutMinutes: 2
                """);
    }

    static Definition parse(String yaml) {
        DefinitionParser.Result r = DefinitionParser.parse(yaml, DefinitionParser.Context.lenient());
        assertTrue(r.ok(), r.problems().toString());
        return r.definition();
    }

    private CatalogRunWorkflow start(Definition def, Map<String, Object> params) {
        return start(def, params, List.of());
    }

    private CatalogRunWorkflow start(Definition def, Map<String, Object> params, List<Blueprint> blueprints) {
        RunInputs.Checked checked = RunInputs.check(def, params);
        assertTrue(checked.problems().isEmpty(), checked.problems().toString());
        String id = RunInputs.runId(def, checked.params());
        CatalogRunWorkflow wf = env.getWorkflowClient().newWorkflowStub(CatalogRunWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue(TaskQueues.INTENT).setWorkflowId(id).build());
        WorkflowClient.start(wf::run, new RunRequest(def, blueprints, checked.params(), "jdoe", C3, false));
        return env.getWorkflowClient().newWorkflowStub(CatalogRunWorkflow.class, id);
    }

    /** Lets Temporal's clock run (builds wait on timers) until the run is in one of these states. */
    private RunStatus waitFor(CatalogRunWorkflow run, String... wanted) {
        Set<String> ok = Set.of(wanted);
        RunStatus s = null;
        for (int i = 0; i < 400; i++) {
            s = run.status();
            if (ok.contains(s.state())) return s;
            env.sleep(Duration.ofSeconds(5));
        }
        throw new AssertionError("still " + (s == null ? "?" : s.state() + ": " + s.message() + " " + s.history()));
    }

    private RunStatus waitForEnd(CatalogRunWorkflow run) {
        return WorkflowStub.fromTyped(run).getResult(RunStatus.class);
    }

    private static StepState step(RunStatus s, String id) {
        return s.steps().stream().filter(x -> x.id().equals(id)).findFirst().orElseThrow();
    }

    private static List<String> states(RunStatus s) {
        List<String> out = new ArrayList<>();
        s.steps().forEach(x -> out.add(x.state()));
        return out;
    }

    private static int indexOf(List<String> history, String text) {
        for (int i = 0; i < history.size(); i++) if (history.get(i).contains(text)) return i;
        return -1;
    }

    private static String rootMessage(Throwable e) {
        Throwable t = e;
        while (t.getCause() != null) t = t.getCause();
        return t.getMessage();
    }
}
