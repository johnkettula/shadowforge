package com.example.vmintent.workflow;

import com.example.vmintent.workflow.Models.LifecycleRequest;
import com.example.vmintent.workflow.Models.LinkReply;
import com.example.vmintent.workflow.Models.Route;
import com.example.vmintent.workflow.Models.VmLifecycle;
import com.example.vmintent.workflow.Models.VmResult;
import io.temporal.activity.ActivityOptions;
import io.temporal.common.RetryOptions;
import io.temporal.failure.ActivityFailure;
import io.temporal.failure.ApplicationFailure;
import io.temporal.spring.boot.WorkflowImpl;
import io.temporal.workflow.Workflow;
import io.temporal.workflow.WorkflowLock;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * See VmLifecycleWorkflow. Workflow code must be deterministic: the clock is
 * Workflow.currentTimeMillis(), waiting is Workflow.await / Workflow.sleep, and anything that
 * touches the outside world is an activity.
 *
 * How expiry works: the main loop works out the next moment that matters (the warning, or the
 * expiry itself) and waits for it with Workflow.await(timeout, condition). The condition wakes
 * it early when something changes, such as a renewal. A VM that expires in 30 days costs
 * nothing for those 30 days: no thread, no polling, just a timer on the Temporal server.
 */
@WorkflowImpl(taskQueues = TaskQueues.INTENT)
public class VmLifecycleWorkflowImpl implements VmLifecycleWorkflow {

    static final long DAY_MS = Duration.ofDays(1).toMillis();
    static final int MAX_RENEW_DAYS = 90;
    static final int MAX_DAYS_AHEAD = 365;
    static final int MAX_SNAPSHOTS = 20;
    static final int MAX_VCPU = 64;
    static final int MAX_MEMORY_GIB = 512;
    /** If removing an expired VM fails, try again after this long. */
    static final Duration RETRY_DECOMMISSION = Duration.ofHours(1);
    /** Start a fresh history (continue-as-new) after this many events, so years of changes stay fast. */
    static final int HISTORY_LIMIT = 2_000;

    static String workflowId(String specHash) {
        return "life-" + specHash;
    }

    private final RecordActivities records = Workflow.newActivityStub(RecordActivities.class,
            ActivityOptions.newBuilder()
                    .setStartToCloseTimeout(Duration.ofSeconds(10))
                    .setRetryOptions(RetryOptions.newBuilder().setMaximumInterval(Duration.ofSeconds(30)).build())
                    .build());

    /** One change at a time: a resize and a power-off must not run at once. */
    private final WorkflowLock busy = Workflow.newWorkflowLock();

    private LifecycleRequest req;
    private CloudOps cloud;
    private LinkReply early;

    private String state = "ACTIVE";
    private long expiresAtMs;
    private boolean warned;
    private String power = "ON";
    private int vcpu;
    private int memoryGiB;
    private final List<String> snapshots = new ArrayList<>();
    private final List<String> history = new ArrayList<>();
    /** Set whenever something changes that the main loop should look at again. */
    private boolean changed;
    /** After a failed removal of an expired VM: don't try again before this time. */
    private long retryAt;

