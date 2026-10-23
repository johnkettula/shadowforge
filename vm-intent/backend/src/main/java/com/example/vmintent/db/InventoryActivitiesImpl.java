package com.example.vmintent.db;

import com.example.vmintent.provider.VmRegistry;
import com.example.vmintent.workflow.InventoryActivities;
import com.example.vmintent.workflow.Models.InventoryFinding;
import com.example.vmintent.workflow.Models.InventoryReport;
import com.example.vmintent.workflow.TaskQueues;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.temporal.spring.boot.ActivityImpl;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Database side of InventoryCheckWorkflow. */
@Component
@ActivityImpl(taskQueues = TaskQueues.INTENT)
public class InventoryActivitiesImpl implements InventoryActivities {

    /** A report lists at most this many examples of each kind; the counts are always complete. */
    static final int MAX_LISTED = 100;

    private final VmRegistry registry;
    private final AuditLog audit;
    private final JdbcClient jdbc;
    private final ObjectMapper json;

    public InventoryActivitiesImpl(VmRegistry registry, AuditLog audit, JdbcClient jdbc, ObjectMapper json) {
        this.registry = registry;
        this.audit = audit;
        this.jdbc = jdbc;
        this.json = json;
    }

    @Override
    public InventoryFinding compare(String provider, List<String> cloudVmIds) {
        Set<String> inCloud = new HashSet<>(cloudVmIds);
        Map<String, String> running = registry.runningOn(provider);   // vmId -> spec hash
        List<String> missing = new ArrayList<>();
        for (Map.Entry<String, String> e : running.entrySet()) {
            if (!inCloud.contains(e.getKey())) {
                missing.add(e.getValue());
                registry.markMissing(e.getValue(), "Not found in " + provider + " by the inventory check");
                audit.record(null, e.getValue(), "MISSING", "inventory-check", e.getKey() + " is no longer in " + provider);
            }
        }
        Set<String> known = registry.knownVmIds(provider);
        List<String> orphans = cloudVmIds.stream().filter(id -> !known.contains(id)).sorted().toList();
        int orphanCount = orphans.size();
        String note = missing.isEmpty() && orphans.isEmpty() ? "In step" : "Differences found";
        return new InventoryFinding(provider, note + (orphanCount > MAX_LISTED ? " (first " + MAX_LISTED + " orphans listed)" : ""),
                running.size(), cloudVmIds.size(),
                missing.size() > MAX_LISTED ? missing.subList(0, MAX_LISTED) : missing,
                orphanCount > MAX_LISTED ? orphans.subList(0, MAX_LISTED) : orphans);
    }

    @Override
    public void saveReport(InventoryReport report) {
        try {
            jdbc.sql("""
                    INSERT INTO inventory_check (check_id, report) VALUES (:id, CAST(:r AS JSONB))
                    ON CONFLICT (check_id) DO UPDATE SET report = EXCLUDED.report, finished_at = now()
                    """)
                    .param("id", report.checkId())
                    .param("r", json.writeValueAsString(report))
                    .update();
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
        audit.record(report.checkId(), null, "INVENTORY_CHECK", "inventory-check",
                report.missingCount() + " missing, " + report.orphanCount() + " orphans");
    }

    /** The newest reports, newest first. */
    public List<InventoryReport> latest(int limit) {
        return jdbc.sql("SELECT report::text FROM inventory_check ORDER BY finished_at DESC LIMIT :n")
                .param("n", limit)
                .query(String.class).list().stream()
                .map(s -> {
                    try {
                        return json.readValue(s, InventoryReport.class);
                    } catch (JsonProcessingException e) {
                        throw new IllegalStateException(e);
                    }
                }).toList();
    }
}
