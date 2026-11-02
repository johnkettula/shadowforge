package com.example.vmintent.workflow;

import com.example.vmintent.workflow.Models.IntentRequest;
import com.example.vmintent.workflow.Models.RequestStatus;
import io.temporal.api.enums.v1.IndexedValueType;
import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowOptions;
import io.temporal.client.WorkflowStub;
import io.temporal.common.SearchAttributes;
import io.temporal.testing.TestWorkflowEnvironment;
import io.temporal.testing.WorkflowReplayer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** A request from words to VMs: the answer, confirm and cancel updates, several VMs at once, and search attributes. */
class IntentWorkflowTest {

    private TestWorkflowEnvironment env;
    private TestFakes.FakeCloud cloud;
    private TestFakes.FakeRecords records;

    @BeforeEach
    void setUp() {
        env = TestWorkflowEnvironment.newInstance();
        for (var key : RequestSearch.ALL) env.registerSearchAttribute(key.getName(), IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD);
        cloud = new TestFakes.FakeCloud();
        records = new TestFakes.FakeRecords();
        TestFakes.startWorkers(env, cloud, records, new TestFakes.FakeLink());
    }

    @AfterEach
    void tearDown() {
        env.close();
    }

    @Test
    void confirmIsRefusedUntilTheRequestIsWaitingAndOnlyForTheSpecShown() {
        IntentWorkflow wf = start("req-confirm", "ubuntu server with 2 cores in us-east", false);
        waitFor(wf, "AWAITING_CLARIFICATION");
        LifecycleWorkflowTest.assertRefused(() -> wf.confirmSpec("jdoe", null), "not waiting for confirmation");

        wf.clarify("aws");
        waitFor(wf, "AWAITING_CONFIRMATION");
        LifecycleWorkflowTest.assertRefused(() -> wf.confirmSpec("jdoe", "0000"), "isn't the spec");

        String hash = wf.status().interpretation().specHash();
        RequestStatus after = wf.confirmSpec("jdoe", hash);
        assertTrue(after.state().equals("PROVISIONING") || after.state().equals("COMPLETED"), after.state());
        RequestStatus done = WorkflowStub.fromTyped(wf).getResult(RequestStatus.class);
        assertEquals("COMPLETED", done.state());
        assertTrue(records.has("CONFIRMED jdoe"));
    }

    @Test
    void answerIsTakenOnlyWhileTheRequestIsWaitingForOne() throws Exception {
        IntentWorkflow wf = start("req-answer", "ubuntu server with 2 cores in us-east", false);
        waitFor(wf, "AWAITING_CLARIFICATION");
        wf.answerQuestion("aws");
        waitFor(wf, "AWAITING_CONFIRMATION");
        LifecycleWorkflowTest.assertRefused(() -> wf.answerQuestion("azure"), "awaiting confirmation, not waiting for an answer");
        assertEquals("aws", wf.status().interpretation().spec().provider(), "the refused answer changed nothing");

        wf.cancelRequest();
        assertEquals("CANCELLED", WorkflowStub.fromTyped(wf).getResult(RequestStatus.class).state());
        // Replay what just happened, updates included, against today's code.
        WorkflowReplayer.replayWorkflowExecution(
                env.getWorkflowClient().fetchHistory("req-answer"), IntentWorkflowImpl.class);
    }

    @Test
    void cancelIsTakenWhileWaitingAndRefusedOnceTheBuildHasStarted() throws Exception {
        IntentWorkflow asked = start("req-cancel-question", "ubuntu server with 2 cores in us-east", false);
        waitFor(asked, "AWAITING_CLARIFICATION");
        asked.cancelRequest();
        // Refused once cancelled, while the workflow is still open: RequestControllerTest holds it open for that.
        assertEquals("CANCELLED", WorkflowStub.fromTyped(asked).getResult(RequestStatus.class).state());

        cloud.throttleFirstCreates.set(1_000);   // hold the build in PROVISIONING
        IntentWorkflow building = start("req-cancel-build", "small debian vm on azure", false);
        waitFor(building, "AWAITING_CONFIRMATION");
        building.confirmSpec("jdoe", null);
        waitFor(building, "PROVISIONING");
        LifecycleWorkflowTest.assertRefused(building::cancelRequest, "build has already started");
        cloud.throttleFirstCreates.set(0);
        assertEquals("COMPLETED", WorkflowStub.fromTyped(building).getResult(RequestStatus.class).state());
        WorkflowReplayer.replayWorkflowExecution(
                env.getWorkflowClient().fetchHistory("req-cancel-build"), IntentWorkflowImpl.class);
    }

