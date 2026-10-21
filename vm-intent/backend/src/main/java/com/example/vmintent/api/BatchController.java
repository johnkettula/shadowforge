package com.example.vmintent.api;

import com.example.vmintent.api.ApiModels.ApiError;
import com.example.vmintent.api.ApiModels.BatchBody;
import com.example.vmintent.api.ApiModels.BatchItemBody;
import com.example.vmintent.api.ApiModels.BatchStatus;
import com.example.vmintent.api.ApiModels.BatchSubmitResponse;
import com.example.vmintent.api.ApiModels.Rejected;
import com.example.vmintent.api.ApiModels.StatsResponse;
import com.example.vmintent.db.BatchStore;
import com.example.vmintent.intent.IntentInterpreter;
import com.example.vmintent.intent.Interpretation;
import com.example.vmintent.provider.VmRegistry;
import com.example.vmintent.security.Caller;
import com.example.vmintent.spec.SpecCanonicalizer;
import com.example.vmintent.spec.SpecValidator;
import com.example.vmintent.workflow.BatchProvisionWorkflow;
import com.example.vmintent.workflow.Models.BatchItem;
import com.example.vmintent.workflow.Models.BatchRequest;
import com.example.vmintent.workflow.TaskQueues;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.tags.Tag;
import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowOptions;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * Bulk provisioning: many VMs in one request, with no confirm step per VM.
 * Each item is either plain text (interpreted here) or an already-structured spec.
 * Items that can't be built without a question are rejected up front, with the reason.
 */
@RestController
@RequestMapping("/api/v2")
@CrossOrigin(origins = "http://localhost:5173")
public class BatchController {

    public static final int MAX_ITEMS = 10_000;

    private final WorkflowClient client;
    private final IntentInterpreter interpreter;
    private final VmRegistry registry;
    private final BatchStore batches;

    public BatchController(WorkflowClient client, IntentInterpreter interpreter, VmRegistry registry,
                           BatchStore batches) {
        this.client = client;
        this.interpreter = interpreter;
        this.registry = registry;
        this.batches = batches;
    }

    @Tag(name = "Batches")
    @Operation(operationId = "createBatch", summary = "Build many VMs at once",
            description = "Every item is checked before anything starts. Items that need a clarifying answer, or "
                    + "break policy, are returned in `rejected`; the rest are built with no confirmation step. "
                    + "An item identical to another (same spec hash) is built once. Poll GET /api/v2/batches/{id}.")
    @ApiResponse(responseCode = "202", description = "Accepted; the batch has started",
            content = @Content(schema = @Schema(implementation = BatchSubmitResponse.class)))
    @ApiResponse(responseCode = "400", description = "Empty, too large, or no item could be built",
            content = @Content(schema = @Schema(implementation = ApiError.class)))
    @PostMapping("/batches")
    public ResponseEntity<?> submit(@RequestBody BatchBody body) {
        if (body.items() == null || body.items().isEmpty()) {
            return ResponseEntity.badRequest().body(ApiError.of("items is empty"));
        }
        if (body.items().size() > MAX_ITEMS) {
            return ResponseEntity.badRequest().body(ApiError.of("At most " + MAX_ITEMS + " items per batch"));
        }

        List<BatchItem> accepted = new ArrayList<>();
        List<Rejected> rejected = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        int sameInBatch = 0;
        for (int i = 0; i < body.items().size(); i++) {
            BatchItem ok;
            try {
                ok = toItem(body.items().get(i));
            } catch (IllegalArgumentException e) {
                rejected.add(new Rejected(i, e.getMessage()));
                continue;
            }
            if (!seen.add(ok.specHash())) {
                sameInBatch++;   // identical to an earlier item in this batch: build it once
                continue;
            }
            accepted.add(ok);
        }
        if (accepted.isEmpty()) {
            return ResponseEntity.badRequest().body(new ApiError("No item could be built", null, rejected));
        }

        int shardSize = clamp(body.shardSize(), 500, 1, 1000);
        int inFlight = clamp(body.maxInFlightPerShard(), shardSize, 1, shardSize);
        String batchId = "batch-" + UUID.randomUUID();
        String by = Caller.nameOr(body.requestedBy(), "batch-api");   // signed-in caller wins
        batches.create(batchId, accepted.size(), shardSize, by);
        BatchProvisionWorkflow wf = client.newWorkflowStub(BatchProvisionWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue(TaskQueues.INTENT).setWorkflowId(batchId).build());
        WorkflowClient.start(wf::run, new BatchRequest(batchId, accepted, shardSize, inFlight, by));

        return ResponseEntity.accepted().body(new BatchSubmitResponse(
                batchId, accepted.size(), sameInBatch, rejected, (accepted.size() + shardSize - 1) / shardSize));
    }

    @Tag(name = "Batches")
    @Operation(operationId = "getBatch", summary = "Get a batch's progress",
            description = "Counted from the audit trail, so it answers immediately even while workers restart.")
    @ApiResponse(responseCode = "200", description = "Current progress",
            content = @Content(schema = @Schema(implementation = BatchStatus.class)))
    @ApiResponse(responseCode = "404", description = "No such batch",
            content = @Content(schema = @Schema(implementation = ApiError.class)))
    @GetMapping("/batches/{id}")
    public ResponseEntity<?> status(@Parameter(description = "Batch ID from POST /api/v2/batches")
                                    @PathVariable String id) {
        Optional<BatchStatus> progress = batches.progress(id);
        if (progress.isPresent()) return ResponseEntity.ok(progress.get());
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(ApiError.of("No batch " + id));
    }

    @Tag(name = "Inventory")
    @Operation(operationId = "getStats", summary = "Count VMs by state")
    @GetMapping("/stats")
    public StatsResponse stats() {
        return new StatsResponse(registry.countByState());
    }

    private BatchItem toItem(BatchItemBody item) {
        if (item == null || (item.text() == null && item.spec() == null)) {
            throw new IllegalArgumentException("Give either text or spec");
        }
        if (item.spec() != null) {
            List<String> problems = SpecValidator.problems(item.spec());
            if (!problems.isEmpty()) throw new IllegalArgumentException(String.join(" ", problems));
            String hash = SpecCanonicalizer.hash(item.spec());
            return new BatchItem(SpecCanonicalizer.withGeneratedName(item.spec(), hash), hash);
        }
        Interpretation it = interpreter.interpret(item.text());
        if (it.question() != null) throw new IllegalArgumentException("Needs an answer: " + it.question());
        return new BatchItem(it.spec(), it.specHash());
    }

    private static int clamp(Integer v, int fallback, int min, int max) {
        int x = v == null ? fallback : v;
        return Math.max(min, Math.min(max, x));
    }
}
