# Temporal features in vm-intent

Last updated 2026-11-18.

This page explains which Temporal features vm-intent uses, what each one is for, where it is in the
code, and how to see it working. It's written for someone learning Temporal.

A quick reminder of the basics:

- A **workflow** is ordinary Java code that Temporal runs durably. If the machine restarts, Temporal
  re-runs the code against its saved **history** to get back to the same point. That's why workflow
  code must be *deterministic*: no clock, no random numbers and no network calls, except through
  Temporal's own versions of them.
- An **activity** is a normal method that does the real work: database writes, cloud calls, files.
  Temporal retries it if it fails.
- A **worker** is the process that runs both. Workflows and activities find workers through **task
  queues**.

## The workflows

| Workflow | ID | What it does |
|---|---|---|
| `IntentWorkflow` | `intent-<uuid>` | One request: interpret, ask, confirm, build one VM or several |
| `VmReconcileWorkflow` | `vm-<spec hash>` | Builds one VM, with rollback if a step fails |
| `VmLifecycleWorkflow` | `life-<spec hash>` | One running VM: expiry, renewal, resize, power, snapshots, removal |
| `BatchProvisionWorkflow`, `BatchShardWorkflow` | `batch-...` | Thousands of VMs from the batch API |
| `InventoryCheckWorkflow` | `inventory-check-...` | Nightly check that the clouds still match the inventory |
| `CatalogRunWorkflow` | `run-<definition>-<hash of version and inputs>` | One run of an operator-written definition: steps in order, resume or tear down after a failure |
| `ArchiveSweepWorkflow` | `archive-sweep-...` | Hourly: copies closed histories to the write-once archive, removes expired ones |

## 1. Waiting for an answer over the one-way link

**Feature:** signals, and `Workflow.await(timeout, condition)`.

When a cloud is behind the one-way link to domain 3, the build workflow doesn't call the cloud. It
writes an order file and waits for the answer to come back on the return link. A waiting workflow
holds no thread, so it can wait minutes or days for free. A listener hands each answer to the right
workflow as a `linkReply` signal, using the workflow ID written in the order.

- Code: `workflow/CloudOps.java` (`sendAndWait`), `link/ReturnLinkListener.java`
- Details and file formats: [ONE-WAY-LINK.md](ONE-WAY-LINK.md)
- Try it: set `VMINTENT_LINK_PROVIDERS=gcp` and `VMINTENT_LINK_SIMULATE=true`, then request a VM
  on Google Cloud. Its VM ID starts with `d3-`.

## 2. Expiry and renewal with durable timers

**Feature:** durable timers (`Workflow.await` with a timeout).

Every VM gets a `VmLifecycleWorkflow` once it's running. It works out the next moment that matters
(the expiry warning, or the expiry itself) and sleeps until then. A renewal wakes it early, and it
works out the new time. There's no cron job and no expiry table: the timer lives on the Temporal
server and survives restarts.

- When it warns: 3 days before expiry for a VM that lives a week or more, 1 day for 2-6 days, 6 hours
  for a 1-day VM. The warning is an `EXPIRY_WARNING` audit event, which is where an email or
  chat message would be sent.
- When it expires: the VM is deleted and marked DELETED. If the delete fails, it tries again an hour later.
- Code: `workflow/VmLifecycleWorkflowImpl.java`

## 3. Rollback (saga)

**Feature:** `io.temporal.workflow.Saga`.

Each build step that changes something registers its "undo". If a later step fails, the undo steps
run in reverse order. For the one-way link, the undo is registered *before* the wait: if no answer
comes, domain 3 may have built the VM anyway, so a DELETE order goes out, matched by the build's
idempotency key. One failed VM in a multi-VM request is rolled back on its own; the others carry on.

**The cloud-side name is a recorded value.** The build workflow takes the VM's name in the cloud from
`ReconcileRequest.cloudName` (null = the name asked for, `spec.name`). The plan, the create, the
CREATE order over the link and the undo all use that name. The VM record, the audit trail and the
lifecycle workflow keep the name asked for. The workflows never work the name out themselves. They
only copy it from the request, which is stored in the history. So a build that is still running
when new code is deployed replays with the name it started with, and its rollback deletes the VM it
really made. Every caller copies the cloud name that `VmIdentity.of` gave the Interpretation, BatchItem
or PreparedVm, which today is the spec's name (or the generated `vm-` name). Only histories recorded
before that change carry a null `cloudName`, which the build treats as `spec.name`.

