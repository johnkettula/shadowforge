# Scaling vm-intent to 2,000 VM builds at once

Last updated 2026-11-10.

This page explains how the provisioning engine runs thousands of VM builds at the same time,
what limits it, and what the load tests showed.

## How a batch flows

```
POST /api/v2/batches  (2,000 items: text or spec)
   |  API checks and interprets every item up front; unclear ones are rejected with the reason
   v
BatchProvisionWorkflow  "batch-<id>"
   |  splits the list into shards of 500
   v
BatchShardWorkflow x 4  "batch-<id>-shard-N"
   |  sliding window: keeps up to 500 builds running, starts the next as each finishes
   v
VmReconcileWorkflow x 2,000  "vm-<spec hash>"
      plan -> create -> sleep / check status -> running   (saga deletes the VM if anything fails)
```

## Why this scales

| Design choice | What it buys |
|---|---|
| **One workflow per VM, ID = `vm-` + spec hash** | Each build is independent and durable. The same spec can't be built twice at once: a repeat counts as a duplicate. |
| **Shards of 500 under one batch** | Each workflow's history stays small (a few thousand events, well under Temporal's 51,200 limit). The batch also stays under the limit of 2,000 open child workflows per parent. A 10,000-VM batch is just 20 shards. |
| **No activity waits for boot** | `createVm` returns at once. The workflow then sleeps on a Temporal timer and checks status (after 15 s, then every 5 s rising to every 30 s). A sleeping workflow uses no worker thread, so 2,000 waiting builds cost almost nothing. |
| **Two queues per cloud** | `aws-q` (create/delete) and `aws-read-q` (plan/status) have separate rate limits, the way real cloud APIs do. |
| **Server-side rate limits** | `maxTaskQueueActivitiesPerSecond` is enforced by Temporal across all workers, so adding workers never breaks a cloud's API limit. Defaults: 25 creates/s for AWS and Google Cloud, 8 for Azure (its documented limit), 15 for vSphere. |
| **Throttling is retried, not failed** | A cloud "429" is retried with exponential backoff (2 s doubling to 60 s), for up to 30 minutes. |
| **Separate API and worker processes** | The same jar runs as `api` (REST only) or `worker` (workflows only). To scale, add workers; nothing else changes. |
| **Virtual threads (Java 21)** | Workflow and activity threads are virtual, so a worker can hold thousands of cached workflows. |
| **Status from the database, not from workflows** | `GET /api/v2/batches/{id}` counts the audit trail in Postgres. It answers at once, even while workers restart. |
| **Graceful shutdown** | On stop, workers finish their running tasks before the database pool closes. Anything unfinished is retried by another worker. |

## How long a batch takes

The ramp-up is set by the create rate limits, not by Temporal:

```
time to start every VM  ≈  number of VMs / total creates per second
2,000 / (25 + 8 + 25 + 15)  ≈  27 seconds
```

Total time is roughly that ramp-up plus the slowest boot plus one status-check interval (up to 30 s).
To go faster, raise `vmintent.workers.rate.*` up to what your cloud accounts allow.

## Load-test results

Command: `node loadtest/run-loadtest.mjs --count 2000 --shard 500 --fail 20`. Twenty of the VMs are
named `fail-…` so their simulated boot fails and the saga must roll them back.

The test machine was a **2-vCPU, 8 GB Linux sandbox** running all of these at once: Temporal's test
server, Postgres, the API and two worker processes. The shared CPU is why ramp-up times are slower
than the rate limits allow.

| Run | Boot time | VMs running | Rolled back | Duplicates | VMs created twice | Peak in flight | Batch time | p50 / p95 per VM |
|---|---|---|---|---|---|---|---|---|
| 1 | 20–60 s | 1,980 | 20 of 20 | 0 | 0 | **2,000** (all started in 28 s) | 190 s | 90 s / 153 s |
| 4 | 20–60 s | 1,980 | 20 of 20 | 0 | 0 | 1,525 (counted after first cloud call) | 191 s | 94 s / 158 s |
| 5 | 60–180 s (realistic) | 1,980 | 20 of 20 | 0 | 0 | **1,960** | 401 s | 246 s / 335 s |

Run 1 counted a VM as in flight from the moment its workflow started. Run 4 counted it only after its
first cloud call, so builds that were still waiting their turn under the rate limit weren't counted.
Run 5 went back to counting from workflow start, with realistic 1–3 minute boots: 1,960 builds were
running at the same moment. The other 40 had already finished.

