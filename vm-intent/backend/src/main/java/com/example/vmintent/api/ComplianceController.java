package com.example.vmintent.api;

import com.example.vmintent.api.ApiModels.ApiError;
import com.example.vmintent.audit.ArchiveStore;
import com.example.vmintent.audit.DecisionLog;
import com.example.vmintent.audit.ReplayService;
import com.example.vmintent.security.Caller;
import com.example.vmintent.workflow.ArchiveSweepWorkflow;
import com.example.vmintent.workflow.TaskQueues;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.tags.Tag;
import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowNotFoundException;
import io.temporal.client.WorkflowOptions;
import org.springframework.http.HttpHeaders;
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

import java.util.List;

/**
 * For auditors: every authorization decision, the archive of workflow histories (kept 1-5 years by
 * data classification) and audit replays, which re-run a recorded workflow against today's code
 * without doing anything again. See docs/AUDIT.md.
 */
@RestController
@org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication   // not in worker pods
@RequestMapping("/api/v2/compliance")
@Tag(name = "Compliance")
public class ComplianceController {

    @Schema(description = "One archived workflow history.")
    public record ArchiveRow(String workflowId, String runId, String workflowType, String classification,
                             int retentionYears, String closedAt, String archivedAt,
                             @Schema(description = "Removed after this time.") String keepUntil,
                             String sha256, long sizeBytes, int events,
                             @Schema(description = "Set when the file was removed at the end of its retention.") String expiredAt) {}

    @Schema(description = "Replay a recorded workflow.")
    public record ReplayBody(@Schema(requiredMode = Schema.RequiredMode.REQUIRED, example = "run-web-server-3f2a9c41d07e")
                             String workflowId,
                             @Schema(description = "A run; empty = the newest archived one, else the newest in Temporal.")
                             String runId) {}

    public record SweepStarted(String workflowId) {}

    private final DecisionLog decisions;
    private final ReplayService replays;
    private final ArchiveStore store;
    private final JdbcClient jdbc;
    private final WorkflowClient client;

    public ComplianceController(DecisionLog decisions, ReplayService replays, ArchiveStore store, JdbcClient jdbc,
                                WorkflowClient client) {
        this.decisions = decisions;
        this.replays = replays;
        this.store = store;
        this.jdbc = jdbc;
        this.client = client;
    }

    @Operation(operationId = "listDecisions", summary = "The decision log",
            description = "Every authorization decision, newest first: who asked to do what, ALLOW or DENY, and the rule "
                    + "that decided. Each is kept for its classification's retention.")
    @GetMapping("/decisions")
    public List<DecisionLog.Decision> decisions(
            @Parameter(description = "Only this person or service") @RequestParam(required = false) String actor,
            @Parameter(description = "Only resources starting with this, e.g. a run ID") @RequestParam(required = false) String resource,
            @Parameter(description = "ALLOW or DENY") @RequestParam(required = false) String decision,
            @RequestParam(defaultValue = "100") int limit) {
        return decisions.find(blank(actor), blank(resource), blank(decision) == null ? null : decision.toUpperCase(),
                Math.max(1, Math.min(limit, 1000)));
    }

    @Operation(operationId = "listArchive", summary = "Archived histories", description = "Newest first.")
    @GetMapping("/archive")
    public List<ArchiveRow> archive(@RequestParam(required = false) String workflowId,
                                    @RequestParam(required = false) String classification,
                                    @RequestParam(defaultValue = "100") int limit) {
        return jdbc.sql("""
                SELECT workflow_id, run_id, workflow_type, classification, retention_years,
                       to_char(closed_at, 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM') c, to_char(archived_at, 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM') a,
                       to_char(keep_until, 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM') k, sha256, size_bytes, events,
                       to_char(expired_at, 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM') e
                FROM archive_record
                WHERE (CAST(:wf AS TEXT) IS NULL OR workflow_id = :wf)
                  AND (CAST(:cls AS TEXT) IS NULL OR classification = :cls)
                ORDER BY archived_at DESC LIMIT :limit
                """)
                .param("wf", blank(workflowId)).param("cls", blank(classification)).param("limit", Math.max(1, Math.min(limit, 1000)))
                .query((rs, n) -> new ArchiveRow(rs.getString("workflow_id"), rs.getString("run_id"), rs.getString("workflow_type"),
                        rs.getString("classification"), rs.getInt("retention_years"), rs.getString("c"), rs.getString("a"),
                        rs.getString("k"), rs.getString("sha256"), rs.getLong("size_bytes"), rs.getInt("events"), rs.getString("e")))
                .list();
    }

