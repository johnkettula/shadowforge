package com.example.vmintent.workflow;

import com.example.vmintent.provider.ProviderActivities;
import com.example.vmintent.workflow.Models.ProviderPlan;
import com.example.vmintent.workflow.Models.ReconcileRequest;
import com.example.vmintent.workflow.Models.VmResult;
import com.example.vmintent.workflow.Models.VmStatus;
import io.temporal.activity.ActivityOptions;
import io.temporal.common.RetryOptions;
import io.temporal.failure.ActivityFailure;
import io.temporal.failure.ApplicationFailure;
import io.temporal.spring.boot.WorkflowImpl;
import io.temporal.workflow.Saga;
import io.temporal.workflow.Workflow;

import java.time.Duration;

/**
 * Builds one VM. Workflow ID = "vm-" + spec hash, so the same spec can't be built twice at once.
 *
 * Built to run thousands at a time:
 *  - Every cloud call is a short activity. Waiting for boot is a workflow timer
 *    (Workflow.sleep), which holds no thread while it waits.
 *  - Create/delete go to the provider's rate-limited queue (aws-q); plan and status
 *    checks go to its read queue (aws-read-q), which has a looser limit.
 *  - Throttling from the cloud is retried with exponential backoff, for up to 30 minutes.
 */
@WorkflowImpl(taskQueues = TaskQueues.INTENT)
public class VmReconcileWorkflowImpl implements VmReconcileWorkflow {

    /** Give up on a VM that hasn't booted after this long, and roll it back. */
    static final Duration BOOT_DEADLINE = Duration.ofMinutes(30);
    /** First status check, then every few seconds more, up to the maximum. */
    static final Duration FIRST_CHECK = Duration.ofSeconds(15);
    static final Duration MAX_CHECK_INTERVAL = Duration.ofSeconds(30);

    private static final RetryOptions CLOUD_RETRY = RetryOptions.newBuilder()
            .setInitialInterval(Duration.ofSeconds(2))
            .setBackoffCoefficient(2.0)
            .setMaximumInterval(Duration.ofSeconds(60))
            .setDoNotRetry("SimulatedBootFailure", "InvalidSpec", "VmNotFound")
            .build();

    private final RecordActivities records = Workflow.newActivityStub(
            RecordActivities.class,
            ActivityOptions.newBuilder()
                    .setStartToCloseTimeout(Duration.ofSeconds(10))
                    .setRetryOptions(RetryOptions.newBuilder()
                            .setInitialInterval(Duration.ofSeconds(1))
                            .setMaximumInterval(Duration.ofSeconds(30))
                            .build())
                    .build());

    @Override
    public VmResult reconcile(ReconcileRequest request) {
        String cloudName = request.spec().provider();
        ProviderActivities mutate = providerStub(TaskQueues.forProvider(cloudName), Duration.ofSeconds(30));
        ProviderActivities read = providerStub(TaskQueues.readQueue(cloudName), Duration.ofSeconds(15));

        // Saga = a list of "undo" steps, run in reverse if something fails.
        Saga saga = new Saga(new Saga.Options.Builder().build());
        String hash = request.specHash();
        // Recorded first, so the inventory shows the VM as soon as its build begins,
        // even while it waits its turn under the cloud's rate limit.
        records.save(hash, request.spec(), "PROVISIONING", "Queued for " + cloudName, null);
        records.audit(request.requestId(), hash, "PROVISIONING", "system", "Build started on " + cloudName);
        try {
            ProviderPlan plan = read.plan(request.spec());
            records.save(hash, request.spec(), "PROVISIONING", plan.summary(), null);

            String vmId = mutate.createVm(request.spec(), plan, hash);
            saga.addCompensation(mutate::deleteVm, vmId);
            records.audit(request.requestId(), hash, "VM_CREATED", "system", vmId);

            String ip = waitForBoot(read, vmId);

            VmResult result = new VmResult(vmId, ip, cloudName,
                    plan.nativeRegion(), plan.nativeSize(), plan.nativeImage());
            records.save(hash, request.spec(), "RUNNING", plan.summary(), result);
            records.audit(request.requestId(), hash, "RUNNING", "system", vmId + " at " + ip);
            return result;
        } catch (ActivityFailure | ApplicationFailure e) {
            saga.compensate();
            String reason = reason(e);
            records.save(hash, request.spec(), "FAILED", "Rolled back: " + reason, null);
            records.audit(request.requestId(), hash, "ROLLED_BACK", "system", reason);
            throw e;
        }
    }

    /** Check now and then until the VM is running. Sleeping here costs no worker thread. */
    private String waitForBoot(ProviderActivities read, String vmId) {
        long deadline = Workflow.currentTimeMillis() + BOOT_DEADLINE.toMillis();
        Duration wait = FIRST_CHECK;
        long nextInterval = 5_000;
        while (true) {
            Workflow.sleep(wait);
            VmStatus status = read.describeVm(vmId);
            if ("RUNNING".equals(status.state())) return status.ipAddress();
            if ("FAILED".equals(status.state())) {
                throw ApplicationFailure.newNonRetryableFailure(status.detail(), "SimulatedBootFailure");
            }
            if (Workflow.currentTimeMillis() > deadline) {
                throw ApplicationFailure.newNonRetryableFailure(
                        vmId + " did not boot within " + BOOT_DEADLINE.toMinutes() + " minutes", "BootTimeout");
            }
            // Then 5 s, 7.5 s, 11 s, ... up to 30 s between checks.
            wait = Duration.ofMillis(nextInterval);
            nextInterval = Math.min((long) (nextInterval * 1.5), MAX_CHECK_INTERVAL.toMillis());
        }
    }

    private static ProviderActivities providerStub(String taskQueue, Duration callTimeout) {
        return Workflow.newActivityStub(
                ProviderActivities.class,
                ActivityOptions.newBuilder()
                        .setTaskQueue(taskQueue)
                        .setStartToCloseTimeout(callTimeout)
                        // Keep retrying throttled calls (with backoff) for up to 30 minutes.
                        .setScheduleToCloseTimeout(Duration.ofMinutes(30))
                        .setRetryOptions(CLOUD_RETRY)
                        .build());
    }

    private static String reason(Exception e) {
        Throwable t = e;
        while (t.getCause() != null) t = t.getCause();
        if (t instanceof ApplicationFailure af) return af.getOriginalMessage();
        return t.getMessage();
    }
}
