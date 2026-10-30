package com.example.vmintent.api;

import com.example.vmintent.api.ApiModels.AnswerBody;
import com.example.vmintent.workflow.IntentWorkflow;
import com.example.vmintent.workflow.Models.IntentRequest;
import com.example.vmintent.workflow.Models.RequestStatus;
import com.example.vmintent.workflow.RequestSearch;
import com.example.vmintent.workflow.TaskQueues;
import com.example.vmintent.workflow.TestFakes;
import io.temporal.api.enums.v1.IndexedValueType;
import io.temporal.api.enums.v1.WorkflowExecutionStatus;
import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowNotFoundException;
import io.temporal.client.WorkflowOptions;
import io.temporal.client.WorkflowStub;
import io.temporal.testing.TestWorkflowEnvironment;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Answering or cancelling a request: 409 once it has finished, 404 for an ID that was never used. */
class RequestControllerTest {

    /** Holds the "CANCELLED" audit event of the "req-closing" request, so its workflow stays open after it's cancelled. */
    static class HeldRecords extends TestFakes.FakeRecords {
        final CountDownLatch cancelledAuditStarted = new CountDownLatch(1);
        final CountDownLatch releaseCancelledAudit = new CountDownLatch(1);

        @Override
        public void audit(String requestId, String specHash, String event, String actor, String detail) {
            if ("req-closing".equals(requestId) && "CANCELLED".equals(event)) {
                cancelledAuditStarted.countDown();
                try {
                    releaseCancelledAudit.await(30, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
            super.audit(requestId, specHash, event, actor, detail);
        }
    }

    private TestWorkflowEnvironment env;
    private HeldRecords records;
    private RequestController controller;

    @BeforeEach
    void setUp() {
        env = TestWorkflowEnvironment.newInstance();
        for (var key : RequestSearch.ALL) env.registerSearchAttribute(key.getName(), IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD);
        records = new HeldRecords();
        TestFakes.startWorkers(env, new TestFakes.FakeCloud(), records, new TestFakes.FakeLink());
        // Only the workflow client is used by clarify and cancel (sign-in is off here).
        controller = new RequestController(env.getWorkflowClient(), null, null, null, null, null, null);
    }

    @AfterEach
    void tearDown() {
        env.close();
    }

    @Test
    void clarifyAndCancelOnAFinishedRequestAre409() {
        IntentWorkflow wf = start("req-finished", "ubuntu server with 2 cores in us-east");
        waitFor(wf, "AWAITING_CLARIFICATION");
        controller.clarify("req-finished", new AnswerBody("aws"));
        waitFor(wf, "AWAITING_CONFIRMATION");
        controller.cancel("req-finished");
        assertEquals("CANCELLED", WorkflowStub.fromTyped(wf).getResult(RequestStatus.class).state());

        for (Runnable call : List.<Runnable>of(() -> controller.cancel("req-finished"),
                () -> controller.clarify("req-finished", new AnswerBody("azure")))) {
            ResponseStatusException e = assertThrows(ResponseStatusException.class, call::run);
            assertEquals(HttpStatus.CONFLICT, e.getStatusCode());
            assertTrue(e.getReason().startsWith("This request has already finished"), e.getReason());
        }
    }

    @Test
    void clarifyAndCancelAre409OnceCancelledEvenBeforeTheWorkflowCloses() throws Exception {
        IntentWorkflow wf = start("req-closing", "ubuntu server with 2 cores in us-east");
        waitFor(wf, "AWAITING_CLARIFICATION");
        controller.clarify("req-closing", new AnswerBody("aws"));
        waitFor(wf, "AWAITING_CONFIRMATION");
        controller.cancel("req-closing");
        waitFor(wf, "CANCELLED");
        try {
            // The final audit event is held, so the workflow is still open.
            assertTrue(records.cancelledAuditStarted.await(10, TimeUnit.SECONDS));
            assertEquals(WorkflowExecutionStatus.WORKFLOW_EXECUTION_STATUS_RUNNING,
                    WorkflowStub.fromTyped(wf).describe().getStatus());
            for (Runnable call : List.<Runnable>of(() -> controller.cancel("req-closing"),
                    () -> controller.clarify("req-closing", new AnswerBody("azure")))) {
                ResponseStatusException e = assertThrows(ResponseStatusException.class, call::run);
                assertEquals(HttpStatus.CONFLICT, e.getStatusCode());
                assertEquals("This request has already finished (cancelled).", e.getReason());
            }
        } finally {
            records.releaseCancelledAudit.countDown();
        }
        assertEquals("CANCELLED", WorkflowStub.fromTyped(wf).getResult(RequestStatus.class).state());
    }

    @Test
    void cancelOnACompletedRequestIs409() {
        IntentWorkflow wf = start("req-completed", "small debian vm on azure");
        waitFor(wf, "AWAITING_CONFIRMATION");
        controller.confirm("req-completed", null);
        assertEquals("COMPLETED", WorkflowStub.fromTyped(wf).getResult(RequestStatus.class).state());

        ResponseStatusException e = assertThrows(ResponseStatusException.class, () -> controller.cancel("req-completed"));
        assertEquals(HttpStatus.CONFLICT, e.getStatusCode());
        assertTrue(e.getReason().contains("completed"), e.getReason());
    }

    @Test
    void clarifyAndCancelOnAnUnknownIdAre404() {
        // WorkflowNotFoundException is what ApiErrorHandler turns into 404.
        assertThrows(WorkflowNotFoundException.class, () -> controller.cancel("intent-does-not-exist"));
        assertThrows(WorkflowNotFoundException.class,
                () -> controller.clarify("intent-does-not-exist", new AnswerBody("x")));
    }

    private IntentWorkflow start(String id, String text) {
        IntentWorkflow wf = env.getWorkflowClient().newWorkflowStub(IntentWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue(TaskQueues.INTENT).setWorkflowId(id).build());
        WorkflowClient.start(wf::run, new IntentRequest(text, "jdoe", "test", false));
        return wf;
    }

    private static void waitFor(IntentWorkflow wf, String state) {
        for (int i = 0; i < 100; i++) {
            try {
                if (state.equals(wf.status().state())) return;
            } catch (Exception notYet) {
                // The workflow hasn't run its first step yet.
            }
            try {
                Thread.sleep(50);
            } catch (InterruptedException e) {
                throw new AssertionError(e);
            }
        }
        throw new AssertionError("timed out waiting for state " + state);
    }
}