    @Operation(operationId = "downloadArchivedHistory", summary = "Download an archived history",
            description = "The history JSON, as \"temporal workflow show --output json\" writes it. Its SHA-256 is checked first.")
    @ApiResponse(responseCode = "200", description = "The history", content = @Content(mediaType = "application/json"))
    @ApiResponse(responseCode = "404", description = "Not archived, or past its retention",
            content = @Content(schema = @Schema(implementation = ApiError.class)))
    @GetMapping("/archive/{workflowId}/{runId}")
    public ResponseEntity<String> download(@PathVariable String workflowId, @PathVariable String runId) throws Exception {
        var row = jdbc.sql("SELECT path, sha256 FROM archive_record WHERE workflow_id = :wf AND run_id = :run AND expired_at IS NULL")
                .param("wf", workflowId).param("run", runId).query().listOfRows().stream().findFirst()
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "That run isn't in the archive"));
        String json = store.read(String.valueOf(row.get("path")), String.valueOf(row.get("sha256")));
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_JSON)
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + workflowId.replaceAll("[^A-Za-z0-9._-]", "_")
                        + "__" + runId + ".json\"")
                .header("X-Content-SHA256", String.valueOf(row.get("sha256")))
                .body(json);
    }

    @Operation(operationId = "replayWorkflow", summary = "Replay a recorded workflow for audit",
            description = "Runs today's code against the recorded history without doing anything again: no cloud calls, "
                    + "no files, no database writes. matches=true shows the recorded run is exactly what this code does. "
                    + "Uses the archive (SHA-256 checked) or, if it isn't archived yet, Temporal.")
    @ApiResponse(responseCode = "200", description = "The result (matches true or false)")
    @ApiResponse(responseCode = "404", description = "No such workflow in the archive or Temporal",
            content = @Content(schema = @Schema(implementation = ApiError.class)))
    @PostMapping("/replays")
    public ReplayService.ReplayResult replay(@RequestBody ReplayBody body) throws Exception {
        if (body == null || blank(body.workflowId()) == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "workflowId: which workflow to replay");
        }
        try {
            return replays.replay(body.workflowId().trim(), blank(body.runId()), Caller.nameOr(null, "demo-user"));
        } catch (WorkflowNotFoundException e) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "No history for " + body.workflowId()
                    + " in the archive or in Temporal");
        } catch (io.grpc.StatusRuntimeException e) {
            if (e.getStatus().getCode() == io.grpc.Status.Code.NOT_FOUND) {
                throw new ResponseStatusException(HttpStatus.NOT_FOUND, "No history for " + body.workflowId()
                        + " in the archive or in Temporal");
            }
            throw e;
        }
    }

    @Operation(operationId = "runArchiveSweep", summary = "Run the archive sweep now",
            description = "Copies closed histories to the archive and removes what is past its retention. It also runs "
                    + "every hour on the vm-archive-sweep schedule.")
    @ApiResponse(responseCode = "202", description = "Started")
    @PostMapping("/sweeps")
    public ResponseEntity<SweepStarted> sweep() {
        String id = "archive-sweep-manual-" + System.currentTimeMillis();
        ArchiveSweepWorkflow wf = client.newWorkflowStub(ArchiveSweepWorkflow.class,
                WorkflowOptions.newBuilder().setTaskQueue(TaskQueues.INTENT).setWorkflowId(id).build());
        WorkflowClient.start(wf::sweep);
        return ResponseEntity.accepted().body(new SweepStarted(id));
    }

    private static String blank(String s) {
        return s == null || s.isBlank() ? null : s.trim();
    }
}
