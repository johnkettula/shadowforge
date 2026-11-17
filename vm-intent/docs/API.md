# vm-intent REST API: guide for calling services

Last updated 2026-11-17.

The API is described by an **OpenAPI 3.0** document that the server generates from its own code, so the
document always matches what the server does. `tests/api_contract_test.py` calls every endpoint and checks
each real response against the document.

## Where to find it

| What | Path | Docker / Azure VM | Local (Windows scripts) |
|---|---|---|---|
| Swagger UI (try calls in the browser) | `/swagger-ui.html` | `http://<host>:8080/swagger-ui.html` or `http://<host>:8088/swagger-ui.html` | `http://localhost:8080/swagger-ui.html` |
| OpenAPI JSON (for client generators) | `/v3/api-docs` | `http://<host>:8080/v3/api-docs` | `http://localhost:8080/v3/api-docs` |
| OpenAPI YAML | `/v3/api-docs.yaml` | same, with `.yaml` | same |
| Snapshot in the repo | `docs/openapi.yaml`, `docs/openapi.json` (checked by `mvn test`; to regenerate them see [Checking the contract](#checking-the-contract)) | | |

Port 8088 is the web app; its nginx forwards `/api`, `/v3/api-docs` and `/swagger-ui` to the API. Behind
a proxy or gateway that sends `X-Forwarded-*` headers, the document lists the public address. To list fixed
addresses instead, set `VMINTENT_API_SERVER_URLS` (comma-separated).

## Operations

| Operation ID | Method and path | What it does |
|---|---|---|
| `interpretRequest` | `POST /api/v2/interpret` | Preview: text to spec, hash, cloud name and defaults, or the question it would ask. Builds nothing. |
| `createRequest` | `POST /api/v2/requests` | Start a one-VM request (asks questions, waits for confirmation) |
| `getRequest` | `GET /api/v2/requests/{id}` | State, interpretation, VM details, history |
| `clarifyRequest` | `POST /api/v2/requests/{id}/clarify` | Answer the question (state `AWAITING_CLARIFICATION`). 409 if the request has already finished, or is not waiting for an answer (the message names its state) |
| `confirmRequest` | `POST /api/v2/requests/{id}/confirm` | Build it (state `AWAITING_CONFIRMATION`). Send `{"specHash": ...}` to make sure it's the spec you saw. 200 with the new status; 409 with the reason if it can't be confirmed |
| `listRequests` | `GET /api/v2/requests` | Recent requests, filtered by `requester` (`me` = you), `state`, `provider`, `env` |
| `cancelRequest` | `POST /api/v2/requests/{id}/cancel` | Cancel while waiting. 409 if the request has already finished, or once the build has started (`PROVISIONING`) |
| `createBatch` | `POST /api/v2/batches` | Build up to 10,000 VMs, no per-VM confirmation |
| `getBatch` | `GET /api/v2/batches/{id}` | Live counts and p50/p95 build times |
| `listVms` | `GET /api/v2/vms` | The 200 most recently changed VMs |
| `getStats` | `GET /api/v2/stats` | VM counts by state |
| `getAuditTrail` | `GET /api/v2/audit` | Events for a request, batch or VM |
| `getVm` | `GET /api/v2/vms/{specHash}` | One VM's record (spec, state, cloud details) by its spec hash, in any state. 400 if the hash isn't 64 lower-case hex characters, 404 if no VM has it |
| `getVmLifecycle` | `GET /api/v2/vms/{specHash}/lifecycle` | Expiry, power, current size, snapshots |
| `renewVm` | `POST /api/v2/vms/{specHash}/renew` | `{"days": 14}`: push the expiry back (1-90 days) |
| `resizeVm` | `POST /api/v2/vms/{specHash}/resize` | `{"vcpu": 4, "memoryGiB": 16}` |
| `powerVm` | `POST /api/v2/vms/{specHash}/power` | `{"on": false}` |
| `snapshotVm` | `POST /api/v2/vms/{specHash}/snapshot` | `{"label": "before-upgrade"}` |
| `decommissionVm` | `POST /api/v2/vms/{specHash}/decommission` | Remove the VM now |
| `listInventoryChecks` | `GET /api/v2/inventory-checks` | Results of the nightly drift and orphan check |
| `runInventoryCheck` | `POST /api/v2/inventory-checks` | Run the check now (ADMIN) |
| `createLegacyVm` | `POST /api/v1/vms` | The old universal JSON format |
| `listDefinitions` | `GET /api/v2/definitions` | Catalog definitions and blueprints ([DEFINITIONS.md](DEFINITIONS.md)) |
| `getDefinition` | `GET /api/v2/definitions/{kind}/{name}` | One, as data and as its YAML |
| `validateDefinition` | `POST /api/v2/definitions/validate` | Check YAML (`application/yaml`, or JSON `{"yaml": ...}`); every problem listed. In the OpenAPI document (and generated clients) this operation is `validateDefinitionJson` |
| `publishDefinition` | `POST /api/v2/definitions` | Publish (OPERATOR). 201 published, 200 unchanged, 422 refused with the problems. In the OpenAPI document (and generated clients) this operation is `publishDefinitionJson` |
| `retireDefinition` | `POST /api/v2/definitions/{kind}/{name}/{version}/retire` | No new runs of that version (OPERATOR) |
| `listClassifications` | `GET /api/v2/classifications` | `{"default": "C1", "classifications": [{"code", "label", "retentionYears"}, ...]}`: the `default` code (one of those listed) applies when neither a run nor its definition gives one, then every code with its text and retention in years |
| `startRun` | `POST /api/v2/runs` | `{"definition": "web-server", "params": {"app": "shop"}}`. 201 started; 200 with `existing: true` if the same inputs are already running |
| `listRuns` | `GET /api/v2/runs` | Recent catalog runs |
| `getRun` | `GET /api/v2/runs/{runId}` | Every step, what it produced, what the run waits for |
| `resumeRun` | `POST /api/v2/runs/{runId}/resume` | Run the failed step again (it picks up its own partial work) |
| `teardownRun` | `POST /api/v2/runs/{runId}/teardown` | Undo everything the run did |
| `approveRun` | `POST /api/v2/runs/{runId}/approve` | `{"approved": true, "note": "..."}`; not by the run's requester |
| `listDecisions` | `GET /api/v2/compliance/decisions` | The decision log (AUDITOR) |
| `listArchive` | `GET /api/v2/compliance/archive` | Archived workflow histories (AUDITOR) |
| `downloadArchivedHistory` | `GET /api/v2/compliance/archive/{workflowId}/{runId}` | One history; SHA-256 in `X-Content-SHA256` |
| `replayWorkflow` | `POST /api/v2/compliance/replays` | Replay a recorded workflow for audit: nothing is done again ([AUDIT.md](AUDIT.md)) |
| `runArchiveSweep` | `POST /api/v2/compliance/sweeps` | Archive closed histories now (ADMIN) |
| `getVsphereStatus` | `GET /api/v2/vsphere/status` | How each datacenter is routed, and whether vCenter and VCF Automation answer (OPERATOR) |
| `listVsphereTemplates` | `GET /api/v2/vsphere/templates` | VM templates in vCenter's content library (OPERATOR). 503 if vCenter isn't set up |
| `listVsphereBlueprints` | `GET /api/v2/vsphere/blueprints` | Blueprints in the VCF Automation project (OPERATOR). 503 if VCF Automation isn't set up |
| `getVsphereBlueprint` | `GET /api/v2/vsphere/blueprints/{nameOrId}` | One blueprint's released versions and inputs (OPERATOR). 404 unknown name; 503 if VCF Automation isn't set up |

## Conventions

- **JSON in and out.** Send `Content-Type: application/json`.
- **Fields with no value are left out** of responses, never sent as `null`. Treat any field not marked
  required as optional.
- **Free-form values** (a definition's step settings and input defaults, a run's inputs, a step's output)
  can be any JSON value, so the document gives them no type.
- **Errors** (every 4xx and 5xx) have the body `{"error": "...", "workflowId"?: "...", "rejected"?: [...]}`.
  `400` is a bad body, `404` an unknown ID (including a `specHash` that matches no VM), `409` a change that can't be made now (the `error` says why:
  a request not waiting for an answer or confirmation, already building or already finished, a VM already off or already removed, an identical VM already built), `500` an
  unexpected error, `502` a backend (vCenter, VCF Automation) that refused vm-intent's sign-in, and `503` a
  backend that isn't set up on this server or didn't answer.
- **Idempotency.** A VM's identity is its `specHash`: with sign-in off, the SHA-256 of its canonical
  spec; for a signed-in user, a SHA-256 that also covers the user ID taken from sign-in (never from
  `userId` or `requestedBy` in the body). A duplicate is the same spec from the same user, or from anyone
  when sign-in is off. Sending a duplicate while the VM is being built, or after it's built, does not
  create a second VM: a batch counts it under `duplicate`, the legacy endpoint returns `409`, and a
  request finishes as `DUPLICATE`. Another signed-in user's same spec is not a duplicate: it gets its own
  `specHash` and its own VM. It is safe to retry a call that timed out. VMs that already exist keep their
  `specHash`, so the day-2 calls, `GET /api/v2/vms/{specHash}`, `GET /api/v2/vms/{specHash}/lifecycle` and
  the VM list `GET /api/v2/vms` work as before. Until the cloud-side name
  gets a per-user suffix (part 2), two users' VMs with the same name on a real vSphere route are refused
  for the second user with `InvalidSpec` (below), while the simulated clouds build both. On the real vSphere routes (vCenter 9 and VCF Automation 9), a spec
  with a different hash that uses a name already taken in the cloud by a VM vm-intent built for another
  spec is not reused: its build fails with the non-retryable reason `InvalidSpec` ("... was built by
  vm-intent for another request; choose another name"). A same-named VM that vm-intent didn't build is
  refused the same way ("... that vm-intent didn't build; choose another name"); on VCF Automation that
  is any same-named deployment with no vm-intent key in its description. The simulated clouds (the
  default) don't check names.
- **Long-running work is asynchronous.** Create calls return at once with an ID; poll the matching
  `GET` every 2–5 seconds. Final request states are `COMPLETED`, `PARTIAL`, `FAILED`, `CANCELLED` and
  `DUPLICATE` (`PARTIAL`: a request for several VMs where some were built and at least one failed); a
  batch is done when `state` is `COMPLETED`.
- **Browser pages on other sites (CORS).** A web page served from another address that calls the API from
  the browser must be listed in `VMINTENT_CORS_ORIGINS` (comma-separated; patterns like
  `https://*.example.com` work). Services calling from their own code don't need this.
- **Versioning.** Paths carry the major version (`/api/v2`). New optional fields may be added without
  notice; renames and removals only come with a new version.

## A service building VMs (batch)

```bash
curl -s -X POST http://localhost:8080/api/v2/batches \
  -H 'Content-Type: application/json' \
  -d '{
        "requestedBy": "ci-pipeline",
        "items": [
          {"spec": {"name": "build-agent-01", "provider": "aws", "region": "us-east", "vcpu": 4, "memoryGiB": 16,
                    "os": "ubuntu", "osVersion": "24.04", "diskGiB": 100, "diskTier": "ssd", "env": "dev",
                    "ttlDays": 7, "publicIp": false}},
          {"text": "small rhel 9 box on prem in dc1 for 2 weeks"}
        ]
      }'
# -> 202 {"batchId": "batch-...", "accepted": 2, "sameInBatch": 0, "rejected": [], "shards": 1}

curl -s http://localhost:8080/api/v2/batches/batch-...
# -> {"state": "RUNNING", "total": 2, "started": 2, "inFlight": 1, "running": 1, "failed": 0, ...}
```

## Generating a client

Point any OpenAPI generator at `/v3/api-docs` (or `docs/openapi.yaml`):

```bash
# TypeScript types (checked: generates all 43 operations)
npx openapi-typescript http://localhost:8080/v3/api-docs -o vmintent-api.d.ts

# Java, C#, Python, Go... with OpenAPI Generator
npx @openapitools/openapi-generator-cli generate -i http://localhost:8080/v3/api-docs -g java -o vmintent-client-java
npx @openapitools/openapi-generator-cli generate -i http://localhost:8080/v3/api-docs -g python -o vmintent-client-py
```

Operation IDs are stable, so generated method names stay the same between versions.

## Importing into an API gateway

Azure API Management, AWS API Gateway, Kong and others accept the OpenAPI 3.0 document directly. In
Azure API Management: **APIs → Add API → OpenAPI → from URL**, `http://<host>:8080/v3/api-docs`.
The API can also check sign-in itself (next section).

## Authentication

Sign-in is set by `VMINTENT_SECURITY_MODE` (details and setup: `docs/SECURITY.md`):

- **`entra`:** every `/api` call needs a Microsoft Entra ID access token: `Authorization: Bearer <token>`.
  Services use the client-credentials flow with scope `api://vm-intent/.default` and need an app role
  (`VmIntent.Batch`, `VmIntent.Read`, ...). The document lists the `entraId` (OAuth 2.0) and `bearerToken`
  security schemes.
- **`pki`:** every `/api` call needs a client certificate (mutual TLS) from a trusted CA that is on the API's
  allowlist. The API serves HTTPS on port 8443. OpenAPI 3.0 can't declare client certificates, so the
  document says so in its overview and in an `x-client-certificate` extension.
  `curl --cacert ca.pem --cert my.crt --key my.key https://<host>:8443/api/v2/stats`
- **`entra,pki`:** either one.
- **`none`** (default): no sign-in, so keep the API on a private network.

Each operation's **Required role** is in its description. A caller who isn't signed in gets 401, with the
reason in `error` (for a refused certificate, which check it failed). A caller without the role gets 403.

## Checking the contract

```bash
pip install openapi-core requests
python tests/api_contract_test.py http://localhost:8080
```

With sign-in on, give it an ADMIN credential: `VMINTENT_TOKEN=<token>`, or `VMINTENT_CLIENT_CERT`,
`VMINTENT_CLIENT_KEY` and `VMINTENT_CA` for a certificate.

It runs 61 checks: every operation, the full question, confirm and cancel flows, a VM's day-2 changes, a
batch, the inventory check, the vSphere endpoints, the catalog and compliance endpoints (reading the built-in
`web-server` definition, validating its YAML, the classifications, runs, the decision log and the archive;
it publishes nothing and starts no run), and the 400, 404, 409 and 503 error cases (vSphere
calls expect 503, so run it against a server without vCenter or VCF Automation set up). Each request and response is validated against the live document. Run it in CI
after any API change.

`mvn test` checks the document too, without a running server: `OpenApiDocumentTest` builds `/v3/api-docs`
from the controllers and fails the build if any operation's 2xx response is documented as a free-form map or
an untyped object (a short allow-list in the test names the exceptions and why). So endpoints return named
record types, not `Map<String,Object>`, which springdoc can't describe and real responses then fail to match.

`mvn test` also compares the generated document with the snapshots `docs/openapi.json` and
`docs/openapi.yaml` (`OpenApiSnapshotTest`, as parsed documents, ignoring the top-level `servers`, which
each snapshot keeps as its local-development entry). When they differ it fails and names the first differing
path in each file. After an intended API change, regenerate both snapshots from `backend/` and commit them:

```bash
cd backend
mvn test -Dtest=OpenApiSnapshotTest -Dopenapi.write=true
```

Plain `mvn test` never writes to `docs/`.
