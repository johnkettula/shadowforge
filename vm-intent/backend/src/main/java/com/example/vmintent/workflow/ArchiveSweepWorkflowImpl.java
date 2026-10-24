package com.example.vmintent.workflow;

import com.example.vmintent.workflow.ArchiveActivities.ClosedRun;
import com.example.vmintent.workflow.ArchiveActivities.SweepReport;
import io.temporal.activity.ActivityOptions;
import io.temporal.common.RetryOptions;
import io.temporal.failure.ActivityFailure;
import io.temporal.spring.boot.WorkflowImpl;
import io.temporal.workflow.Workflow;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

@WorkflowImpl(taskQueues = TaskQueues.INTENT)
public class ArchiveSweepWorkflowImpl implements ArchiveSweepWorkflow {

    /** Most histories one sweep copies; the next sweep carries on. */
    static final int BATCH = 1000;

    private final ArchiveActivities archive = Workflow.newActivityStub(ArchiveActivities.class,
            ActivityOptions.newBuilder()
                    .setStartToCloseTimeout(Duration.ofMinutes(5))
                    .setRetryOptions(RetryOptions.newBuilder().setMaximumAttempts(3)
                            .setMaximumInterval(Duration.ofSeconds(30)).build())
                    .build());

    @Override
    public SweepReport sweep() {
        List<ClosedRun> todo = archive.findUnarchived(BATCH);
        int archived = 0, already = 0;
        List<String> failures = new ArrayList<>();
        for (ClosedRun run : todo) {
            try {
                if (archive.archive(run)) archived++;
                else already++;
            } catch (ActivityFailure e) {
                failures.add(run.workflowId() + "/" + run.runId() + ": " + VmReconcileWorkflowImpl.reason(e));
            }
        }
        int[] expired = archive.expire();
        return new SweepReport(Instant.ofEpochMilli(Workflow.currentTimeMillis()).toString(), archived, already,
                failures.size(), failures.size() > 20 ? failures.subList(0, 20) : failures, expired[0], expired[1]);
    }
}
