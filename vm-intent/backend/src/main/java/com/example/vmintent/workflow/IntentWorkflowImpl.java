package com.example.vmintent.workflow;

import com.example.vmintent.intent.Interpretation;
import com.example.vmintent.workflow.Models.IntentRequest;
import com.example.vmintent.workflow.Models.ReconcileRequest;
import com.example.vmintent.workflow.Models.RequestStatus;
import com.example.vmintent.workflow.Models.VmResult;
import io.temporal.activity.ActivityOptions;
import io.temporal.common.RetryOptions;
import io.temporal.failure.ChildWorkflowFailure;
import io.temporal.failure.TemporalFailure;
import io.temporal.spring.boot.WorkflowImpl;
import io.temporal.workflow.ChildWorkflowOptions;
import io.temporal.workflow.Workflow;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

/**
 * IMPORTANT: workflow code must be deterministic. No network calls, no
 * random numbers, no System.currentTimeMillis() here — anything like that
 * goes in an activity. Temporal replays this code to rebuild state.
 */
@WorkflowImpl(taskQueues = TaskQueues.INTENT)
public class IntentWorkflowImpl implements IntentWorkflow {

    private static final Duration WAIT_FOR_USER = Duration.ofHours(24);

    private final IntentActivities activities = Workflow.newActivityStub(
            IntentActivities.class,
            ActivityOptions.newBuilder()
                    .setStartToCloseTimeout(Duration.ofSeconds(60))
                    .setRetryOptions(RetryOptions.newBuilder().setMaximumAttempts(3).build())
                    .build());

    private final RecordActivities records = Workflow.newActivityStub(
            RecordActivities.class,
            ActivityOptions.newBuilder()
                    .setStartToCloseTimeout(Duration.ofSeconds(10))
                    .setRetryOptions(RetryOptions.newBuilder().setMaximumAttempts(5).build())
                    .build());

    private String requestId;
    private String actor = "unknown";
    private String state = "STARTING";
    private String message = "";
    private Interpretation interpretation;
    private VmResult vm;
    private final List<String> history = new ArrayList<>();

    private final List<String> answers = new ArrayList<>();
    private int answersUsed = 0;
    private boolean confirmed = false;
    private boolean cancelled = false;

    @Override
    public RequestStatus run(IntentRequest request) {
        requestId = Workflow.getInfo().getWorkflowId();
        actor = request.userId() == null ? "unknown" : request.userId();
        log("Request received via " + request.channel() + ": \"" + request.text() + "\"");
        audit(null, "REQUESTED", actor, "via " + request.channel() + ": " + request.text());
        String text = request.text();

        // 1. Interpret, asking clarifying questions until we have a full spec.
        while (true) {
            setState("INTERPRETING", "Working out what you need...");
            interpretation = activities.interpret(text);
            log("Interpreted with " + interpretation.extractor());
            if (interpretation.question() == null) {
                audit(interpretation.specHash(), "INTERPRETED", "system",
                        interpretation.summary() + " (by " + interpretation.extractor() + ")");
                break;
            }
            audit(null, "QUESTION_ASKED", "system", interpretation.question());

            setState("AWAITING_CLARIFICATION", interpretation.question());
            boolean answered = Workflow.await(WAIT_FOR_USER, () -> answers.size() > answersUsed || cancelled);
            if (cancelled) return finish("CANCELLED", "Cancelled by user.");
            if (!answered) return finish("CANCELLED", "No answer within 24 hours.");
            String answer = answers.get(answersUsed++);
            log("User answered: \"" + answer + "\"");
            audit(null, "ANSWERED", actor, answer);
            text = text + ". " + answer;
        }

        // 2. Show the user what we understood and wait for a yes.
        setState("AWAITING_CONFIRMATION", "Check the spec below, then confirm or cancel.");
        boolean decided = Workflow.await(WAIT_FOR_USER, () -> confirmed || cancelled);
        if (cancelled) return finish("CANCELLED", "Cancelled by user.");
        if (!decided) return finish("CANCELLED", "Not confirmed within 24 hours.");
        log("User confirmed spec " + interpretation.specHash().substring(0, 12));
        audit(interpretation.specHash(), "CONFIRMED", actor, interpretation.summary());

        // 3. Same spec already built? Then this is a duplicate, not a second VM.
        String existing = activities.findExistingVm(interpretation.specHash());
        if (existing != null) {
            return finish("DUPLICATE", "An identical VM already exists or is being built: " + existing);
        }

        // 4. Hand off to the reconcile workflow. Its ID is the spec hash.
        setState("PROVISIONING", "Building on " + interpretation.spec().provider() + "...");
        VmReconcileWorkflow child = Workflow.newChildWorkflowStub(
                VmReconcileWorkflow.class,
                ChildWorkflowOptions.newBuilder()
                        .setWorkflowId("vm-" + interpretation.specHash())
                        .setTaskQueue(TaskQueues.INTENT)
                        .build());
        try {
            vm = child.reconcile(new ReconcileRequest(
                    interpretation.spec(), interpretation.specHash(), request.userId(), requestId));
            return finish("COMPLETED", "VM " + vm.vmId() + " is running at " + vm.ipAddress());
        } catch (ChildWorkflowFailure e) {
            return finish("FAILED", "Provisioning failed and was rolled back: " + rootMessage(e));
        }
    }

    @Override
    public void clarify(String answer) {
        answers.add(answer);
    }

    @Override
    public void confirm() {
        confirmed = true;
    }

    @Override
    public void cancel() {
        cancelled = true;
    }

    @Override
    public RequestStatus status() {
        return new RequestStatus(requestId, state, message, interpretation, vm, List.copyOf(history), actor);
    }

    private void setState(String newState, String newMessage) {
        state = newState;
        message = newMessage;
    }

    private RequestStatus finish(String finalState, String finalMessage) {
        setState(finalState, finalMessage);
        log(finalState + ": " + finalMessage);
        audit(interpretation == null ? null : interpretation.specHash(), finalState,
                "CANCELLED".equals(finalState) ? actor : "system", finalMessage);
        return status();
    }

    private void audit(String specHash, String event, String who, String detail) {
        records.audit(requestId, specHash, event, who, detail);
    }

    private void log(String line) {
        // Workflow.currentTimeMillis() is the deterministic, replay-safe clock.
        String time = java.time.Instant.ofEpochMilli(Workflow.currentTimeMillis()).toString().substring(11, 19);
        history.add(time + "  " + line);
    }

    private static String rootMessage(Throwable e) {
        Throwable t = e;
        while (t.getCause() != null) t = t.getCause();
        if (t instanceof TemporalFailure tf) return tf.getOriginalMessage();
        return t.getMessage();
    }
}
