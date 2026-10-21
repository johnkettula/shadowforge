package com.example.vmintent.workflow;

import com.example.vmintent.intent.Interpretation;
import com.example.vmintent.spec.VmSpec;

import java.util.List;

/** Small data records passed into and out of workflows and activities. */
public final class Models {
    private Models() {}

    public record IntentRequest(String text, String userId, String channel) {}

    /** requestId = the IntentWorkflow or batch that asked for it, or null for the legacy JSON API. */
    public record ReconcileRequest(VmSpec spec, String specHash, String requestedBy, String requestId) {}

    /** How a provider translates the abstract spec into its own names. */
    public record ProviderPlan(String nativeRegion, String nativeSize, String nativeImage, String summary) {}

    public record VmResult(String vmId, String ipAddress, String provider,
                           String nativeRegion, String nativeSize, String nativeImage) {}

    /** One status check from a cloud. state = PENDING | RUNNING | FAILED. */
    public record VmStatus(String state, String ipAddress, String detail) {}

    public record RequestStatus(String requestId, String state, String message,
                                Interpretation interpretation, VmResult vm, List<String> history) {}

    public record VmRecord(String specHash, VmSpec spec, String state, String detail,
                           VmResult result, String updatedAt) {}

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