- Code: `workflow/VmReconcileWorkflowImpl.java` (`cloudSpec`)
- Try it: name a VM with "fail" in it (`called fail-demo`).

## 4. Live status and searchable requests

**Features:** queries, and search attributes.

- A **query** (`status()`) lets the web app ask a running workflow where it is, without waiting for it.
- **Search attributes** are extra fields Temporal indexes for each request: `VmRequester`, `VmState`,
  `VmProvider`, `VmEnv` and `VmSpecHash`, and for catalog runs `VmDefinition` and `VmClassification`. They power `GET /api/v2/requests?requester=&state=&provider=&env=`
  and the web app's *Requests* list. You can also search in the Temporal UI, for example
  `VmRequester = "jdoe" AND VmState = "AWAITING_CONFIRMATION"`.

A Temporal server refuses a workflow that sets an attribute it doesn't know.
`config/SearchAttributesSetup.java` checks at startup and adds any that are missing. The dev server and
a self-hosted server allow this. If it can't (Temporal Cloud), requests still work but can't be
filtered until someone runs:

```
temporal operator search-attribute create --name VmRequester --type Keyword
```

for each of the seven attributes, or `tcld` on Temporal Cloud. Set `VMINTENT_SEARCH_ATTRIBUTES=off` to not use them.

## 5. Confirming with an update

**Features:** updates and update validators.

A **signal** is fire-and-forget: the caller never learns whether it counted. An **update** answers.
`POST /api/v2/requests/{id}/confirm` is now an update with a validator that refuses it straight away
(409, with the reason) when:

- the request isn't waiting for confirmation, or has finished;
- the `specHash` you send isn't the spec the request is waiting on, so nobody confirms a spec they
  didn't see.

A refused update leaves no trace in the workflow's history. The old `confirm` signal is still there
for older callers.

Answering and cancelling work the same way. `clarify` is the `answerQuestion` update, refused unless
the request is waiting for an answer. `cancel` is the `cancelRequest` update, refused once the build
has started (`PROVISIONING`) or the request has finished. Each sets the same fields as the old
`clarify` / `cancel` signals, which are kept so running workflows and recorded histories still replay.

- Code: `IntentWorkflow.confirmSpec` / `validateConfirmSpec`, `answerQuestion`, `cancelRequest`

## 6. The nightly inventory check

**Feature:** Schedules.

A Temporal Schedule (`vm-inventory-check`) starts an `InventoryCheckWorkflow` every night at 02:00 UTC,
even if no copy of the app was running at that moment: a worker picks it up when one starts. For each
cloud it lists the VMs and compares them with the inventory:

- **Missing:** RUNNING here but gone from the cloud. Marked MISSING, and its lifecycle workflow is
  told to stop.
- **Unrecorded (orphans):** in the cloud but never recorded here. Reported only, never deleted.
- Clouds behind the one-way link are skipped, because domain 2 can't look into domain 3.

Change the timing with `VMINTENT_INVENTORY_CHECK_CRON` and `_TZ`. The app writes the
`vm-inventory-check` schedule again from these settings every time it starts, so a timing changed in
the Temporal UI lasts only until the next start. Pause it or run it now in the
Temporal UI under **Schedules**, or with `POST /api/v2/inventory-checks`. To turn the nightly check
off, set `VMINTENT_INVENTORY_CHECK=false` (default `true`): the next time the app starts, it removes
the `vm-inventory-check` schedule.

- Code: `config/InventorySchedule.java`, `workflow/InventoryCheckWorkflowImpl.java`

## 7. Day-2 changes

**Features:** updates with validators, `WorkflowLock`, continue-as-new.

Renew, resize, power on or off, snapshot and remove are updates to the VM's lifecycle workflow:

- The **validator** checks the request first (sizes in range, not already off, a valid snapshot label,
  renewals capped at 365 days ahead). A refusal comes straight back as a 409 with the reason.
