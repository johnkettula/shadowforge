package com.example.vmintent.api;

import com.example.vmintent.api.ApiModels.ApiError;
import com.example.vmintent.audit.DecisionLog;
import com.example.vmintent.audit.PolicyEngine;
import com.example.vmintent.audit.PolicyEngine.Verdict;
import com.example.vmintent.catalog.CatalogModels.Blueprint;
import com.example.vmintent.catalog.CatalogModels.Classification;
import com.example.vmintent.catalog.CatalogModels.Definition;
import com.example.vmintent.catalog.CatalogModels.RunRequest;
import com.example.vmintent.catalog.CatalogModels.RunStatus;
import com.example.vmintent.catalog.ClassificationCatalog;
import com.example.vmintent.catalog.DefinitionCatalog;
import com.example.vmintent.catalog.DefinitionParser;
import com.example.vmintent.catalog.RunInputs;
import com.example.vmintent.config.SearchAttributesSetup;
import com.example.vmintent.security.ApiAccessRules.Role;
import com.example.vmintent.security.Caller;
import com.example.vmintent.workflow.CatalogRunWorkflow;
import com.example.vmintent.workflow.RequestSearch;
import com.example.vmintent.workflow.TaskQueues;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.tags.Tag;
import io.temporal.api.enums.v1.WorkflowIdReusePolicy;
import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowExecutionAlreadyStarted;
import io.temporal.client.WorkflowNotFoundException;
import io.temporal.client.WorkflowOptions;
import io.temporal.common.SearchAttributes;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The catalog: definitions written in YAML by technical operators (published through Git and the
 * pipeline, or straight to this API), and runs of them. See docs/DEFINITIONS.md and docs/RUNS.md.
 */
@RestController
@org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication   // not in worker pods
@RequestMapping("/api/v2")
public class CatalogController {

    private static final String YAML = "application/yaml";

    // ------------------------------------------------------------------ bodies

    @Schema(description = "A definition as YAML, for clients that can only send JSON.")
    public record YamlBody(@Schema(requiredMode = Schema.RequiredMode.REQUIRED) String yaml) {}

    @Schema(description = "What checking a definition found.")
    public record ValidationResult(boolean ok, String kind, String name, int version,
                                   @Schema(description = "Every problem, each as 'where: what'.") List<String> problems) {}

    @Schema(description = "A published version, as data and as the YAML it was published from.")
    public record DefinitionView(DefinitionCatalog.Entry entry, Definition definition, Blueprint blueprint, String yaml) {}

    @Schema(description = "Stop (or allow again) new runs of one version.")
    public record RetireBody(@Schema(defaultValue = "true") Boolean retired) {}

    @Schema(description = "Start a run of a definition.")
    public record RunBody(
            @Schema(requiredMode = Schema.RequiredMode.REQUIRED, example = "web-server") String definition,
            @Schema(description = "A version; empty = the newest that isn't retired.", example = "1") Integer version,
            @Schema(description = "The definition's inputs.", example = "{\"app\": \"shop\", \"env\": \"dev\"}")
            Map<String, Object> params,
            @Schema(description = "Data classification code; empty = the definition's. Can raise the definition's "
                    + "retention, not lower it.", example = "C3") String classification,
            @Schema(description = "Who is asking, when sign-in is off.", example = "jdoe") String requestedBy) {}

    @Schema(description = "A run that has started, or the one already running with the same inputs.")
    public record RunStarted(String runId, @Schema(description = "true = a run with these inputs already existed") boolean existing,
                             RunStatus status) {}

    @Schema(description = "A run, as recorded (also after Temporal has removed it).")
    public record RunRow(String runId, String temporalRunId, String definition, int version, String classification,
                         String requestedBy, String state, String startedAt, String updatedAt, String finishedAt) {}

    public record ResumeBody(@Schema(description = "Why, or what was fixed.", example = "the site files are in the store now") String note) {}

    public record TeardownBody(@Schema(example = "not needed any more") String reason) {}

    public record ApproveBody(@Schema(requiredMode = Schema.RequiredMode.REQUIRED) boolean approved,
                              @Schema(example = "change ticket CHG-1234") String note) {}

    // ------------------------------------------------------------------ wiring

    private final DefinitionCatalog catalog;
    private final ClassificationCatalog classifications;
    private final WorkflowClient client;
    private final SearchAttributesSetup searchAttributes;
    private final PolicyEngine policy;
    private final DecisionLog decisions;
    private final JdbcClient jdbc;

