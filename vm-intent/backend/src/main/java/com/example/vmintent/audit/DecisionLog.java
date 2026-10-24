package com.example.vmintent.audit;

import com.example.vmintent.catalog.CatalogModels.Classification;
import com.example.vmintent.catalog.ClassificationCatalog;
import io.swagger.v3.oas.annotations.media.Schema;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * Every authorization decision, allowed or refused (table access_decision): who asked to do what
 * to which thing, the answer, and the rule that gave it. Each row is kept for as long as its data
 * classification says (1-5 years) and then removed by the archive sweep.
 *
 * Writing the row is part of the decision: if it can't be written, the request fails rather than
 * going ahead unrecorded.
 */
@Component
public class DecisionLog {

    @Schema(description = "One authorization decision.")
    public record Decision(long id,
                           @Schema(description = "ISO-8601 time.") String at,
                           @Schema(example = "jdoe@example.com") String actor,
                           @Schema(example = "REQUESTER") String roles,
                           @Schema(example = "POST /api/v2/runs/run-web-server-3f2a9c41d07e/resume") String action,
                           String resource,
                           @Schema(allowableValues = {"ALLOW", "DENY"}) String decision,
                           @Schema(description = "The rule that decided.", example = "role rule: REQUESTER") String policy,
                           String reason,
                           @Schema(example = "C3") String classification,
                           @Schema(description = "Removed after this time (ISO-8601).") String keepUntil) {}

    private final JdbcClient jdbc;
    private final ClassificationCatalog classifications;

    public DecisionLog(JdbcClient jdbc, ClassificationCatalog classifications) {
        this.jdbc = jdbc;
        this.classifications = classifications;
    }

    public void record(String actor, String roles, String action, String resource, boolean allowed,
                       String policy, String reason, String classificationCode) {
        Classification c = classifications.exists(classificationCode)
                ? classifications.get(classificationCode) : classifications.defaultClassification();
        jdbc.sql("""
                INSERT INTO access_decision (actor, roles, action, resource, decision, policy, reason, classification, keep_until)
                VALUES (:actor, :roles, :action, :resource, :decision, :policy, :reason, :code,
                        now() + make_interval(years => :years))
                """)
                .param("actor", actor == null || actor.isBlank() ? "anonymous" : actor)
                .param("roles", roles)
                .param("action", cut(action, 300))
                .param("resource", cut(resource, 300))
                .param("decision", allowed ? "ALLOW" : "DENY")
                .param("policy", cut(policy, 200))
                .param("reason", cut(reason, 1000))
                .param("code", c.code())
                .param("years", c.retentionYears())
                .update();
    }

    /** Newest first. Any filter may be null. resource matches as a prefix. */
    public List<Decision> find(String actor, String resourcePrefix, String decision, int limit) {
        return jdbc.sql("""
                SELECT id, to_char(at, 'YYYY-MM-DD"T"HH24:MI:SS.MSTZH:TZM') AS at_text, actor, roles, action, resource,
                       decision, policy, reason, classification, to_char(keep_until, 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM') AS keep_text
                FROM access_decision
                WHERE (CAST(:actor AS TEXT) IS NULL OR actor = :actor)
                  AND (CAST(:res AS TEXT) IS NULL OR resource LIKE :res)
                  AND (CAST(:decision AS TEXT) IS NULL OR decision = :decision)
                ORDER BY id DESC LIMIT :limit
                """)
                .param("actor", actor)
                .param("res", resourcePrefix == null ? null : resourcePrefix.replace("%", "\\%") + "%")
                .param("decision", decision)
                .param("limit", limit)
                .query((rs, n) -> new Decision(rs.getLong("id"), rs.getString("at_text"), rs.getString("actor"),
                        rs.getString("roles"), rs.getString("action"), rs.getString("resource"), rs.getString("decision"),
                        rs.getString("policy"), rs.getString("reason"), rs.getString("classification"),
                        rs.getString("keep_text")))
                .list();
    }

    /** Removes rows past their keep-until time. Returns how many. */
    public int expire() {
        return jdbc.sql("DELETE FROM access_decision WHERE keep_until < now()").update();
    }

    private static String cut(String s, int max) {
        return s == null || s.length() <= max ? s : s.substring(0, max);
    }
}