- A **WorkflowLock** makes sure only one change runs at a time, so a resize and a power-off can't overlap.
- If the cloud refuses a change, the update fails and nothing changes on our side.
- **Continue-as-new:** a VM that lives for years could collect a very long history. After 2,000 events the
  workflow starts a fresh history and carries its state over.

API: `POST /api/v2/vms/{specHash}/renew | resize | power | snapshot | decommission`, and
`GET /api/v2/vms/{specHash}/lifecycle`. In the web app, click a VM in the inventory.

## 8. Several VMs in one request

**Features:** child workflows, `Async.function` and `Promise`.

"3 web servers on aws" builds three VMs named `web-01`, `web-02` and `web-03`, each in its own child
workflow with its own rollback, at most 5 at a time. The request ends COMPLETED (built, none failed;
VMs that already existed count as running, not failed, and the message names them), PARTIAL (some built and
at least one failed), FAILED (none built, at least one failed) or DUPLICATE (all already existed). One request can ask for up to 20 VMs; for more, use a batch.

## 9. Replay tests

**Features:** `WorkflowReplayer` and `Workflow.getVersion`.

`ReplayTest` replays every file in `backend/src/test/resources/histories` against today's code. It
picks the workflow class from the file name's prefix: `intent-` → `IntentWorkflowImpl`, `reconcile-` →
`VmReconcileWorkflowImpl`, `catalog-` → `CatalogRunWorkflowImpl`, `lifecycle-` → `VmLifecycleWorkflowImpl`,
`batchshard-` → `BatchShardWorkflowImpl`.
A file with any other prefix fails the test with its name, so no history is skipped. It also checks
that the seven pinned histories (the `intent-v1-*`, `reconcile-v1-*` and `catalog-v1-*` files), the
four recorded ones after them, the two signed-in ones and the cloud-name one are all still there.

- `intent-v1-*` and `reconcile-v1-*` were recorded from the code *before* the lifecycle, update and
  link features were added; the three `catalog-v1-*` histories are real catalog runs (resumed, torn
  down, approved).
- `intent-v2-multi-existing` is a request for two VMs where one already existed; the other is built
  by a `vm-` child workflow.
- `lifecycle-v1-renewed` is a VM's lifecycle (`life-` workflow) that took a `renew` update, saved
  while it was still running.
- `batchshard-v1-duplicate` is a batch shard given the same spec twice: one `vm-` child workflow builds
  the VM, the second start finds that workflow already there and counts as a duplicate.
