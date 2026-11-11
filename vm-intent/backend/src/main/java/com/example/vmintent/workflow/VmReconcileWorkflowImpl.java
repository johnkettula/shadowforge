package com.example.vmintent.workflow;

import com.example.vmintent.provider.ProviderActivities;
import com.example.vmintent.spec.VmIdentity;
import com.example.vmintent.workflow.Models.LifecycleRequest;
import com.example.vmintent.workflow.Models.LinkReply;
import com.example.vmintent.workflow.Models.ProviderPlan;
import com.example.vmintent.workflow.Models.ReconcileRequest;
import com.example.vmintent.workflow.Models.Route;
import com.example.vmintent.workflow.Models.VmResult;
import com.example.vmintent.workflow.Models.VmStatus;
import io.temporal.activity.ActivityOptions;
import io.temporal.api.enums.v1.ParentClosePolicy;
import io.temporal.common.RetryOptions;
import io.temporal.failure.ActivityFailure;
import io.temporal.failure.ApplicationFailure;
import io.temporal.failure.TemporalFailure;
import io.temporal.spring.boot.WorkflowImpl;
import io.temporal.workflow.Async;
import io.temporal.workflow.ChildWorkflowOptions;
import io.temporal.workflow.Saga;
import io.temporal.workflow.Workflow;

import java.time.Duration;
import java.util.Map;

/**
 * Builds one VM. Workflow ID = "vm-" + spec hash, so the same spec can't be built twice at once.
 *
 * Built to run thousands at a time:
 *  - Every cloud call is a short activity. Waiting for boot is a workflow timer
 *    (Workflow.sleep), which holds no thread while it waits.
 *  - Create/delete go to the provider's rate-limited queue (aws-q); plan and status
 *    checks go to its read queue (aws-read-q), which has a looser limit.
 *  - Throttling from the cloud is retried with exponential backoff, for up to 30 minutes.
 *
 * Two ways to reach the cloud (see CloudOps):
 *  - direct: call its API from here (the simulated clouds, or a cloud this domain can reach);
 *  - one-way link: send a CREATE order to domain 3 and wait for its answer on the return link.
 *
 * Once the VM runs, a VmLifecycleWorkflow ("life-" + spec hash) takes over: expiry, renewals,
 * resize, power, snapshots and decommissioning.
 *
 * Saga: every step that changes something adds its "undo". If a later step fails, the undo
 * steps run in reverse order, so a failed build never leaves half a VM behind.
 */
@WorkflowImpl(taskQueues = TaskQueues.INTENT)
public class VmReconcileWorkflowImpl implements VmReconcileWorkflow {

    /** Give up on a VM that hasn't booted after this long, and roll it back. */
    static final Duration BOOT_DEADLINE = Duration.ofMinutes(30);
    /** First status check, then every few seconds more, up to the maximum. */
    static final Duration FIRST_CHECK = Duration.ofSeconds(15);
    static final Duration MAX_CHECK_INTERVAL = Duration.ofSeconds(30);

    /**
     * Version marker for the one-way link and lifecycle steps. Builds started before they existed
     * replay with DEFAULT_VERSION and take the old path; see ReplayTest.
     */
    static final String LINK_AND_LIFECYCLE = "link-and-lifecycle";

    private final RecordActivities records = Workflow.newActivityStub(
            RecordActivities.class,
            ActivityOptions.newBuilder()
                    .setStartToCloseTimeout(Duration.ofSeconds(10))
                    .setRetryOptions(RetryOptions.newBuilder()
                            .setInitialInterval(Duration.ofSeconds(1))
                            .setMaximumInterval(Duration.ofSeconds(30))
                            .build())
                    .build());

    private CloudOps cloud;
    /** A reply that arrived before CloudOps was ready (can't happen in practice, but cheap to handle). */
    private LinkReply early;

