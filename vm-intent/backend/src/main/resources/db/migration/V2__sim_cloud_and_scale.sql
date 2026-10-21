-- The simulated cloud's own VM list. Kept in Postgres so every worker process sees the same "cloud".
-- A real deployment talks to AWS/Azure/GCP/vSphere instead and never touches this table.
CREATE TABLE sim_cloud_vm (
    vm_id            TEXT PRIMARY KEY,
    idempotency_key  TEXT        NOT NULL UNIQUE,   -- same key, same VM (like an EC2 clientToken)
    provider         TEXT        NOT NULL,
    name             TEXT,
    state            TEXT        NOT NULL,          -- PENDING | RUNNING | DELETED
    ready_at         TIMESTAMPTZ NOT NULL,          -- when the pretend boot finishes
    ip               TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX sim_cloud_vm_state_idx ON sim_cloud_vm (state, ready_at);

-- The inventory page lists the most recently changed VMs first.
CREATE INDEX vm_record_updated_idx ON vm_record (updated_at DESC);

-- One row per batch request. Progress is counted from audit_event (request_id = batch_id),
-- so the status page never has to wait on a workflow or a worker.
CREATE TABLE vm_batch (
    batch_id      TEXT PRIMARY KEY,
    total         INT         NOT NULL,
    shard_size    INT         NOT NULL,
    requested_by  TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_event_request_event_idx ON audit_event (request_id, event);
