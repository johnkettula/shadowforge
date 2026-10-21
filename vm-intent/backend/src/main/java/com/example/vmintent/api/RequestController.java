package com.example.vmintent.api;

import com.example.vmintent.db.AuditLog;
import com.example.vmintent.intent.IntentInterpreter;
import com.example.vmintent.intent.Interpretation;
import com.example.vmintent.legacy.LegacySpecTranslator;
import com.example.vmintent.legacy.LegacyVmDefinition;
import com.example.vmintent.provider.VmRegistry;
import com.example.vmintent.workflow.IntentWorkflow;
import com.example.vmintent.workflow.Models.IntentRequest;
import com.example.vmintent.workflow.Models.ReconcileRequest;
import com.example.vmintent.workflow.Models.RequestStatus;
import com.example.vmintent.workflow.Models.VmRecord;
import com.example.vmintent.workflow.TaskQueues;
import com.example.vmintent.workflow.VmReconcileWorkflow;
import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowExecutionAlreadyStarted;
import io.temporal.client.WorkflowOptions;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/api")
@CrossOrigin(origins = "http://localhost:5173")
public class RequestController {

    public record TextBody(String text, String userId) {}

    public record AnswerBody(String answer) {}

    private final WorkflowClient client;
    private final IntentInterpreter interpreter;
    private final LegacySpecTranslator legacy;
    private final VmRegistry registry;
    private final AuditLog audit;

    public RequestController(WorkflowClient client, IntentInterpreter interpreter,
                             LegacySpecTranslator legacy, VmRegistry registry, AuditLog audit) {
        this.client = client;
        this.interpreter = interpreter;
        this.legacy = legacy;
        this.registry = registry;
        this.audit = audit;
    }

    /** Preview only: what would this text become? No workflow, nothing built. */
    @PostMapping("/v2/interpret")
    public Interpretation preview(@RequestBody TextBody body) {
        return interpreter.interpret(body.text());
    }

    /** Start a natural-language request. Returns the request (workflow) ID. */
    @PostMapping("/v2/requests")
    public Map<String, String> submit(@RequestBody TextBody body) {
        String id = "intent-" + UUID.randomUUID();
        IntentWorkflow wf = client.newWorkflowStub(IntentWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue(TaskQueues.INTENT).setWorkflowId(id).build());
        String user = body.userId() == null ? "demo-user" : body.userId();
        WorkflowClient.start(wf::run, new IntentRequest(body.text(), user, "web"));
        return Map.of("requestId", id);
    }

    @GetMapping("/v2/requests/{id}")
    public ResponseEntity<RequestStatus> status(@PathVariable String id) {
        try {
            return ResponseEntity.ok(stub(id).status());
        } catch (Exception e) {
            // The workflow may not have run its first step yet.
            return ResponseEntity.ok(new RequestStatus(id, "STARTING", "Starting...", null, null, List.of()));
        }
    }

    @PostMapping("/v2/requests/{id}/clarify")
    public void clarify(@PathVariable String id, @RequestBody AnswerBody body) {
        stub(id).clarify(body.answer());
    }

    @PostMapping("/v2/requests/{id}/confirm")
    public void confirm(@PathVariable String id) {
        stub(id).confirm();
    }

    @PostMapping("/v2/requests/{id}/cancel")
    public void cancel(@PathVariable String id) {
        stub(id).cancel();
    }

    @GetMapping("/v2/vms")
    public List<VmRecord> vms() {
        return registry.all();
    }

    /** Audit trail: filter by request ID or spec hash (prefix), newest events last. */
    @GetMapping("/v2/audit")
    public List<AuditLog.AuditEvent> auditTrail(@RequestParam(required = false) String requestId,
                                                @RequestParam(required = false) String specHash,
                                                @RequestParam(defaultValue = "50") int limit) {
        return audit.find(requestId, specHash, Math.max(1, Math.min(limit, 500)));
    }

    /** The OLD endpoint: legacy JSON in, straight to reconcile (no AI step). */
    @PostMapping("/v1/vms")
    public ResponseEntity<Map<String, Object>> legacyCreate(@RequestBody LegacyVmDefinition def) {
        Interpretation it = legacy.translate(def);
        if (it.question() != null) {
            return ResponseEntity.badRequest().body(Map.of("error", it.question()));
        }
        String workflowId = "vm-" + it.specHash();
        VmReconcileWorkflow wf = client.newWorkflowStub(VmReconcileWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue(TaskQueues.INTENT).setWorkflowId(workflowId).build());
        try {
            audit.record(null, it.specHash(), "REQUESTED", "legacy-api", "legacy JSON for " + it.summary());
            WorkflowClient.start(wf::reconcile, new ReconcileRequest(it.spec(), it.specHash(), "legacy-api", null));
        } catch (WorkflowExecutionAlreadyStarted e) {
            return ResponseEntity.status(HttpStatus.CONFLICT)
                    .body(Map.of("error", "An identical VM is already being built", "workflowId", workflowId));
        }
        return ResponseEntity.accepted().body(Map.of(
                "workflowId", workflowId, "specHash", it.specHash(), "spec", it.spec(), "summary", it.summary()));
    }

    private IntentWorkflow stub(String id) {
        return client.newWorkflowStub(IntentWorkflow.class, id);
    }
}
