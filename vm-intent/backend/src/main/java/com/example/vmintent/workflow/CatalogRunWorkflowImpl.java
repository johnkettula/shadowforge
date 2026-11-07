package com.example.vmintent.workflow;

import com.example.vmintent.catalog.Actions;
import com.example.vmintent.catalog.CatalogModels.ActionResult;
import com.example.vmintent.catalog.CatalogModels.Approval;
import com.example.vmintent.catalog.CatalogModels.Definition;
import com.example.vmintent.catalog.CatalogModels.PreparedVm;
import com.example.vmintent.catalog.CatalogModels.RunRequest;
import com.example.vmintent.catalog.CatalogModels.RunStatus;
import com.example.vmintent.catalog.CatalogModels.StepDef;
import com.example.vmintent.catalog.CatalogModels.StepState;
import com.example.vmintent.catalog.DefinitionParser;
import com.example.vmintent.catalog.Templates;
import com.example.vmintent.cel.Cel;
import com.example.vmintent.spec.VmIdentity;
import com.example.vmintent.workflow.Models.ReconcileRequest;
import com.example.vmintent.workflow.Models.VmResult;
import io.temporal.activity.ActivityOptions;
import io.temporal.api.enums.v1.ParentClosePolicy;
import io.temporal.api.enums.v1.WorkflowIdReusePolicy;
import io.temporal.common.RetryOptions;
import io.temporal.failure.ApplicationFailure;
import io.temporal.failure.TemporalFailure;
import io.temporal.spring.boot.WorkflowImpl;
import io.temporal.workflow.ChildWorkflowOptions;
import io.temporal.workflow.Workflow;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * See CatalogRunWorkflow. Workflow code must be deterministic: CEL conditions and ${ } values are
 * worked out here (CEL is pure: no clock, no I/O, no randomness), and everything that touches the
 * outside world is an activity or a child workflow.
 */
@WorkflowImpl(taskQueues = TaskQueues.INTENT)
public class CatalogRunWorkflowImpl implements CatalogRunWorkflow {

    static final Set<String> NEEDS_UNDO = Set.of("vm.create", "vm.resize", "vm.power", "tools.stage", "files.copy", "config.apply",
            "blueprint.deploy");
    static final Duration VM_BUSY_CHECK = Duration.ofSeconds(30);
    static final Duration VM_BUSY_LIMIT = Duration.ofMinutes(60);
    static final int HISTORY_KEPT = 200;

    /** Quick bookkeeping calls: saving the run, logging a decision, looking at a VM. */
    private final CatalogActivities records = Workflow.newActivityStub(CatalogActivities.class,
            ActivityOptions.newBuilder()
                    .setStartToCloseTimeout(Duration.ofSeconds(30))
                    .setRetryOptions(RetryOptions.newBuilder().setMaximumInterval(Duration.ofSeconds(30)).build())
                    .build());

    /** Undo steps: allowed longer (removing a VM waits for the cloud), retried a few times. */
    private final CatalogActivities undoer = Workflow.newActivityStub(CatalogActivities.class,
            ActivityOptions.newBuilder()
                    .setStartToCloseTimeout(Duration.ofMinutes(60))
                    .setRetryOptions(RetryOptions.newBuilder().setMaximumAttempts(5)
                            .setMaximumInterval(Duration.ofMinutes(2)).build())
                    .build());

    private final RecordActivities audit = Workflow.newActivityStub(RecordActivities.class,
            ActivityOptions.newBuilder()
                    .setStartToCloseTimeout(Duration.ofSeconds(10))
                    .setRetryOptions(RetryOptions.newBuilder().setMaximumInterval(Duration.ofSeconds(30)).build())
                    .build());

    private RunRequest req;
    private Definition def;
    /** Kept from run(): queries can't call Workflow.getInfo(). */
    private String workflowId;
    private String state = "STARTING";
    private String message = "Starting";
    private final List<StepState> steps = new ArrayList<>();
    /** What each finished step produced, by step ID: later steps read these as steps.<id>. */
    private final Map<String, Object> outputs = new LinkedHashMap<>();
    /** Each step's settings as worked out when it last ran; teardown needs them to undo the step. */
    private final Map<String, Map<String, Object>> resolved = new HashMap<>();
    private final List<String> history = new ArrayList<>();

    // While stopped after a failure
    private String failedStep;
    private long recoveryDeadlineMs;
    private String decision;        // null | resume | teardown
    private String decisionBy;
    private String decisionNote;