    @Override
    public void run(LifecycleRequest request) {
        req = request;
        Route route = CloudOps.linkStub().route(request.spec().provider());
        cloud = new CloudOps(request.spec().provider(), route, request.specHash(), request.specHash(), request.requestedBy());
        if (early != null) cloud.receive(early);

        if (request.carried() != null) {
            restore(request.carried());
        } else {
            vcpu = request.spec().vcpu();
            memoryGiB = request.spec().memoryGiB();
            int ttl = request.spec().ttlDays();
            expiresAtMs = ttl == 0 ? 0 : now() + ttl * DAY_MS;
            log("Running" + (ttl == 0 ? "; never expires" : "; expires " + iso(expiresAtMs)));
            save(null);
            audit("LIFECYCLE_STARTED", "system", ttl == 0 ? "No expiry" : "Expires " + iso(expiresAtMs));
        }

        while (!terminal()) {
            if (Workflow.getInfo().getHistoryLength() > HISTORY_LIMIT || Workflow.getInfo().isContinueAsNewSuggested()) {
                // Let any change in progress finish, then carry the state into a fresh run.
                Workflow.await(Workflow::isEveryHandlerFinished);
                Workflow.continueAsNew(new LifecycleRequest(req.spec(), req.specHash(), req.vm(),
                        req.requestedBy(), req.requestId(), snapshotState()));
            }
            changed = false;
            long now = now();
            if (expiresAtMs == 0) {
                Workflow.await(() -> changed || terminal());
                continue;
            }
            if (now >= expiresAtMs) {
                if (now >= retryAt) expire();
                else Workflow.await(Duration.ofMillis(retryAt - now), () -> changed || terminal());
                continue;
            }
            long warnAt = expiresAtMs - warningLead();
            if (!warned && now >= warnAt) {
                warn();
                continue;
            }
            long wakeAt = warned ? expiresAtMs : warnAt;
            Workflow.await(Duration.ofMillis(wakeAt - now), () -> changed || terminal());
        }
        if ("MISSING".equals(state)) {
            save(null);
            audit("LIFECYCLE_ENDED", "system", "VM no longer in its cloud");
        }
        // Updates still running (e.g. a decommission's reply) finish before the workflow closes.
        Workflow.await(Workflow::isEveryHandlerFinished);
    }

    // ------------------------------------------------------------------ queries and signals

    @Override
    public VmLifecycle status() {
        return snapshotState();
    }

    @Override
    public void linkReply(LinkReply reply) {
        if (cloud != null) cloud.receive(reply);
        else early = reply;
    }

    @Override
    public void markMissing(String detail) {
        if (terminal()) return;
        state = "MISSING";
        log("Gone from the cloud: " + detail);
        changed = true;
    }

    // ------------------------------------------------------------------ updates

    @Override
    public void validateRenew(String actor, int days) {
        requireActive();
        if (expiresAtMs == 0) reject("This VM never expires, so there is nothing to renew.");
        if (days < 1 || days > MAX_RENEW_DAYS) reject("Renew for 1 to " + MAX_RENEW_DAYS + " days.");
        long newExpiry = Math.max(expiresAtMs, now()) + days * DAY_MS;
        if (newExpiry > now() + MAX_DAYS_AHEAD * DAY_MS) {
            reject("A VM can't be renewed to more than " + MAX_DAYS_AHEAD + " days from today.");
        }
    }

    @Override
    public VmLifecycle renew(String actor, int days) {
        busy.lock();
        try {
            expiresAtMs = Math.max(expiresAtMs, now()) + days * DAY_MS;
            warned = false;
            log("Renewed for " + days + " days by " + actor + "; now expires " + iso(expiresAtMs));
            save(null);
            audit("RENEWED", actor, days + " days; expires " + iso(expiresAtMs));
            changed = true;
            return snapshotState();
        } finally {
            busy.unlock();
        }
    }

    @Override
    public void validateResize(String actor, int newVcpu, int newMemoryGiB) {
        requireActive();
        if (newVcpu < 1 || newVcpu > MAX_VCPU) reject("vCPU must be 1 to " + MAX_VCPU + ".");
        if (newMemoryGiB < 1 || newMemoryGiB > MAX_MEMORY_GIB) reject("Memory must be 1 to " + MAX_MEMORY_GIB + " GiB.");
        if (newVcpu == vcpu && newMemoryGiB == memoryGiB) reject("The VM already has that size.");
    }

