package com.example.vmintent.audit;

import com.example.vmintent.db.AuditLog;
import com.example.vmintent.workflow.ArchiveSweepWorkflowImpl;
import com.example.vmintent.workflow.BatchProvisionWorkflowImpl;
import com.example.vmintent.workflow.BatchShardWorkflowImpl;
import com.example.vmintent.workflow.CatalogRunWorkflowImpl;
import com.example.vmintent.workflow.IntentWorkflowImpl;
import com.example.vmintent.workflow.InventoryCheckWorkflowImpl;
import com.example.vmintent.workflow.VmLifecycleWorkflowImpl;
import com.example.vmintent.workflow.VmReconcileWorkflowImpl;
import com.google.protobuf.util.JsonFormat;
import io.swagger.v3.oas.annotations.media.Schema;
import io.temporal.api.history.v1.History;
import io.temporal.client.WorkflowClient;
import io.temporal.common.WorkflowExecutionHistory;
import io.temporal.worker.Worker;
import io.temporal.worker.WorkerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * Audit replay: runs today's workflow code against a recorded history, without doing anything.
 *
 * Replay is how Temporal itself recovers a workflow. Every decision the code makes is checked
 * against the history: which activities it called, with what, in what order, which timers it set.
 * Nothing is executed again (no cloud calls, no files, no database writes): the activities'
 * recorded results are fed back in. If the code would have done anything differently, the replay
 * fails and says where. So a passing replay shows the recorded run is exactly what this code does.
 *
 * The history comes from the archive (its SHA-256 is checked first) or, if it isn't archived
 * yet, from Temporal.
 */
@Component
public class ReplayService {

    /** Every workflow this application runs. */
    static final List<Class<?>> WORKFLOWS = List.of(IntentWorkflowImpl.class, VmReconcileWorkflowImpl.class,
            VmLifecycleWorkflowImpl.class, BatchProvisionWorkflowImpl.class, BatchShardWorkflowImpl.class,
            InventoryCheckWorkflowImpl.class, CatalogRunWorkflowImpl.class, ArchiveSweepWorkflowImpl.class);

    @Schema(description = "What an audit replay found.")
    public record ReplayResult(
            String workflowId, String runId, String workflowType,
            @Schema(allowableValues = {"archive", "temporal"}) String source,
            @Schema(description = "Events in the history.") int events,
            @Schema(description = "SHA-256 of the archived file, checked before the replay.") String sha256,
            @Schema(description = "true = today's code makes exactly the decisions recorded in the history.") boolean matches,
            @Schema(description = "Where and why it differs, if it does.") String problem,
            String replayedAt, String replayedBy) {}

    private final WorkflowClient client;
    private final ArchiveStore store;
    private final JdbcClient jdbc;
    private final AuditLog audit;

    public ReplayService(WorkflowClient client, ArchiveStore store, JdbcClient jdbc, AuditLog audit) {
        this.client = client;
        this.store = store;
        this.jdbc = jdbc;
        this.audit = audit;
    }

    /** runId null = the newest archived run of that workflow, else the newest in Temporal. */
    public ReplayResult replay(String workflowId, String runId, String who) throws Exception {
        Optional<Map<String, Object>> rec = jdbc.sql("""
                SELECT run_id, workflow_type, path, sha256 FROM archive_record
                WHERE workflow_id = :wf AND (CAST(:run AS TEXT) IS NULL OR run_id = :run) AND expired_at IS NULL
                ORDER BY closed_at DESC LIMIT 1
                """).param("wf", workflowId).param("run", runId).query().listOfRows().stream().findFirst();
        WorkflowExecutionHistory history;
        String source;
        String sha = null;
        if (rec.isPresent()) {
            sha = String.valueOf(rec.get().get("sha256"));
            String json = store.read(String.valueOf(rec.get().get("path")), sha);
            History.Builder h = History.newBuilder();
            JsonFormat.parser().ignoringUnknownFields().merge(json, h);
            history = new WorkflowExecutionHistory(h.build(), workflowId);
            source = "archive";
        } else {
            history = runId == null ? client.fetchHistory(workflowId) : client.fetchHistory(workflowId, runId);
            source = "temporal";
        }
        String type = history.getEvents().isEmpty() ? null : history.getEvents().get(0)
                .getWorkflowExecutionStartedEventAttributes().getWorkflowType().getName();
        String rid = rec.map(r -> String.valueOf(r.get("run_id"))).orElse(runId != null ? runId
                : history.getEvents().get(0).getWorkflowExecutionStartedEventAttributes().getOriginalExecutionRunId());

        boolean matches = true;
        String problem = null;
        WorkerFactory factory = WorkerFactory.newInstance(client);
        try {
            Worker w = factory.newWorker("audit-replay-" + UUID.randomUUID());
            w.registerWorkflowImplementationTypes(WORKFLOWS.toArray(new Class<?>[0]));
            w.replayWorkflowExecution(history);
        } catch (Exception | Error e) {
            matches = false;
            Throwable t = e;
            while (t.getCause() != null && t.getCause() != t) t = t.getCause();
            problem = t.getClass().getSimpleName() + ": " + t.getMessage();
        } finally {
            factory.shutdownNow();
        }
        audit.record(workflowId, null, "AUDIT_REPLAY", who, (matches ? "matches" : "DIFFERS") + " (" + source + ", "
                + history.getEvents().size() + " events)" + (problem == null ? "" : ": " + problem));
        return new ReplayResult(workflowId, rid, type, source, history.getEvents().size(), sha, matches, problem,
                Instant.now().toString(), who);
    }
}
