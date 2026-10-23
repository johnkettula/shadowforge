package com.example.vmintent.workflow;

import com.example.vmintent.provider.ProviderActivities;
import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.LinkOrder;
import com.example.vmintent.workflow.Models.LinkReply;
import com.example.vmintent.workflow.Models.ProviderPlan;
import com.example.vmintent.workflow.Models.Route;
import io.temporal.activity.ActivityOptions;
import io.temporal.common.RetryOptions;
import io.temporal.failure.ApplicationFailure;
import io.temporal.workflow.Workflow;

import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Workflow-side helper: one cloud operation, done either directly (an activity on the cloud's
 * queue) or across the one-way link (an order file out, then wait for the answer to come back).
 * The workflows call the same methods either way.
 *
 * Runs inside workflow code, so it follows the same rules: no I/O here, only activities, timers
 * and waits. The waiting costs nothing: a workflow waiting days for a reply holds no thread.
 */
final class CloudOps {

    static final RetryOptions CLOUD_RETRY = RetryOptions.newBuilder()
            .setInitialInterval(Duration.ofSeconds(2))
            .setBackoffCoefficient(2.0)
            .setMaximumInterval(Duration.ofSeconds(60))
            .setDoNotRetry("SimulatedBootFailure", "InvalidSpec", "VmNotFound")
            .build();

    private final String provider;
    private final Route route;
    private final String specHash;
    private final String buildKey;
    private final String requestedBy;
    private final ProviderActivities mutate;
    private final ProviderActivities read;
    private final LinkActivities link;
    /** Answers that came back on the return link, by order ID. */
    private final Map<String, LinkReply> replies = new LinkedHashMap<>();

    /**
     * buildKey = the idempotency key for creating this VM: the spec hash plus something unique to
     * this build, so building the same spec again after it was removed makes a new VM instead of
     * getting the old (deleted) one back.
     */
    CloudOps(String provider, Route route, String specHash, String buildKey, String requestedBy) {
        this.provider = provider;
        this.route = route;
        this.specHash = specHash;
        this.buildKey = buildKey;
        this.requestedBy = requestedBy;
        this.mutate = providerStub(TaskQueues.forProvider(provider), Duration.ofSeconds(30));
        this.read = providerStub(TaskQueues.readQueue(provider), Duration.ofSeconds(15));
        this.link = linkStub();
    }

    boolean oneWay() {
        return route.oneWay();
    }

    ProviderActivities read() {
        return read;
    }

    ProviderActivities mutate() {
        return mutate;
    }

    /** Called from the workflow's linkReply signal. */
    void receive(LinkReply reply) {
        if (reply != null && reply.orderId() != null) replies.put(reply.orderId(), reply);
    }

    ProviderPlan plan(VmSpec spec) {
        return route.oneWay() ? link.planHere(spec) : read.plan(spec);
    }

    void resize(String vmId, int vcpu, int memoryGiB) {
        if (!route.oneWay()) {
            mutate.resizeVm(vmId, vcpu, memoryGiB);
            return;
        }
        sendAndWait("RESIZE", null, null, vmId, Map.of("vcpu", String.valueOf(vcpu), "memoryGiB", String.valueOf(memoryGiB)));
    }

    void power(String vmId, boolean on) {
        if (!route.oneWay()) {
            mutate.setPower(vmId, on);
            return;
        }
        sendAndWait("POWER", null, null, vmId, Map.of("on", String.valueOf(on)));
    }

    String snapshot(String vmId, String label) {
        if (!route.oneWay()) return mutate.snapshotVm(vmId, label);
        LinkReply r = sendAndWait("SNAPSHOT", null, null, vmId, Map.of("label", label));
        return r.detail() != null && !r.detail().isBlank() ? r.detail() : "snapshot " + label;
    }

    void delete(String vmId) {
        if (!route.oneWay()) {
            mutate.deleteVm(vmId);
            return;
        }
        sendAndWait("DELETE", null, null, vmId, Map.of());
    }

    /**
     * Sends a DELETE by idempotency key and doesn't wait for the answer. Used to undo a build whose
     * answer never came: domain 3 removes whatever it built for this key, and its late answer is
     * still written to the audit trail by the listener.
     */
    void deleteByKeyNoWait(VmSpec spec) {
        send("DELETE", spec, null, null, Map.of());
    }

    /** Sends an order and waits for its answer. A refusal or no answer in time fails the step. */
    LinkReply sendAndWait(String type, VmSpec spec, ProviderPlan plan, String vmId, Map<String, String> params) {
        String orderId = send(type, spec, plan, vmId, params);
        Duration timeout = Duration.ofMinutes(Math.max(1, route.replyTimeoutMinutes()));
        boolean answered = Workflow.await(timeout, () -> replies.containsKey(orderId));
        if (!answered) {
            throw ApplicationFailure.newNonRetryableFailure(
                    "No answer from domain 3 for " + type + " order " + orderId + " within "
                            + timeout.toMinutes() + " minutes", "LinkTimeout");
        }
        LinkReply reply = replies.remove(orderId);
        if (!reply.ok()) {
            throw ApplicationFailure.newNonRetryableFailure(
                    "Domain 3 refused " + type + ": " + reply.detail(), "RemoteFailure");
        }
        return reply;
    }

    String send(String type, VmSpec spec, ProviderPlan plan, String vmId, Map<String, String> params) {
        // Workflow.randomUUID() is replay-safe: the same ID comes back every time this code is re-run.
        String orderId = type.toLowerCase() + "-" + Workflow.randomUUID();
        String now = Instant.ofEpochMilli(Workflow.currentTimeMillis()).toString();
        link.send(new LinkOrder(orderId, type, Workflow.getInfo().getWorkflowId(), provider, buildKey, specHash,
                spec, plan, vmId, params, requestedBy, now));
        return orderId;
    }

    static LinkActivities linkStub() {
        return Workflow.newActivityStub(LinkActivities.class, ActivityOptions.newBuilder()
                .setTaskQueue(TaskQueues.INTENT)
                .setStartToCloseTimeout(Duration.ofSeconds(30))
                .setRetryOptions(RetryOptions.newBuilder().setMaximumInterval(Duration.ofSeconds(30)).build())
                .build());
    }

    static ProviderActivities providerStub(String taskQueue, Duration callTimeout) {
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
}
