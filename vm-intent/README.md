# vm-intent: natural-language VM requests on Temporal

Last updated 2026-11-20.

You type a request for a VM in plain English. One canonical, cloud-neutral spec
comes out, and a Temporal workflow builds it on vSphere, AWS, Azure or Google
Cloud. The clouds are **simulated** by default, so everything runs on this PC
with no cloud accounts. vSphere can also use a real vCenter 9 or VCF Automation 9
([docs/VSPHERE.md](docs/VSPHERE.md)); real Azure is being built and isn't connected yet
([docs/AZURE.md](docs/AZURE.md)).

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
10. In the **Catalog** card, run **web-server**: a VM, nginx, the site's files,
    settings and a readiness check, from an operator-written YAML definition.
    If a step fails the run waits: **Resume** picks up where it stopped, or
    **Tear down** undoes it all ([docs/DEFINITIONS.md](docs/DEFINITIONS.md)).
11. In the **Compliance** card, look at the decision log, archive the finished
    histories and **Replay** one: it re-runs the recorded workflow against
    today's code without doing anything again ([docs/AUDIT.md](docs/AUDIT.md)).

The Temporal features used, and how to try each one, are explained in
[docs/TEMPORAL-FEATURES.md](docs/TEMPORAL-FEATURES.md). Clouds behind a one-way
link (domain 2 to domain 3) are covered in [docs/ONE-WAY-LINK.md](docs/ONE-WAY-LINK.md).
vSphere can be real: each datacenter can go to **vCenter 9** directly (templates from a content
library) or to **VCF Automation 9 blueprints**, and catalog definitions can deploy any blueprint with
`blueprint.deploy`. See [docs/VSPHERE.md](docs/VSPHERE.md).

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
Among the other tests, `SpecValidatorTest` checks the spec limits and the VM-name rule, `VmNamesTest`
the VM-name rule itself, `PolicyDefaultsTest` the sizes
and defaults, `LlmIntentExtractorTest` the AI providers, the fallback to the rules and the startup
settings check, and `RequestOwnerTest` that a request's owner comes from sign-in, or is 'anonymous'.
The workflow tests are listed in [docs/TEMPORAL-FEATURES.md](docs/TEMPORAL-FEATURES.md).

## How the code is organised