- `catalog-v2-existing-vm` is a catalog run whose VM was already RUNNING (built by an earlier run with
  the same spec): the `ExistingVm` activity finds it and the run uses it ("already built with this
  spec") without starting a `vm-` child workflow.

These four were recorded before per-user identity changed the spec hash of signed-in users, and so
their `vm-` child workflow IDs, to show that executions started before that change still replay.
Requests with no owner keep the same hash and `vm-` child IDs as before.

All of the above have no owner (sign-in off), so they only cover the anonymous path. Two more were
recorded with an owner set, while `VmIdentity.hash` still ignored it, so a change to the
owner-dependent path (a new step, or another `vm-` child workflow ID) without `Workflow.getVersion`
fails the build too:

- `intent-v2-signed-in` is a request with `IntentRequest.owner` set to `alice-signed-in`; its VM is
  built by a `vm-` child workflow.
- `catalog-v3-signed-in` is a catalog run with `RunRequest.owner` set to `alice-signed-in`, so the
  `PrepareVm` activity gets the owner; its VM is built by a `vm-` child workflow.

One more pins how the workflows pass the cloud name on. `VmIdentity.of` gives every new
`Interpretation`, `BatchItem` and `PreparedVm` a `cloudName`, which the workflows copy into
`ReconcileRequest.cloudName` without working anything out, so no `Workflow.getVersion` is needed.
Histories recorded before it existed decode `cloudName` as null, which the build workflow treats as
the spec's name:

- `batchshard-v2-cloud-name` is a batch shard whose `BatchItem` has the cloud name `x-test` while its
  spec is named `web-01` (recorded by `CloudNameTest`); its `vm-` child workflow builds the VM as
  `x-test`.

If a change would make a workflow that's running during an upgrade behave differently from its
history (a new step, a timer moved, a child workflow ID that changed), the test fails before it ships.

The build workflow gained steps (the link route and the lifecycle hand-off), so they are wrapped in
`Workflow.getVersion("link-and-lifecycle", DEFAULT_VERSION, 1)`. Old builds replay down the old path;
new builds take the new one.

To add a history from a real server:

```
temporal workflow show --workflow-id intent-... --output json > backend/src/test/resources/histories/my-case.json
```

To record one in the repository instead, write a `TestWorkflowEnvironment` scenario that ends with
`HistoryRecorder.record(client, workflowId, "intent-my-case")` (see `RecordedHistoriesTest`) and run:

```
cd backend && mvn test -Dhistories.record=true
```

`HistoryRecorder` writes only files that are missing; it never overwrites or deletes one, and a plain
`mvn test` writes nothing. Name the file with one of the prefixes above and `ReplayTest` replays it
from then on. Saved histories are append-only: record a new file rather than changing an old one.

## 10. Catalog runs that wait instead of failing

**Features:** updates with validators, durable timers, child workflows, deterministic workflow code.

A catalog run ([DEFINITIONS.md](DEFINITIONS.md)) runs a definition's steps in order. When a step
fails, the workflow doesn't fail: it stops in AWAITING_RECOVERY and waits with
`Workflow.await(30 days, () -> decision != null)`. A waiting run costs nothing.

- **`resume`** and **`teardown`** are updates. Their validators refuse them straight away (409) unless
  the run is waiting. Resume runs only the failed step again; teardown undoes the finished steps,
  newest first. If the timer runs out first, the run tears itself down.
- **`approve`** is an update too: an `approval.wait` step waits until someone answers. Its validator
  refuses the run's own requester (four-eyes) and anyone not on the step's approvers list.
- **`vm.create`** starts the same `VmReconcileWorkflow` as a plain-English request, as a child
  workflow, so the VM gets its rollback, the one-way link and its lifecycle.
- **CEL in workflow code.** `when:` conditions and `${ }` values are worked out inside the workflow.
  That's allowed because CEL is deterministic: no clock, no I/O, no randomness. The run keeps a copy
  of its definition in its input, so a definition published later can't change how it replays.
- **The workflow ID comes from the inputs**, so sending the same run twice finds the first one
  (`WorkflowExecutionAlreadyStarted`), and a waiting run can't be duplicated.

- Code: `workflow/CatalogRunWorkflowImpl.java`, `catalog/CatalogActivitiesImpl.java`

## 11. Archive and audit replay

**Features:** Schedules, visibility queries, `fetchHistory`, `Worker.replayWorkflowExecution`.

The `vm-archive-sweep` schedule lists closed workflows (`ExecutionStatus != 'Running' AND CloseTime > ...`),
fetches each history and writes it to the write-once archive, kept 1-5 years by data classification.
`POST /api/v2/compliance/replays` replays one against today's code, the same way Temporal recovers a
workflow after a restart: activities aren't run, their recorded results are fed back in, and any
difference is reported. See [AUDIT.md](AUDIT.md).

- Code: `workflow/ArchiveSweepWorkflowImpl.java`, `audit/ArchiveActivitiesImpl.java`, `audit/ReplayService.java`

## 12. Time-skipping tests

**Feature:** `TestWorkflowEnvironment`.

Temporal's in-memory test server skips time, so `LifecycleWorkflowTest` checks a 10-day expiry, the
warning on day 7 and a renewal in under a second. `env.sleep(Duration.ofDays(8))` moves the clock
forward and fires any timers due.

One thing to know: it only skips ahead while a timer is waiting. To wait for a workflow to *end*, use
`getResult(...)`. An `env.sleep` that runs past the last timer runs in real time.

| Test | What it covers |
|---|---|
| `LifecycleWorkflowTest` | Expiry, warning, renewal, validators, day-2 changes, rebuilding a removed VM |
| `OneWayLinkTest` | Build and changes over the link, no answer (timeout and undo), refusal |
| `CloudNameTest` | The build workflow takes the cloud-side name from `ReconcileRequest.cloudName` (null = the name asked for) and never works it out itself: the cloud's plan and create, and the link's CREATE order, get the cloud name, while the VM record and the audit trail keep the name asked for; a rollback (direct, or the undo by key over the link) removes the VM made under the cloud name; a batch shard passes its `BatchItem.cloudName` on to the cloud (the scenario behind `batchshard-v2-cloud-name`) |
| `LinkFilesTest` | The real file-based link with the simulated domain 3 |
| `IntentWorkflowTest` | Answer, confirm and cancel updates (with a replay round trip), several VMs at once, search attributes |
| `InventoryCheckTest` | Missing VMs and orphans |
| `ReplayTest` | Every saved history against new code, the workflow class picked by file-name prefix (a file with no known prefix fails), and the seven pinned histories (`intent-v1-*`, `reconcile-v1-*`, `catalog-v1-*`) and the four recorded ones (`intent-v2-multi-existing`, `lifecycle-v1-renewed`, `batchshard-v1-duplicate`, `catalog-v2-existing-vm`) and the two signed-in ones (`intent-v2-signed-in`, `catalog-v3-signed-in`) and the cloud-name one (`batchshard-v2-cloud-name`) still present |
| `RecordedHistoriesTest` | The scenarios behind `intent-v2-multi-existing` (two VMs, one already there), `lifecycle-v1-renewed` (a renewal), `batchshard-v1-duplicate` (a shard with the same spec twice) and `intent-v2-signed-in` (a signed-in request); with `-Dhistories.record=true` they save missing histories |
| `HistoryRecorderTest` | `HistoryRecorder` writes nothing without `-Dhistories.record=true`, writes a missing file that replays, and leaves an existing file byte-for-byte unchanged |
| `CatalogRunWorkflowTest` | Steps in order, resume with partial work, teardown, 30-day auto teardown, approvals, blueprints, reusing a VM already built with the same spec (the scenario behind `catalog-v2-existing-vm`), a signed-in run whose owner reaches `prepareVm` (the scenario behind `catalog-v3-signed-in`), the run's owner changes the prepared spec hash so each user gets their own VM, the prepared VM's cloud name is its spec's name and reaches the build |
| `CountPhrasingTest` | "3 web servers" vs "a RHEL 9 server" |
| `BatchWorkflowTest` | Batches in shards: rollbacks, duplicates in one batch, throttled creates retried |
| `VsphereRoutesWorkflowTest` | vSphere builds through the mock vCenter 9 and VCF Automation 9, their rollbacks, and a catalog run that deploys a blueprint and tears it down |
| `RequestControllerTest` | Answering or cancelling a request: 409 once it has finished or can't take it, 404 for an unknown ID |
| `VmControllerTest` | Day-2 changes: 404 for a spec hash that matches no VM, 409 for a VM that exists but can't be changed, 400 for a malformed hash. `GET /api/v2/vms/{specHash}` (`getVm`): 200 and the record for a known VM in any state, 400 for a malformed hash, 404 for an unknown one |
| `RequestOwnerFlowTest` | Each request's owner comes from sign-in on the server (`anonymous` when sign-in is off), never from `userId` or `requestedBy`: a single request, a multi-VM request, a batch, preview and the legacy endpoint; a second signed-in user's identical request, or identical batch item, builds its own VM while the first user's repeat is DUPLICATE; a `userId` or `requestedBy` in the body does not change the hash; the cloud name recorded for a single request, a multi-VM request, a batch and the legacy endpoint is the spec's name, and is what the build gets |
| `VmIdentityTest` | Golden values: no owner (null or `anonymous`) keeps today's pinned canonical strings and hash; two signed-in users get different hashes for the same spec, neither equal to the anonymous hash; a signed-in user's hash is stable (pinned) and changes with the spec; no anonymous spec hashes the same input as a signed-in user; `VmIdentity.of` gives exactly a hash (today's, for null, `anonymous` and a signed-in owner) and a cloud name (the spec's name, or the generated one); the `vm-` and `life-` workflow IDs are built from the hash; `buildKey` is the hash, or the hash + `-` + the run ID's first 8 characters, and `hashOfBuildKey` gives the hash back; `VmIdentity.sameBuild` is true only for the same spec hash (the clouds adopt an existing VM only when it matches) |
