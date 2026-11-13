# Audit: classification, retention, decisions and replay

Last updated 2026-11-13.

Every workflow vm-intent runs can be replayed for audit, for 1 to 5 years depending on its data
classification, and every authorization decision is logged for as long.

"Rerun" here means **replay**: today's code is run against the recorded history and every decision
it makes is checked against what happened. Nothing is done again: no cloud calls, no files, no
database writes.

## Data classification

A classification is a **code** with a **text** mapped to it, and the code decides the retention.

| Code | Text | Kept |
|---|---|---|
| C1 | Placeholder - kept 1 year | 1 year |
| C3 | Placeholder - kept 3 years | 3 years |
| C5 | Placeholder - kept 5 years | 5 years |

These are **placeholders** (`backend/src/main/resources/classifications.yaml`) until the real scheme is
known. To use your own, copy the file, change it and set `VMINTENT_CLASSIFICATIONS_FILE`:

```yaml
default: C1                 # used when neither the run nor its definition gives one
classifications:
  - code: C3
    label: Confidential
    retentionYears: 3       # 1 to 5
```

Keep codes that runs already use. `VMINTENT_DEFAULT_CLASSIFICATION` overrides the default.

Where a code comes from:

- A catalog run has its definition's `classification`. Whoever starts it may choose a code with a
  **longer** retention, never a shorter one.
- Plain-English requests, VM builds, lifecycles, batches and checks have the default code.
- Every decision about a run has the run's code; other decisions have the default.

## The decision log

Every authorization decision is a row in `access_decision`: who (and their roles), what action, on
which resource, ALLOW or DENY, the rule that decided, and why.

| Decision | Logged by |
|---|---|
| Every API call, allowed or refused, by role (or "sign-in off") | `ApiDecisionPublisher` (Spring Security calls it for each request) |
| Changing someone's VM or request (owner or ADMIN) | `VmController`, `RequestController` |
| Starting, resuming, tearing down and approving runs; publishing and retiring definitions | `CatalogController` |
| An approval answered inside a run | `CatalogRunWorkflow` |

A decision that can't be written to the log isn't carried out: the request fails instead.
`VMINTENT_LOG_READS=false` leaves out allowed GETs (the web app reads often); refusals and all
changes are always logged.

`GET /api/v2/compliance/decisions?actor=&resource=&decision=` lists them (AUDITOR). A run's
decisions are filed under its ID, so `?resource=run-web-server-3f2a9c41d07e` shows them all.

### OPA (optional)

The built-in rules answer first. Set `VMINTENT_OPA_URL` (for example
`http://opa:8181/v1/data/vmintent/allow`) and OPA is asked too; both must allow. OPA receives

```json
{"input": {"action": "run.resume", "actor": "jdoe", "roles": ["REQUESTER"],
           "resource": "run-web-server-3f2a9c41d07e", "attributes": {"state": "AWAITING_RECOVERY"}}}
```

and answers `{"result": true}` or `{"result": {"allow": false, "reason": "change freeze"}}`. If OPA
can't be reached, the answer is no. The decision log records `... + opa` as the rule.

## The archive

Temporal keeps a closed workflow's history only for the namespace's retention (1 day on the dev
server, at most 90 days on Temporal Cloud). So every hour, the Temporal Schedule `vm-archive-sweep`
copies the history of every workflow that has closed to the archive (`VMINTENT_ARCHIVE_DIR`):

```
<archive>/<retention>y/<code>/<year>/<month>/<workflow id>/<run id>.json   the history
                                                                ... .sha256 its SHA-256
```

- **Write-once**: a file is created once and made read-only. Writing the same history again does
  nothing; a different one is refused. Reading checks the SHA-256, so a changed file is reported.
- The history is in the same JSON format as `temporal workflow show --output json`, so Temporal's
  own tools can read it too.
- At the end of its retention (closed time + 1-5 years) the sweep removes the file, and the
  decision-log rows past their retention.
- The sweep's own runs aren't archived.

`archive_record` lists what's archived. A folder can still be changed by someone with access to the
disk; for storage that nobody can change before the retention ends, use a bucket with object lock in
compliance mode (S3, or MinIO). That means an S3 version of `ArchiveStore`; the rest stays the same.

Settings: `VMINTENT_ARCHIVE_SWEEP` (true), `VMINTENT_ARCHIVE_SWEEP_CRON` (`17 * * * *`), and
`vmintent.audit.sweep-lookback-days` (30). Run it by hand with `POST /api/v2/compliance/sweeps` (ADMIN).

## Replay

```
POST /api/v2/compliance/replays   {"workflowId": "run-web-server-3f2a9c41d07e"}
-> {"source": "archive", "events": 106, "sha256": "...", "matches": true, ...}
```

The history comes from the archive (SHA-256 checked first), or from Temporal if it isn't archived
yet. `matches: true` shows the recorded run is exactly what this code does; `false` says where it
differs. Each replay is written to the audit trail (`AUDIT_REPLAY`).

Replay covers every workflow: requests, builds, lifecycles, batches, inventory checks, catalog runs.
`ReplayTest` replays saved histories (including real catalog runs that were resumed, torn down and
approved) on every build, so a code change that would break replay fails the build first.
`AuditTest` checks the rest of this page: archive files are written once and their SHA-256 checked,
classifications map codes to text and retention (the built-in set, and a set from a file, whose bad
codes and retention are reported), OPA is asked after the built-in rules and both must allow, and
replay knows every workflow type.

## Who may see what

| Role | Can |
|---|---|
| AUDITOR | read the decision log and the archive, download histories, replay |
| ADMIN | everything, including running the sweep by hand |
| READER | the audit trail of requests (`GET /api/v2/audit`), not the decision log |

## API

| | |
|---|---|
| `GET /api/v2/compliance/decisions` | the decision log |
| `GET /api/v2/compliance/archive` | archived histories |
| `GET /api/v2/compliance/archive/{workflowId}/{runId}` | download one (header `X-Content-SHA256`) |
| `POST /api/v2/compliance/replays` | replay one |
| `POST /api/v2/compliance/sweeps` | run the archive sweep now |
| `GET /api/v2/classifications` | the classification codes |