    public CatalogController(DefinitionCatalog catalog, ClassificationCatalog classifications, WorkflowClient client,
                             SearchAttributesSetup searchAttributes, PolicyEngine policy, DecisionLog decisions, JdbcClient jdbc) {
        this.catalog = catalog;
        this.classifications = classifications;
        this.client = client;
        this.searchAttributes = searchAttributes;
        this.policy = policy;
        this.decisions = decisions;
        this.jdbc = jdbc;
    }

    // ------------------------------------------------------------------ definitions

    @Tag(name = "Catalog")
    @Operation(operationId = "listDefinitions", summary = "List definitions and blueprints",
            description = "The newest version of each, or every version with all=true.")
    @GetMapping("/definitions")
    public List<DefinitionCatalog.Entry> definitions(@RequestParam(defaultValue = "false") boolean all) {
        return catalog.list(all);
    }

    @Tag(name = "Catalog")
    @Operation(operationId = "getDefinition", summary = "Get one definition or blueprint",
            description = "kind = Provisioning or Blueprint. version 0 (the default) = the newest.")
    @ApiResponse(responseCode = "200", description = "The definition")
    @ApiResponse(responseCode = "404", description = "Not published", content = @Content(schema = @Schema(implementation = ApiError.class)))
    @GetMapping("/definitions/{kind}/{name}")
    public DefinitionView definition(@PathVariable String kind, @PathVariable String name,
                                     @RequestParam(defaultValue = "0") int version) {
        String k = kind(kind);
        DefinitionCatalog.Entry e = catalog.list(true).stream()
                .filter(x -> x.kind().equals(k) && x.name().equals(name) && (version == 0 || x.version() == version))
                .findFirst()
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "No " + k + " called " + name
                        + (version == 0 ? "" : " v" + version)));
        String yaml = catalog.yaml(k, name, e.version()).orElseThrow();
        DefinitionParser.Result r = DefinitionParser.parse(yaml, DefinitionParser.Context.lenient());
        return new DefinitionView(e, r.definition(), r.blueprint(), yaml);
    }

    @Tag(name = "Catalog")
    @Operation(operationId = "validateDefinition", summary = "Check a definition without publishing it",
            description = "Send the YAML (Content-Type: application/yaml or text/plain), or JSON {\"yaml\": \"...\"}. "
                    + "Every problem is listed at once: names, actions and their settings, every CEL expression, and "
                    + "that steps only read earlier steps. Used by the Git pipeline before a merge.")
    @PostMapping(value = "/definitions/validate", consumes = {YAML, "text/yaml", MediaType.TEXT_PLAIN_VALUE})
    public ValidationResult validate(@RequestBody String yaml) {
        DefinitionParser.Result r = catalog.validate(yaml);
        return new ValidationResult(r.ok(), r.kind(), r.name(), r.version(), r.problems());
    }

    @Tag(name = "Catalog")
    @Operation(operationId = "validateDefinitionJson", summary = "Check a definition sent as JSON")
    @PostMapping(value = "/definitions/validate", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ValidationResult validateJson(@RequestBody YamlBody body) {
        return validate(body.yaml());
    }

    @Tag(name = "Catalog")
    @Operation(operationId = "publishDefinition", summary = "Publish a definition or blueprint",
            description = "Operators only. A published version never changes: publish a higher version to change it. "
                    + "Publishing the same version with the same content again does nothing (UNCHANGED), so a pipeline "
                    + "can publish every file on every merge.")
    @ApiResponse(responseCode = "201", description = "Published")
    @ApiResponse(responseCode = "200", description = "Already published, unchanged")
    @ApiResponse(responseCode = "422", description = "Refused: the problems are listed")
    @PostMapping(value = "/definitions", consumes = {YAML, "text/yaml", MediaType.TEXT_PLAIN_VALUE})
    public ResponseEntity<DefinitionCatalog.PublishResult> publish(@RequestBody String yaml) {
        String me = actor(null);
        DefinitionParser.Result parsed = catalog.validate(yaml);
        Verdict v = decide("definition.publish", me, parsed.kind() + "/" + parsed.name(), Map.of("version", parsed.version()),
                new Verdict(true, "role OPERATOR", "operators publish definitions"), null);
        if (!v.allowed()) throw new ResponseStatusException(HttpStatus.FORBIDDEN, v.reason());
        DefinitionCatalog.PublishResult r = catalog.publish(yaml, me);
        HttpStatus status = switch (r.outcome()) {
            case "PUBLISHED" -> HttpStatus.CREATED;
            case "UNCHANGED" -> HttpStatus.OK;
            default -> HttpStatus.UNPROCESSABLE_ENTITY;
        };
        return ResponseEntity.status(status).body(r);
    }

    @Tag(name = "Catalog")
    @Operation(operationId = "publishDefinitionJson", summary = "Publish a definition sent as JSON")
    @PostMapping(value = "/definitions", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<DefinitionCatalog.PublishResult> publishJson(@RequestBody YamlBody body) {
        return publish(body.yaml());
    }

    @Tag(name = "Catalog")
    @Operation(operationId = "retireDefinition", summary = "Retire a version",
            description = "No new runs of it; runs already going carry on. retired=false brings it back.")
    @PostMapping("/definitions/{kind}/{name}/{version}/retire")
    public DefinitionView retire(@PathVariable String kind, @PathVariable String name, @PathVariable int version,
                                 @RequestBody(required = false) RetireBody body) {
        String k = kind(kind);
        boolean retired = body == null || body.retired() == null || body.retired();
        Verdict v = decide("definition.retire", actor(null), k + "/" + name + "/" + version, Map.of("retired", retired),
                new Verdict(true, "role OPERATOR", "operators retire definitions"), null);
        if (!v.allowed()) throw new ResponseStatusException(HttpStatus.FORBIDDEN, v.reason());
        if (!catalog.retire(k, name, version, retired)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "No " + k + " " + name + " v" + version);
        }
        return definition(k, name, version);
    }

    @Tag(name = "Catalog")
    @Operation(operationId = "listClassifications", summary = "Data classifications",
            description = "Each code, its text, and how many years runs with it are kept. The first one marked default "
                    + "applies when neither the run nor its definition gives one.")
    @GetMapping("/classifications")
    public Map<String, Object> classifications() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("default", classifications.defaultClassification().code());
        out.put("classifications", classifications.all());
        return out;
    }

    // ------------------------------------------------------------------ runs

    @Tag(name = "Catalog runs")
    @Operation(operationId = "startRun", summary = "Start a run of a definition",
            description = "Checks the inputs, fills in defaults and starts the run. The run's ID comes from the definition "
                    + "version and the inputs, so sending the same thing again finds the run already going (200, "
                    + "existing=true) instead of starting a second one.")
    @ApiResponse(responseCode = "201", description = "Started")
    @ApiResponse(responseCode = "200", description = "A run with the same definition version and inputs is already going")
    @ApiResponse(responseCode = "400", description = "Bad inputs", content = @Content(schema = @Schema(implementation = ApiError.class)))
    @ApiResponse(responseCode = "404", description = "No such definition", content = @Content(schema = @Schema(implementation = ApiError.class)))
    @PostMapping("/runs")
    public ResponseEntity<RunStarted> startRun(@RequestBody RunBody body) {
        if (body == null || body.definition() == null || body.definition().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "definition: which definition to run");
        }
        int version = body.version() == null ? 0 : body.version();
        Definition def = catalog.definition(body.definition(), version).orElseThrow(() -> new ResponseStatusException(
                HttpStatus.NOT_FOUND, "No published definition " + body.definition() + (version == 0 ? "" : " v" + version)
                + (version == 0 ? " (or every version is retired)" : "")));
        if (catalog.isRetired(DefinitionParser.PROVISIONING, def.name(), def.version())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, def.name() + " v" + def.version() + " is retired: no new runs");
        }
        RunInputs.Checked inputs = RunInputs.check(def, body.params());
        if (!inputs.problems().isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, String.join("; ", inputs.problems()));
        }
        Classification cls = classification(def, body.classification());
        String me = actor(body.requestedBy());
        String runId = RunInputs.runId(def, inputs.params());
        Verdict v = decide("run.start", me, runId, Map.of("definition", def.name(), "version", def.version(),
                "classification", cls.code()), new Verdict(true, "role REQUESTER", "requesters start runs"), cls.code());
        if (!v.allowed()) throw new ResponseStatusException(HttpStatus.FORBIDDEN, v.reason());

        List<Blueprint> blueprints = catalog.blueprints();
        boolean tag = searchAttributes.enabled();
        WorkflowOptions.Builder opts = WorkflowOptions.newBuilder()
                .setTaskQueue(TaskQueues.INTENT)
                .setWorkflowId(runId)
                // A run that is still going (or waiting for a decision) can't be started again with the same inputs.
                // Once it has finished or been torn down, the same inputs may run again.
                .setWorkflowIdReusePolicy(WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE);
        if (tag) {
            opts.setTypedSearchAttributes(SearchAttributes.newBuilder()
                    .set(RequestSearch.REQUESTER, me)
                    .set(RequestSearch.STATE, "RUNNING")
                    .set(RequestSearch.DEFINITION, def.name())
                    .set(RequestSearch.CLASSIFICATION, cls.code())
                    .build());
        }
        CatalogRunWorkflow wf = client.newWorkflowStub(CatalogRunWorkflow.class, opts.build());
        try {
            WorkflowClient.start(wf::run, new RunRequest(def, blueprints, inputs.params(), me, cls, tag));
        } catch (WorkflowExecutionAlreadyStarted already) {
            return ResponseEntity.ok(new RunStarted(runId, true, status(runId)));
        }
        return ResponseEntity.status(HttpStatus.CREATED).body(new RunStarted(runId, false, status(runId)));
    }

    @Tag(name = "Catalog runs")
    @Operation(operationId = "listRuns", summary = "Recent runs", description = "Newest first, from the run records.")
    @GetMapping("/runs")
    public List<RunRow> runs(@RequestParam(defaultValue = "50") int limit,
                             @Parameter(description = "Only this definition") @RequestParam(required = false) String definition,
                             @Parameter(description = "Only this state") @RequestParam(required = false) String state) {
        return jdbc.sql("""
                SELECT workflow_id, run_id, definition, version, classification, requested_by, state,
                       to_char(started_at, 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM') AS s, to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM') AS u,
                       to_char(finished_at, 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM') AS f
                FROM catalog_run
                WHERE (CAST(:def AS TEXT) IS NULL OR definition = :def)
                  AND (CAST(:state AS TEXT) IS NULL OR state = :state)
                ORDER BY started_at DESC LIMIT :limit
                """)
                .param("def", definition).param("state", state).param("limit", Math.max(1, Math.min(limit, 500)))
                .query((rs, n) -> new RunRow(rs.getString("workflow_id"), rs.getString("run_id"), rs.getString("definition"),
                        rs.getInt("version"), rs.getString("classification"), rs.getString("requested_by"),
                        rs.getString("state"), rs.getString("s"), rs.getString("u"), rs.getString("f")))
                .list();
    }

    @Tag(name = "Catalog runs")
    @Operation(operationId = "getRun", summary = "Get a run", description = "Live from the run's workflow: every step, "
            + "what it produced, and what the run is waiting for.")
    @ApiResponse(responseCode = "404", description = "No such run", content = @Content(schema = @Schema(implementation = ApiError.class)))
    @GetMapping("/runs/{runId}")
    public RunStatus run(@PathVariable String runId) {
        return status(runId);
    }

    @Tag(name = "Catalog runs")
    @Operation(operationId = "resumeRun", summary = "Resume a stopped run",
            description = "Runs the failed step again (it picks up whatever its last try did), then carries on. "
                    + "The run's requester or an operator. 409 if the run isn't stopped after a failure.")
    @ApiResponse(responseCode = "409", description = "Not stopped", content = @Content(schema = @Schema(implementation = ApiError.class)))
    @PostMapping("/runs/{runId}/resume")
    public RunStatus resume(@PathVariable String runId, @RequestBody(required = false) ResumeBody body) {
        String me = actor(null);
        RunStatus now = status(runId);
        allowOwnerOrOperator("run.resume", me, now);
        try {
            return stub(runId).resume(me, body == null ? null : body.note());
        } catch (WorkflowNotFoundException finished) {
            throw finishedRun(now);
        }
    }

    @Tag(name = "Catalog runs")
    @Operation(operationId = "teardownRun", summary = "Tear a run down",
            description = "Undoes everything the run did, newest step first (including the failed step's partial work). "
                    + "For a run stopped after a failure or waiting for an approval. The run's requester or an operator.")
    @ApiResponse(responseCode = "409", description = "Not in a state that can be torn down",
            content = @Content(schema = @Schema(implementation = ApiError.class)))
    @PostMapping("/runs/{runId}/teardown")
    public RunStatus teardown(@PathVariable String runId, @RequestBody(required = false) TeardownBody body) {
        String me = actor(null);
        RunStatus now = status(runId);
        allowOwnerOrOperator("run.teardown", me, now);
        try {
            return stub(runId).teardown(me, body == null ? null : body.reason());
        } catch (WorkflowNotFoundException finished) {
            throw finishedRun(now);
        }
    }

    @Tag(name = "Catalog runs")
    @Operation(operationId = "approveRun", summary = "Approve or reject a waiting step",
            description = "Anyone but the run's requester, and only someone on the step's approvers list if it has one.")
    @ApiResponse(responseCode = "403", description = "Not allowed to answer", content = @Content(schema = @Schema(implementation = ApiError.class)))
    @ApiResponse(responseCode = "409", description = "Not waiting for an approval", content = @Content(schema = @Schema(implementation = ApiError.class)))
    @PostMapping("/runs/{runId}/approve")
    public RunStatus approve(@PathVariable String runId, @RequestBody ApproveBody body) {
        String me = actor(null);
        RunStatus now = status(runId);
        String code = now.classification() == null ? null : now.classification().code();
        Verdict builtIn;
        if (me.equals(now.requestedBy())) {
            builtIn = new Verdict(false, "four-eyes", "you started this run, so someone else has to approve it");
        } else if (now.approval() != null && !now.approval().approvers().isEmpty() && !now.approval().approvers().contains(me)) {
            builtIn = new Verdict(false, "approvers list", "only " + String.join(", ", now.approval().approvers()) + " can answer");
        } else {
            builtIn = new Verdict(true, now.approval() != null && !now.approval().approvers().isEmpty()
                    ? "approvers list and four-eyes" : "four-eyes", "not the requester");
        }
        Verdict v = decide("run.approve", me, runId, Map.of("approved", body.approved()), builtIn, code);
        if (!v.allowed()) throw new ResponseStatusException(HttpStatus.FORBIDDEN, v.reason());
        try {
            return stub(runId).approve(me, body.approved(), body.note());
        } catch (WorkflowNotFoundException finished) {
            throw finishedRun(now);
        }
    }

    /** An update sent to a run that has already ended: 409 with its final state, not 404. */
    private static ResponseStatusException finishedRun(RunStatus now) {
        return new ResponseStatusException(HttpStatus.CONFLICT, "This run has already ended (" + now.state()
                + "), so it can't be resumed, torn down or approved");
    }

    // ------------------------------------------------------------------ helpers

    /** The requester of the run, or an operator / admin. With sign-in off, anyone (and that's logged). */
    private void allowOwnerOrOperator(String action, String me, RunStatus run) {
        Verdict builtIn;
        if (Caller.signedIn() == null) {
            builtIn = new Verdict(true, "sign-in off", "no sign-in, so anyone may");
        } else if (me.equals(run.requestedBy())) {
            builtIn = new Verdict(true, "run requester", "it's their run");
        } else if (Caller.hasAnyRole(Role.OPERATOR, Role.ADMIN)) {
            builtIn = new Verdict(true, "role OPERATOR", "operators look after every run");
        } else {
            builtIn = new Verdict(false, "run requester or OPERATOR", "only the run's requester or an operator can do that");
        }
        Verdict v = decide(action, me, run.runId(), Map.of("state", String.valueOf(run.state()), "requestedBy",
                String.valueOf(run.requestedBy())), builtIn, run.classification() == null ? null : run.classification().code());
        if (!v.allowed()) throw new ResponseStatusException(HttpStatus.FORBIDDEN, v.reason());
    }

    /** Asks the policy (built-in, then OPA if set) and logs the answer. */
    private Verdict decide(String action, String actor, String resource, Map<String, Object> attrs, Verdict builtIn,
                           String classification) {
        List<String> roles = Caller.roles();
        Verdict v = policy.decide(action, actor, roles, resource, attrs, builtIn);
        decisions.record(actor, String.join(",", roles), action, resource, v.allowed(), v.policy(), v.reason(), classification);
        return v;
    }

    private Classification classification(Definition def, String asked) {
        Classification base = classifications.orDefault(def.classification());
        if (asked == null || asked.isBlank()) return base;
        if (!classifications.exists(asked)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "classification: '" + asked + "' isn't a code ("
                    + classifications.all().stream().map(Classification::code).toList() + ")");
        }
        Classification c = classifications.get(asked);
        if (c.retentionYears() < base.retentionYears()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "classification: " + def.name() + " is " + base.code()
                    + " (kept " + base.retentionYears() + " years); a run can be classified higher, not lower");
        }
        return c;
    }

    private RunStatus status(String runId) {
        try {
            return stub(runId).status();
        } catch (WorkflowNotFoundException e) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "No run " + runId
                    + " in Temporal (it may be older than Temporal keeps; see GET /api/v2/runs and the archive)");
        }
    }

    private CatalogRunWorkflow stub(String runId) {
        if (!runId.matches("run-[a-z0-9-]{3,80}")) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Not a run ID");
        return client.newWorkflowStub(CatalogRunWorkflow.class, runId);
    }

    private static String kind(String kind) {
        if (kind.equalsIgnoreCase(DefinitionParser.PROVISIONING)) return DefinitionParser.PROVISIONING;
        if (kind.equalsIgnoreCase(DefinitionParser.BLUEPRINT)) return DefinitionParser.BLUEPRINT;
        throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "kind must be Provisioning or Blueprint");
    }

    private static String actor(String claimed) {
        return Caller.nameOr(claimed, "demo-user");
    }
}
