package com.example.vmintent.api;

import com.example.vmintent.db.BatchStore;
import com.example.vmintent.intent.IntentInterpreter;
import com.example.vmintent.intent.Interpretation;
import com.example.vmintent.provider.VmRegistry;
import com.example.vmintent.spec.SpecCanonicalizer;
import com.example.vmintent.spec.SpecValidator;
import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.BatchProvisionWorkflow;
import com.example.vmintent.workflow.Models.BatchItem;
import com.example.vmintent.workflow.Models.BatchRequest;
import com.example.vmintent.workflow.TaskQueues;
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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
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

    public record ItemBody(String text, VmSpec spec) {}

    public record BatchBody(List<ItemBody> items, Integer shardSize, Integer maxInFlightPerShard, String requestedBy) {}

    public record Rejected(int index, String reason) {}

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

    @PostMapping("/batches")
    public ResponseEntity<Map<String, Object>> submit(@RequestBody BatchBody body) {
        if (body.items() == null || body.items().isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("error", "items is empty"));
        }
        if (body.items().size() > MAX_ITEMS) {
            return ResponseEntity.badRequest().body(Map.of("error", "At most " + MAX_ITEMS + " items per batch"));
        }

        List<BatchItem> accepted = new ArrayList<>();
        List<Rejected> rejected = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        int sameInBatch = 0;
        for (int i = 0; i < body.items().size(); i++) {
            ItemBody item = body.items().get(i);
            BatchItem ok;
            try {
                ok = toItem(item);
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
            return ResponseEntity.badRequest().body(Map.of("error", "No item could be built", "rejected", rejected));
        }

        int shardSize = clamp(body.shardSize(), 500, 1, 1000);
        int inFlight = clamp(body.maxInFlightPerShard(), shardSize, 1, shardSize);
        String batchId = "batch-" + UUID.randomUUID();
        String by = body.requestedBy() == null ? "batch-api" : body.requestedBy();
        batches.create(batchId, accepted.size(), shardSize, by);
        BatchProvisionWorkflow wf = client.newWorkflowStub(BatchProvisionWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue(TaskQueues.INTENT).setWorkflowId(batchId).build());
        WorkflowClient.start(wf::run, new BatchRequest(batchId, accepted, shardSize, inFlight, by));

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("batchId", batchId);
        out.put("accepted", accepted.size());
        out.put("sameInBatch", sameInBatch);
        out.put("rejected", rejected);
        out.put("shards", (accepted.size() + shardSize - 1) / shardSize);
        return ResponseEntity.accepted().body(out);
    }

    /**
     * Live progress, counted from the audit trail in Postgres. It doesn't ask the workflows,
     * so it answers straight away even while workers are restarting.
     */
    @GetMapping("/batches/{id}")
    public ResponseEntity<Map<String, Object>> status(@PathVariable String id) {
        return batches.progress(id)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "No batch " + id)));
    }

    /** VM counts by state across the whole inventory. */
    @GetMapping("/stats")
    public Map<String, Object> stats() {
        return Map.of("vmsByState", registry.countByState());
    }

    private BatchItem toItem(ItemBody item) {
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
