# vm-intent: natural-language VM requests on Temporal

You type a request for a VM in plain English. One canonical, cloud-neutral spec
comes out, and a Temporal workflow builds it on vSphere, AWS, Azure or Google
Cloud. The four clouds are **simulated** here, so everything runs on this PC
with no cloud accounts.

Stack: **React + TypeScript (Vite)** front end, **Spring Boot 3 + Temporal Java SDK** back end.

## What to try

1. Click the first four example chips and press **Preview** on each. They are
   worded differently but get the **same spec hash**. That is the "many ways
   in, one meaning out" idea.
2. Submit **"I need a big linux machine"**. The workflow pauses and asks which
   platform you want. Answer `azure`.
3. Submit any request and press **Looks right, build it**. Watch the steps run
   in the Temporal UI at http://localhost:8233.
4. Submit the same request again. You get **DUPLICATE** instead of a second VM.
5. Submit **"small rhel 9 box on prem for 2 weeks, called fail-demo"**. Boot
   is made to fail on purpose, and the saga **rolls back** (deletes) the
   half-built VM.
6. Open the **Legacy JSON API** tab. Old-style JSON skips the AI and goes
   straight to the same reconcile workflow.

## One-time setup (Windows)

**Easiest:** double-click `0-install-prereqs.cmd`. It installs everything below,
skips anything you already have, and prints the versions at the end. Click **Yes**
when Windows asks for permission. Then open a **new** terminal so your PATH updates.

To install by hand instead:

| Tool | How |
|---|---|
| Java 21 | `winget install Microsoft.OpenJDK.21` |
| Maven 3.9+ | Download from https://maven.apache.org/download.cgi, unzip, and add its `bin` folder to PATH |
| Node.js 20+ | `winget install OpenJS.NodeJS.LTS` |
| Temporal CLI | Download from https://temporal.download/cli/archive/latest?platform=windows&arch=amd64, unzip `temporal.exe`, and add its folder to PATH |

Check your setup: `java -version`, `mvn -v`, `node -v`, `temporal --version`.

## Run it (three terminals, in this order)

Double-click each script, or run it from a terminal in this folder:

```
1-start-temporal.cmd     Temporal server      UI: http://localhost:8233
2-start-backend.cmd      Spring Boot + workers     http://localhost:8080
3-start-frontend.cmd     React app                 http://localhost:5173  <- open this
```

The first backend start downloads dependencies, which can take a few minutes.

Run the tests: `cd backend` then `mvn test`. `GoldenPhrasingTest` fails the build if
any listed phrasing stops producing the expected spec.

## How the code is organised

```
backend/src/main/java/com/example/vmintent/
  spec/       VmSpec (the canonical spec), canonical form + SHA-256 hash, policy checks
  intent/     Words -> spec: RuleBasedIntentExtractor, LlmIntentExtractor (optional),
              Vocabulary (synonyms), PolicyDefaults (size catalog and defaults)
  workflow/   IntentWorkflow (interpret, clarify, confirm) and
              VmReconcileWorkflow (plan, create, verify, saga rollback)
  provider/   ProviderActivities interface + simulated AWS/Azure/GCP/vSphere adapters
              (SimCloud keeps the pretend clouds in Postgres), each on its own task queues,
              and the VM inventory (VmRegistry)
  workflow/   also BatchProvisionWorkflow -> BatchShardWorkflow -> one VmReconcileWorkflow per VM
  config/     WorkerTuning: per-queue concurrency and cloud rate limits
  legacy/     The old JSON format -> the same spec (no AI)
  api/        REST endpoints used by the React app
frontend/src/ App.tsx (the whole UI), api.ts (typed REST calls)
deploy/       docker-compose.yml for Linux, deploy/linux/ scripts and systemd units
loadtest/     run-loadtest.mjs: the 2,000-VM load test
docs/         SCALING.md: how it scales, and load-test results
```

**Main rule:** the AI only turns words into fields. Defaults, validation and
hashing are plain code, so the same request always gives the same result.

## Database (Postgres) and audit trail

The VM inventory and an audit trail are stored in Postgres, so they survive restarts. You don't
install anything: by default the backend starts its own Postgres 17 (embedded, no admin rights),
with data in `C:\Users\<you>\.vm-intent\pgdata`. The first backend start downloads it, so it
takes a little longer.

- Tables are created by Flyway from `backend/src/main/resources/db/migration`.
- Audit events: REQUESTED, QUESTION_ASKED, ANSWERED, INTERPRETED, CONFIRMED, PROVISIONING,
  VM_CREATED, RUNNING, ROLLED_BACK, COMPLETED, FAILED, CANCELLED, DUPLICATE.