    // While an approval step waits
    private Approval approval;
    private Boolean approvalAnswer;
    private String approvalBy;
    private String approvalNote;

    @Override
    public RunStatus run(RunRequest request) {
        req = request;
        def = request.definition();
        workflowId = Workflow.getInfo().getWorkflowId();
        for (StepDef d : def.steps()) {
            steps.add(new StepState(d.id(), d.action(), title(d), "PENDING", 0, null, null, null, null));
        }
        note("Started by " + request.requestedBy() + ": " + def.name() + " v" + def.version()
                + ", classification " + request.classification().code() + " (" + request.classification().label() + ")");
        setState("RUNNING", "Running " + def.steps().size() + " steps");
        saveRun(false);
        audit("RUN_STARTED", request.requestedBy(), def.name() + " v" + def.version() + " with " + request.params());

        int i = 0;
        while (i < steps.size()) {
            if (runStep(i)) {
                i++;
                continue;
            }
            StepState failed = steps.get(i);
            failedStep = failed.id();
            int hours = Math.max(1, Math.min(DefinitionParser.MAX_RECOVERY_HOURS, def.recoveryWaitHours()));
            recoveryDeadlineMs = Workflow.currentTimeMillis() + Duration.ofHours(hours).toMillis();
            if (decision == null) {
                setState("AWAITING_RECOVERY", "Step '" + failed.id() + "' failed: " + failed.error()
                        + ". Resume it or tear the run down by " + iso(recoveryDeadlineMs)
                        + "; after that it tears itself down.");
                saveRun(false);
                audit("RUN_STOPPED", "system", "Step " + failed.id() + " failed: " + failed.error());
                boolean decided = Workflow.await(Duration.ofHours(hours), () -> decision != null);
                if (!decided) {
                    decision = "teardown";
                    decisionBy = "system";
                    decisionNote = "nobody resumed or tore down the run within " + span(hours);
                }
            }
            failedStep = null;
            recoveryDeadlineMs = 0;
            if ("resume".equals(decision)) {
                audit("RUN_RESUMED", decisionBy, "Step " + failed.id() + (blank(decisionNote) ? "" : ": " + decisionNote));
                decision = null;
                continue;   // the same step again
            }
            teardown(i);
            Workflow.await(Workflow::isEveryHandlerFinished);
            return status();
        }
        setState("COMPLETED", "All " + steps.size() + " steps done");
        saveRun(true);
        audit("RUN_COMPLETED", "system", message);
        Workflow.await(Workflow::isEveryHandlerFinished);
        return status();
    }

    // ------------------------------------------------------------------ one step

    /** Runs step i once. True = done or skipped; false = failed (the run then waits for a decision). */
    private boolean runStep(int i) {
        StepDef d = def.steps().get(i);
        Map<String, Object> with;
        try {
            Map<String, Object> vars = vars();
            if (d.when() != null && !Cel.compile(d.when(), Templates.VARIABLES).evalBool(vars)) {
                put(i, "SKIPPED", Map.of("skipped", true), null, false);
                outputs.put(d.id(), Map.of("skipped", true));
                note("Skipped " + d.id() + ": its condition (" + d.when() + ") is false");
                return true;
            }
            with = Templates.resolveMap(d.with(), vars);
        } catch (Cel.CelException e) {
            put(i, "FAILED", null, "Couldn't work out its settings: " + e.getMessage(), false);
            note("Step " + d.id() + " failed: " + steps.get(i).error());
            return false;
        }
        // The step key lets an action keep its own journal across tries (see CatalogActivitiesImpl).
        with = new LinkedHashMap<>(with);
        with.put("_step", workflowId + ":" + d.id());
        resolved.put(d.id(), with);
        put(i, "RUNNING", null, null, true);
        note("Step " + d.id() + " (" + d.action() + ") started" + (steps.get(i).attempts() > 1
                ? ", try " + steps.get(i).attempts() + ": it picks up whatever the last try left" : ""));
        try {
            ActionResult r = execute(d, with);
            Map<String, Object> out = r.output() == null ? Map.of() : r.output();
            outputs.put(d.id(), out);
            put(i, "DONE", out, null, false);
            note("Step " + d.id() + " done" + (blank(r.note()) ? "" : ": " + r.note()));
            audit("STEP_DONE", "system", d.id() + " (" + d.action() + ")" + (blank(r.note()) ? "" : ": " + r.note()));
            return true;
        } catch (TemporalFailure | Cel.CelException e) {
            String why = e instanceof TemporalFailure ? VmReconcileWorkflowImpl.reason(e) : e.getMessage();
            put(i, "FAILED", null, why, false);
            note("Step " + d.id() + " failed: " + why);
            audit("STEP_FAILED", "system", d.id() + " (" + d.action() + "): " + why);
            return false;
        }
    }

