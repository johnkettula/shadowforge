package com.example.vmintent.audit;

import com.example.vmintent.catalog.CatalogModels.Classification;
import com.example.vmintent.catalog.ClassificationCatalog;
import com.example.vmintent.workflow.ArchiveActivities;
import com.example.vmintent.workflow.RequestSearch;
import com.example.vmintent.workflow.TaskQueues;
import com.google.protobuf.util.JsonFormat;
import io.temporal.client.WorkflowClient;
import io.temporal.client.WorkflowExecutionMetadata;
import io.temporal.common.WorkflowExecutionHistory;
import io.temporal.failure.ApplicationFailure;
import io.temporal.spring.boot.ActivityImpl;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The archive sweep's activities. Histories are exported in the same JSON format as
 * "temporal workflow show --output json", so they can also be replayed with Temporal's own tools.
 */
@Component
@ActivityImpl(taskQueues = TaskQueues.INTENT)
public class ArchiveActivitiesImpl implements ArchiveActivities {

    private static final Logger log = LoggerFactory.getLogger(ArchiveActivitiesImpl.class);
    /** Not archived: the sweep would only be archiving itself. */
    static final Set<String> SKIPPED_TYPES = Set.of("ArchiveSweepWorkflow");

    private final WorkflowClient client;
    private final ArchiveStore store;
    private final ClassificationCatalog classifications;
    private final DecisionLog decisions;
    private final JdbcClient jdbc;
    private final int lookbackDays;

    public ArchiveActivitiesImpl(WorkflowClient client, ArchiveStore store, ClassificationCatalog classifications,
                                 DecisionLog decisions, JdbcClient jdbc,
                                 @Value("${vmintent.audit.sweep-lookback-days:30}") int lookbackDays) {
        this.client = client;
        this.store = store;
        this.classifications = classifications;
        this.decisions = decisions;
        this.jdbc = jdbc;
        this.lookbackDays = Math.max(1, lookbackDays);
    }

    @Override
    public List<ClosedRun> findUnarchived(int max) {
        Instant since = Instant.now().minus(Duration.ofDays(lookbackDays));
        String query = "ExecutionStatus != 'Running' AND CloseTime > '" + since + "'";
        List<WorkflowExecutionMetadata> closed;
        try {
            closed = client.listExecutions(query).limit(Math.max(max * 5L, 1000)).toList();
        } catch (Exception e) {
            throw ApplicationFailure.newFailure("Couldn't list closed workflows: " + e.getMessage(), "Visibility");
        }
        List<WorkflowExecutionMetadata> candidates = closed.stream()
                .filter(m -> !SKIPPED_TYPES.contains(m.getWorkflowType())).toList();
        Set<String> done = archived(candidates.stream().map(m -> m.getExecution().getWorkflowId()).distinct().toList());
        List<ClosedRun> out = new ArrayList<>();
        for (WorkflowExecutionMetadata m : candidates) {
            String wf = m.getExecution().getWorkflowId();
            String run = m.getExecution().getRunId();
            if (done.contains(wf + "/" + run)) continue;
            String code = null;
            try {
                code = m.getTypedSearchAttributes().get(RequestSearch.CLASSIFICATION);
            } catch (Exception notSet) {
                // not a catalog run, or the attribute isn't set up
            }
            out.add(new ClosedRun(wf, run, m.getWorkflowType(), m.getCloseTime() == null ? null : m.getCloseTime().toString(), code));
            if (out.size() >= max) break;
        }
        return out;
    }

    private Set<String> archived(List<String> workflowIds) {
        Set<String> out = new HashSet<>();
        for (int i = 0; i < workflowIds.size(); i += 500) {
            List<String> chunk = workflowIds.subList(i, Math.min(workflowIds.size(), i + 500));
            jdbc.sql("SELECT workflow_id, run_id FROM archive_record WHERE workflow_id IN (:ids)")
                    .param("ids", chunk)
                    .query((rs, n) -> rs.getString(1) + "/" + rs.getString(2))
                    .list().forEach(out::add);
        }
        return out;
    }

    @Override
    public boolean archive(ClosedRun run) {
        Classification c = classificationFor(run);
        try {
            WorkflowExecutionHistory h = client.fetchHistory(run.workflowId(), run.runId());
            // Sorted map keys: the server sends maps (search attributes, headers) in any order, and the
            // same history must always give the same file and SHA-256.
            String json = JsonFormat.printer().sortingMapKeys().print(h.getHistory());
            Instant closed = run.closedAt() == null ? Instant.now() : Instant.parse(run.closedAt());
            String path = ArchiveStore.pathFor(c.retentionYears(), c.code(), closed, run.workflowId(), run.runId());
            ArchiveStore.Stored s = store.write(path, json);
            int rows = jdbc.sql("""
                    INSERT INTO archive_record (workflow_id, run_id, workflow_type, classification, retention_years,
                                                closed_at, keep_until, path, sha256, size_bytes, events)
                    VALUES (:wf, :run, :type, :code, :years, :closed, CAST(:closed AS timestamptz) + make_interval(years => :years),
                            :path, :sha, :size, :events)
                    ON CONFLICT (workflow_id, run_id) DO NOTHING
                    """)
                    .param("wf", run.workflowId()).param("run", run.runId()).param("type", run.workflowType())
                    .param("code", c.code()).param("years", c.retentionYears()).param("closed", Timestamp.from(closed))
                    .param("path", s.path()).param("sha", s.sha256()).param("size", s.sizeBytes())
                    .param("events", h.getEvents().size())
                    .update();
            return rows > 0 && !s.alreadyThere();
        } catch (Exception e) {
            throw ApplicationFailure.newFailure("Couldn't archive " + run.workflowId() + ": " + e.getMessage(), "ArchiveFailed");
        }
    }

    /** The run's own classification (catalog runs), else the default one. */
    private Classification classificationFor(ClosedRun run) {
        String code = run.classification();
        if (code == null) {
            code = jdbc.sql("SELECT classification FROM catalog_run WHERE workflow_id = :wf AND run_id = :run")
                    .param("wf", run.workflowId()).param("run", run.runId()).query(String.class).optional().orElse(null);
        }
        return classifications.exists(code) ? classifications.get(code) : classifications.defaultClassification();
    }

    @Override
    public int[] expire() {
        List<Map<String, Object>> due = jdbc.sql("""
                SELECT workflow_id, run_id, path FROM archive_record
                WHERE expired_at IS NULL AND keep_until < now() ORDER BY keep_until LIMIT 1000
                """).query().listOfRows();
        int removed = 0;
        for (Map<String, Object> r : due) {
            try {
                store.delete(String.valueOf(r.get("path")));
                jdbc.sql("UPDATE archive_record SET expired_at = now() WHERE workflow_id = :wf AND run_id = :run")
                        .param("wf", r.get("workflow_id")).param("run", r.get("run_id")).update();
                removed++;
            } catch (Exception e) {
                log.warn("Couldn't remove expired archive file {}: {}", r.get("path"), e.getMessage());
            }
        }
        int d = decisions.expire();
        if (removed > 0 || d > 0) {
            log.info("Retention: removed {} archived histories and {} decision-log rows past their retention", removed, d);
        }
        return new int[]{removed, d};
    }
}
