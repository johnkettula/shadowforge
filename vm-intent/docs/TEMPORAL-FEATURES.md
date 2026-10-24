# Temporal features in vm-intent

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

- Code: `workflow/VmReconcileWorkflowImpl.java`
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

- Code: `IntentWorkflow.confirmSpec` / `validateConfirmSpec`

## 6. The nightly inventory check

**Feature:** Schedules.

A Temporal Schedule (`vm-inventory-check`) starts an `InventoryCheckWorkflow` every night at 02:00 UTC,
even if no copy of the app was running at that moment: a worker picks it up when one starts. For each
cloud it lists the VMs and compares them with the inventory:

- **Missing:** RUNNING here but gone from the cloud. Marked MISSING, and its lifecycle workflow is
  told to stop.
- **Unrecorded (orphans):** in the cloud but never recorded here. Reported only, never deleted.
- Clouds behind the one-way link are skipped, because domain 2 can't look into domain 3.

Change the timing with `VMINTENT_INVENTORY_CHECK_CRON` and `_TZ`. Pause it or run it now in the
Temporal UI under **Schedules**, or with `POST /api/v2/inventory-checks`.

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
workflow with its own rollback, at most 5 at a time. The request ends COMPLETED (all built), PARTIAL
(some failed) or FAILED (none built). One request can ask for up to 20 VMs; for more, use a batch.

## 9. Replay tests

**Features:** `WorkflowReplayer` and `Workflow.getVersion`.

`ReplayTest` re-runs saved histories, recorded from the code *before* these features were added,
against today's code. If a change would make a workflow that's running during an upgrade behave
differently from its history, the test fails before it ships.

The build workflow gained steps (the link route and the lifecycle hand-off), so they are wrapped in
`Workflow.getVersion("link-and-lifecycle", DEFAULT_VERSION, 1)`. Old builds replay down the old path;
new builds take the new one.

To add a history from a real server:

```
temporal workflow show --workflow-id intent-... --output json > backend/src/test/resources/histories/my-case.json
```

## 10. Catalog runs that wait instead of failing

**Features:** updates with validators, durable timers, child workflows, deterministic workflow code.

A catalog run ([DEFINITIONS.md](DEFINITIONS.md)) runs a definition's steps in order. When a step
fails, the workflow doesn't fail: it stops in AWAITING_RECOVERY and waits with
`Workflow.await(72 hours, () -> decision != null)`. A waiting run costs nothing.

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
| `LinkFilesTest` | The real file-based link with the simulated domain 3 |
| `IntentWorkflowTest` | Confirm update, several VMs at once, search attributes |
| `InventoryCheckTest` | Missing VMs and orphans |
| `ReplayTest` | Old histories against new code, including real catalog runs (resumed, torn down, approved) |
| `CatalogRunWorkflowTest` | Steps in order, resume with partial work, teardown, 72-hour auto teardown, approvals, blueprints |
| `CountPhrasingTest` | "3 web servers" vs "a RHEL 9 server" |
