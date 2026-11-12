package com.example.vmintent.workflow;

import com.example.vmintent.intent.Interpretation;
import com.example.vmintent.spec.VmSpec;
import io.swagger.v3.oas.annotations.media.Schema;

import java.util.List;
import java.util.Map;

/** Small data records passed into and out of workflows and activities. */
public final class Models {
    private Models() {}

    /**
     * searchAttributes = tag the workflow with VmRequester, VmState etc. so requests can be listed and
     * filtered. Only set when the Temporal server has those attributes (see SearchAttributesSetup).
     * owner = who the VM is for, from sign-in on the server (see VmIdentity); null (as in requests
     * started before it existed) = anonymous. userId is only the name recorded in the audit trail.
     */
    public record IntentRequest(String text, String userId, String channel, boolean searchAttributes, String owner) {
        public IntentRequest(String text, String userId, String channel, boolean searchAttributes) {
            this(text, userId, channel, searchAttributes, null);
        }

        public IntentRequest(String text, String userId, String channel) {
            this(text, userId, channel, false);
        }
    }

    /**
     * requestId = the IntentWorkflow or batch that asked for it, or null for the legacy JSON API.
     * cloudName = the VM's name in the cloud. It is recorded here, not worked out by the build, so a
     * build replays with the name it started with. null (every caller today, and older histories) =
     * spec.name().
     */
    public record ReconcileRequest(VmSpec spec, String specHash, String requestedBy, String requestId,
                                   String cloudName) {}

    /** How a provider translates the abstract spec into its own names. */
    public record ProviderPlan(String nativeRegion, String nativeSize, String nativeImage, String summary) {}

    @Schema(description = "The built VM, in the provider's own terms.")
    public record VmResult(@Schema(example = "i-0b755f1ffc4e") String vmId,
                           @Schema(example = "10.20.0.17") String ipAddress,
                           @Schema(example = "aws") String provider,
                           @Schema(example = "us-east-1") String nativeRegion,
                           @Schema(example = "m6i.xlarge") String nativeSize,
                           @Schema(example = "AMI lookup: ubuntu 24.04") String nativeImage) {}

    /** One status check from a cloud. state = PENDING | RUNNING | FAILED. */
    public record VmStatus(String state, String ipAddress, String detail) {}

    @Schema(description = "Where a request is, and what it understood.")
    public record RequestStatus(
            String requestId,
            @Schema(allowableValues = {"STARTING", "INTERPRETING", "AWAITING_CLARIFICATION", "AWAITING_CONFIRMATION",
                    "PROVISIONING", "COMPLETED", "PARTIAL", "FAILED", "CANCELLED", "DUPLICATE", "BUSY"})
            String state,
            @Schema(description = "Human-readable status, or the question being asked.") String message,
            Interpretation interpretation,
            @Schema(description = "Set once the VM is running.") VmResult vm,
            @Schema(description = "Timestamped steps so far.") List<String> history,
            @Schema(description = "Who made the request.", example = "jdoe@example.com") String requestedBy,
            @Schema(description = "Every VM of a request for more than one (count > 1), in order.") List<VmResult> vms) {
        public RequestStatus(String requestId, String state, String message, Interpretation interpretation,
                             VmResult vm, List<String> history, String requestedBy) {
            this(requestId, state, message, interpretation, vm, history, requestedBy, null);
        }
    }

    @Schema(description = "One VM in the inventory.")
    public record VmRecord(String specHash, VmSpec spec,
                           @Schema(allowableValues = {"PROVISIONING", "RUNNING", "FAILED", "DELETED", "MISSING"}) String state,
                           @Schema(description = "Provider plan, or why it failed.") String detail,
                           VmResult result,
                           @Schema(description = "ISO-8601 time of the last change.") String updatedAt,
                           @Schema(description = "Expiry, power, current size and snapshots, once the VM is running.")
                           VmLifecycle lifecycle) {
        public VmRecord(String specHash, VmSpec spec, String state, String detail, VmResult result, String updatedAt) {
            this(specHash, spec, state, detail, result, updatedAt, null);
        }
    }

    // ------------------------------------------------------------ lifecycle (after the build)

