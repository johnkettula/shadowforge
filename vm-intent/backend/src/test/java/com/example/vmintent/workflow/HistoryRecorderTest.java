package com.example.vmintent.workflow;

import com.example.vmintent.workflow.Models.IntentRequest;
import com.example.vmintent.workflow.Models.RequestStatus;
import io.temporal.api.enums.v1.EventType;
import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowOptions;
import io.temporal.client.WorkflowStub;
import io.temporal.common.WorkflowExecutionHistory;
import io.temporal.testing.TestWorkflowEnvironment;
import io.temporal.testing.WorkflowReplayer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** HistoryRecorder writes only when asked to, only missing files, into a temporary folder here. */
class HistoryRecorderTest {

    private TestWorkflowEnvironment env;
    private String saved;

    @TempDir
    Path dir;

    @BeforeEach
    void setUp() {
        saved = System.getProperty(HistoryRecorder.PROPERTY);
        env = TestWorkflowEnvironment.newInstance();
        TestFakes.startWorkers(env, new TestFakes.FakeCloud(), new TestFakes.FakeRecords(), new TestFakes.FakeLink());
        // A short request: asked which cloud, then cancelled.
        IntentWorkflow wf = env.getWorkflowClient().newWorkflowStub(IntentWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue(TaskQueues.INTENT).setWorkflowId("req-recorded").build());
        WorkflowClient.start(wf::run, new IntentRequest("ubuntu server with 2 cores in us-east", "jdoe", "test", false));
        LifecycleWorkflowTest.eventually(() -> "AWAITING_CLARIFICATION".equals(wf.status().state()), "the question");
        wf.cancelRequest();
        assertEquals("CANCELLED", WorkflowStub.fromTyped(wf).getResult(RequestStatus.class).state());
    }

    @AfterEach
    void tearDown() {
        env.close();
        if (saved == null) System.clearProperty(HistoryRecorder.PROPERTY);
        else System.setProperty(HistoryRecorder.PROPERTY, saved);
    }

    @Test
    void writesNothingWithoutTheProperty() throws Exception {
        System.clearProperty(HistoryRecorder.PROPERTY);
        assertFalse(HistoryRecorder.record(env.getWorkflowClient(), "req-recorded", "intent-test", dir));
        System.setProperty(HistoryRecorder.PROPERTY, "yes");
        assertFalse(HistoryRecorder.record(env.getWorkflowClient(), "req-recorded", "intent-test", dir));
        try (var files = Files.list(dir)) {
            assertEquals(0, files.count());
        }
    }

    @Test
    void writesAMissingFileThatReplays() throws Exception {
        System.setProperty(HistoryRecorder.PROPERTY, "true");
        assertTrue(HistoryRecorder.record(env.getWorkflowClient(), "req-recorded", "intent-test", dir));

        Path file = dir.resolve("intent-test.json");
        WorkflowExecutionHistory h = ReplayTest.parse(Files.readString(file, StandardCharsets.UTF_8), "intent-test");
        assertEquals(EventType.EVENT_TYPE_WORKFLOW_EXECUTION_STARTED, h.getEvents().get(0).getEventType());
        assertEquals("IntentWorkflow",
                h.getEvents().get(0).getWorkflowExecutionStartedEventAttributes().getWorkflowType().getName());
        assertTrue(Files.readString(file).contains("\"EVENT_TYPE_WORKFLOW_EXECUTION_STARTED\""));
        WorkflowReplayer.replayWorkflowExecution(h, IntentWorkflowImpl.class);
    }

    @Test
    void leavesAnExistingFileAsItWas() throws Exception {
        System.setProperty(HistoryRecorder.PROPERTY, "true");
        Path file = dir.resolve("intent-test.json");
        byte[] before = "{\"events\": []}\n".getBytes(StandardCharsets.UTF_8);
        Files.write(file, before);

        assertFalse(HistoryRecorder.record(env.getWorkflowClient(), "req-recorded", "intent-test", dir));
        assertArrayEquals(before, Files.readAllBytes(file));
    }

    @Test
    void refusesANameThatIsAPath() {
        assertThrows(IllegalArgumentException.class,
                () -> HistoryRecorder.record(env.getWorkflowClient(), "req-recorded", "../intent-test", dir));
    }
}
