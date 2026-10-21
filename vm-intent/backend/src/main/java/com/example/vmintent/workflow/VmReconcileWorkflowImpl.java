package com.example.vmintent.workflow;

import com.example.vmintent.provider.ProviderActivities;
import com.example.vmintent.workflow.Models.ProviderPlan;
import com.example.vmintent.workflow.Models.ReconcileRequest;
import com.example.vmintent.workflow.Models.VmResult;
import io.temporal.activity.ActivityOptions;
import io.temporal.common.RetryOptions;
import io.temporal.failure.ActivityFailure;
import io.temporal.spring.boot.WorkflowImpl;
import io.temporal.workflow.Saga;
import io.temporal.workflow.Workflow;

import java.time.Duration;

@WorkflowImpl(taskQueues = TaskQueues.INTENT)
public class VmReconcileWorkflowImpl implements VmReconcileWorkflow {

    private final RecordActivities records = Workflow.newActivityStub(
            RecordActivities.class,
            ActivityOptions.newBuilder().setStartToCloseTimeout(Duration.ofSeconds(10)).build());

    @Override
    public VmResult reconcile(ReconcileRequest request) {
        // The provider activities run on that provider's own task queue,
        // so each cloud's worker (and credentials) can live somewhere else.
        ProviderActivities provider = Workflow.newActivityStub(
                ProviderActivities.class,
                ActivityOptions.newBuilder()
                        .setTaskQueue(TaskQueues.forProvider(request.spec().provider()))
                        .setStartToCloseTimeout(Duration.ofMinutes(10))
                        .setHeartbeatTimeout(Duration.ofSeconds(30))
                        .setRetryOptions(RetryOptions.newBuilder()
                                .setInitialInterval(Duration.ofSeconds(2))
                                .setBackoffCoefficient(2.0)
                                .setMaximumAttempts(5)
                                .build())
                        .build());

        // Saga = a list of "undo" steps, run in reverse if something fails.
        Saga saga = new Saga(new Saga.Options.Builder().build());
        String hash = request.specHash();
        try {
            ProviderPlan plan = provider.plan(request.spec());
            records.save(hash, request.spec(), "PROVISIONING", plan.summary(), null);
            records.audit(request.requestId(), hash, "PROVISIONING", "system", plan.summary());

            String vmId = provider.createVm(request.spec(), plan, hash);
            saga.addCompensation(provider::deleteVm, vmId);
            records.audit(request.requestId(), hash, "VM_CREATED", "system", vmId);

            String ip = provider.waitUntilReady(vmId, request.spec().name());

            VmResult result = new VmResult(vmId, ip, request.spec().provider(),
                    plan.nativeRegion(), plan.nativeSize(), plan.nativeImage());
            records.save(hash, request.spec(), "RUNNING", plan.summary(), result);
            records.audit(request.requestId(), hash, "RUNNING", "system", vmId + " at " + ip);
            return result;
        } catch (ActivityFailure e) {
            saga.compensate();
            String reason = e.getCause() != null ? e.getCause().getMessage() : e.getMessage();
            records.save(hash, request.spec(), "FAILED", "Rolled back: " + reason, null);
            records.audit(request.requestId(), hash, "ROLLED_BACK", "system", reason);
            throw e;
        }
    }
}