Checks after every run:
- every VM in the inventory ended RUNNING or FAILED, with none stuck;
- every rolled-back VM was deleted in the simulated cloud;
- no idempotency key produced two VMs;
- the audit trail has one PROVISIONING, VM_CREATED and RUNNING (or ROLLED_BACK) event per VM.

Other checks:
- Duplicates: submitting the same batch twice while the first was still building gave 2 duplicates and 0 new VMs.
- An item that needs a question ("I need a big linux machine") was rejected up front, with the question.

### Worker failure

The Linux sandbox uses Temporal's Java **test server**, which can't find Temporal's real server
binary there. When a worker was killed in the middle of a 2,000-VM run, the test server lost the
tasks it had just handed to that worker. In a real Temporal server, those tasks time out and go to
another worker. A new batch run afterwards completed normally. So the crash test was repeated against
a real Temporal server, on basement.

**Crash test on basement (Windows, real Temporal server):**
- Setup: Temporal's single-binary dev server (SQLite), the all-in-one backend, and one extra worker
  started with `5-start-worker.cmd`. Load test: `6-run-loadtest.cmd`, 2,000 VMs with 20 set to fail.
- At about 70 s, with roughly 140 builds in progress, the extra worker's window was closed.
- **Result:** 1,980 VMs running and 20 of 20 rolled back, exactly as expected. No duplicates, and no
  build lost or stuck. The surviving process picked up every in-progress build.
- Speed: the dev server's single SQLite file handled about 1 VM per second, so the batch took 33
  minutes and at most 152 VMs were in flight at once. That is the dev server's limit, not the app's.
  For thousands at once, use the Postgres-backed Temporal in `deploy/docker-compose.yml`.

Two genuine bugs came out of the sandbox crash tests, and both are fixed:
1. The batch status page queried workflows, which hangs if the worker holding them has died. It now
   reads Postgres. The single-request status query also has a 5-second timeout.
2. On shutdown, the database pool closed before running tasks finished. `GracefulWorkerShutdown` now
   lets the workers drain first.

## Automated tests

`BatchWorkflowTest` (run with `mvn test`) runs the real batch, shard and VM workflows in Temporal's
in-memory test server, with timers skipped and a fake cloud. It checks:
- a 12-VM batch in 3 shards gives 10 running and 2 rolled back, with no shard over its in-flight limit;
- an identical spec in one batch is built once and counted as a duplicate;
- throttled create calls are retried until they succeed.

## Sizing guide for 2,000 at once

| Part | Suggested starting point |
|---|---|
| Workers | 3 processes, 2 vCPU and 2 GB each (the 2-vCPU sandbox ran 2,000 with two) |
| API | 1 process (2 for availability) |
| Temporal | Postgres-backed, 512 history shards (set at first start; see `deploy/docker-compose.yml`). For production use Temporal's Helm chart with 3+ history nodes, or Temporal Cloud. |
| Postgres | `max_connections` 400+. About 7 small writes per VM. |
| Cloud limits | Set `vmintent.workers.rate.*` to your accounts' API limits and check vCPU quotas: 2,000 VMs of 4 vCPU is 8,000 vCPU. |

## What is still simulated

By default every cloud is simulated (`SimCloud`). vSphere can already be real (vCenter 9 or VCF Automation 9,
see [VSPHERE.md](VSPHERE.md)), and real Azure is being built ([AZURE.md](AZURE.md)). For the rest, `createVm`,
`describeVm` and `deleteVm` get real API calls the same way: for AWS, `RunInstances` with `ClientToken` = spec
hash, `DescribeInstances`, and `TerminateInstances`. Nothing in the workflows changes. The load-test results
above are all against the simulated clouds.

The simulator's settings (`vmintent.sim.*` in `application.yml`) shape those results:

| Variable | Default | What it sets |
|---|---|---|
| `VMINTENT_SIM_BOOT_MIN`, `VMINTENT_SIM_BOOT_MAX` | 20 s, 60 s | The simulated boot time: each VM boots in between these two |
| `VMINTENT_SIM_LATENCY_MS` | 250 | The delay of each simulated cloud call, in milliseconds (on average: each call waits between half and one and a half times this) |
| `VMINTENT_SIM_THROTTLE` | 0.02 | The share of cloud calls refused as throttled (like an HTTP 429) |
