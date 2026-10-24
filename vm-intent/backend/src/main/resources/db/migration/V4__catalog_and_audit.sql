-- Operator-written definitions (YAML). Each published version is kept and never changed.
CREATE TABLE catalog_definition (
    kind          TEXT        NOT NULL,              -- Provisioning | Blueprint
    name          TEXT        NOT NULL,
    version       INT         NOT NULL,
    yaml          TEXT        NOT NULL,
    sha256        TEXT        NOT NULL,
    published_by  TEXT        NOT NULL,
    published_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    retired       BOOLEAN     NOT NULL DEFAULT false, -- retired = no new runs; running ones carry on
    PRIMARY KEY (kind, name, version)
);

-- One row per catalog run (a run of a provisioning definition).
CREATE TABLE catalog_run (
    workflow_id     TEXT        NOT NULL,
    run_id          TEXT        NOT NULL,             -- Temporal's run ID
    definition      TEXT        NOT NULL,
    version         INT         NOT NULL,
    classification  TEXT        NOT NULL,
    requested_by    TEXT,
    state           TEXT        NOT NULL,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    PRIMARY KEY (workflow_id, run_id)
);
CREATE INDEX catalog_run_started_idx ON catalog_run (started_at DESC);

-- Every authorization decision: who asked to do what, allowed or refused, by which rule.
-- Kept until keep_until, which comes from the data classification.
CREATE TABLE access_decision (
    id              BIGSERIAL   PRIMARY KEY,
    at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor           TEXT        NOT NULL,
    roles           TEXT,
    action          TEXT        NOT NULL,             -- e.g. POST /api/v2/runs, run.resume
    resource        TEXT,
    decision        TEXT        NOT NULL,             -- ALLOW | DENY
    policy          TEXT        NOT NULL,             -- which rule decided
    reason          TEXT,
    classification  TEXT        NOT NULL,
    keep_until      TIMESTAMPTZ NOT NULL
);
CREATE INDEX access_decision_at_idx ON access_decision (at DESC);
CREATE INDEX access_decision_resource_idx ON access_decision (resource);
CREATE INDEX access_decision_keep_idx ON access_decision (keep_until);

-- Closed workflow histories copied to the write-once archive, so they can be replayed for audit
-- long after Temporal's own retention has removed them.
CREATE TABLE archive_record (
    workflow_id     TEXT        NOT NULL,
    run_id          TEXT        NOT NULL,
    workflow_type   TEXT        NOT NULL,
    classification  TEXT        NOT NULL,
    retention_years INT         NOT NULL,
    closed_at       TIMESTAMPTZ,
    archived_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    keep_until      TIMESTAMPTZ NOT NULL,
    path            TEXT        NOT NULL,
    sha256          TEXT        NOT NULL,
    size_bytes      BIGINT      NOT NULL,
    events          INT         NOT NULL,
    expired_at      TIMESTAMPTZ,                      -- set when the file was removed at the end of its retention
    PRIMARY KEY (workflow_id, run_id)
);
CREATE INDEX archive_record_keep_idx ON archive_record (keep_until) WHERE expired_at IS NULL;
CREATE INDEX archive_record_archived_idx ON archive_record (archived_at DESC);
