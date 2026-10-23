package com.example.vmintent.provider;

import com.example.vmintent.workflow.Models.VmStatus;
import io.temporal.failure.ApplicationFailure;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;

/**
 * The pretend cloud behind the four simulated providers.
 *
 * It keeps its "VMs" in Postgres (table sim_cloud_vm), not in memory, so any
 * number of worker processes on any number of machines see the same cloud.
 * That's what makes the multi-worker load test honest.
 *
 * It behaves like a real cloud API in the ways that matter for scale:
 *  - create returns at once and the VM boots in the background (boot time is
 *    between vmintent.sim.boot-min-seconds and boot-max-seconds);
 *  - the same idempotency key never makes a second VM;
 *  - a small share of calls are refused with "throttled", like an HTTP 429,
 *    and Temporal retries them with backoff.
 *
 * Tip: name a VM with "fail" in it ("called fail-test") to watch the saga roll back.
 */
@Component
public class SimCloud {

    private final JdbcClient jdbc;
    private final int bootMin;
    private final int bootMax;
    private final int apiLatencyMs;
    private final double throttleRate;

    public SimCloud(JdbcClient jdbc,
                    @Value("${vmintent.sim.boot-min-seconds:20}") int bootMin,
                    @Value("${vmintent.sim.boot-max-seconds:60}") int bootMax,
                    @Value("${vmintent.sim.api-latency-ms:250}") int apiLatencyMs,
                    @Value("${vmintent.sim.throttle-rate:0.02}") double throttleRate) {
        this.jdbc = jdbc;
        this.bootMin = bootMin;
        this.bootMax = Math.max(bootMin, bootMax);
        this.apiLatencyMs = apiLatencyMs;
        this.throttleRate = throttleRate;
    }

    public String create(String provider, String idPrefix, String name, String idempotencyKey) {
        callApi();
        // Same key -> same boot time, so a retried call doesn't change the answer.
        int boot = bootMin + Math.floorMod(idempotencyKey.hashCode(), bootMax - bootMin + 1);
        String vmId = idPrefix + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        jdbc.sql("""
                INSERT INTO sim_cloud_vm (vm_id, idempotency_key, provider, name, state, ready_at, ip)
                VALUES (:id, :key, :provider, :name, 'PENDING', now() + make_interval(secs => :boot), :ip)
                ON CONFLICT (idempotency_key) DO NOTHING
                """)
                .param("id", vmId)
                .param("key", idempotencyKey)
                .param("provider", provider)
                .param("name", name)
                .param("boot", boot)
                .param("ip", ipFor(vmId))
                .update();
        // If the key was used before, this returns the VM made then.
        return jdbc.sql("SELECT vm_id FROM sim_cloud_vm WHERE idempotency_key = :key")
                .param("key", idempotencyKey)
                .query(String.class)
                .single();
    }

    public VmStatus describe(String vmId) {
        callApi();
        List<Map<String, Object>> rows = jdbc.sql("""
                SELECT name, state, ip, ready_at <= now() AS ready
                FROM sim_cloud_vm WHERE vm_id = :id
                """)
                .param("id", vmId)
                .query()
                .listOfRows();
        if (rows.isEmpty()) {
            // Like a real cloud's "instance not found": retrying won't help.
            throw ApplicationFailure.newNonRetryableFailure("VM " + vmId + " not found", "VmNotFound");
        }
        Map<String, Object> row = rows.get(0);
        String state = (String) row.get("state");
        if ("DELETED".equals(state)) return new VmStatus("FAILED", null, "VM was deleted");
        if (!Boolean.TRUE.equals(row.get("ready"))) return new VmStatus("PENDING", null, "booting");
        String name = (String) row.get("name");
        if (name != null && name.contains("fail")) {
            return new VmStatus("FAILED", null, "Simulated boot failure for " + vmId);
        }
        if (!"RUNNING".equals(state)) {
            jdbc.sql("UPDATE sim_cloud_vm SET state = 'RUNNING' WHERE vm_id = :id AND state = 'PENDING'")
                    .param("id", vmId).update();
        }
        return new VmStatus("RUNNING", (String) row.get("ip"), "running");
    }

    public void delete(String vmId) {
        callApi();
        jdbc.sql("UPDATE sim_cloud_vm SET state = 'DELETED' WHERE vm_id = :id")
                .param("id", vmId).update();
    }

    public void resize(String vmId, int vcpu, int memoryGiB) {
        callApi();
        requireLive(vmId);
        jdbc.sql("UPDATE sim_cloud_vm SET vcpu = :c, memory_gib = :m WHERE vm_id = :id")
                .param("c", vcpu).param("m", memoryGiB).param("id", vmId).update();
    }

    public void setPower(String vmId, boolean on) {
        callApi();
        requireLive(vmId);
        jdbc.sql("UPDATE sim_cloud_vm SET power = :p WHERE vm_id = :id")
                .param("p", on ? "ON" : "OFF").param("id", vmId).update();
    }

    public String snapshot(String vmId, String label) {
        callApi();
        requireLive(vmId);
        int n = jdbc.sql("UPDATE sim_cloud_vm SET snapshot_count = snapshot_count + 1 WHERE vm_id = :id RETURNING snapshot_count")
                .param("id", vmId).query(Integer.class).single();
        return "snap-" + vmId.replaceAll("[^a-z0-9]", "") + "-" + n;
    }

    /** VMs of one provider that aren't deleted. */
    public List<String> list(String provider) {
        callApi();
        return jdbc.sql("SELECT vm_id FROM sim_cloud_vm WHERE provider = :p AND state <> 'DELETED' ORDER BY vm_id")
                .param("p", provider).query(String.class).list();
    }

    private void requireLive(String vmId) {
        List<String> state = jdbc.sql("SELECT state FROM sim_cloud_vm WHERE vm_id = :id")
                .param("id", vmId).query(String.class).list();
        if (state.isEmpty() || "DELETED".equals(state.get(0))) {
            throw ApplicationFailure.newNonRetryableFailure("VM " + vmId + " not found", "VmNotFound");
        }
    }

    /** A real API call takes time and is sometimes refused. */
    private void callApi() {
        ThreadLocalRandom rnd = ThreadLocalRandom.current();
        if (apiLatencyMs > 0) {
            sleep(apiLatencyMs / 2 + rnd.nextInt(apiLatencyMs + 1));
        }
        if (rnd.nextDouble() < throttleRate) {
            // Retryable: Temporal tries again after the activity's backoff interval.
            throw ApplicationFailure.newFailure("Simulated cloud API throttling (HTTP 429)", "Throttled");
        }
    }

    private static String ipFor(String vmId) {
        int h = vmId.hashCode();
        return "10." + Math.floorMod(h >> 16, 256) + "." + Math.floorMod(h >> 8, 256) + "." + (Math.floorMod(h, 250) + 2);
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
