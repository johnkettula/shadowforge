package com.example.vmintent.workflow;

import com.example.vmintent.spec.SpecCanonicalizer;
import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.LinkOrder;
import com.example.vmintent.workflow.Models.ProviderPlan;
import com.example.vmintent.workflow.Models.ReconcileRequest;
import com.example.vmintent.workflow.Models.VmResult;
import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowFailedException;
import io.temporal.client.WorkflowOptions;
import io.temporal.client.WorkflowStub;
import io.temporal.testing.TestWorkflowEnvironment;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The build workflow sends the cloud the name in ReconcileRequest.cloudName (null = the name asked
 * for), while the VM record and the audit trail keep the name the user asked for.
 */
class CloudNameTest {

    private TestWorkflowEnvironment env;
    private SpecCloud cloud;
    private SpecRecords records;
    private TestFakes.FakeLink link;

    /** A FakeCloud that remembers the name of every spec it is asked to plan or create. */
    static class SpecCloud extends TestFakes.FakeCloud {
        final List<String> planned = new CopyOnWriteArrayList<>();
        final List<String> createdNames = new CopyOnWriteArrayList<>();

        @Override
        public ProviderPlan plan(VmSpec spec) {
            planned.add(spec.name());
            return super.plan(spec);
        }

        @Override
        public String createVm(VmSpec spec, ProviderPlan plan, String key) {
            createdNames.add(spec.name());
            return super.createVm(spec, plan, key);
        }
    }

    /** FakeRecords that also remembers the name of every spec saved to the VM record. */
    static class SpecRecords extends TestFakes.FakeRecords {
        final List<String> savedNames = new CopyOnWriteArrayList<>();

        @Override
        public void save(String specHash, VmSpec spec, String st, String detail, VmResult result) {
            savedNames.add(spec.name());
            super.save(specHash, spec, st, detail, result);
        }
    }

    @BeforeEach
    void setUp() {
        env = TestWorkflowEnvironment.newInstance();
        cloud = new SpecCloud();
        records = new SpecRecords();
        link = new TestFakes.FakeLink();
        link.oneWay.add("azure");
        link.client = env.getWorkflowClient();
        TestFakes.startWorkers(env, cloud, records, link);
    }

    @AfterEach
    void tearDown() {
        env.close();
    }

    @Test
    void theCloudGetsTheCloudNameAndTheRecordsKeepTheAskedForName() {
        VmSpec spec = TestFakes.spec("web-01", "aws", 30);
        String hash = SpecCanonicalizer.hash(spec);
        VmResult vm = build(hash).reconcile(new ReconcileRequest(spec, hash, "jdoe", "req-a", "web-01-test"));

        assertEquals(List.of("web-01-test"), cloud.planned);
        assertEquals(List.of("web-01-test"), cloud.createdNames);
        assertEquals("web-01-test", cloud.nameById.get(vm.vmId()));
        assertEquals("RUNNING", records.state.get(hash));
        assertFalse(records.savedNames.isEmpty());
        assertTrue(records.savedNames.stream().allMatch("web-01"::equals), "saved as " + records.savedNames);
        assertTrue(records.events.stream().noneMatch(e -> e.contains("web-01-test")), "audit: " + records.events);
    }

    @Test
    void noCloudNameMeansTheAskedForName() {
        VmSpec spec = TestFakes.spec("web-01", "aws", 30);
        String hash = SpecCanonicalizer.hash(spec);
        VmResult vm = build(hash).reconcile(new ReconcileRequest(spec, hash, "jdoe", "req-b", null));

        assertEquals(List.of("web-01"), cloud.planned);
        assertEquals(List.of("web-01"), cloud.createdNames);
        assertEquals("web-01", cloud.nameById.get(vm.vmId()));
        assertTrue(records.savedNames.stream().allMatch("web-01"::equals), "saved as " + records.savedNames);
    }

    @Test
    void aFailedBuildRollsBackTheVmMadeUnderTheCloudName() {
        cloud.failNames.add("web-01-test");   // boots under its cloud name, then fails
        VmSpec spec = TestFakes.spec("web-01", "aws", 30);
        String hash = SpecCanonicalizer.hash(spec);
        assertThrows(WorkflowFailedException.class,
                () -> build(hash).reconcile(new ReconcileRequest(spec, hash, "jdoe", "req-c", "web-01-test")));

        assertEquals(1, cloud.deleted.size(), "the VM it made was deleted");
        String deleted = cloud.deleted.iterator().next();
        assertEquals("web-01-test", cloud.nameById.get(deleted));
        assertEquals("FAILED", records.state.get(hash));
        assertTrue(records.savedNames.stream().allMatch("web-01"::equals), "saved as " + records.savedNames);
    }

    @Test
    void theOneWayRouteOrdersAndUndoesUnderTheCloudName() {
        link.autoAnswer = false;   // no answer comes, so the build is undone by key
        VmSpec spec = TestFakes.spec("web-01", "azure", 30);
        String hash = SpecCanonicalizer.hash(spec);
        VmReconcileWorkflow wf = build(hash);
        WorkflowClient.start(wf::reconcile, new ReconcileRequest(spec, hash, "jdoe", "req-d", "web-01-test"));
        assertThrows(WorkflowFailedException.class, () -> WorkflowStub.fromTyped(wf).getResult(VmResult.class));

        assertEquals(2, link.sent.size());
        LinkOrder create = link.sent.get(0);
        LinkOrder undo = link.sent.get(1);
        assertEquals("CREATE", create.type());
        assertEquals("web-01-test", create.spec().name());
        assertEquals("DELETE", undo.type());
        assertEquals("web-01-test", undo.spec().name());
        assertTrue(records.savedNames.stream().allMatch("web-01"::equals), "saved as " + records.savedNames);
    }

    private VmReconcileWorkflow build(String hash) {
        return env.getWorkflowClient().newWorkflowStub(VmReconcileWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue(TaskQueues.INTENT).setWorkflowId("vm-" + hash).build());
    }
}
