package com.example.vmintent.workflow;

import com.example.vmintent.spec.SpecCanonicalizer;
import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.IntentRequest;
import com.example.vmintent.workflow.Models.ReconcileRequest;
import com.example.vmintent.workflow.Models.RequestStatus;
import com.example.vmintent.workflow.Models.VmLifecycle;
import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowOptions;
import io.temporal.client.WorkflowStub;
import io.temporal.testing.TestWorkflowEnvironment;
import io.temporal.testing.WorkflowReplayer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Duration;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The scenarios behind the histories recorded in the repository. They run in every build as
 * ordinary tests; with -Dhistories.record=true they also save the history, if it isn't saved yet,
 * for ReplayTest to replay against later versions of the code.
 */
class RecordedHistoriesTest {

    private TestWorkflowEnvironment env;
    private TestFakes.FakeCloud cloud;
    private TestFakes.FakeRecords records;

    @BeforeEach
    void setUp() {
        env = TestWorkflowEnvironment.newInstance();
        cloud = new TestFakes.FakeCloud();
        records = new TestFakes.FakeRecords();
        TestFakes.startWorkers(env, cloud, records, new TestFakes.FakeLink());
    }

    @AfterEach
    void tearDown() {
        env.close();
    }

    /** intent-v2-multi-existing: two VMs, one already there, the other built by a vm- child workflow. */
    @Test
    void multiVmRequestWithOneVmThatAlreadyExisted() throws Exception {
        // First app-01 is built and app-02 fails and is rolled back, so only app-01 exists.
        cloud.failNames.add("app-02");
        IntentWorkflow first = start("req-multi-first", "2 small ubuntu servers on aws called app");
        assertEquals("PARTIAL", WorkflowStub.fromTyped(first).getResult(RequestStatus.class).state());
        cloud.failNames.clear();

        IntentWorkflow wf = start("req-multi-existing", "2 small ubuntu servers on aws called app");
        RequestStatus done = WorkflowStub.fromTyped(wf).getResult(RequestStatus.class);
        assertEquals("COMPLETED", done.state(), done.message());
        assertEquals("All 2 VMs are running (1 already existed: app-01).", done.message());
        assertEquals(1, done.vms().size());
        assertEquals("app-02", cloud.nameById.get(done.vms().get(0).vmId()));

        WorkflowReplayer.replayWorkflowExecution(
                env.getWorkflowClient().fetchHistory("req-multi-existing"), IntentWorkflowImpl.class);
        HistoryRecorder.record(env.getWorkflowClient(), "req-multi-existing", "intent-v2-multi-existing");
    }

    /** lifecycle-v1-renewed: a VM's lifecycle that took a renew update, captured while still running. */
    @Test
    void lifecycleRenewed() throws Exception {
        VmSpec spec = TestFakes.spec("renewed", "aws", 10);
        String hash = SpecCanonicalizer.hash(spec);
        VmReconcileWorkflow build = env.getWorkflowClient().newWorkflowStub(VmReconcileWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue(TaskQueues.INTENT).setWorkflowId("vm-" + hash).build());
        build.reconcile(new ReconcileRequest(spec, hash, "jdoe", "req-renewed"));
        records.state.put(hash, "RUNNING");
        LifecycleWorkflowTest.eventually(() -> records.lifecycles.containsKey(hash), "the lifecycle workflow started");

        String id = VmLifecycleWorkflowImpl.workflowId(hash);
        assertTrue(id.startsWith("life-"), id);
        VmLifecycleWorkflow life = env.getWorkflowClient().newWorkflowStub(VmLifecycleWorkflow.class, id);
        long firstExpiry = life.status().expiresAtMs();
        env.sleep(Duration.ofDays(8));
        assertTrue(life.status().warned());
        VmLifecycle after = life.renew("jdoe", 7);
        assertEquals(firstExpiry + Duration.ofDays(7).toMillis(), after.expiresAtMs());
        assertEquals("ACTIVE", after.state());

        WorkflowReplayer.replayWorkflowExecution(env.getWorkflowClient().fetchHistory(id), VmLifecycleWorkflowImpl.class);
        HistoryRecorder.record(env.getWorkflowClient(), id, "lifecycle-v1-renewed");
    }

    /** Starts a request and confirms the spec it shows. */
    private IntentWorkflow start(String id, String text) {
        IntentWorkflow wf = env.getWorkflowClient().newWorkflowStub(IntentWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue(TaskQueues.INTENT).setWorkflowId(id).build());
        WorkflowClient.start(wf::run, new IntentRequest(text, "jdoe", "test", false));
        LifecycleWorkflowTest.eventually(() -> {
            try {
                return "AWAITING_CONFIRMATION".equals(wf.status().state());
            } catch (Exception e) {
                return false;
            }
        }, "state AWAITING_CONFIRMATION");
        wf.confirm();
        return wf;
    }
}