    private ActionResult execute(StepDef d, Map<String, Object> with) {
        CatalogActivities act = actionStub(d);
        return switch (d.action()) {
            case "vm.create" -> createVm(with, act);
            case "vm.resize", "vm.power", "vm.snapshot" -> act.changeVm(d.action(), with, req.requestedBy());
            case "tools.stage" -> act.stageTools(with);
            case "files.copy" -> act.copyFiles(with);
            case "config.apply" -> act.applyConfig(with);
            case "check.until" -> checkUntil(d, with);
            case "approval.wait" -> approvalWait(d, with);
            case "blueprint.deploy" -> deployBlueprint(with, act);
            default -> throw ApplicationFailure.newNonRetryableFailure("Unknown action " + d.action(), "InvalidStep");
        };
    }

    /**
     * Builds the VM with the same build workflow as every other request, so it gets the same
     * rollback, one-way link handling and lifecycle. Its own partial work: the VM's identity is its
     * spec hash, so if an earlier try already built it (or is building it), that VM is used.
     */
    private ActionResult createVm(Map<String, Object> with, CatalogActivities act) {
        PreparedVm vm = act.prepareVm(with, req.blueprints(), def.blueprint(), req.params(), runVars(), req.owner());
        if (!vm.problems().isEmpty()) {
            throw ApplicationFailure.newNonRetryableFailure("The VM doesn't pass the rules: "
                    + String.join("; ", vm.problems()), "InvalidStep");
        }
        Map<String, Object> existing = act.existingVm(vm.specHash());
        if (existing != null && "PROVISIONING".equals(existing.get("state"))) {
            long until = Workflow.currentTimeMillis() + VM_BUSY_LIMIT.toMillis();
            while (existing != null && "PROVISIONING".equals(existing.get("state")) && Workflow.currentTimeMillis() < until) {
                Workflow.sleep(VM_BUSY_CHECK);
                existing = act.existingVm(vm.specHash());
            }
            if (existing != null && "PROVISIONING".equals(existing.get("state"))) {
                throw ApplicationFailure.newFailure("The same VM has been building for over an hour elsewhere", "VmBusy");
            }
        }
        if (existing != null && "RUNNING".equals(existing.get("state"))) {
            Map<String, Object> out = new LinkedHashMap<>(existing);
            out.put("specHash", vm.specHash());
            out.put("reused", true);
            return new ActionResult(out, "using " + existing.get("vmId") + ", already built with this spec");
        }
        VmReconcileWorkflow build = Workflow.newChildWorkflowStub(VmReconcileWorkflow.class,
                ChildWorkflowOptions.newBuilder()
                        .setWorkflowId(VmIdentity.buildWorkflowId(vm.specHash()))
                        .setTaskQueue(TaskQueues.INTENT)
                        .setParentClosePolicy(ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON)
                        .setWorkflowIdReusePolicy(WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE)
                        .build());
        VmResult r = build.reconcile(new ReconcileRequest(vm.spec(), vm.specHash(), req.requestedBy(),
                workflowId));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("specHash", vm.specHash());
        out.put("name", vm.spec().name());
        out.put("provider", r.provider());
        out.put("region", vm.spec().region());
        out.put("vmId", r.vmId());
        out.put("ipAddress", r.ipAddress());
        out.put("nativeSize", r.nativeSize());
        out.put("nativeRegion", r.nativeRegion());
        out.put("vcpu", vm.spec().vcpu());
        out.put("memoryGiB", vm.spec().memoryGiB());
        out.put("reused", false);
        return new ActionResult(out, r.vmId() + " at " + r.ipAddress());
    }