    /** Input of VmLifecycleWorkflow. carried = state handed over by continue-as-new, else null. */
    public record LifecycleRequest(VmSpec spec, String specHash, VmResult vm, String requestedBy,
                                   String requestId, VmLifecycle carried) {}

    @Schema(description = "A running VM's life after the build: expiry, power, size, snapshots.")
    public record VmLifecycle(
            @Schema(allowableValues = {"ACTIVE", "DECOMMISSIONING", "DECOMMISSIONED", "MISSING"}) String state,
            @Schema(description = "When the VM is removed (ISO-8601), or empty if it never expires.") String expiresAt,
            @Schema(description = "Same as expiresAt, in epoch milliseconds; 0 = never.") long expiresAtMs,
            @Schema(description = "The expiry warning has been sent for the current expiry date.") boolean warned,
            @Schema(allowableValues = {"ON", "OFF"}) String power,
            @Schema(description = "Current vCPU (after any resize).") int vcpu,
            @Schema(description = "Current memory in GiB (after any resize).") int memoryGiB,
            @Schema(description = "Snapshots taken, newest last.") List<String> snapshots,
            @Schema(description = "Who owns the VM: the person who asked for it.") String owner,
            @Schema(description = "Timestamped lifecycle events, newest last (the last 50).") List<String> history) {}

    // ------------------------------------------------------------ one-way link to domain 3

    /**
     * How to reach a cloud. oneWay = send orders as files over the one-way link and wait for the
     * answer on the return link, instead of calling the cloud's API.
     */
    public record Route(boolean oneWay, int replyTimeoutMinutes) {
        public static final Route DIRECT = new Route(false, 0);
    }

    /**
     * One order sent to domain 3. type = CREATE | DELETE | RESIZE | POWER | SNAPSHOT.
     * replyTo = the workflow that waits for the answer. idempotencyKey = one build of the VM
     * (spec hash + build): the same key never builds a second VM, and DELETE by key works even
     * if the VM ID never came back. specHash = which VM this is about.
     */
    public record LinkOrder(String orderId, String type, String replyTo, String provider, String idempotencyKey,
                            String specHash,
                            VmSpec spec, ProviderPlan plan, String vmId, Map<String, String> params,
                            String requestedBy, String sentAt) {}

    /** The answer from domain 3, as it arrives on the return link. */
    public record LinkReply(String orderId, String type, boolean ok, String vmId, String ipAddress, String detail) {}

    // ------------------------------------------------------------ scheduled inventory check

    /** What one cloud's check found. missing = spec hashes; orphans = cloud VM IDs nobody recorded. */
    public record InventoryFinding(String provider, String note, int recordedRunning, int inCloud,
                                   List<String> missing, List<String> orphans) {}

    @Schema(description = "The result of one inventory check.")
    public record InventoryReport(String checkId, String startedAt, String finishedAt,
                                  @Schema(description = "VMs marked MISSING by this check.") int missingCount,
                                  @Schema(description = "VMs in a cloud with no record here (reported, not deleted).")
                                  int orphanCount,
                                  List<InventoryFinding> findings) {}

    // ------------------------------------------------------------ batches

    /** One VM in a batch: an already-interpreted, validated spec. */
    public record BatchItem(VmSpec spec, String specHash) {}

    /**
     * A batch of VMs to build without asking anyone (the specs were checked when the
     * batch was submitted). shardSize = how many VMs one shard workflow looks after.
     * maxInFlightPerShard = how many of those it builds at the same time.
     */
    public record BatchRequest(String batchId, List<BatchItem> items, int shardSize,
                               int maxInFlightPerShard, String requestedBy) {}

    public record ShardRequest(String batchId, int shardNo, List<BatchItem> items,
                               int maxInFlight, String requestedBy) {}

    /**
     * Live counts for one shard. durationsMs = how long each finished build took,
     * so the API can report p50 and p95.
     */
    public record ShardProgress(String shardId, int total, int started, int inFlight, int running,
                                int failed, int duplicate, int peakInFlight, List<Long> durationsMs,
                                List<String> failures, boolean done) {}

    /** What the batch workflow itself knows: its shards and whether they have all finished. */
    public record BatchInfo(String batchId, int total, List<String> shardIds, int shardsDone,
                            long startedAtMs, long finishedAtMs, String state) {}
}
