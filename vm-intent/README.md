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
  provider/   ProviderActivities interface + simulated AWS/Azure/GCP/vSphere adapters,
              each on its own task queue, and an in-memory VM inventory
  legacy/     The old JSON format -> the same spec (no AI)
  api/        REST endpoints used by the React app
frontend/src/ App.tsx (the whole UI), api.ts (typed REST calls)
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
- Move `VmRegistry` to PostgreSQL with Spring Data JPA so the inventory survives restarts.
- Add an approval step (a signal from an approver) before provisioning prod VMs.
- Change `legacy/LegacyVmDefinition.java` to match your real legacy JSON format.
  The current fields are placeholders.
