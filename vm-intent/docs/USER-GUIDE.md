# vm-intent User Guide

Last updated 21 October 2026.

## What vm-intent does

You ask for a virtual machine in plain English, and vm-intent builds it on vSphere, AWS, Azure or Google Cloud. The clouds are **simulated** in this version, so nothing real is created and no cloud accounts are needed.

How a request becomes a VM:

1. You type what you need, for example *"small rhel 9 box on prem for 2 weeks"*.
2. vm-intent turns the words into one exact, cloud-neutral **spec**: size, OS, disk, region, how long it lives. Defaults fill anything you left out, and you see them before anything is built.
3. If something important is missing, such as which cloud, it **asks you a question**.
4. You **confirm**, and a Temporal workflow builds the VM step by step.
5. If a step fails, the workflow **rolls back**: it deletes the half-built VM so nothing is left behind.

Each spec gets a fingerprint (a SHA-256 hash). Two requests worded differently but meaning the same thing get the same fingerprint, so the same VM is never built twice at once.

People use the web app. Other systems use the REST API, described in Swagger. Both reach the same workflows.

## Opening the app

Open the web app in any browser. Use `localhost` on basement itself, or basement's network address from your phone or another computer on the same network.

| What | On basement | From another device |
| --- | --- | --- |
| Web app | http://localhost:5173 | http://192.168.4.39:5173 |
| Swagger API docs | http://localhost:8080/swagger-ui.html | http://192.168.4.39:8080/swagger-ui.html |
| Temporal UI (workflow details) | http://localhost:8233 | http://192.168.4.39:8233 |

If the network address stops working, your router may have given basement a new one. Double-click `7-show-addresses.cmd` in the vm-intent folder to see the current addresses.

The web app is one page with three parts:

- **Request panel**, with two tabs: **Plain English** for typed requests and **Legacy JSON API** for the old JSON format.
- **Request card**, which appears once you submit. It shows the state, the questions, the spec and the finished VM.
- **Inventory**, a list of every VM and its state.

The **Help** menu at the top right opens this guide, the API documentation and the Temporal UI.

## Requesting one VM

On the **Plain English** tab, describe the VM, press **Preview** to check it, then **Submit request** and confirm.

1. **Describe it.** Type in the box, or click one of the example chips under it to fill the box.
2. **Preview** (optional). Shows the spec your words become, under *Preview (nothing built)*. Nothing is created.
3. **Submit request.** A request card appears and the workflow starts.
4. **Answer any question.** If the state is *AWAITING CLARIFICATION*, type your answer (for example `azure`) and press **Answer** or Enter.
5. **Check and confirm.** Under *What I understood*, read the spec and the *Assumptions (platform defaults)*. Then press **Looks right, build it**.
6. **Watch it build.** The state moves to *PROVISIONING*, then *COMPLETED*. The card then shows the VM ID, IP address and the cloud's own size, region and image.

Press **Cancel** at any point before you confirm. A request waits up to 24 hours for an answer or a confirmation, then cancels itself.

### What to say

Mention any of these, in any order and any wording. Anything you leave out gets the default.

| Detail | Example words | Default if left out |
| --- | --- | --- |
| Platform | on prem, vSphere, AWS, Amazon, Azure, GCP, Google Cloud | **Asked**: the one thing vm-intent always asks for |
| Size | xsmall, small, medium, large, xlarge, or "4 cores 16 gigs" | small (2 vCPU, 4 GiB) |
| Operating system | ubuntu, rhel 9, windows server 2022, debian, rocky | Ubuntu 24.04 ("linux" also means Ubuntu) |
| Location | us-east, Virginia, us-central1, dc1 | us-east, or dc1 on vSphere |
| Disk | 200 GB ssd | 50 GiB SSD, 128 GiB for Windows |
| Environment | dev, test, staging, production | dev |
| Lifetime | for 2 weeks, for 10 days | dev 30 days, test 14, staging 30, prod never expires |
| Name | called app-db-01 | none |
| Public IP | public IP | private IP only |

