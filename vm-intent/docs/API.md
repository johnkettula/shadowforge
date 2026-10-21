# vm-intent REST API: guide for calling services

The API is described by an **OpenAPI 3.0** document that the server generates from its own code, so the
document always matches what the server does. `tests/api_contract_test.py` calls every endpoint and checks
each real response against the document.

## Where to find it

| What | Path | Docker / Azure VM | Local (Windows scripts) |
|---|---|---|---|
| Swagger UI (try calls in the browser) | `/swagger-ui.html` | `http://<host>:8080/swagger-ui.html` or `http://<host>:8088/swagger-ui.html` | `http://localhost:8080/swagger-ui.html` |
| OpenAPI JSON (for client generators) | `/v3/api-docs` | `http://<host>:8080/v3/api-docs` | `http://localhost:8080/v3/api-docs` |
| OpenAPI YAML | `/v3/api-docs.yaml` | same, with `.yaml` | same |
| Snapshot in the repo | `docs/openapi.yaml`, `docs/openapi.json` | | |

Port 8088 is the web app; its nginx forwards `/api`, `/v3/api-docs` and `/swagger-ui` to the API. Behind
a proxy or gateway that sends `X-Forwarded-*` headers, the document lists the public address. To list fixed
addresses instead, set `VMINTENT_API_SERVER_URLS` (comma-separated).

## Operations

| Operation ID | Method and path | What it does |
|---|---|---|
| `interpretRequest` | `POST /api/v2/interpret` | Preview: text to spec, hash and defaults, or the question it would ask. Builds nothing. |
| `createRequest` | `POST /api/v2/requests` | Start a one-VM request (asks questions, waits for confirmation) |
| `getRequest` | `GET /api/v2/requests/{id}` | State, interpretation, VM details, history |
| `clarifyRequest` | `POST /api/v2/requests/{id}/clarify` | Answer the question (state `AWAITING_CLARIFICATION`) |
| `confirmRequest` | `POST /api/v2/requests/{id}/confirm` | Build it (state `AWAITING_CONFIRMATION`) |
| `cancelRequest` | `POST /api/v2/requests/{id}/cancel` | Cancel while waiting |
| `createBatch` | `POST /api/v2/batches` | Build up to 10,000 VMs, no per-VM confirmation |
| `getBatch` | `GET /api/v2/batches/{id}` | Live counts and p50/p95 build times |
| `listVms` | `GET /api/v2/vms` | The 200 most recently changed VMs |
| `getStats` | `GET /api/v2/stats` | VM counts by state |
| `getAuditTrail` | `GET /api/v2/audit` | Events for a request, batch or VM |
| `createLegacyVm` | `POST /api/v1/vms` | The old universal JSON format |

## Conventions

- **JSON in and out.** Send `Content-Type: application/json`.
- **Fields with no value are left out** of responses, never sent as `null`. Treat any field not marked
  required as optional.
- **Errors** (every 4xx and 5xx) have the body `{"error": "...", "workflowId"?: "...", "rejected"?: [...]}`.
  `400` is a bad body, `404` an unknown ID, `409` an identical VM already being built (legacy endpoint),
  and `500` an unexpected error.
- **Idempotency.** A VM's identity is the SHA-256 of its canonical spec (`specHash`). Sending the same
  spec again while it's being built, or after it's built, does not create a second VM: a batch counts it
  under `duplicate`, the legacy endpoint returns `409`, and a request finishes as `DUPLICATE`. It is safe
  to retry a call that timed out.
- **Long-running work is asynchronous.** Create calls return at once with an ID; poll the matching
  `GET` every 2–5 seconds. Final request states are `COMPLETED`, `FAILED`, `CANCELLED` and `DUPLICATE`; a
  batch is done when `state` is `COMPLETED`.
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
# TypeScript types (checked: generates all 12 operations)
npx openapi-typescript http://localhost:8080/v3/api-docs -o vmintent-api.d.ts

# Java, C#, Python, Go... with OpenAPI Generator
npx @openapitools/openapi-generator-cli generate -i http://localhost:8080/v3/api-docs -g java -o vmintent-client-java
npx @openapitools/openapi-generator-cli generate -i http://localhost:8080/v3/api-docs -g python -o vmintent-client-py
```

Operation IDs are stable, so generated method names stay the same between versions.

## Importing into an API gateway

Azure API Management, AWS API Gateway, Kong and others accept the OpenAPI 3.0 document directly. In
Azure API Management: **APIs → Add API → OpenAPI → from URL**, `http://<host>:8080/v3/api-docs`.
A gateway is also the simplest place to add authentication (next section).

## Authentication

With `VMINTENT_SECURITY_MODE=entra`, every `/api` call needs a Microsoft Entra ID access token:
`Authorization: Bearer <token>`. Services use the client-credentials flow with scope
`api://vm-intent/.default` and need an app role (`VmIntent.Batch`, `VmIntent.Read`, ...). Each operation's
**Required role** is listed in its description, and the document lists the `entraId` (OAuth 2.0) and
`bearerToken` security schemes. A missing or bad token gets 401; a token without the role gets 403.
Setup steps and the role table are in `docs/SECURITY.md`.

With the default `VMINTENT_SECURITY_MODE=none` there is no sign-in, so keep the API on a private network.

## Checking the contract

```bash
pip install openapi-core requests
python tests/api_contract_test.py http://localhost:8080
```

It runs 21 checks: every operation, the full question, confirm and cancel flows, a batch, and the 400,
404 and 409 error cases. Each request and response is validated against the live document. Run it in CI
after any API change.
