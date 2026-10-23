-- Life after the build: expiry, power, current size and snapshots (written by VmLifecycleWorkflow).
ALTER TABLE vm_record ADD COLUMN lifecycle JSONB;

-- The simulated cloud remembers power, size and snapshots so day-2 changes can be seen.
ALTER TABLE sim_cloud_vm ADD COLUMN power          TEXT NOT NULL DEFAULT 'ON';
ALTER TABLE sim_cloud_vm ADD COLUMN vcpu           INT;
ALTER TABLE sim_cloud_vm ADD COLUMN memory_gib     INT;
ALTER TABLE sim_cloud_vm ADD COLUMN snapshot_count INT NOT NULL DEFAULT 0;
CREATE INDEX sim_cloud_vm_provider_idx ON sim_cloud_vm (provider, state);

-- Results of the scheduled inventory check (drift and orphans), newest first.
CREATE TABLE inventory_check (
    check_id     TEXT PRIMARY KEY,
    finished_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    report       JSONB       NOT NULL
);
CREATE INDEX inventory_check_finished_idx ON inventory_check (finished_at DESC);