- API: `GET /api/v2/audit?requestId=...` or `?specHash=...`. The UI shows it under "Audit trail".
- To use a real Postgres server, set `vmintent.db.embedded: false` in `application.yml` and fill in
  `spring.datasource.url`, `username` and `VMINTENT_DB_PASSWORD`.

## MCP server (use the app from Claude)

`mcp-server/` is an MCP server with tools to preview requests, run workflows, read the inventory
and audit trail, and run the phrasing tests. Double-click `4-setup-mcp.cmd` to build it and register
it with the Claude desktop app, then restart the app. Add your GitLab address to `gitlab-host.txt`
first to register GitLab's own MCP server too. See `mcp-server/README.md`.

## REST API and Swagger (for other services)

The backend publishes an OpenAPI 3.0 document generated from its code:

- Swagger UI: http://localhost:8080/swagger-ui.html
- OpenAPI JSON: http://localhost:8080/v3/api-docs (YAML: `/v3/api-docs.yaml`; snapshot in `docs/openapi.yaml`)

`docs/API.md` covers the operations, conventions (errors, idempotency, polling), client generation and
gateway import.

**Sign-in:** set `VMINTENT_SECURITY_MODE=entra` to require Microsoft Entra ID access tokens, with four
roles (ADMIN, BATCH, REQUESTER, READER) taken from Entra app roles. Setup steps: `docs/SECURITY.md`.
Off by default, in which case keep the API on a private network. `python tests/api_contract_test.py` checks every endpoint against the live document.

## Building thousands of VMs at once

The app is built to run 2,000+ VM builds at the same time. See `docs/SCALING.md` for the design
and the load-test results.

- **Batch API:** `POST /api/v2/batches` with up to 10,000 items, each `{"text": "..."}` or
  `{"spec": {...}}`. There is no confirm step per VM. Items that would need a question are
  rejected up front, with the reason. `GET /api/v2/batches/{id}` shows live counts and p50/p95
  build times. `GET /api/v2/stats` counts VMs by state.
- **Separate API and workers:** the same jar runs as `SPRING_PROFILES_ACTIVE=api` (REST only) or
  `worker` (workflows only). To scale, add more workers; nothing else changes. With no profile it
  runs both in one process, which is how the Windows scripts run it.
- **Cloud rate limits:** each cloud has a create/delete queue (`aws-q`) and a read queue
  (`aws-read-q`). Temporal enforces calls per second across all workers. Change them under
  `vmintent.workers.rate` in `application.yml`.
- **Load test:** `node loadtest/run-loadtest.mjs --count 2000 --fail 20` submits 2,000 VMs, watches
  them build, and writes a JSON report.

## Running on Linux

**With Docker** (Postgres-backed Temporal, API, 3 workers, web app, Temporal UI):

```
cd deploy
cp .env.example .env        # change the two passwords
docker compose up -d --build
docker compose up -d --scale worker=6     # more workers any time
```

Web app http://host:8088, API http://host:8080, Temporal UI http://host:8233.

**Without Docker** (Ubuntu/Debian or RHEL/Rocky):

```
sudo ./deploy/linux/install-prereqs.sh    # Java 21, Maven, Node, Postgres, Temporal CLI
./deploy/linux/setup-db.sh                # database, user and deploy/linux/vm-intent.env
./deploy/linux/build.sh
./deploy/linux/start-temporal.sh          # terminal 1
./deploy/linux/start-api.sh               # terminal 2
./deploy/linux/start-worker.sh            # terminal 3, 4, ... one per worker
```

`deploy/linux/systemd/` has service files to run these at boot instead.

## Turning on the LLM (optional)

The rule-based interpreter works offline. To use an LLM instead:

```
set ANTHROPIC_API_KEY=your-key
```

Then set `vmintent.llm.enabled: true` in `backend/src/main/resources/application.yml`
and restart the backend. If the LLM call fails, the app falls back to the rules. Each
result shows which interpreter was used.

## Next steps toward production

- Replace a `SimulatedProvider` subclass with real SDK calls, such as AWS SDK for Java v2
  `Ec2Client.runInstances` with a `clientToken` for idempotency.
- Add an approval step (a signal from an approver) before provisioning prod VMs.
- Change `legacy/LegacyVmDefinition.java` to match your real legacy JSON format.
  The current fields are placeholders.
