package com.example.vmintent.api;

import com.example.vmintent.api.ApiModels.AnswerBody;
import com.example.vmintent.api.ApiModels.ApiError;
import com.example.vmintent.api.ApiModels.ConfirmBody;
import com.example.vmintent.api.ApiModels.RequestSummary;
import com.example.vmintent.config.SearchAttributesSetup;
import com.example.vmintent.workflow.RequestSearch;
import io.temporal.client.WorkflowExecutionMetadata;
import io.temporal.common.SearchAttributes;
import com.example.vmintent.api.ApiModels.LegacyAccepted;
import com.example.vmintent.api.ApiModels.SubmitResponse;
import com.example.vmintent.api.ApiModels.TextBody;
import com.example.vmintent.db.AuditLog;
import com.example.vmintent.intent.IntentInterpreter;
import com.example.vmintent.intent.Interpretation;
import com.example.vmintent.legacy.LegacySpecTranslator;
import com.example.vmintent.legacy.LegacyVmDefinition;
import com.example.vmintent.provider.VmRegistry;
import com.example.vmintent.security.ApiAccessRules;
import com.example.vmintent.security.Caller;
import com.example.vmintent.workflow.IntentWorkflow;
import com.example.vmintent.workflow.Models.IntentRequest;
import com.example.vmintent.workflow.Models.ReconcileRequest;
import com.example.vmintent.workflow.Models.RequestStatus;
import com.example.vmintent.workflow.Models.VmRecord;
import com.example.vmintent.workflow.TaskQueues;
import com.example.vmintent.workflow.VmReconcileWorkflow;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.tags.Tag;
import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowExecutionAlreadyStarted;
import io.temporal.client.WorkflowNotFoundException;
import io.temporal.client.WorkflowOptions;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

@RestController
@RequestMapping("/api")
public class RequestController {

    private static final int QUERY_TIMEOUT_SECONDS = 5;

    private final WorkflowClient client;
    private final IntentInterpreter interpreter;
    private final LegacySpecTranslator legacy;
    private final VmRegistry registry;
    private final AuditLog audit;
    private final SearchAttributesSetup search;
    private final com.example.vmintent.audit.DecisionLog decisions;

    public RequestController(WorkflowClient client, IntentInterpreter interpreter,
                             LegacySpecTranslator legacy, VmRegistry registry, AuditLog audit,
                             SearchAttributesSetup search, com.example.vmintent.audit.DecisionLog decisions) {
        this.decisions = decisions;
        this.client = client;
        this.interpreter = interpreter;
        this.legacy = legacy;
        this.registry = registry;
        this.audit = audit;
        this.search = search;
    }

    // ------------------------------------------------------------------ requests

    @Tag(name = "Requests")
    @Operation(operationId = "interpretRequest", summary = "Preview how a request is understood",
            description = "Turns plain English into the canonical spec and its hash, or returns the question it "
                    + "would ask. Starts nothing and builds nothing. Many wordings of the same VM give the same specHash.")
    @PostMapping("/v2/interpret")
    public Interpretation preview(@RequestBody TextBody body) {
        return interpreter.interpret(body.text());
    }

    @Tag(name = "Requests")
    @Operation(operationId = "createRequest", summary = "Start a request",
            description = "Starts a request workflow for one VM. Poll GET /api/v2/requests/{id}: when state is "
                    + "AWAITING_CLARIFICATION, answer the question; when AWAITING_CONFIRMATION, confirm or cancel. "
                    + "Both waits time out after 24 hours.")
    @ApiResponse(responseCode = "200", description = "Started")
    @PostMapping("/v2/requests")
    public SubmitResponse submit(@RequestBody TextBody body) {
        String id = "intent-" + UUID.randomUUID();
        IntentWorkflow wf = client.newWorkflowStub(IntentWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue(TaskQueues.INTENT).setWorkflowId(id).build());
        // Signed-in callers are recorded as themselves, whatever userId says.
        String user = Caller.nameOr(body.userId(), "demo-user");
        WorkflowClient.start(wf::run, new IntentRequest(body.text(), user, "api", search.enabled()));
        return new SubmitResponse(id);
    }