    @Override
    public VmLifecycle resize(String actor, int newVcpu, int newMemoryGiB) {
        busy.lock();
        try {
            String from = vcpu + " vCPU / " + memoryGiB + " GiB";
            String to = newVcpu + " vCPU / " + newMemoryGiB + " GiB";
            try {
                cloud.resize(vmId(), newVcpu, newMemoryGiB);
            } catch (ActivityFailure | ApplicationFailure e) {
                // Nothing changed on our side; the caller sees why.
                log("Resize to " + to + " failed: " + VmReconcileWorkflowImpl.reason(e));
                audit("RESIZE_FAILED", actor, to + ": " + VmReconcileWorkflowImpl.reason(e));
                throw ApplicationFailure.newFailure("Resize failed: " + VmReconcileWorkflowImpl.reason(e), "ResizeFailed");
            }
            vcpu = newVcpu;
            memoryGiB = newMemoryGiB;
            log("Resized from " + from + " to " + to + " by " + actor);
            save(null);
            audit("RESIZED", actor, from + " -> " + to);
            return snapshotState();
        } finally {
            busy.unlock();
        }
    }

    @Override
    public void validatePower(String actor, boolean on) {
        requireActive();
        if (on == "ON".equals(power)) reject("The VM is already " + (on ? "on" : "off") + ".");
    }

    @Override
    public VmLifecycle power(String actor, boolean on) {
        busy.lock();
        try {
            try {
                cloud.power(vmId(), on);
            } catch (ActivityFailure | ApplicationFailure e) {
                audit("POWER_FAILED", actor, VmReconcileWorkflowImpl.reason(e));
                throw ApplicationFailure.newFailure("Power " + (on ? "on" : "off") + " failed: "
                        + VmReconcileWorkflowImpl.reason(e), "PowerFailed");
            }
            power = on ? "ON" : "OFF";
            log("Powered " + (on ? "on" : "off") + " by " + actor);
            save(null);
            audit(on ? "POWERED_ON" : "POWERED_OFF", actor, vmId());
            return snapshotState();
        } finally {
            busy.unlock();
        }
    }

    @Override
    public void validateSnapshot(String actor, String label) {
        requireActive();
        if (label == null || !label.matches("[a-z0-9][a-z0-9-]{0,39}")) {
            reject("Snapshot label: lowercase letters, digits and dashes, up to 40 characters.");
        }
        if (snapshots.size() >= MAX_SNAPSHOTS) reject("This VM already has " + MAX_SNAPSHOTS + " snapshots.");
    }

    @Override
    public VmLifecycle snapshot(String actor, String label) {
        busy.lock();
        try {
            String id;
            try {
                id = cloud.snapshot(vmId(), label);
            } catch (ActivityFailure | ApplicationFailure e) {
                audit("SNAPSHOT_FAILED", actor, VmReconcileWorkflowImpl.reason(e));
                throw ApplicationFailure.newFailure("Snapshot failed: " + VmReconcileWorkflowImpl.reason(e), "SnapshotFailed");
            }
            snapshots.add(id + " (" + label + ", " + iso(now()) + ")");
            log("Snapshot " + id + " (" + label + ") by " + actor);
            save(null);
            audit("SNAPSHOT", actor, id + " " + label);
            return snapshotState();
        } finally {
            busy.unlock();
        }
    }

    @Override
    public void validateDecommission(String actor, String reason) {
        requireActive();
    }

    @Override
    public VmLifecycle decommission(String actor, String reason) {
        busy.lock();
        try {
            if (!terminal()) {   // the VM may have expired while this update waited its turn
                removeVm(actor, reason == null || reason.isBlank() ? "Removed on request" : reason);
            }
            return snapshotState();
        } finally {
            busy.unlock();
        }
    }

    // ------------------------------------------------------------------ expiry

    /** Warn ahead of time: 3 days for a VM that lives a week or more, less for short-lived ones. */
    private long warningLead() {
        int ttl = req.spec().ttlDays();
        if (ttl >= 7) return 3 * DAY_MS;
        if (ttl >= 2) return DAY_MS;
        return Duration.ofHours(6).toMillis();
    }

