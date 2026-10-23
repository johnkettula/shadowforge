package com.example.vmintent.provider;

import com.example.vmintent.spec.VmSpec;
import com.example.vmintent.workflow.Models.VmLifecycle;
import com.example.vmintent.workflow.Models.VmRecord;
import com.example.vmintent.workflow.Models.VmResult;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;

/**
 * VM inventory, keyed by spec hash, stored in Postgres (table vm_record).
 * Because it's durable, the duplicate check ("this exact VM already exists")
 * still works after the app restarts.
 */
@Component
public class VmRegistry {

    private final JdbcClient jdbc;
    private final ObjectMapper json;

    public VmRegistry(JdbcClient jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    /** Insert or update the row for this spec hash. */
    public void put(VmRecord r) {
        jdbc.sql("""
                INSERT INTO vm_record (spec_hash, name, provider, region, state, detail, spec, result, updated_at)
                VALUES (:hash, :name, :provider, :region, :state, :detail,
                        CAST(:spec AS JSONB), CAST(:result AS JSONB), now())
                ON CONFLICT (spec_hash) DO UPDATE SET
                    state = EXCLUDED.state,
                    detail = EXCLUDED.detail,
                    spec = EXCLUDED.spec,
                    result = EXCLUDED.result,
                    -- A new build of the same spec starts a new life.
                    lifecycle = CASE WHEN EXCLUDED.state = 'PROVISIONING' THEN NULL ELSE vm_record.lifecycle END,
                    updated_at = now()
                """)
                .param("hash", r.specHash())
                .param("name", r.spec().name())
                .param("provider", r.spec().provider())
                .param("region", r.spec().region())
                .param("state", r.state())
                .param("detail", r.detail())
                .param("spec", toJson(r.spec()))
                .param("result", r.result() == null ? null : toJson(r.result()))
                .update();
    }

    /** Writes the lifecycle (expiry, power, size, snapshots) and, if state isn't null, a new state. */
    public void putLifecycle(String specHash, String state, VmLifecycle lifecycle) {
        jdbc.sql("""
                UPDATE vm_record SET lifecycle = CAST(:lc AS JSONB),
                                     state = COALESCE(:state, state),
                                     updated_at = now()
                WHERE spec_hash = :hash
                """)
                .param("lc", toJson(lifecycle))
                .param("state", state)
                .param("hash", specHash)
                .update();
    }

    /** RUNNING VMs on one cloud: VM ID -> spec hash. Used by the inventory check. */
    public Map<String, String> runningOn(String provider) {
        Map<String, String> out = new TreeMap<>();
        jdbc.sql("""
                SELECT spec_hash, result->>'vmId' AS vm_id FROM vm_record
                WHERE provider = :p AND state = 'RUNNING' AND result IS NOT NULL
                """)
                .param("p", provider)
                .query((rs, i) -> out.put(rs.getString("vm_id"), rs.getString("spec_hash")))
                .list();
        return out;
    }

    /** Every VM ID ever recorded for a cloud, in any state, so a VM we know about is never called an orphan. */
    public Set<String> knownVmIds(String provider) {
        return new HashSet<>(jdbc.sql("""
                SELECT result->>'vmId' FROM vm_record WHERE provider = :p AND result IS NOT NULL
                """).param("p", provider).query(String.class).list());
    }

    /** RUNNING -> MISSING, for a VM the cloud no longer has. */
    public void markMissing(String specHash, String detail) {
        jdbc.sql("UPDATE vm_record SET state = 'MISSING', detail = :d, updated_at = now() "
                        + "WHERE spec_hash = :hash AND state = 'RUNNING'")
                .param("d", detail).param("hash", specHash).update();
    }

    public VmRecord get(String specHash) {
        Optional<VmRecord> row = jdbc.sql(SELECT + " WHERE spec_hash = :hash")
                .param("hash", specHash)
                .query(this::map)
                .optional();
        return row.orElse(null);
    }

    /** The most recently changed VMs (capped, so the UI stays fast with thousands of VMs). */
    public List<VmRecord> all() {
        return jdbc.sql(SELECT + " ORDER BY updated_at DESC LIMIT 200").query(this::map).list();
    }

    public Map<String, Long> countByState() {
        Map<String, Long> out = new TreeMap<>();
        jdbc.sql("SELECT state, count(*) AS n FROM vm_record GROUP BY state")
                .query((rs, i) -> out.put(rs.getString("state"), rs.getLong("n")))
                .list();
        return out;
    }

    private static final String SELECT = """
            SELECT spec_hash, state, detail, spec::text AS spec_json, result::text AS result_json,
                   lifecycle::text AS lifecycle_json,
                   to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF') AS updated_text
            FROM vm_record""";

    private VmRecord map(ResultSet rs, int rowNum) throws SQLException {
        String resultJson = rs.getString("result_json");
        String lifecycleJson = rs.getString("lifecycle_json");
        return new VmRecord(
                rs.getString("spec_hash"),
                fromJson(rs.getString("spec_json"), VmSpec.class),
                rs.getString("state"),
                rs.getString("detail"),
                resultJson == null ? null : fromJson(resultJson, VmResult.class),
                rs.getString("updated_text"),
                lifecycleJson == null ? null : fromJson(lifecycleJson, VmLifecycle.class));
    }

    private String toJson(Object o) {
        try {
            return json.writeValueAsString(o);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Could not write JSON", e);
        }
    }

    private <T> T fromJson(String s, Class<T> type) {
        try {
            return json.readValue(s, type);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Could not read stored JSON", e);
        }
    }
}
