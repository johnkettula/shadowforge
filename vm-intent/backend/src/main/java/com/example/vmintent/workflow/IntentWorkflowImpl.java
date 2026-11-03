package com.example.vmintent.workflow;

import com.example.vmintent.intent.Interpretation;
import com.example.vmintent.workflow.Models.BatchItem;
import com.example.vmintent.workflow.Models.IntentRequest;
import com.example.vmintent.workflow.Models.ReconcileRequest;
import com.example.vmintent.workflow.Models.RequestStatus;
import com.example.vmintent.workflow.Models.VmResult;
import io.temporal.activity.ActivityOptions;
import io.temporal.common.RetryOptions;
import io.temporal.failure.ChildWorkflowFailure;
import io.temporal.failure.TemporalFailure;
import io.temporal.spring.boot.WorkflowImpl;
import io.temporal.workflow.Async;
import io.temporal.workflow.ChildWorkflowOptions;
import io.temporal.workflow.Workflow;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

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
    private String confirmedBy;
    private boolean cancelled = false;
    private boolean tagged = false;
    private List<VmResult> vms;

    /** Most builds of one multi-VM request that run at the same time. */
    static final int MAX_PARALLEL_BUILDS = 5;

    private static final Set<String> FINAL_STATES = Set.of("COMPLETED", "PARTIAL", "FAILED", "CANCELLED", "DUPLICATE");

    @Override
    public RequestStatus run(IntentRequest request) {
        requestId = Workflow.getInfo().getWorkflowId();
        actor = request.userId() == null ? "unknown" : request.userId();
        tagged = request.searchAttributes();
        if (tagged) Workflow.upsertTypedSearchAttributes(RequestSearch.REQUESTER.valueSet(actor));
        log("Request received via " + request.channel() + ": \"" + request.text() + "\"");
        audit(null, "REQUESTED", actor, "via " + request.channel() + ": " + request.text());
        String text = request.text();

        // 1. Interpret, asking clarifying questions until we have a full spec.
        while (true) {
            setState("INTERPRETING", "Working out what you need...");
            interpretation = activities.interpret(text);
            log("Interpreted with " + interpretation.extractor());
            if (interpretation.question() == null) {
                if (tagged) {
                    Workflow.upsertTypedSearchAttributes(
                            RequestSearch.PROVIDER.valueSet(interpretation.spec().provider()),
                            RequestSearch.ENV.valueSet(interpretation.spec().env()),
                            RequestSearch.SPEC_HASH.valueSet(interpretation.specHash()));
                }
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
        audit(interpretation.specHash(), "CONFIRMED", confirmedBy != null ? confirmedBy : actor, interpretation.summary());

        // 3b. Several VMs asked for ("3 web servers"): build them side by side.
        if (interpretation.vmCount() > 1) return buildMany(request);

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
    public void validateConfirmSpec(String who, String specHash) {
        if (cancelled || !"AWAITING_CONFIRMATION".equals(state)) {
            throw new IllegalArgumentException("This request is " + state.toLowerCase().replace('_', ' ')
                    + ", not waiting for confirmation.");
        }
        if (specHash != null && !specHash.isBlank() && !specHash.equals(interpretation.specHash())) {
            throw new IllegalArgumentException("That isn't the spec this request is waiting on. Reload and check it again.");
        }
    }

    @Override
    public RequestStatus confirmSpec(String who, String specHash) {
        confirmedBy = who;
        confirmed = true;
        // Answer once the request has moved on, so the caller sees "PROVISIONING" (or "DUPLICATE").
        Workflow.await(() -> !"AWAITING_CONFIRMATION".equals(state));
        return status();
    }

    @Override
    public void cancel() {
        cancelled = true;
    }

    // The two updates below set the same fields as the clarify / cancel signals, so the workflow's
    // steps are the same either way. Their validators refuse what the signals would silently drop.

    @Override
    public void validateAnswerQuestion(String answer) {
        refuseIfFinished();
        if (!"AWAITING_CLARIFICATION".equals(state) || answers.size() > answersUsed) {
            throw new IllegalArgumentException("This request is " + state.toLowerCase().replace('_', ' ')
                    + ", not waiting for an answer.");
        }
    }

    @Override
    public void answerQuestion(String answer) {
        answers.add(answer);
    }

    @Override
    public void validateCancelRequest() {
        refuseIfFinished();
        if (confirmed || "PROVISIONING".equals(state)) {
            throw new IllegalArgumentException("The build has already started, so this request can't be cancelled.");
        }
    }

    @Override
    public void cancelRequest() {
        cancelled = true;
    }

    private void refuseIfFinished() {
        if (cancelled || FINAL_STATES.contains(state)) {
            throw new IllegalArgumentException("This request has already finished ("
                    + (cancelled ? "cancelled" : state.toLowerCase()) + ").");
        }
    }

    @Override
    public RequestStatus status() {
        return new RequestStatus(requestId, state, message, interpretation, vm, List.copyOf(history), actor,
                vms == null ? null : List.copyOf(vms));
    }

    private void setState(String newState, String newMessage) {
        if (tagged && !newState.equals(state)) Workflow.upsertTypedSearchAttributes(RequestSearch.STATE.valueSet(newState));
        state = newState;
        message = newMessage;
    }

    /**
     * Builds every VM of a multi-VM request, at most MAX_PARALLEL_BUILDS at a time. Each is its own
     * child workflow ("vm-" + its spec hash), with its own rollback, so one failure doesn't stop the rest.
     */
    private RequestStatus buildMany(IntentRequest request) {
        List<BatchItem> items = activities.expand(interpretation);
        int n = items.size();
        VmResult[] built = new VmResult[n];
        List<String> failures = new ArrayList<>();
        List<String> duplicates = new ArrayList<>();
        int[] inFlight = {0};
        int[] finished = {0};
        String where = interpretation.spec().provider();
        setState("PROVISIONING", "Building " + n + " VMs on " + where + "...");
        for (int i = 0; i < n; i++) {
            BatchItem item = items.get(i);
            String existing = activities.findExistingVm(item.specHash());
            if (existing != null) {
                duplicates.add(item.spec().name());
                finished[0]++;
                continue;
            }
            Workflow.await(() -> inFlight[0] < MAX_PARALLEL_BUILDS);
            inFlight[0]++;
            int slot = i;
            VmReconcileWorkflow child = Workflow.newChildWorkflowStub(VmReconcileWorkflow.class,
                    ChildWorkflowOptions.newBuilder()
                            .setWorkflowId("vm-" + item.specHash())
                            .setTaskQueue(TaskQueues.INTENT)
                            .build());
            Async.function(child::reconcile,
                            new ReconcileRequest(item.spec(), item.specHash(), request.userId(), requestId))
                    .handle((result, failure) -> {
                        inFlight[0]--;
                        finished[0]++;
                        if (failure == null) built[slot] = result;
                        else failures.add(item.spec().name() + ": " + rootMessage(failure));
                        message = progress(n, built, failures, duplicates);
                        return null;
                    });
        }
        Workflow.await(() -> finished[0] == n);

        vms = new ArrayList<>();
        for (VmResult r : built) if (r != null) vms.add(r);
        if (!vms.isEmpty()) vm = vms.get(0);
        String summary = progress(n, built, failures, duplicates)
                + (failures.isEmpty() ? "" : " Failed (rolled back): " + String.join("; ", failures) + ".")
                + (duplicates.isEmpty() ? "" : " Already existed: " + String.join(", ", duplicates) + ".");
        if (vms.size() == n) return finish("COMPLETED", "All " + n + " VMs are running.");
        // VMs that already existed count as running, not failed: with no failures the request is complete.
        if (!vms.isEmpty() && failures.isEmpty()) return finish("COMPLETED", "All " + n + " VMs are running ("
                + duplicates.size() + " already existed: " + String.join(", ", duplicates) + ").");
        if (vms.isEmpty() && failures.isEmpty()) return finish("DUPLICATE", summary);
        if (vms.isEmpty()) return finish("FAILED", summary);
        return finish("PARTIAL", summary);
    }

    private static String progress(int n, VmResult[] built, List<String> failures, List<String> duplicates) {
        int running = 0;
        for (VmResult r : built) if (r != null) running++;
        int waiting = n - running - failures.size() - duplicates.size();
        return n + " VMs: " + running + " running" + (failures.isEmpty() ? "" : ", " + failures.size() + " failed")
                + (duplicates.isEmpty() ? "" : ", " + duplicates.size() + " already existed")
                + (waiting > 0 ? ", " + waiting + " in progress." : ".");
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