    @Tag(name = "Requests")
    @Operation(operationId = "listRequests", summary = "List requests",
            description = "Newest first, filtered by any of: requester, state, provider, env. Uses Temporal search "
                    + "attributes; if the Temporal server doesn't have them, filters are refused (400) and only "
                    + "the unfiltered list works. The state is the last one the request reported.")
    @GetMapping("/v2/requests")
    public List<RequestSummary> list(
            @Parameter(description = "Who made the request; \"me\" = the signed-in caller") @RequestParam(required = false) String requester,
            @Parameter(description = "e.g. AWAITING_CONFIRMATION, COMPLETED") @RequestParam(required = false) String state,
            @Parameter(description = "vsphere, aws, azure or gcp") @RequestParam(required = false) String provider,
            @Parameter(description = "dev, test, staging or prod") @RequestParam(required = false) String env,
            @Parameter(description = "Most to return (1-200)") @RequestParam(defaultValue = "50") int limit) {
        if ("me".equals(requester)) requester = Caller.nameOr(null, "demo-user");
        StringBuilder q = new StringBuilder("WorkflowType = 'IntentWorkflow'");
        boolean filtered = false;
        filtered |= addFilter(q, "VmRequester", requester);
        filtered |= addFilter(q, "VmState", state == null ? null : state.toUpperCase());
        filtered |= addFilter(q, "VmProvider", provider == null ? null : provider.toLowerCase());
        filtered |= addFilter(q, "VmEnv", env == null ? null : env.toLowerCase());
        if (filtered && !search.enabled()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Filtering needs Temporal search attributes, "
                    + "which this Temporal server doesn't have. See docs/TEMPORAL-FEATURES.md.");
        }
        // Newest first is Temporal's own order. (Not every server accepts ORDER BY, so it isn't asked for.)
        int n = Math.max(1, Math.min(limit, 200));
        return client.listExecutions(q.toString()).limit(n).map(RequestController::summary).toList();
    }

    private static boolean addFilter(StringBuilder q, String attribute, String value) {
        if (value == null || value.isBlank()) return false;
        if (!value.matches("[A-Za-z0-9@._-]{1,200}")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unexpected characters in " + attribute + " filter");
        }
        q.append(" AND ").append(attribute).append(" = '").append(value).append("'");
        return true;
    }

    private static RequestSummary summary(WorkflowExecutionMetadata m) {
        SearchAttributes sa = m.getTypedSearchAttributes();
        return new RequestSummary(m.getExecution().getWorkflowId(),
                sa.get(RequestSearch.STATE), sa.get(RequestSearch.REQUESTER), sa.get(RequestSearch.PROVIDER),
                sa.get(RequestSearch.ENV), sa.get(RequestSearch.SPEC_HASH),
                m.getStartTime() == null ? null : m.getStartTime().toString(),
                m.getCloseTime() == null ? null : m.getCloseTime().toString(),
                m.getStatus().name().replace("WORKFLOW_EXECUTION_STATUS_", ""));
    }

    @Tag(name = "Requests")
    @Operation(operationId = "getRequest", summary = "Get a request's status",
            description = "state is one of STARTING, INTERPRETING, AWAITING_CLARIFICATION, AWAITING_CONFIRMATION, "
                    + "PROVISIONING, COMPLETED, FAILED, CANCELLED, DUPLICATE, or BUSY (workers didn't answer "
                    + "within 5 seconds; try again). The last four of the first list are final.")
    @ApiResponse(responseCode = "200", description = "Current status")
    @ApiResponse(responseCode = "404", description = "No such request",
            content = @Content(schema = @Schema(implementation = ApiError.class)))
    @GetMapping("/v2/requests/{id}")
    public ResponseEntity<RequestStatus> status(@Parameter(description = "Request ID from POST /api/v2/requests")
                                                @PathVariable String id) {
        try {
            // A query is answered by a worker. Don't let a busy or restarting worker hold this request.
            RequestStatus s = CompletableFuture.supplyAsync(() -> stub(id).status())
                    .get(QUERY_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            return ResponseEntity.ok(s);
        } catch (TimeoutException e) {
            return ResponseEntity.ok(new RequestStatus(id, "BUSY", "Workers are busy; trying again...", null, null, List.of(), null));
        } catch (ExecutionException e) {
            if (e.getCause() instanceof WorkflowNotFoundException nf) throw nf;
            // The workflow exists but hasn't run its first step yet.
            return ResponseEntity.ok(new RequestStatus(id, "STARTING", "Starting...", null, null, List.of(), null));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return ResponseEntity.ok(new RequestStatus(id, "BUSY", "Interrupted; try again.", null, null, List.of(), null));
        }
    }

    @Tag(name = "Requests")
    @Operation(operationId = "clarifyRequest", summary = "Answer the request's question", description = "Use when state is AWAITING_CLARIFICATION.")
    @ApiResponse(responseCode = "204", description = "Answer delivered")
    @ApiResponse(responseCode = "404", description = "No such request",
            content = @Content(schema = @Schema(implementation = ApiError.class)))
    @ApiResponse(responseCode = "403", description = "Not your request (sign-in on, not an admin)",
            content = @Content(schema = @Schema(implementation = ApiError.class)))
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @PostMapping("/v2/requests/{id}/clarify")
    public void clarify(@PathVariable String id, @RequestBody AnswerBody body) {
        requireOwner(id);
        stub(id).clarify(body.answer());
    }

    @Tag(name = "Requests")
    @Operation(operationId = "confirmRequest", summary = "Confirm and build",
            description = "Use when state is AWAITING_CONFIRMATION, after the requester has checked the spec. "
                    + "Send the specHash you were shown to make sure it's the spec being built. Answers with the "
                    + "request's new status (PROVISIONING, or DUPLICATE if the VM already exists).")
    @ApiResponse(responseCode = "200", description = "Confirmed; the build has started")
    @ApiResponse(responseCode = "409", description = "Not waiting for confirmation, or a different spec",
            content = @Content(schema = @Schema(implementation = ApiError.class)))
    @ApiResponse(responseCode = "404", description = "No such request",
            content = @Content(schema = @Schema(implementation = ApiError.class)))
    @ApiResponse(responseCode = "403", description = "Not your request (sign-in on, not an admin)",
            content = @Content(schema = @Schema(implementation = ApiError.class)))
    @PostMapping("/v2/requests/{id}/confirm")
    public RequestStatus confirm(@PathVariable String id, @RequestBody(required = false) ConfirmBody body) {
        requireOwner(id);
        // An update, not a signal: it's refused at once (409) if the request can't be confirmed now.
        try {
            return stub(id).confirmSpec(Caller.nameOr(null, "demo-user"), body == null ? null : body.specHash());
        } catch (WorkflowNotFoundException e) {
            throw finishedOr404(id, e);
        }
    }

    @Tag(name = "Requests")
    @Operation(operationId = "cancelRequest", summary = "Cancel a waiting request", description = "Has no effect once the build has started.")
    @ApiResponse(responseCode = "204", description = "Cancelled")
    @ApiResponse(responseCode = "404", description = "No such request",
            content = @Content(schema = @Schema(implementation = ApiError.class)))
    @ApiResponse(responseCode = "403", description = "Not your request (sign-in on, not an admin)",
            content = @Content(schema = @Schema(implementation = ApiError.class)))
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @PostMapping("/v2/requests/{id}/cancel")
    public void cancel(@PathVariable String id) {
        requireOwner(id);
        stub(id).cancel();
    }

    // ------------------------------------------------------------------ inventory and audit

    @Tag(name = "Inventory")
    @Operation(operationId = "listVms", summary = "List VMs", description = "The 200 most recently changed VMs, newest first.")
    @GetMapping("/v2/vms")
    public List<VmRecord> vms() {
        return registry.all();
    }

    @Tag(name = "Inventory")
    @Operation(operationId = "getAuditTrail", summary = "Read the audit trail",
            description = "Events for one request, batch or VM (spec hash or its first characters), oldest first. "
                    + "With no filter, the latest events overall.")
    @GetMapping("/v2/audit")
    public List<AuditLog.AuditEvent> auditTrail(
            @Parameter(description = "Request or batch ID") @RequestParam(required = false) String requestId,
            @Parameter(description = "Spec hash, or its first 8+ characters") @RequestParam(required = false) String specHash,
            @Parameter(description = "Most events to return (1-500)") @RequestParam(defaultValue = "50") int limit) {
        return audit.find(requestId, specHash, Math.max(1, Math.min(limit, 500)));
    }

    // ------------------------------------------------------------------ legacy

    @Tag(name = "Legacy")
    @Operation(operationId = "createLegacyVm", summary = "Create a VM from the legacy JSON format",
            description = "The old universal JSON definition. Skips interpretation and confirmation and goes "
                    + "straight to the build. Kept for existing callers; new callers should use /api/v2.")
    @ApiResponse(responseCode = "202", description = "Accepted; the build has started",
            content = @Content(schema = @Schema(implementation = LegacyAccepted.class)))
    @ApiResponse(responseCode = "400", description = "Missing or invalid fields",
            content = @Content(schema = @Schema(implementation = ApiError.class)))
    @ApiResponse(responseCode = "409", description = "An identical VM already exists or is being built",
            content = @Content(schema = @Schema(implementation = ApiError.class)))
    @PostMapping("/v1/vms")
    public ResponseEntity<?> legacyCreate(@RequestBody LegacyVmDefinition def) {
        Interpretation it = legacy.translate(def);
        if (it.question() != null) {
            return ResponseEntity.badRequest().body(ApiError.of(it.question()));
        }
        String workflowId = "vm-" + it.specHash();
        VmRecord existing = registry.get(it.specHash());
        if (existing != null && "RUNNING".equals(existing.state())) {
            return ResponseEntity.status(HttpStatus.CONFLICT)
                    .body(new ApiError("An identical VM already exists: " + existing.result().vmId(), workflowId, null));
        }
        VmReconcileWorkflow wf = client.newWorkflowStub(VmReconcileWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue(TaskQueues.INTENT).setWorkflowId(workflowId).build());
        try {
            String by = Caller.nameOr(null, "legacy-api");
            audit.record(null, it.specHash(), "REQUESTED", by, "legacy JSON for " + it.summary());
            WorkflowClient.start(wf::reconcile, new ReconcileRequest(it.spec(), it.specHash(), by, null));
        } catch (WorkflowExecutionAlreadyStarted e) {
            return ResponseEntity.status(HttpStatus.CONFLICT)
                    .body(new ApiError("An identical VM is already being built", workflowId, null));
        }
        return ResponseEntity.accepted().body(new LegacyAccepted(workflowId, it.specHash(), it.spec(), it.summary()));
    }

    /**
     * With sign-in on, only the person who made a request (or an ADMIN) may answer, confirm or
     * cancel it. Anyone with READER can still see it.
     */
    private void requireOwner(String id) {
        String me = Caller.signedIn();
        if (me == null || Caller.hasRole(ApiAccessRules.Role.ADMIN)) return;
        RequestStatus s;
        try {
            s = CompletableFuture.supplyAsync(() -> stub(id).status()).get(QUERY_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } catch (ExecutionException e) {
            if (e.getCause() instanceof WorkflowNotFoundException nf) throw nf;
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "The request isn't ready yet; try again.");
        } catch (TimeoutException e) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Workers are busy; try again.");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Interrupted; try again.");
        }
        boolean allowed = s.requestedBy() == null || s.requestedBy().equals(me);
        decisions.record(me, String.join(",", Caller.roles()), "request.change", id, allowed, "request owner or ADMIN",
                allowed ? "their own request" : "the request belongs to " + s.requestedBy(), null);
        if (!allowed) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN,
                    "Only the person who made this request, or an admin, can change it.");
        }
    }

    /** An update to a request that has already finished: say so (409) instead of "not found". */
    private RuntimeException finishedOr404(String id, WorkflowNotFoundException e) {
        try {
            var d = client.newUntypedWorkflowStub(id).describe();
            String status = d.getStatus().name().replace("WORKFLOW_EXECUTION_STATUS_", "").toLowerCase();
            return new ResponseStatusException(HttpStatus.CONFLICT, "This request has already finished (" + status + ").");
        } catch (RuntimeException notThere) {
            return e;
        }
    }

    private IntentWorkflow stub(String id) {
        return client.newWorkflowStub(IntentWorkflow.class, id);
    }
}