```
backend/src/main/java/com/example/vmintent/
  spec/       VmSpec (the canonical spec), canonical form + SHA-256 hash, policy checks;
              VmIdentity: the one place that computes a VM's spec hash (a signed-in user's also covers
              their user ID, so duplicates are per user) and its vm-/life- workflow IDs;
              VmIdentity.of gives the spec hash together with the VM's cloud name (cloudName),
              which is the spec's name, except that a signed-in user's named VM gets "-" plus
              the first 8 hex characters of its spec hash after it,
              and builds a VM's build key, which the real clouds use to decide whether to reuse an
              existing VM with the same name (same spec hash only);
              VmNames: the one VM-name rule (lower-case letters, digits and hyphens, 2 to 41
              characters, not starting with a hyphen), used by SpecValidator and the English extractor
  intent/     Words -> spec: RuleBasedIntentExtractor, LlmIntentExtractor (optional),
              Vocabulary (synonyms), PolicyDefaults (size catalog and defaults)
  workflow/   IntentWorkflow (interpret, clarify, confirm) and
              VmReconcileWorkflow (plan, create, verify, saga rollback)
  provider/   ProviderActivities interface + simulated AWS/Azure/GCP/vSphere adapters;
              CloudBackend (a real cloud's plan/create/describe/delete/resize/power/snapshot/list)
              and RoutedProvider (builds go to the spec's backend, later calls to the backend
              that handles the VM ID, the rest to the simulator; VsphereProvider extends it);
              provider/vsphere: real vCenter 9 and VCF Automation 9 clients (docs/VSPHERE.md)
              provider/azure: the Azure Resource Manager client (ArmClient) and AzureArmBackend
              (create, describe, delete one VM); not connected to builds yet (docs/AZURE.md)
              (SimCloud keeps the pretend clouds in Postgres), each on its own task queues,
              and the VM inventory (VmRegistry)
  workflow/   also BatchProvisionWorkflow -> BatchShardWorkflow -> one VmReconcileWorkflow per VM
  config/     WorkerTuning: per-queue concurrency and cloud rate limits
  security/   Sign-in (Entra ID tokens, client certificates), who may call what (ApiAccessRules),
              and logging every decision (ApiDecisionPublisher)
  catalog/    Operator-written YAML definitions and blueprints: parser and checks, the actions
              (CatalogActivitiesImpl), data classifications
  cel/        The CEL expression engine used in definitions
  audit/      Decision log, optional OPA, the write-once history archive, audit replay
  workflow/   also CatalogRunWorkflow (steps, resume or tear down) and ArchiveSweepWorkflow
  workflow/   also VmLifecycleWorkflow (expiry, renewal and day-2 changes) and
              InventoryCheckWorkflow (the nightly inventory check)
  link/       The one-way link to domain 3 (docs/ONE-WAY-LINK.md): order files written to the outbox
              (LinkActivitiesImpl), answers read from the inbox (ReturnLinkListener, ReplyFile),
              and Domain3Simulator, a pretend domain 3 for trying it on one PC
  db/         Postgres: AuditLog (the audit trail), BatchStore (batches), InventoryActivitiesImpl
              (the inventory check's database side), DatabaseConfig (embedded or real server)
  legacy/     The old JSON format -> the same spec (no AI)
  api/        REST endpoints used by the React app; RequestOwner: the request's owner, taken from
              sign-in ('anonymous' when sign-in is off)
frontend/src/ App.tsx (the whole UI), api.ts (typed REST calls)
deploy/       docker-compose.yml for Linux, deploy/linux/ scripts and systemd units,
              deploy/kubernetes/ (kustomize), deploy/catalog/ (publishing definitions from Git)
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
  VM_CREATED, RUNNING, ROLLED_BACK, COMPLETED, PARTIAL, FAILED, CANCELLED, DUPLICATE, plus each VM's
  lifecycle events (EXPIRY_WARNING, RENEWED, RESIZED, POWERED_ON, POWERED_OFF, SNAPSHOT, DELETED and others).
  Also: BATCH_STARTED and BATCH_COMPLETED for a batch; LINK_ORDER_SENT, LINK_REPLY and
  LINK_REPLY_UNMATCHED for the one-way link; LIFECYCLE_NOT_STARTED when a built VM's lifecycle
  could not be started (for example, one already looks after that VM); INVENTORY_CHECK, MISSING,
  NOT_MARKED_MISSING (a listing left out too many VMs to trust) and LISTED_AGAIN (a MISSING VM is in
  its cloud again) from the nightly inventory check; AUDIT_REPLAY for each audit replay; and catalog-run events such
  as RUN_STARTED, STEP_DONE, STEP_FAILED, RUN_STOPPED, RUN_RESUMED and RUN_COMPLETED.
- API: `GET /api/v2/audit?requestId=...` or `?specHash=...`. The UI shows it under "Audit trail".
- To use a real Postgres server, set these environment variables (`application.yml` reads them;
  docker-compose, the Kubernetes configmap and `deploy/linux/setup-db.sh` use the same names):

  | Variable | Default | What it sets |
  |---|---|---|
  | `VMINTENT_DB_EMBEDDED` | `true` | `true` starts the embedded Postgres; `false` uses the server below (`vmintent.db.embedded`) |
  | `VMINTENT_DB_URL` | `jdbc:postgresql://localhost:5432/vmintent` | the server's JDBC address (`spring.datasource.url`) |
  | `VMINTENT_DB_USER` | `vmintent` | the user name |
  | `VMINTENT_DB_PASSWORD` | empty | the password |
  | `VMINTENT_DB_POOL` | `30` | the connection pool size, per process |

## MCP server (use the app from Claude)

`mcp-server/` is an MCP server with tools to preview requests, run workflows, read the inventory
and audit trail, run the phrasing tests, and start a batch of VMs and follow its progress
(`vm_batch_submit`, `vm_batch_status`). Double-click `4-setup-mcp.cmd` to build it and register
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
`entra,pki`. Both use the same six roles: ADMIN, OPERATOR, AUDITOR, BATCH, REQUESTER, READER. Setup steps: `docs/SECURITY.md`.
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

## Running on Kubernetes

Every worker runs on Kubernetes in production: `kubectl apply -k deploy/kubernetes/overlays/dev`
(or `overlays/prod`). The API, the workflow workers and the cloud workers are separate deployments
that scale on their own, each pod chooses its task queues with `VMINTENT_WORKER_QUEUES`, and every
pod answers health probes on port 8081. Temporal and Postgres come from their own charts or
services. See [docs/KUBERNETES.md](docs/KUBERNETES.md).

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

- Make the other clouds real the way vSphere was ([docs/VSPHERE.md](docs/VSPHERE.md)) and Azure is being
  done ([docs/AZURE.md](docs/AZURE.md)): for AWS, the EC2 API's `RunInstances` with a `ClientToken` for
  idempotency.
- Send the EXPIRY_WARNING audit events as email or chat messages.
- Point the catalog's file actions at the real SSH servers and MinIO instead of the local
  file store (`catalog/TargetStore.java`), and replace the placeholder classification codes.
- Change `legacy/LegacyVmDefinition.java` to match your real legacy JSON format.
  The current fields are placeholders.