    /** Looks at the VM now and then until the condition is true, or the time is up. */
    private ActionResult checkUntil(StepDef d, Map<String, Object> with) {
        String untilText = String.valueOf(d.with().get("until"));
        Cel.Program until = Cel.compile(untilText, Set.of("params", "steps", "run", "probe"));
        int every = clamp(with.get("everySeconds"), 5, 3600, 30);
        int minutes = clamp(with.get("timeoutMinutes"), 1, 1440, 30);
        long deadline = Workflow.currentTimeMillis() + Duration.ofMinutes(minutes).toMillis();
        String vm = String.valueOf(with.get("vm"));
        int checks = 0;
        while (true) {
            Map<String, Object> probe = records.probe(vm);
            checks++;
            Map<String, Object> vars = new HashMap<>(vars());
            vars.put("probe", probe);
            if (until.evalBool(vars)) {
                return new ActionResult(Map.of("checks", checks, "probe", probe), "true after " + checks + " check(s)");
            }
            if (Workflow.currentTimeMillis() + every * 1000L > deadline) {
                throw ApplicationFailure.newNonRetryableFailure("Still not true after " + minutes + " minutes ("
                        + checks + " checks): " + untilText + ". Last look: " + probe, "CheckTimeout");
            }
            Workflow.sleep(Duration.ofSeconds(every));
        }
    }

    /**
     * Asks VCF Automation for a blueprint deployment, then looks at it now and then until it's done.
     * The waiting is a workflow timer, so a deployment that takes an hour holds no worker thread.
     */
    private ActionResult deployBlueprint(Map<String, Object> with, CatalogActivities act) {
        Map<String, Object> started = act.startBlueprint(with, req.requestedBy());
        String id = String.valueOf(started.get("deploymentId"));
        int every = clamp(with.get("everySeconds"), 10, 600, 30);
        int minutes = clamp(with.get("timeoutMinutes"), 5, 1440, 90);
        long deadline = Workflow.currentTimeMillis() + Duration.ofMinutes(minutes).toMillis();
        while (true) {
            Map<String, Object> st = records.blueprintStatus(id);
            String s = String.valueOf(st.get("state"));
            if ("SUCCESSFUL".equals(s)) {
                Map<String, Object> out = new LinkedHashMap<>(st);
                out.put("blueprint", started.getOrDefault("blueprint", with.get("blueprint")));
                out.put("version", started.getOrDefault("version", with.getOrDefault("version", "")));
                out.put("reused", started.getOrDefault("reused", false));
                return new ActionResult(out, "deployment " + st.get("name") + " " + st.get("status") + " " + st.get("addresses"));
            }
            if ("FAILED".equals(s)) {
                throw ApplicationFailure.newNonRetryableFailure("Deployment " + id + " failed: " + st.getOrDefault("detail", st.get("status")),
                        "DeploymentFailed");
            }
            if (Workflow.currentTimeMillis() + every * 1000L > deadline) {
                throw ApplicationFailure.newNonRetryableFailure("Deployment " + id + " still " + st.get("status") + " after " + minutes + " minutes",
                        "DeploymentTimeout");
            }
            Workflow.sleep(Duration.ofSeconds(every));
        }
    }

