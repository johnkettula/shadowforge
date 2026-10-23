package com.example.vmintent.workflow;

import com.example.vmintent.provider.ProviderActivities;
import com.example.vmintent.workflow.Models.InventoryFinding;
import com.example.vmintent.workflow.Models.InventoryReport;
import com.example.vmintent.workflow.Models.Route;
import io.temporal.activity.ActivityOptions;
import io.temporal.common.RetryOptions;
import io.temporal.failure.ActivityFailure;
import io.temporal.spring.boot.WorkflowImpl;
import io.temporal.workflow.Async;
import io.temporal.workflow.ExternalWorkflowStub;
import io.temporal.workflow.Promise;
import io.temporal.workflow.Workflow;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * See InventoryCheckWorkflow. For each cloud: list its VMs (one call on the cloud's read queue),
 * then compare in the database. Missing VMs are marked MISSING and their lifecycle workflow is
 * told to stop; orphans are only reported, because deleting something we can't explain is a
 * decision for a person.
 *
 * Clouds behind the one-way link are skipped: domain 2 can't look into domain 3. (Domain 3 would
 * run its own check and send the result back on the return link.)
 */
@WorkflowImpl(taskQueues = TaskQueues.INTENT)
public class InventoryCheckWorkflowImpl implements InventoryCheckWorkflow {

    private final InventoryActivities inventory = Workflow.newActivityStub(InventoryActivities.class,
            ActivityOptions.newBuilder()
                    .setStartToCloseTimeout(Duration.ofMinutes(2))
                    .setRetryOptions(RetryOptions.newBuilder().setMaximumAttempts(5).build())
                    .build());

    @Override
    public InventoryReport run() {
        String checkId = Workflow.getInfo().getWorkflowId();
        String started = Instant.ofEpochMilli(Workflow.currentTimeMillis()).toString();
        List<InventoryFinding> findings = new ArrayList<>();
        int missing = 0;
        int orphans = 0;
        for (String provider : TaskQueues.PROVIDERS) {
            Route route = CloudOps.linkStub().route(provider);
            if (route.oneWay()) {
                findings.add(new InventoryFinding(provider, "Skipped: behind the one-way link", 0, 0, List.of(), List.of()));
                continue;
            }
            ProviderActivities read = Workflow.newActivityStub(ProviderActivities.class, ActivityOptions.newBuilder()
                    .setTaskQueue(TaskQueues.readQueue(provider))
                    .setStartToCloseTimeout(Duration.ofMinutes(2))
                    .setScheduleToCloseTimeout(Duration.ofMinutes(15))
                    .setRetryOptions(CloudOps.CLOUD_RETRY)
                    .build());
            List<String> inCloud;
            try {
                inCloud = read.listVmIds();
            } catch (ActivityFailure e) {
                findings.add(new InventoryFinding(provider, "Couldn't list VMs: " + VmReconcileWorkflowImpl.reason(e),
                        0, 0, List.of(), List.of()));
                continue;
            }
            InventoryFinding f = inventory.compare(provider, inCloud);
            findings.add(f);
            missing += f.missing().size();
            orphans += f.orphans().size();
            tellLifecycles(f.missing());
        }
        InventoryReport report = new InventoryReport(checkId, started,
                Instant.ofEpochMilli(Workflow.currentTimeMillis()).toString(), missing, orphans, findings);
        inventory.saveReport(report);
        return report;
    }

    /** These VMs are gone, so their lifecycle workflows should stop waiting to expire them. All at once. */
    private void tellLifecycles(List<String> specHashes) {
        List<Promise<Void>> sent = new ArrayList<>();
        for (String hash : specHashes) {
            ExternalWorkflowStub life = Workflow.newUntypedExternalWorkflowStub(VmLifecycleWorkflowImpl.workflowId(hash));
            String why = "Not found by inventory check " + Workflow.getInfo().getWorkflowId();
            sent.add(Async.procedure(() -> life.signal("markMissing", why)));
        }
        for (Promise<Void> p : sent) {
            try {
                p.get();
            } catch (Exception e) {
                // No lifecycle running for it (e.g. a VM built before lifecycles existed): nothing to tell.
            }
        }
    }
}