    @Override
    public VmResult reconcile(ReconcileRequest request) {
        String cloudName = request.spec().provider();
        int version = Workflow.getVersion(LINK_AND_LIFECYCLE, Workflow.DEFAULT_VERSION, 1);
        Route route = version >= 1 ? CloudOps.linkStub().route(cloudName) : Route.DIRECT;
        // One build = one idempotency key. Builds started before this change used the spec hash alone.
        String buildKey = VmIdentity.buildKey(request.specHash(),
                version >= 1 ? Workflow.getInfo().getRunId().substring(0, 8) : null);
        cloud = new CloudOps(cloudName, route, request.specHash(), buildKey, request.requestedBy());
        if (early != null) cloud.receive(early);

        // Saga = a list of "undo" steps, run in reverse if something fails.
        Saga saga = new Saga(new Saga.Options.Builder().build());
        String hash = request.specHash();
        // Recorded first, so the inventory shows the VM as soon as its build begins,
        // even while it waits its turn under the cloud's rate limit.
        records.save(hash, request.spec(), "PROVISIONING", "Queued for " + cloudName, null);
        records.audit(request.requestId(), hash, "PROVISIONING", "system",
                "Build started on " + cloudName + (route.oneWay() ? " (over the one-way link)" : ""));
        try {
            ProviderPlan plan = cloud.plan(request.spec());
            records.save(hash, request.spec(), "PROVISIONING", plan.summary(), null);

            String vmId;
            String ip;
            if (route.oneWay()) {
                // The undo goes in BEFORE the wait: if no answer comes, domain 3 may still have built it.
                saga.addCompensation(() -> cloud.deleteByKeyNoWait(request.spec()));
                records.audit(request.requestId(), hash, "LINK_ORDER_SENT", "system", "CREATE sent to domain 3");
                LinkReply built = cloud.sendAndWait("CREATE", request.spec(), plan, null, Map.of());
                vmId = built.vmId();
                ip = built.ipAddress();
                records.audit(request.requestId(), hash, "VM_CREATED", "system", vmId + " (reported by domain 3)");
            } else {
                vmId = cloud.mutate().createVm(request.spec(), plan, buildKey);
                String created = vmId;
                saga.addCompensation(() -> cloud.mutate().deleteVm(created));
                records.audit(request.requestId(), hash, "VM_CREATED", "system", vmId);
                ip = waitForBoot(cloud.read(), vmId);
            }

            VmResult result = new VmResult(vmId, ip, cloudName,
                    plan.nativeRegion(), plan.nativeSize(), plan.nativeImage());
            records.save(hash, request.spec(), "RUNNING", plan.summary(), result);
            records.audit(request.requestId(), hash, "RUNNING", "system", vmId + " at " + ip);
            if (version >= 1) startLifecycle(request, result);
            return result;
        } catch (ActivityFailure | ApplicationFailure e) {
            saga.compensate();
            String reason = reason(e);
            records.save(hash, request.spec(), "FAILED", "Rolled back: " + reason, null);
            records.audit(request.requestId(), hash, "ROLLED_BACK", "system", reason);
            throw e;
        }
    }

    @Override
    public void linkReply(LinkReply reply) {
        if (cloud != null) cloud.receive(reply);
        else early = reply;
    }

    /**
     * Hands the running VM to its own long-lived workflow. ABANDON = it carries on after this build
     * workflow finishes. We only wait until it has started, not until it ends (which may be months).
     */
    private void startLifecycle(ReconcileRequest request, VmResult result) {
        VmLifecycleWorkflow life = Workflow.newChildWorkflowStub(VmLifecycleWorkflow.class,
                ChildWorkflowOptions.newBuilder()
                        .setWorkflowId(VmLifecycleWorkflowImpl.workflowId(request.specHash()))
                        .setTaskQueue(TaskQueues.INTENT)
                        .setParentClosePolicy(ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON)
                        .build());
        Async.procedure(life::run, new LifecycleRequest(request.spec(), request.specHash(), result,
                request.requestedBy(), request.requestId(), null));
        try {
            Workflow.getWorkflowExecution(life).get();
        } catch (TemporalFailure e) {
            // Already looked after (the same spec was built through another path): keep the VM, note it.
            records.audit(request.requestId(), request.specHash(), "LIFECYCLE_NOT_STARTED", "system", reason(e));
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

    static String reason(Throwable e) {
        Throwable t = e;
        while (t.getCause() != null) t = t.getCause();
        if (t instanceof ApplicationFailure af) return af.getOriginalMessage();
        if (t instanceof TemporalFailure tf) return tf.getOriginalMessage();
        return t.getMessage();
    }
}