Size names stand for fixed sizes: xsmall 1 vCPU / 2 GiB, small 2 / 4, medium 4 / 16, large 8 / 32, xlarge 16 / 64. If you give only cores or only memory, the other is set at 4 GiB per vCPU.

If vm-intent doesn't recognise a size or a place, it asks rather than guessing.

### Try these

- Click the first four example chips and **Preview** each. They are worded differently but give the **same spec hash**.
- *"I need a big linux machine"*: it asks which platform. Answer `azure`.
- *"small rhel 9 box on prem for 2 weeks, called fail-demo"*: any VM with "fail" in its name fails on purpose, so you can watch the rollback.

## Following a request

The badge on the request card shows where the request is. It updates by itself every couple of seconds.

<!-- request-states-diagram -->

A request waits for you twice: to answer a question if something is missing, and to confirm. After that it runs on its own.

A request ends in one of four states:

| Final state | What it means |
| --- | --- |
| COMPLETED | The VM was built and is running |
| FAILED | A build step failed. The half-built VM was rolled back (deleted) |
| CANCELLED | You cancelled, or nobody answered or confirmed within 24 hours |
| DUPLICATE | An identical VM (same spec hash) is already built or being built, so no second one was made |

**Audit trail.** Open *Audit trail* on the card for a timed list of what happened and who did it. Events include REQUESTED, QUESTION_ASKED, ANSWERED, INTERPRETED, CONFIRMED, PROVISIONING, VM_CREATED, RUNNING, ROLLED_BACK, COMPLETED, FAILED, CANCELLED and DUPLICATE. The trail is kept in the database, so it survives restarts.

**Workflow history.** Open *Workflow history* for the steps the workflow ran. Its **open workflow** link shows every step, with timings and retries, in the Temporal UI.

**Duplicates are safe.** Submitting the same request again, even worded differently, never builds a second copy. That also makes it safe to retry if you aren't sure a request went through.

## Building many VMs at once

A **batch** builds up to 10,000 VMs in one call, with no confirmation step per VM. Batches are sent through the API, not the web app. The easiest way to try one is Swagger UI.

1. Open Swagger UI and expand **POST /api/v2/batches** under *Batches*.
2. Press **Try it out** and paste a body. Each item is either plain text or an exact spec:

```json
{
  "requestedBy": "john",
  "items": [
    {"text": "small rhel 9 box on prem in dc1 for 2 weeks"},
    {"spec": {"name": "build-agent-01", "provider": "aws", "region": "us-east", "vcpu": 4, "memoryGiB": 16,
              "os": "ubuntu", "osVersion": "24.04", "diskGiB": 100, "diskTier": "ssd", "env": "dev",
              "ttlDays": 7, "publicIp": false}}
  ]
}
```

3. Press **Execute**. The answer gives a `batchId`, how many items were accepted, and any **rejected** items with the reason. A text item that would need a question, such as one with no platform, is rejected up front rather than paused.
4. To follow it, use **GET /api/v2/batches/{id}** with that ID. It shows how many VMs are in flight, running and failed, and the typical (p50) and slow (p95) build times.

The new VMs also appear in the web app's Inventory. The system has been load-tested at 2,000 VMs building at the same time.

## Legacy JSON and the inventory

**Legacy JSON API tab.** Older systems send a fixed JSON format to `/api/v1/vms`. This tab lets you try it: edit the sample JSON and press **POST /api/v1/vms**. It skips the plain-English step and goes straight to the build workflow. If an identical VM already exists, the answer is a 409 conflict instead of a second VM. The field names in the sample are placeholders, to be matched to the real legacy format later.

**Inventory.** The bottom of the page lists the most recently changed VMs (up to 200) with name, platform, size, state and spec hash. VM states are PROVISIONING while it is built, RUNNING when ready, FAILED and DELETED (rolled back). For counts by state across every VM, use **GET /api/v2/stats** in Swagger.

## Sign-in and roles

Sign-in is **off** by default, so anyone who can reach the server can use it. Keep it on a network you trust. An administrator can turn on either or both sign-in methods:

- **Microsoft Entra ID.** Callers send an Entra access token. Their role comes from the Entra app role they were given.
- **Client certificates (PKI).** Callers connect over HTTPS (port 8443) with a certificate from a trusted CA. An allowlist on the server names each permitted certificate and its role.