    /** Waits for someone on the approvers list (never the requester) to approve or reject. */
    private ActionResult approvalWait(StepDef d, Map<String, Object> with) {
        List<String> approvers = new ArrayList<>();
        if (with.get("approvers") instanceof List<?> l) l.forEach(a -> approvers.add(String.valueOf(a)));
        int hours = clamp(with.get("timeoutHours"), 1, 72, 24);
        long deadline = Workflow.currentTimeMillis() + Duration.ofHours(hours).toMillis();
        approval = new Approval(d.id(), String.valueOf(with.get("message")), List.copyOf(approvers), iso(deadline));
        approvalAnswer = null;
        setState("AWAITING_APPROVAL", "Waiting for approval: " + approval.message()
                + (approvers.isEmpty() ? "" : " (approvers: " + String.join(", ", approvers) + ")"));
        saveRun(false);
        audit("APPROVAL_REQUESTED", "system", approval.message());
        boolean answered = Workflow.await(Duration.ofHours(hours), () -> approvalAnswer != null || decision != null);
        approval = null;
        setState("RUNNING", "Running");
        if (!answered) {
            throw ApplicationFailure.newNonRetryableFailure("Nobody answered the approval within " + hours + " hours", "ApprovalTimeout");
        }
        if (approvalAnswer == null) {
            throw ApplicationFailure.newNonRetryableFailure("Torn down while waiting for approval", "Cancelled");
        }
        boolean yes = approvalAnswer;
        approvalAnswer = null;
        if (!yes) {
            throw ApplicationFailure.newNonRetryableFailure("Rejected by " + approvalBy
                    + (blank(approvalNote) ? "" : ": " + approvalNote), "Rejected");
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("approvedBy", approvalBy);
        out.put("note", approvalNote == null ? "" : approvalNote);
        return new ActionResult(out, "approved by " + approvalBy);
    }

    // ------------------------------------------------------------------ teardown

    /** Undoes every step that did something, newest first, including the failed one's partial work. */
    private void teardown(int lastIndex) {
        setState("TEARING_DOWN", "Tearing down (" + decisionBy + ": " + (blank(decisionNote) ? "no reason given" : decisionNote) + ")");
        saveRun(false);
        audit("RUN_TEARDOWN_STARTED", decisionBy, blank(decisionNote) ? "" : decisionNote);
        int problems = 0;
        for (int j = lastIndex; j >= 0; j--) {
            StepState s = steps.get(j);
            if (!"DONE".equals(s.state()) && !"FAILED".equals(s.state())) continue;
            if (!NEEDS_UNDO.contains(s.action()) || !resolved.containsKey(s.id())) continue;
            if (Boolean.TRUE.equals(s.output() == null ? null : s.output().get("reused"))) {
                note("Kept " + s.id() + ": the VM was already there before this run");
                continue;
            }
            try {
                String undoNote = undoer.undo(s.action(), resolved.get(s.id()), s.output(), decisionBy);
                put(j, "UNDONE", s.output(), null, false);
                note("Undid " + s.id() + ": " + undoNote);
            } catch (TemporalFailure e) {
                problems++;
                put(j, "UNDO_FAILED", s.output(), VmReconcileWorkflowImpl.reason(e), false);
                note("Couldn't undo " + s.id() + ": " + steps.get(j).error());
            }
        }
        if (problems == 0) setState("TORN_DOWN", "Torn down by " + decisionBy + ": everything the run did is undone");
        else setState("TEARDOWN_INCOMPLETE", problems + " step(s) couldn't be undone; see the steps marked UNDO_FAILED");
        saveRun(true);
        audit(state.equals("TORN_DOWN") ? "RUN_TORN_DOWN" : "RUN_TEARDOWN_INCOMPLETE", decisionBy, message);
    }

    // ------------------------------------------------------------------ updates and query

    @Override
    public RunStatus status() {
        return new RunStatus(workflowId, def == null ? null : def.name(),
                def == null ? 0 : def.version(), state, message,
                req == null ? null : req.requestedBy(), req == null ? null : req.classification(),
                req == null ? null : req.params(), List.copyOf(steps), failedStep,
                recoveryDeadlineMs > 0 ? iso(recoveryDeadlineMs) : null, approval,
                List.copyOf(history.subList(Math.max(0, history.size() - 50), history.size())));
    }

    @Override
    public void validateResume(String actor, String note) {
        requireActor(actor);
        if (!"AWAITING_RECOVERY".equals(state) || decision != null) {
            throw new IllegalStateException("Only a run stopped after a failed step can be resumed; this one is " + state);
        }
    }

    @Override
    public RunStatus resume(String actor, String note) {
        decision = "resume";
        decisionBy = actor;
        decisionNote = note;
        note("Resume requested by " + actor + (blank(note) ? "" : ": " + note));
        setState("RUNNING", "Resumed by " + actor + ": running step '" + failedStep + "' again");
        return status();
    }

    @Override
    public void validateTeardown(String actor, String reason) {
        requireActor(actor);
        if (!("AWAITING_RECOVERY".equals(state) || "AWAITING_APPROVAL".equals(state)) || decision != null) {
            throw new IllegalStateException("A run can be torn down while it waits after a failure or for an approval; this one is " + state);
        }
    }

    @Override
    public RunStatus teardown(String actor, String reason) {
        decision = "teardown";
        decisionBy = actor;
        decisionNote = reason;
        note("Tear down requested by " + actor + (blank(reason) ? "" : ": " + reason));
        setState("TEARING_DOWN", "Tearing down, as asked by " + actor);
        return status();
    }

    @Override
    public void validateApprove(String actor, boolean approved, String note) {
        requireActor(actor);
        if (!"AWAITING_APPROVAL".equals(state) || approval == null || approvalAnswer != null) {
            throw new IllegalStateException("This run isn't waiting for an approval; it is " + state);
        }
        if (actor.equals(req.requestedBy())) {
            throw new IllegalStateException("You started this run, so someone else has to approve it");
        }
        if (!approval.approvers().isEmpty() && !approval.approvers().contains(actor)) {
            throw new IllegalStateException("Only " + String.join(", ", approval.approvers()) + " can answer this approval");
        }
    }

    @Override
    public RunStatus approve(String actor, boolean approved, String note) {
        Approval asked = approval;   // the main loop clears it as soon as the answer is in
        approvalAnswer = approved;
        approvalBy = actor;
        approvalNote = note;
        note((approved ? "Approved" : "Rejected") + " by " + actor + (blank(note) ? "" : ": " + note));
        RunStatus now = status();
        records.logDecision(actor, "run.approve", workflowId, true,
                asked.approvers().isEmpty() ? "four-eyes (anyone but the requester)" : "approvers list and four-eyes",
                (approved ? "approved" : "rejected") + " step " + asked.step(), req.classification().code());
        audit(approved ? "APPROVED" : "REJECTED", actor, asked.step() + (blank(note) ? "" : ": " + note));
        return now;
    }

    // ------------------------------------------------------------------ helpers

    private CatalogActivities actionStub(StepDef d) {
        return Workflow.newActivityStub(CatalogActivities.class, ActivityOptions.newBuilder()
                .setStartToCloseTimeout(Duration.ofMinutes(Math.max(1, d.timeoutMinutes())))
                .setHeartbeatTimeout(Duration.ofMinutes(2))
                .setRetryOptions(RetryOptions.newBuilder()
                        .setMaximumAttempts(Math.max(1, d.attempts()))
                        .setInitialInterval(Duration.ofSeconds(2))
                        .setMaximumInterval(Duration.ofMinutes(1))
                        .setDoNotRetry("InvalidStep", "NotFound")
                        .build())
                .build());
    }

    private Map<String, Object> vars() {
        Map<String, Object> v = new HashMap<>();
        v.put("params", req.params() == null ? Map.of() : req.params());
        v.put("steps", outputs);
        v.put("run", runVars());
        return v;
    }

    private Map<String, Object> runVars() {
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("id", workflowId);
        r.put("definition", def.name());
        r.put("version", def.version());
        r.put("requestedBy", req.requestedBy() == null ? "" : req.requestedBy());
        r.put("classification", req.classification().code());
        return r;
    }

    private void put(int i, String newState, Map<String, Object> output, String error, boolean starting) {
        StepState s = steps.get(i);
        String now = iso(Workflow.currentTimeMillis());
        steps.set(i, new StepState(s.id(), s.action(), s.title(), newState, starting ? s.attempts() + 1 : s.attempts(),
                output != null ? output : starting ? null : s.output(), error,
                starting ? now : s.startedAt() == null ? now : s.startedAt(),
                starting ? null : now));
    }

    private void setState(String newState, String text) {
        state = newState;
        message = text;
        if (req.searchAttributes()) Workflow.upsertTypedSearchAttributes(RequestSearch.STATE.valueSet(newState));
    }

    private void saveRun(boolean finished) {
        records.saveRun(workflowId, Workflow.getInfo().getRunId(), def.name(), def.version(),
                req.classification().code(), req.requestedBy(), state, finished);
    }

    private void audit(String event, String actor, String detail) {
        audit.audit(workflowId, null, event, actor == null ? "system" : actor, detail);
    }

    private void note(String text) {
        history.add(iso(Workflow.currentTimeMillis()) + "  " + text);
        if (history.size() > HISTORY_KEPT) history.remove(0);
    }

    private static void requireActor(String actor) {
        if (actor == null || actor.isBlank()) throw new IllegalArgumentException("Say who is asking (actor)");
    }

    private static String title(StepDef d) {
        return blank(d.title()) ? Actions.ALL.containsKey(d.action()) ? Actions.ALL.get(d.action()).summary() : d.action() : d.title();
    }

    private static int clamp(Object v, int min, int max, int dflt) {
        if (!(v instanceof Number n)) return dflt;
        return (int) Math.max(min, Math.min(max, n.longValue()));
    }

    private static boolean blank(String s) {
        return s == null || s.isBlank();
    }

    /** "30 days", "36 hours". */
    static String span(int hours) {
        if (hours % 24 == 0) return hours / 24 + (hours == 24 ? " day" : " days");
        return hours + (hours == 1 ? " hour" : " hours");
    }

    private static String iso(long ms) {
        return Instant.ofEpochMilli(ms).toString();
    }
}
