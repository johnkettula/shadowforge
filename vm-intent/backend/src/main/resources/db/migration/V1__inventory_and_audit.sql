-- VM inventory: one row per canonical spec (the spec hash is the identity).
CREATE TABLE vm_record (
    spec_hash   TEXT PRIMARY KEY,
    name        TEXT        NOT NULL,
    provider    TEXT        NOT NULL,
    region      TEXT        NOT NULL,
    state       TEXT        NOT NULL,          -- PROVISIONING | RUNNING | FAILED | DELETED
    detail      TEXT,
    spec        JSONB       NOT NULL,          -- the full canonical spec
    result      JSONB,                         -- VM ID, IP, provider names once built
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX vm_record_state_idx ON vm_record (state);

-- Audit trail: append-only, one row per thing that happened.
CREATE TABLE audit_event (
    id          BIGSERIAL   PRIMARY KEY,
    at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    request_id  TEXT,                          -- the IntentWorkflow ID (null for legacy API calls)
    spec_hash   TEXT,
    event       TEXT        NOT NULL,          -- REQUESTED, INTERPRETED, QUESTION_ASKED, ANSWERED, CONFIRMED, ...
    actor       TEXT,                          -- who caused it: a user ID, "system", "legacy-api"
    detail      TEXT
);

CREATE INDEX audit_event_request_idx ON audit_event (request_id, id);
CREATE INDEX audit_event_spec_idx    ON audit_event (spec_hash, id);
