package com.example.vmintent.workflow;

import com.example.vmintent.workflow.Models.BatchItem;
import com.example.vmintent.workflow.Models.ReconcileRequest;
import com.example.vmintent.workflow.Models.ShardProgress;
import com.example.vmintent.workflow.Models.ShardRequest;
import com.example.vmintent.workflow.Models.VmResult;
import io.temporal.activity.ActivityOptions;
import io.temporal.api.enums.v1.ParentClosePolicy;
import io.temporal.api.enums.v1.WorkflowIdReusePolicy;
import io.temporal.failure.ApplicationFailure;
import io.temporal.failure.TemporalFailure;
import io.temporal.spring.boot.WorkflowImpl;
import io.temporal.workflow.Async;
import io.temporal.workflow.ChildWorkflowOptions;
import io.temporal.workflow.Promise;
import io.temporal.workflow.Workflow;

import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;

/**
 * Sliding window: keep up to maxInFlight VM builds running; each time one finishes,
 * start the next. Each VM is its own VmReconcileWorkflow (ID "vm-" + spec hash), so
 * an identical spec that is already being built or already exists counts as a duplicate
 * instead of a second VM.
 */
@WorkflowImpl(taskQueues = TaskQueues.INTENT)
public class BatchShardWorkflowImpl implements BatchShardWorkflow {

    private static final int MAX_FAILURES_KEPT = 50;

    private record Done(BatchItem item, VmResult result, RuntimeException error, long startedAt) {}

    private final RecordActivities records = Workflow.newActivityStub(
            RecordActivities.class,
            ActivityOptions.newBuilder().setStartToCloseTimeout(Duration.ofSeconds(10)).build());

    private String batchId;

    private String shardId;
    private int total;
    private int started;
    private int inFlight;
    private int running;
    private int failed;
    private int duplicate;
    private int peakInFlight;
    private boolean done;
    private final List<Long> durationsMs = new ArrayList<>();
    private final List<String> failures = new ArrayList<>();
    private final Deque<Done> finished = new ArrayDeque<>();

    @Override
    public ShardProgress run(ShardRequest request) {
        shardId = Workflow.getInfo().getWorkflowId();
        batchId = request.batchId();
        List<BatchItem> items = request.items();
        total = items.size();
        int next = 0;

        while (next < total || inFlight > 0) {
            while (inFlight < request.maxInFlight() && next < total) {
                start(items.get(next++), request);
            }
            Workflow.await(() -> !finished.isEmpty());
            while (!finished.isEmpty()) {
                record(finished.poll());
            }
        }
        done = true;
        return progress();
    }

    private void start(BatchItem item, ShardRequest request) {
        VmReconcileWorkflow vm = Workflow.newChildWorkflowStub(
                VmReconcileWorkflow.class,
                ChildWorkflowOptions.newBuilder()
                        .setWorkflowId("vm-" + item.specHash())
                        .setTaskQueue(TaskQueues.INTENT)
                        .setParentClosePolicy(ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON)
                        // Build again only if the last attempt failed; otherwise it's a duplicate.
                        .setWorkflowIdReusePolicy(WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE_FAILED_ONLY)
                        .build());
        long t0 = Workflow.currentTimeMillis();
        Promise<VmResult> result = Async.function(vm::reconcile,
                new ReconcileRequest(item.spec(), item.specHash(), request.requestedBy(), request.batchId()));
        started++;
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        result.handle((r, e) -> {
            finished.add(new Done(item, r, e, t0));
            return null;
        });
    }

    private void record(Done d) {
        inFlight--;
        if (d.error() == null) {
            running++;
            durationsMs.add(Workflow.currentTimeMillis() - d.startedAt());
        } else if (isAlreadyStarted(d.error())) {
            duplicate++;
            records.audit(batchId, d.item().specHash(), "DUPLICATE", "system",
                    "Identical VM already exists or is being built");
        } else {
            failed++;
            if (failures.size() < MAX_FAILURES_KEPT) failures.add(rootMessage(d.error()));
        }
    }

    @Override
    public ShardProgress progress() {
        return new ShardProgress(shardId, total, started, inFlight, running, failed, duplicate,
                peakInFlight, List.copyOf(durationsMs), List.copyOf(failures), done);
    }

    /** True when the child couldn't start because a workflow with that ID already exists. */
    static boolean isAlreadyStarted(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            String name = t.getClass().getSimpleName();
            String msg = String.valueOf(t.getMessage());
            if (name.contains("AlreadyStarted") || msg.contains("AlreadyStarted") || msg.contains("already started")) {
                return true;
            }
        }
        return false;
    }

    private static String rootMessage(Throwable e) {
        Throwable t = e;
        while (t.getCause() != null) t = t.getCause();
        if (t instanceof ApplicationFailure af) return af.getOriginalMessage();
        if (t instanceof TemporalFailure tf) return tf.getOriginalMessage();
        return t.getMessage();
    }
}