    private void warn() {
        warned = true;
        String text = "VM " + req.spec().name() + " (" + vmId() + ") will be removed on " + iso(expiresAtMs)
                + " unless it is renewed.";
        log("Expiry warning sent to " + req.requestedBy());
        save(null);
        // Recorded as an audit event; NOTIFY events are where an email or chat message would go out.
        audit("EXPIRY_WARNING", "system", "To " + req.requestedBy() + ": " + text);
    }

    private void expire() {
        busy.lock();
        try {
            if (terminal() || now() < expiresAtMs) return;   // renewed or removed meanwhile
            try {
                removeVm("system", "Expired on " + iso(expiresAtMs));
            } catch (ApplicationFailure e) {
                // Try again later; meanwhile the lock is free, so a renewal can still save the VM.
                retryAt = now() + RETRY_DECOMMISSION.toMillis();
                log("Removing the expired VM failed; trying again at " + iso(retryAt));
            }
        } finally {
            busy.unlock();
        }
    }

    /** Deletes the VM and marks it DELETED. On failure the VM stays ACTIVE and the error goes back up. */
    private void removeVm(String actor, String why) {
        state = "DECOMMISSIONING";
        log("Removing: " + why + " (" + actor + ")");
        save(null);
        try {
            cloud.delete(vmId());
        } catch (ActivityFailure | ApplicationFailure e) {
            String r = VmReconcileWorkflowImpl.reason(e);
            if (!r.contains("not found")) {
                state = "ACTIVE";
                log("Remove failed: " + r);
                save(null);
                audit("DECOMMISSION_FAILED", actor, r);
                throw ApplicationFailure.newFailure("Remove failed: " + r, "DecommissionFailed");
            }
            // Already gone from the cloud: that's the outcome we wanted.
        }
        state = "DECOMMISSIONED";
        log("Removed");
        records.save(req.specHash(), req.spec(), "DELETED", why, req.vm());
        save(null);
        audit("DECOMMISSIONED", actor, why);
        changed = true;
    }

    // ------------------------------------------------------------------ helpers

    private boolean terminal() {
        return "DECOMMISSIONED".equals(state) || "MISSING".equals(state);
    }

    private void requireActive() {
        if (!"ACTIVE".equals(state)) reject("This VM is " + state.toLowerCase() + ".");
    }

    /** A validator refusal: goes straight back to the caller and is not recorded in the history. */
    private static void reject(String message) {
        throw new IllegalArgumentException(message);
    }

    private String vmId() {
        VmResult vm = req.vm();
        return vm == null ? null : vm.vmId();
    }

    private long now() {
        return Workflow.currentTimeMillis();
    }

    private static String iso(long ms) {
        return ms == 0 ? "" : Instant.ofEpochMilli(ms).toString();
    }

    private void log(String line) {
        history.add(iso(now()).substring(0, 19).replace('T', ' ') + "  " + line);
        if (history.size() > 50) history.remove(0);
    }

    private void save(String inventoryState) {
        records.saveLifecycle(req.specHash(), inventoryState, snapshotState());
    }

    private void audit(String event, String actor, String detail) {
        records.audit(req.requestId(), req.specHash(), event, actor, detail);
    }

    private VmLifecycle snapshotState() {
        return new VmLifecycle(state, iso(expiresAtMs), expiresAtMs, warned, power, vcpu, memoryGiB,
                List.copyOf(snapshots), req == null ? null : req.requestedBy(), List.copyOf(history));
    }

    private void restore(VmLifecycle s) {
        state = s.state();
        expiresAtMs = s.expiresAtMs();
        warned = s.warned();
        power = s.power();
        vcpu = s.vcpu();
        memoryGiB = s.memoryGiB();
        snapshots.addAll(s.snapshots());
        history.addAll(s.history());
        log("Continued in a fresh history");
    }
}
