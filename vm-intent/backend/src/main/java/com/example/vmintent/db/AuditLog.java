package com.example.vmintent.db;

import io.swagger.v3.oas.annotations.media.Schema;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import java.util.List;

/** Append-only audit trail stored in the audit_event table. */
@Component
public class AuditLog {

    @Schema(description = "One thing that happened, in order.")
    public record AuditEvent(long id,
                             @Schema(description = "ISO-8601 time.") String at,
                             @Schema(description = "Request or batch ID.") String requestId,
                             String specHash,
                             @Schema(description = "REQUESTED, QUESTION_ASKED, ANSWERED, INTERPRETED, CONFIRMED, "
                                     + "PROVISIONING, VM_CREATED, RUNNING, ROLLED_BACK, DUPLICATE, COMPLETED, FAILED, "
                                     + "CANCELLED, BATCH_STARTED, BATCH_COMPLETED", example = "RUNNING")
                             String event,
                             @Schema(description = "A user ID, system, or legacy-api.", example = "system") String actor,
                             String detail) {}

    private final JdbcClient jdbc;

    public AuditLog(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public void record(String requestId, String specHash, String event, String actor, String detail) {
        jdbc.sql("""
                INSERT INTO audit_event (request_id, spec_hash, event, actor, detail)
                VALUES (:requestId, :specHash, :event, :actor, :detail)
                """)
                .param("requestId", requestId)
                .param("specHash", specHash)
                .param("event", event)
                .param("actor", actor)
                .param("detail", detail)
                .update();
    }

    /**
     * Events for one request, one spec (full hash or a prefix of 8+ characters),
     * or the most recent overall when both are null. Oldest first.
     */
    public List<AuditEvent> find(String requestId, String specHashPrefix, int limit) {
        String hashLike = specHashPrefix == null ? null : specHashPrefix + "%";
        return jdbc.sql("""
                SELECT * FROM (
                    SELECT id, to_char(at, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF') AS at_text,
                           request_id, spec_hash, event, actor, detail
                    FROM audit_event
                    WHERE (CAST(:requestId AS TEXT) IS NULL OR request_id = :requestId)
                      AND (CAST(:hashLike AS TEXT) IS NULL OR spec_hash LIKE :hashLike)
                    ORDER BY id DESC
                    LIMIT :limit
                ) recent ORDER BY id
                """)
                .param("requestId", requestId)
                .param("hashLike", hashLike)
                .param("limit", limit)
                .query((rs, n) -> new AuditEvent(
                        rs.getLong("id"), rs.getString("at_text"), rs.getString("request_id"),
                        rs.getString("spec_hash"), rs.getString("event"), rs.getString("actor"),
                        rs.getString("detail")))
                .list();
    }
}