Every caller has one of four roles. Each role includes the ones below it.

| Role | Can |
| --- | --- |
| ADMIN | Everything, including cancelling anyone's request |
| BATCH | Start batches and use the legacy JSON endpoint, plus everything READER can |
| REQUESTER | Preview, create, answer, confirm and cancel **their own** requests, plus everything READER can |
| READER | Look only: inventory, stats, audit trail, request and batch status |

With sign-in on, the audit trail records the real caller: a person's sign-in name, `app:<id>` for a service, or `pki:<name>` for a certificate. A missing or refused sign-in gets a 401 error, and a missing role gets 403. The message says why.

The web app can't sign in yet, so use it only with sign-in off. Setup steps for administrators are in `docs/SECURITY.md`.

## For other services: the REST API

Everything the web app does is also available to other systems through a REST API, described by an OpenAPI 3.0 document.

- **Swagger UI** (`/swagger-ui.html`): read every operation and try it with **Try it out**. Each operation lists its **Required role**.
- **OpenAPI document** (`/v3/api-docs`, or `/v3/api-docs.yaml`): point a client generator or an API gateway at it.

| Operation | What it does |
| --- | --- |
| POST /api/v2/interpret | Preview: text to spec, without building |
| POST /api/v2/requests | Start a one-VM request |
| GET /api/v2/requests/{id} | A request's state, spec, VM and history |
| POST /api/v2/requests/{id}/clarify, /confirm, /cancel | Answer, build, or cancel |
| POST /api/v2/batches · GET /api/v2/batches/{id} | Many VMs at once, and their progress |
| GET /api/v2/vms · /api/v2/stats · /api/v2/audit | Inventory, counts, audit trail |
| POST /api/v1/vms | The legacy JSON format |

Create calls return at once with an ID. Check the matching GET every 2 to 5 seconds until it reaches a final state. Errors always come back as `{"error": "..."}`. More detail is in `docs/API.md`.

## Starting and stopping the app on Windows

On basement, double-click these in `Documents\vm-intent`, in order, and leave each window open:

1. `1-start-temporal.cmd` starts the Temporal server and its UI.
2. `2-start-backend.cmd` starts the backend: the API, the database and the workers that build VMs. Wait for *Started VmIntentApplication*.
3. `3-start-frontend.cmd` starts the web app.

To stop the app, close those windows. Nothing is lost: requests, VMs and the audit trail are kept in the database, and running workflows carry on where they left off after a restart.

Other scripts in the folder:

| Script | What it does |
| --- | --- |
| `0-install-prereqs.cmd` | One-time install of Java, Maven, Node.js and the Temporal CLI |
| `4-setup-mcp.cmd` | Connects the app to the Claude desktop app, so you can use it from Claude |
| `5-start-worker.cmd` | Starts an extra worker, for more VMs at once |
| `6-run-loadtest.cmd` | Runs the load test (many VMs at once) |
| `7-show-addresses.cmd` | Shows the addresses to use from other devices |

For running on Linux or Azure, see `README.md` and `deploy/`.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| The page doesn't load | Check that all three windows from *Starting and stopping* are open. Start any that are missing, in order. |
| It loads on basement but not from another device | Use `7-show-addresses.cmd` for the current address. Allow Node.js, Java and temporal.exe through Windows Firewall on private networks. |
| An error box appears after Submit or Preview | The backend may still be starting, or Temporal isn't running. Wait 30 seconds and try again. |
| A request stays in PROVISIONING | Simulated VMs take 20 to 60 seconds to boot. If it is still there after a few minutes, check that the backend window is running. |
| The request says DUPLICATE | An identical VM already exists. Change something, such as the name, to build another. |
| The request FAILED | Open *Audit trail* for the reason. The VM was rolled back, so nothing needs cleaning up. A name containing "fail" always fails, on purpose. |
| A 401 or 403 error | Sign-in is on. Get a token or certificate with the role the operation needs (see *Sign-in and roles*). |
| The first backend start is slow | It downloads its dependencies and a database the first time. Later starts take seconds. |
