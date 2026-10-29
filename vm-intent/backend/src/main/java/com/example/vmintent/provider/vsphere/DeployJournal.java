package com.example.vmintent.provider.vsphere;

import org.springframework.jdbc.core.simple.JdbcClient;

import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Remembers each vCenter deploy that vm-intent started: which task builds which VM, with which
 * idempotency key. A status check uses it to tell "still cloning" from "the clone failed", and a
 * retried create uses it to avoid starting a second clone. Kept in Postgres (table vsphere_deploy),
 * so every worker process sees the same answers and a restart forgets nothing.
 */
public interface DeployJournal {

    record Entry(String vmKey, String idempotencyKey, String taskId, String vm, boolean tagged) {}

    Optional<Entry> get(String vmKey);

    void started(String vmKey, String idempotencyKey, String taskId);

    void found(String vmKey, String vm, boolean tagged);

    void forget(String vmKey);

    /** Postgres. */
    class Jdbc implements DeployJournal {
        private final JdbcClient jdbc;

        public Jdbc(JdbcClient jdbc) {
            this.jdbc = jdbc;
        }

        @Override
        public Optional<Entry> get(String vmKey) {
            return jdbc.sql("SELECT vm_key, idempotency_key, task_id, vm, tagged FROM vsphere_deploy WHERE vm_key = :k")
                    .param("k", vmKey)
                    .query((rs, i) -> new Entry(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4), rs.getBoolean(5)))
                    .optional();
        }

        @Override
        public void started(String vmKey, String idempotencyKey, String taskId) {
            jdbc.sql("""
                    INSERT INTO vsphere_deploy (vm_key, idempotency_key, task_id) VALUES (:k, :key, :task)
                    ON CONFLICT (vm_key) DO UPDATE SET idempotency_key = :key, task_id = :task, vm = NULL, tagged = false, updated_at = now()
                    """).param("k", vmKey).param("key", idempotencyKey).param("task", taskId).update();
        }

        @Override
        public void found(String vmKey, String vm, boolean tagged) {
            jdbc.sql("""
                    INSERT INTO vsphere_deploy (vm_key, vm, tagged) VALUES (:k, :vm, :t)
                    ON CONFLICT (vm_key) DO UPDATE SET vm = :vm, tagged = :t, updated_at = now()
                    """).param("k", vmKey).param("vm", vm).param("t", tagged).update();
        }

        @Override
        public void forget(String vmKey) {
            jdbc.sql("DELETE FROM vsphere_deploy WHERE vm_key = :k").param("k", vmKey).update();
        }
    }

    /** In memory, for tests. */
    class InMemory implements DeployJournal {
        private final Map<String, Entry> entries = new ConcurrentHashMap<>();

        @Override
        public Optional<Entry> get(String vmKey) {
            return Optional.ofNullable(entries.get(vmKey));
        }

        @Override
        public void started(String vmKey, String idempotencyKey, String taskId) {
            entries.put(vmKey, new Entry(vmKey, idempotencyKey, taskId, null, false));
        }

        @Override
        public void found(String vmKey, String vm, boolean tagged) {
            Entry e = entries.get(vmKey);
            entries.put(vmKey, new Entry(vmKey, e == null ? null : e.idempotencyKey(), e == null ? null : e.taskId(), vm, tagged));
        }

        @Override
        public void forget(String vmKey) {
            entries.remove(vmKey);
        }
    }
}
