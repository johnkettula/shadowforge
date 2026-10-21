package com.example.vmintent.db;

import com.example.vmintent.api.ApiModels.BatchStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Batch bookkeeping. Progress is counted from the audit trail, which every VM workflow
 * writes to as it goes, so this never has to wait on a workflow or a worker. It keeps
 * answering even while workers are restarting.
 */
@Component
public class BatchStore {

    private final JdbcClient jdbc;

    public BatchStore(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public void create(String batchId, int total, int shardSize, String requestedBy) {
        jdbc.sql("INSERT INTO vm_batch (batch_id, total, shard_size, requested_by) VALUES (:id, :total, :shard, :by)")
                .param("id", batchId).param("total", total).param("shard", shardSize).param("by", requestedBy)
                .update();
    }

    /** Counts and timings for one batch, or empty if there's no such batch. */
    public Optional<BatchStatus> progress(String batchId) {
        // DISTINCT spec_hash: a retried audit write can't make a VM count twice.
        // Times are seconds from when the batch was submitted until each VM was running.
        List<Map<String, Object>> rows = jdbc.sql("""
                SELECT b.total, b.shard_size,
                       (extract(epoch FROM b.created_at) * 1000)::bigint AS created_ms,
                       count(DISTINCT a.spec_hash) FILTER (WHERE a.event = 'PROVISIONING') AS started,
                       count(DISTINCT a.spec_hash) FILTER (WHERE a.event = 'RUNNING')      AS running,
                       count(DISTINCT a.spec_hash) FILTER (WHERE a.event = 'ROLLED_BACK')  AS failed,
                       count(DISTINCT a.spec_hash) FILTER (WHERE a.event = 'DUPLICATE')    AS duplicate,
                       count(*) FILTER (WHERE a.event = 'BATCH_COMPLETED')                AS done,
                       percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM a.at - b.created_at))
                           FILTER (WHERE a.event = 'RUNNING') AS p50,
                       percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM a.at - b.created_at))
                           FILTER (WHERE a.event = 'RUNNING') AS p95,
                       max(extract(epoch FROM a.at - b.created_at)) FILTER (WHERE a.event = 'RUNNING') AS max_s,
                       (extract(epoch FROM max(a.at) FILTER (WHERE a.event = 'BATCH_COMPLETED')) * 1000)::bigint AS finished_ms
                FROM vm_batch b
                LEFT JOIN audit_event a ON a.request_id = b.batch_id
                WHERE b.batch_id = :id
                GROUP BY b.batch_id
                """)
                .param("id", batchId)
                .query()
                .listOfRows();
        if (rows.isEmpty()) return Optional.empty();
        Map<String, Object> r = rows.get(0);
        long started = num(r.get("started"));
        long running = num(r.get("running"));
        long failed = num(r.get("failed"));
        Object created = r.get("created_ms");
        Object finished = r.get("finished_ms");
        List<String> failures = jdbc.sql("""
                SELECT detail FROM audit_event
                WHERE request_id = :id AND event = 'ROLLED_BACK' ORDER BY id LIMIT 20
                """).param("id", batchId).query(String.class).list();
        BatchStatus out = new BatchStatus(batchId,
                num(r.get("done")) > 0 ? "COMPLETED" : "RUNNING",
                num(r.get("total")), num(r.get("shard_size")),
                started, Math.max(0, started - running - failed), running, failed, num(r.get("duplicate")),
                round(r.get("p50")), round(r.get("p95")), round(r.get("max_s")),
                created == null ? null : num(created), finished == null ? null : num(finished),
                failures);
        return Optional.of(out);
    }

    private static long num(Object o) {
        return o == null ? 0 : ((Number) o).longValue();
    }

    private static Double round(Object o) {
        return o == null ? null : Math.round(((Number) o).doubleValue() * 10) / 10.0;
    }
}
