package com.example.vmintent.api;

import com.example.vmintent.spec.VmSpec;
import com.fasterxml.jackson.annotation.JsonInclude;
import io.swagger.v3.oas.annotations.media.Schema;

import java.util.List;
import java.util.Map;

/**
 * Request and response bodies of the public REST API. They appear by name in the
 * OpenAPI document (/v3/api-docs), so client generators produce typed classes.
 * Field names are part of the contract: don't rename them without a new API version.
 */
public final class ApiModels {
    private ApiModels() {}

    // ------------------------------------------------------------------ requests

    @Schema(description = "A VM request in plain English.")
    public record TextBody(
            @Schema(description = "What you want, in your own words.", requiredMode = Schema.RequiredMode.REQUIRED,
                    example = "Ubuntu box, 4 cores, 16 gigs, us-east on AWS")
            String text,
            @Schema(description = "Who is asking. Recorded in the audit trail.", example = "jdoe")
            String userId) {}

    @Schema(description = "An answer to the question a request is waiting on.")
    public record AnswerBody(
            @Schema(description = "The answer, in plain words.", requiredMode = Schema.RequiredMode.REQUIRED,
                    example = "azure")
            String answer) {}

    @Schema(description = "One VM in a batch: either plain text or an exact spec (give one of the two).")
    public record BatchItemBody(
            @Schema(description = "Plain-English request. Rejected if it would need a clarifying question.",
                    example = "small rhel 9 box on prem in dc1 for 2 weeks")
            String text,
            @Schema(description = "Exact spec. Validated against policy; name is optional.")
            VmSpec spec) {}

    @Schema(description = "Many VMs in one request. No confirmation step per VM.")
    public record BatchBody(
            @Schema(description = "1 to 10,000 items.", requiredMode = Schema.RequiredMode.REQUIRED)
            List<BatchItemBody> items,
            @Schema(description = "VMs per shard workflow (1-1000).", defaultValue = "500", example = "500")
            Integer shardSize,
            @Schema(description = "VMs one shard builds at the same time (1 to shardSize).", defaultValue = "shardSize")
            Integer maxInFlightPerShard,
            @Schema(description = "Who is asking. Recorded in the audit trail.", example = "provisioning-service")
            String requestedBy) {}

    // ------------------------------------------------------------------ responses

    @Schema(description = "A request was started.")
    public record SubmitResponse(
            @Schema(description = "ID to use with the other /requests endpoints.",
                    example = "intent-3f2c9a1e-5b7d-4c1a-9e0f-2a6b8c4d1e7f")
            String requestId) {}

    @Schema(description = "A batch item that was not accepted.")
    public record Rejected(
            @Schema(description = "Position in the submitted items list (0-based).", example = "2")
            int index,
            @Schema(description = "Why, or the question that would need answering.",
                    example = "Needs an answer: Which platform should this run on: vSphere (on-prem), AWS, Azure or Google Cloud?")
            String reason) {}

    @Schema(description = "A batch was accepted and started.")
    public record BatchSubmitResponse(
            @Schema(example = "batch-7d1e0c2a-9b4f-4e6a-8c3d-1f2e3a4b5c6d") String batchId,
            @Schema(description = "Items that will be built.", example = "1998") int accepted,
            @Schema(description = "Items identical to an earlier item in the same batch (built once).", example = "0")
            int sameInBatch,
            @Schema(description = "Items not accepted, with the reason.") List<Rejected> rejected,
            @Schema(description = "Shard workflows the batch was split into.", example = "4") int shards) {}

    @Schema(description = "Live progress of a batch, counted from the audit trail.")
    public record BatchStatus(
            String batchId,
            @Schema(allowableValues = {"RUNNING", "COMPLETED"}) String state,
            @Schema(description = "VMs accepted into the batch.") long total,
            long shardSize,
            @Schema(description = "VMs whose build has started.") long started,
            @Schema(description = "Started but not finished.") long inFlight,
            @Schema(description = "Built and running.") long running,
            @Schema(description = "Failed and rolled back (deleted).") long failed,
            @Schema(description = "Not built because an identical VM already exists or is being built.") long duplicate,
            @Schema(description = "Median seconds from submit to running.") Double p50Seconds,
            @Schema(description = "95th percentile seconds from submit to running.") Double p95Seconds,
            @Schema(description = "Slowest VM, seconds from submit to running.") Double maxSeconds,
            @Schema(description = "When the batch was submitted (epoch milliseconds).") Long startedAtMs,
            @Schema(description = "When the batch finished (epoch milliseconds), or null.") Long finishedAtMs,
            @Schema(description = "Up to 20 failure reasons.") List<String> failures) {}

    @Schema(description = "Inventory counts.")
    public record StatsResponse(
            @Schema(description = "Number of VMs in each state.", example = "{\"RUNNING\": 1980, \"FAILED\": 20}")
            Map<String, Long> vmsByState) {}

    @Schema(description = "A legacy JSON definition was accepted and its build started.")
    public record LegacyAccepted(
            @Schema(description = "Temporal workflow ID: vm- plus the spec hash.") String workflowId,
            @Schema(description = "SHA-256 of the canonical spec.") String specHash,
            VmSpec spec,
            @Schema(description = "One-line summary of the spec.") String summary) {}

    @Schema(description = "Error body returned with every 4xx and 5xx response.")
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ApiError(
            @Schema(description = "What went wrong, in plain words.", example = "No batch batch-123") String error,
            @Schema(description = "The workflow involved, when there is one.") String workflowId,
            @Schema(description = "Rejected batch items, when a whole batch was refused.")
            List<Rejected> rejected) {

        public static ApiError of(String message) {
            return new ApiError(message, null, null);
        }
    }
}
