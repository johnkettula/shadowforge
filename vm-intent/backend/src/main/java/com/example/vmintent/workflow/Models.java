package com.example.vmintent.workflow;

import com.example.vmintent.intent.Interpretation;
import com.example.vmintent.spec.VmSpec;
import io.swagger.v3.oas.annotations.media.Schema;

import java.util.List;

/** Small data records passed into and out of workflows and activities. */
public final class Models {
    private Models() {}

    public record IntentRequest(String text, String userId, String channel) {}

    /** requestId = the IntentWorkflow or batch that asked for it, or null for the legacy JSON API. */
    public record ReconcileRequest(VmSpec spec, String specHash, String requestedBy, String requestId) {}

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
                    "PROVISIONING", "COMPLETED", "FAILED", "CANCELLED", "DUPLICATE", "BUSY"})
            String state,
            @Schema(description = "Human-readable status, or the question being asked.") String message,
            Interpretation interpretation,
            @Schema(description = "Set once the VM is running.") VmResult vm,
            @Schema(description = "Timestamped steps so far.") List<String> history) {}

    @Schema(description = "One VM in the inventory.")
    public record VmRecord(String specHash, VmSpec spec,
                           @Schema(allowableValues = {"PROVISIONING", "RUNNING", "FAILED", "DELETED"}) String state,
                           @Schema(description = "Provider plan, or why it failed.") String detail,
                           VmResult result,
                           @Schema(description = "ISO-8601 time of the last change.") String updatedAt) {}

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
