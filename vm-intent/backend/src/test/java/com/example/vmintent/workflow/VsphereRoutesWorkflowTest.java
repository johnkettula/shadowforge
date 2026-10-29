package com.example.vmintent.workflow;

import com.example.vmintent.catalog.CatalogActivitiesImpl;
import com.example.vmintent.catalog.CatalogModels.Classification;
import com.example.vmintent.catalog.CatalogModels.Definition;
import com.example.vmintent.catalog.CatalogModels.RunRequest;
import com.example.vmintent.catalog.CatalogModels.RunStatus;
import com.example.vmintent.catalog.RunInputs;
import com.example.vmintent.catalog.TargetStore;
import com.example.vmintent.provider.ProviderActivities;
import com.example.vmintent.provider.VsphereProvider;
import com.example.vmintent.provider.vsphere.VsphereTestKit;
import com.example.vmintent.spec.SpecCanonicalizer;
import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.ReconcileRequest;
import com.example.vmintent.workflow.Models.VmResult;
import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowFailedException;
import io.temporal.client.WorkflowOptions;
import io.temporal.testing.TestWorkflowEnvironment;
import io.temporal.worker.Worker;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The real build and catalog workflows, with vSphere routed to the mock vCenter 9 (dc1) and the mock
 * VCF Automation 9 (dc2): what a vm-intent user sees end to end.
 */
class VsphereRoutesWorkflowTest {

    @TempDir
    Path tmp;

    private TestWorkflowEnvironment env;
    private VsphereTestKit kit;
    private CatalogRunWorkflowTest.SpecRecords records;

    @BeforeEach
    void setUp() throws Exception {
        kit = new VsphereTestKit();
        env = TestWorkflowEnvironment.newInstance();
        records = new CatalogRunWorkflowTest.SpecRecords();
        TargetStore store = new TargetStore(tmp.resolve("files").toString(), tmp.resolve("targets").toString());
        CatalogActivitiesImpl catalog = new CatalogActivitiesImpl(store, new CatalogRunWorkflowTest.FakeRegistry(records),
                env.getWorkflowClient(), null, null, kit.routes()) {
            @Override
            public void saveRun(String workflowId, String runId, String definition, int version, String classification,
                                String requestedBy, String state, boolean finished) {}

            @Override
            public void logDecision(String actor, String action, String resource, boolean allowed, String policy,
                                    String reason, String classification) {}
        };
        Worker intent = env.newWorker(TaskQueues.INTENT);
        intent.registerWorkflowImplementationTypes(CatalogRunWorkflowImpl.class, VmReconcileWorkflowImpl.class, VmLifecycleWorkflowImpl.class);
        intent.registerActivitiesImplementations(records, new TestFakes.FakeLink(), catalog);
        VsphereProvider vsphere = new VsphereProvider(null, kit.routes());
        env.newWorker(TaskQueues.VSPHERE).registerActivitiesImplementations(vsphere);
        env.newWorker(TaskQueues.VSPHERE_READ).registerActivitiesImplementations(vsphere);
        TestFakes.FakeCloud others = new TestFakes.FakeCloud();
        for (String p : TaskQueues.PROVIDERS) {
            if (p.equals("vsphere")) continue;
            ProviderActivities view = others.view(p);
            env.newWorker(TaskQueues.forProvider(p)).registerActivitiesImplementations(view);
            env.newWorker(TaskQueues.readQueue(p)).registerActivitiesImplementations(view);
        }
        env.start();
    }

    @AfterEach
    void tearDown() {
        env.close();
        kit.close();
    }

    private VmResult build(VmSpec spec) {
        String hash = SpecCanonicalizer.hash(spec);
        VmReconcileWorkflow wf = env.getWorkflowClient().newWorkflowStub(VmReconcileWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue(TaskQueues.INTENT).setWorkflowId("vm-" + hash).build());
        return wf.reconcile(new ReconcileRequest(spec, hash, "jdoe", "req-" + hash.substring(0, 6)));
    }

    @Test
    void dc1BuildsThroughVcenterFromTheContentLibraryTemplate() {
        kit.vcenter.autoBoot = true;
        VmResult r = build(new VmSpec("db-01", "vsphere", "dc1", 4, 16, "ubuntu", "24.04", 50, "ssd", "prod", 0, false));
        assertEquals("vcenter:dc1:db-01", r.vmId());
        assertTrue(r.ipAddress().startsWith("10.10.0."), r.ipAddress());
        assertTrue(r.nativeImage().contains("tpl-ubuntu-2404"), r.nativeImage());
        assertTrue(kit.vcenter.tagged.contains(kit.vcenter.idByName("db-01")), "tagged as vm-intent's");
    }