    @Test
    void severalVmsAreBuiltSideBySide() {
        IntentWorkflow wf = start("req-three", "3 small ubuntu servers on aws called web", false);
        waitFor(wf, "AWAITING_CONFIRMATION");
        assertEquals(3, wf.status().interpretation().vmCount());
        wf.confirmSpec("jdoe", null);
        RequestStatus done = WorkflowStub.fromTyped(wf).getResult(RequestStatus.class);

        assertEquals("COMPLETED", done.state(), done.message());
        assertEquals(3, done.vms().size());
        assertEquals(3, cloud.created.get());
        assertEquals(3, records.count("RUNNING"));
        assertTrue(cloud.nameById.containsValue("web-01") && cloud.nameById.containsValue("web-03"));

        // The same request again finds all three already there.
        IntentWorkflow again = start("req-three-again", "3 small ubuntu servers on aws called web", false);
        waitFor(again, "AWAITING_CONFIRMATION");
        again.confirm();
        RequestStatus dup = WorkflowStub.fromTyped(again).getResult(RequestStatus.class);
        assertEquals("DUPLICATE", dup.state(), dup.message());
        assertEquals(3, cloud.created.get(), "nothing new was built");
    }

    @Test
    void failuresInAMultiVmRequestAreRolledBackOneByOne() {
        IntentWorkflow wf = start("req-fail", "2 ubuntu boxes on gcp called fail-node", false);
        waitFor(wf, "AWAITING_CONFIRMATION");
        wf.confirm();
        RequestStatus done = WorkflowStub.fromTyped(wf).getResult(RequestStatus.class);
        assertEquals("FAILED", done.state());
        assertTrue(done.message().contains("2 failed"), done.message());
        assertEquals(2, cloud.deleted.size());
    }

    @Test
    void requestsAreTaggedForSearch() {
        IntentWorkflow wf = start("req-tagged", "small debian vm on azure for prod", true);
        waitFor(wf, "AWAITING_CONFIRMATION");
        SearchAttributes sa = WorkflowStub.fromTyped(wf).describe().getTypedSearchAttributes();
        assertEquals("jdoe", sa.get(RequestSearch.REQUESTER));
        assertEquals("azure", sa.get(RequestSearch.PROVIDER));
        assertEquals("prod", sa.get(RequestSearch.ENV));
        assertEquals("AWAITING_CONFIRMATION", sa.get(RequestSearch.STATE));

        IntentWorkflow plain = start("req-plain", "small debian vm on azure", false);
        waitFor(plain, "AWAITING_CONFIRMATION");
        assertNull(WorkflowStub.fromTyped(plain).describe().getTypedSearchAttributes().get(RequestSearch.STATE),
                "not tagged when the server doesn't have the attributes");
    }

    private IntentWorkflow start(String id, String text, boolean tagged) {
        IntentWorkflow wf = env.getWorkflowClient().newWorkflowStub(IntentWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue(TaskQueues.INTENT).setWorkflowId(id).build());
        WorkflowClient.start(wf::run, new IntentRequest(text, "jdoe", "test", tagged));
        return wf;
    }

    private static void waitFor(IntentWorkflow wf, String state) {
        LifecycleWorkflowTest.eventually(() -> {
            try {
                return state.equals(wf.status().state());
            } catch (Exception e) {
                return false;
            }
        }, "state " + state);
    }
}
