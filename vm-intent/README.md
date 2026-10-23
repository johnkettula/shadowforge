# vm-intent: natural-language VM requests on Temporal

You type a request for a VM in plain English. One canonical, cloud-neutral spec
comes out, and a Temporal workflow builds it on vSphere, AWS, Azure or Google
Cloud. The four clouds are **simulated** here, so everything runs on this PC
with no cloud accounts.

Stack: **React + TypeScript (Vite)** front end, **Spring Boot 3 + Temporal Java SDK** back end.

**New here?** Open the web app and choose **Help → User guide** (the same guide is in `docs/USER-GUIDE.md`).

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
7. Submit **"3 small ubuntu web servers on gcp for 5 days, called web"**. Three
   VMs are built side by side, each with its own rollback.
8. Click a VM in the **Inventory**: renew it, resize it, power it off, take a
   snapshot or remove it. Each is a Temporal *update*, refused straight away
   with the reason if it can't be done.
9. Press **Run now** on the **Inventory check** card. It also runs every night
   on a Temporal *Schedule* (see the Temporal UI's Schedules page).

The Temporal features used, and how to try each one, are explained in
[docs/TEMPORAL-FEATURES.md](docs/TEMPORAL-FEATURES.md). Clouds behind a one-way
link (domain 2 to domain 3) are covered in [docs/ONE-WAY-LINK.md](docs/ONE-WAY-LINK.md).

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

**From your phone or another computer** on the same network, use this PC's IP address instead of
`localhost`. Double-click `7-show-addresses.cmd` to print the exact addresses. The first time, Windows may
ask to let Node.js, Java or Temporal through the firewall: allow it on private networks. Sign-in is off by
default, so only do this on a network you trust.

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
  security/   Sign-in (Entra ID tokens, client certificates) and who may call what (ApiAccessRules)
  legacy/     The old JSON format -> the same spec (no AI)
  api/        REST endpoints used by the React app
frontend/src/ App.tsx (the whole UI), api.ts (typed REST calls)
deploy/       docker-compose.yml for Linux, deploy/linux/ scripts and systemd units
loadtest/     run-loadtest.mjs: the 2,000-VM load test
docs/         USER-GUIDE.md (the Help menu's guide; rebuild with docs/build-user-guide.py),
              SCALING.md: how it scales, and load-test results
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

**Sign-in:** set `VMINTENT_SECURITY_MODE` to `entra` (Microsoft Entra ID access tokens, roles from Entra
app roles), `pki` (client certificates from your CAs, on an allowlist that gives each one a role) or
`entra,pki`. Both use the same four roles: ADMIN, BATCH, REQUESTER, READER. Setup steps: `docs/SECURITY.md`.
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

## Using an AI (optional)

By default the built-in rules turn words into a spec: offline, free and predictable. You can have an AI
model do that step instead. It only fills in the fields: defaults, policy checks and hashing stay in
plain code, you still confirm the spec, and the rules answer whenever the AI is down, slow or gives a
bad reply. Each result says which one answered (*interpreted by ai:ollama/llama3.2*, or *rules*).

| `VMINTENT_LLM_PROVIDER` | What it uses | Needs |
|---|---|---|
| `none` (default) | The built-in rules | Nothing |
| `ollama` | A model running on this PC (or one on your network) with [Ollama](https://ollama.com): free, nothing leaves your network | Ollama installed and a model pulled: `ollama pull llama3.2` |
| `anthropic` | Claude | `VMINTENT_LLM_API_KEY` (or `ANTHROPIC_API_KEY`) |
| `openai` | OpenAI, or any OpenAI-compatible service (set `VMINTENT_LLM_URL` to its `.../v1` address) | `VMINTENT_LLM_API_KEY`, `VMINTENT_LLM_MODEL` |
| `azure-openai` | Azure OpenAI | `VMINTENT_LLM_URL` (`https://<resource>.openai.azure.com`), `VMINTENT_LLM_API_KEY`, `VMINTENT_LLM_MODEL` (your deployment name) |

Optional: `VMINTENT_LLM_MODEL` (defaults: Claude `claude-sonnet-5-5`, Ollama `llama3.2`), `VMINTENT_LLM_URL`
(e.g. Ollama on another machine, `http://gpu-box:11434`), `VMINTENT_LLM_TIMEOUT_SECONDS` (30, or 120 for Ollama).
If a provider is missing its key or model, the backend stops at startup and says which setting to add.

**On Windows:** copy `ai-settings.example.cmd` to `ai-settings.cmd`, un-comment one provider's lines, and
restart the backend. `2-start-backend.cmd` and `5-start-worker.cmd` read it; it's git-ignored, so keys stay on
your PC. The backend log shows `Interpreter: AI via ollama (model llama3.2, ...)` when it's on.

**With Docker:** set the same variables in `deploy/.env`. For a local model in Docker, use
`VMINTENT_LLM_PROVIDER=ollama` and `VMINTENT_LLM_URL=http://ollama:11434`, then
`docker compose --profile ollama up -d` and `docker compose exec ollama ollama pull llama3.2`.

Small local models (3B, like `llama3.2`) answer in a few seconds on an ordinary PC; larger ones need a GPU to
be quick. Try the example phrasings with **Preview** to compare a model with the rules.

## Next steps toward production

- Replace a `SimulatedProvider` subclass with real SDK calls, such as AWS SDK for Java v2
  `Ec2Client.runInstances` with a `clientToken` for idempotency.
- Add an approval step for prod VMs: an update from someone other than the requester,
  like `confirmSpec`, with a validator that checks the approver's role.
- Send the EXPIRY_WARNING audit events as email or chat messages.
- Add a tools-install step (from MinIO) after the build, with its own undo in the saga.
- Change `legacy/LegacyVmDefinition.java` to match your real legacy JSON format.
  The current fields are placeholders.