    @Test
    void aFailedCloneIsRolledBackAndTheBuildFailsWithVcentersReason() {
        kit.vcenter.failNextDeploy = "Insufficient resources in cluster Cluster-A";
        WorkflowFailedException e = assertThrows(WorkflowFailedException.class,
                () -> build(new VmSpec("big-01", "vsphere", "dc1", 64, 512, "ubuntu", "24.04", 500, "ssd", "prod", 0, false)));
        assertTrue(VmReconcileWorkflowImpl.reason(e).contains("Insufficient resources"), VmReconcileWorkflowImpl.reason(e));
        assertNull(kit.vcenter.byName("big-01"));
        assertTrue(records.has("ROLLED_BACK"));
    }

    @Test
    void dc2BuildsThroughAVcfAutomationBlueprint() {
        VmResult r = build(new VmSpec("app-01", "vsphere", "dc2", 2, 8, "ubuntu", "24.04", 50, "ssd", "test", 14, false));
        assertTrue(r.vmId().startsWith("vcfa:dep-"), r.vmId());
        assertEquals("10.20.0.10", r.ipAddress());
        assertTrue(r.nativeImage().contains("vm-intent-standard"), r.nativeImage());
        assertEquals("bp-1", kit.vcfa.byName("app-01").request.path("blueprintId").asText());
    }

    @Test
    void aFailedDeploymentIsRemovedByTheRollback() {
        kit.vcfa.failNames.add("app-02");
        assertThrows(WorkflowFailedException.class,
                () -> build(new VmSpec("app-02", "vsphere", "dc2", 2, 8, "ubuntu", "24.04", 50, "ssd", "test", 14, false)));
        assertTrue(kit.vcfa.calls.stream().anyMatch(c -> c.startsWith("DELETE /deployment/api/deployments/")), kit.vcfa.calls.toString());
    }

    @Test
    void aCatalogRunDeploysABlueprintAndTearDownRemovesIt() {
        Definition def = CatalogRunWorkflowTest.parse("""
                kind: Provisioning
                name: shop-stack
                version: 1
                inputs:
                  app: { type: string, required: true }
                steps:
                  - id: stack
                    action: blueprint.deploy
                    with:
                      blueprint: three-tier
                      name: "${ params.app + '-stack' }"
                      inputs: { size: medium, owner: "${ run.requestedBy }" }
                      everySeconds: 10
                  - id: fails
                    action: check.until
                    attempts: 1
                    with: { vm: nothing, until: "probe.reachable", everySeconds: 5, timeoutMinutes: 1 }
                """);
        RunInputs.Checked checked = RunInputs.check(def, Map.of("app", "shop"));
        String id = RunInputs.runId(def, checked.params());
        CatalogRunWorkflow wf = env.getWorkflowClient().newWorkflowStub(CatalogRunWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue(TaskQueues.INTENT).setWorkflowId(id).build());
        WorkflowClient.start(wf::run, new RunRequest(def, List.of(), checked.params(), "jdoe",
                new Classification("C3", "kept 3 years", 3), false));
        CatalogRunWorkflow run = env.getWorkflowClient().newWorkflowStub(CatalogRunWorkflow.class, id);
        RunStatus s = waitFor(run, "AWAITING_RECOVERY");
        assertEquals("DONE", s.steps().get(0).state(), s.history().toString());
        Map<String, Object> out = s.steps().get(0).output();
        assertEquals(List.of("10.20.0.10", "10.20.0.11", "10.20.0.12"), out.get("addresses"));
        assertEquals("three-tier", out.get("blueprint"));
        assertEquals("medium", kit.vcfa.byName("shop-stack").request.path("inputs").path("size").asText());
        assertEquals("jdoe", kit.vcfa.byName("shop-stack").request.path("inputs").path("owner").asText());

        run.teardown("jdoe", "not needed");
        s = waitFor(run, "TORN_DOWN", "TEARDOWN_INCOMPLETE");
        assertEquals("TORN_DOWN", s.state(), s.history().toString());
        assertNull(kit.vcfa.byName("shop-stack"), "the deployment was removed");
    }

    private RunStatus waitFor(CatalogRunWorkflow run, String... wanted) {
        Set<String> ok = Set.of(wanted);
        RunStatus s = null;
        for (int i = 0; i < 300; i++) {
            s = run.status();
            if (ok.contains(s.state())) return s;
            env.sleep(Duration.ofSeconds(10));
        }
        throw new AssertionError("still " + (s == null ? "?" : s.state() + ": " + s.message() + " " + s.history()));
    }
}
