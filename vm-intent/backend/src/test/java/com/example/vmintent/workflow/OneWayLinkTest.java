package com.example.vmintent.workflow;

import com.example.vmintent.spec.SpecCanonicalizer;
import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.LinkOrder;
import com.example.vmintent.workflow.Models.ReconcileRequest;
import com.example.vmintent.workflow.Models.VmLifecycle;
import com.example.vmintent.workflow.Models.VmResult;
import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowFailedException;
import io.temporal.client.WorkflowOptions;
import io.temporal.client.WorkflowStub;
import io.temporal.testing.TestWorkflowEnvironment;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Clouds behind the one-way link: the workflow sends an order and waits for domain 3's answer
 * (the linkReply signal). FakeLink plays domain 3.
 */
class OneWayLinkTest {

    private TestWorkflowEnvironment env;
    private TestFakes.FakeCloud cloud;
    private TestFakes.FakeRecords records;
    private TestFakes.FakeLink link;

    @BeforeEach
    void setUp() {
        env = TestWorkflowEnvironment.newInstance();
        cloud = new TestFakes.FakeCloud();
        records = new TestFakes.FakeRecords();
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
    void buildsAndChangesAVmThroughDomain3() {
        VmSpec spec = TestFakes.spec("remote", "azure", 30);
        String hash = SpecCanonicalizer.hash(spec);
        VmResult vm = reconcile(spec, hash).reconcile(new ReconcileRequest(spec, hash, "jdoe", "req-1"));

        assertTrue(vm.vmId().startsWith("d3-"), "the VM ID came back from domain 3");
        assertEquals("172.20.0.9", vm.ipAddress());
        assertEquals(0, cloud.created.get(), "the cloud API wasn't called from here");
        LinkOrder order = link.sent.get(0);
        assertEquals("CREATE", order.type());
        assertEquals("vm-" + hash, order.replyTo());
        assertEquals(hash, order.specHash());
        assertTrue(order.idempotencyKey().startsWith(hash + "-"), "one key per build: " + order.idempotencyKey());
        assertEquals("Standard_B2s", order.plan().nativeSize(), "the plan was worked out here");

        LifecycleWorkflowTest.eventually(() -> records.lifecycles.containsKey(hash), "lifecycle started");
        VmLifecycleWorkflow life = env.getWorkflowClient().newWorkflowStub(VmLifecycleWorkflow.class,
                VmLifecycleWorkflowImpl.workflowId(hash));
        VmLifecycle s = life.resize("jdoe", 4, 16);
        assertEquals(4, s.vcpu());
        assertEquals(1, link.count("RESIZE"));
        assertEquals("life-" + hash, link.sent.get(link.sent.size() - 1).replyTo());
        life.decommission("jdoe", "done");
        assertEquals(1, link.count("DELETE"));
        assertTrue(cloud.calls.isEmpty());
    }

    @Test
    void noAnswerInTimeRollsBackByKey() {
        link.autoAnswer = false;   // the return link is down
        VmSpec spec = TestFakes.spec("silent", "azure", 30);
        String hash = SpecCanonicalizer.hash(spec);
        VmReconcileWorkflow wf = reconcile(spec, hash);
        WorkflowClient.start(wf::reconcile, new ReconcileRequest(spec, hash, "jdoe", "req-2"));

        // The workflow waits up to 60 minutes (FakeLink's route) for the answer; the test server skips ahead.
        WorkflowFailedException e = assertThrows(WorkflowFailedException.class,
                () -> WorkflowStub.fromTyped(wf).getResult(VmResult.class));
        assertTrue(VmReconcileWorkflowImpl.reason(e).contains("No answer from domain 3"), VmReconcileWorkflowImpl.reason(e));
        assertEquals(1, link.count("DELETE"), "an undo order went out, by idempotency key");
        assertEquals(link.sent.get(0).idempotencyKey(), link.sent.get(1).idempotencyKey(), "the same build's key");
        assertEquals("FAILED", records.state.get(hash));
        assertTrue(records.has("ROLLED_BACK"));
    }

    @Test
    void aRefusalFromDomain3RollsBack() {
        VmSpec spec = TestFakes.spec("fail-remote", "azure", 30);
        String hash = SpecCanonicalizer.hash(spec);
        VmReconcileWorkflow wf = reconcile(spec, hash);
        WorkflowFailedException e = assertThrows(WorkflowFailedException.class,
                () -> wf.reconcile(new ReconcileRequest(spec, hash, "jdoe", "req-3")));
        assertTrue(VmReconcileWorkflowImpl.reason(e).contains("Domain 3 refused CREATE"), VmReconcileWorkflowImpl.reason(e));
        assertEquals(1, link.count("DELETE"));
    }

    @Test
    void otherCloudsAreStillCalledDirectly() {
        VmSpec spec = TestFakes.spec("local", "aws", 30);
        String hash = SpecCanonicalizer.hash(spec);
        reconcile(spec, hash).reconcile(new ReconcileRequest(spec, hash, "jdoe", "req-4"));
        assertEquals(1, cloud.created.get());
        assertTrue(link.sent.isEmpty());
    }

    private VmReconcileWorkflow reconcile(VmSpec spec, String hash) {
        return env.getWorkflowClient().newWorkflowStub(VmReconcileWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue(TaskQueues.INTENT).setWorkflowId("vm-" + hash).build());
    }
}
