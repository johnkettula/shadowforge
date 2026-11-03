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

### Using an AI to understand requests

By default, built-in rules turn your words into a spec. An administrator can have an AI model do that step instead: Claude, OpenAI, Azure OpenAI, or **Ollama**, which runs free on basement itself. The AI only fills in the fields. You still see the spec and confirm it, and the rules answer whenever the AI is unavailable.

The line under the spec says which one answered: *interpreted by ai:ollama/llama3.2*, *rules*, or *rules (AI unavailable)*. To turn it on, copy `ai-settings.example.cmd` to `ai-settings.cmd`, follow the steps inside, and restart the backend. Details are in `README.md` under *Using an AI*.

## Following a request

The badge on the request card shows where the request is. It updates by itself every couple of seconds.

<!-- request-states-diagram -->

A request waits for you twice: to answer a question if something is missing, and to confirm. After that it runs on its own.

A request ends in one of five states:

| Final state | What it means |
| --- | --- |
| COMPLETED | The VM (or every VM, for a request for several) was built and is running. A request for several VMs where some already existed and the rest were built also ends COMPLETED: VMs that already existed count as running, and the message names them |
| PARTIAL | A request for several VMs where some were built and at least one failed (the failed ones were rolled back) |
| FAILED | A build step failed. The half-built VM was rolled back (deleted) |
| CANCELLED | You cancelled, or nobody answered or confirmed within 24 hours |
| DUPLICATE | An identical VM (same spec hash) is already built or being built, so no second one was made |

**Confirming checks the spec.** **Looks right, build it** sends the spec hash you were looking at. If the request isn't waiting any more, or the spec isn't the one you saw, you get a message saying so instead of a build.

**Audit trail.** Open *Audit trail* on the card for a timed list of what happened and who did it. Events include REQUESTED, QUESTION_ASKED, ANSWERED, INTERPRETED, CONFIRMED, PROVISIONING, VM_CREATED, RUNNING, ROLLED_BACK, COMPLETED, FAILED, CANCELLED and DUPLICATE, plus the lifecycle events below. The trail is kept in the database, so it survives restarts.

**Workflow history.** Open *Workflow history* for the steps the workflow ran. Its **open workflow** link shows every step, with timings and retries, in the Temporal UI.

**Duplicates are safe.** Submitting the same request again, even worded differently, never builds a second copy. That also makes it safe to retry if you aren't sure a request went through.

**Finding a request again.** The *Requests* list shows recent requests, newest first. Pick *Mine*, *Waiting for confirmation* or *Failed* to filter it, and press **Open** to bring a request back onto the card.

## Several VMs in one request

Ask for a number of machines and you get that many: "3 small ubuntu web servers on gcp, called web" builds `web-01`, `web-02` and `web-03`. The summary starts with "3 ×" so you can check the count before you confirm. They're built side by side, at most five at a time, and each one is rolled back on its own if it fails. One request can ask for up to 20; for more, use a batch (below).

Numbers that belong to something else aren't counts: "a RHEL 9 server" or "16 GB RAM server" is one VM.

## Looking after a VM: expiry and changes

Every VM gets an expiry date from its lifetime (dev 30 days, test 14, prod never, or what you asked for). The inventory's **Expires** column shows how long is left, in amber once the warning has gone out.

- **Warning.** Three days before a VM expires (less for short-lived VMs), the owner is warned. The warning is recorded in the audit trail as EXPIRY_WARNING.
- **Expiry.** When the time is up, the VM is removed and its state becomes DELETED.

**Click a VM in the inventory** to open its panel. There you can:

| Action | What it does |
| --- | --- |
| Renew +7 / +30 days | Push the expiry back. At most 90 days at a time, and never more than 365 days from today |
| Resize | Change vCPU and memory. If the cloud refuses, nothing changes and you see why |
| Power off / on | Stop or start the VM. It keeps its expiry date |
| Take snapshot | Save a snapshot with a label (lowercase letters, digits and dashes) |
| Remove this VM | Delete it now. It asks *Sure?* first, because this can't be undone |

A change that can't be done (renewing a VM that never expires, powering off a VM that's already off) is refused straight away with the reason, and nothing happens to the VM. With sign-in on, only the VM's owner or an admin can change it.

The same spec can be built again after it was removed; you get a new VM.

## The nightly inventory check

Every night at 02:00 UTC the app compares each cloud with its inventory. The *Inventory check* card shows the last result:

- **Missing:** a VM the inventory says is running, but the cloud no longer has (someone deleted it by hand). It's marked MISSING.
- **Unrecorded:** a VM in the cloud that the inventory never recorded. These are only listed, never deleted; deciding what to do is up to a person.

Press **Run now** to check straight away (admins only when sign-in is on). Clouds reached over the one-way link to domain 3 are skipped. To change the time or pause it, use the Temporal UI's **Schedules** page.

## Catalog runs: ready-made jobs from operators

The **Catalog** card runs jobs that technical operators have written in YAML: build a VM, install tools, copy files, set its configuration, check it's ready. Each job is a *definition*; how to write one is in `docs/DEFINITIONS.md`.

1. Pick a definition at the top right of the card, for example **web-server**. Its steps and data classification are shown.
2. Fill in its inputs (a `*` means required) and press **Start run**. The run opens below with every step and its state.
3. Starting the same definition with the same inputs again opens the run that is already going instead of starting a second one.

A production web server (`env` = prod) first waits for an **approval**: someone other than you must press **Approve** (or **Reject**) on the run, with a note such as a change ticket.

**When a step fails**, the run doesn't start again from the beginning. It stops, shows the reason, and waits for a decision:

- Fix the cause (for example, put the missing file in the file store), then press **Resume step …**. Only the failed step runs again, and it picks up what it already did: files already copied are skipped.
- Or press **Tear down…** and confirm: everything the run did is undone, newest first, including the VM.
- If nobody decides by the time shown under *Decide by* (30 days at most), the run tears itself down.

The person who started a run, or an operator, can resume or tear it down. A VM built by a run is also in the Inventory, where it can be renewed or changed like any other.

## Compliance: decisions, archive and replay

The **Compliance** card is for auditors.

- **Decision log:** every permission decision, newest first: who asked to do what, whether it was allowed, and the rule that decided. Type a run ID to see only that run's decisions.
- **Archive:** every finished workflow's history is copied here every hour, write-once, and kept for 1 to 5 years depending on its data classification (a code such as C3, with its text). **Replay** runs the recorded workflow against today's code without doing anything again, and shows **matches** if the code makes exactly the recorded decisions. **Archive now** copies new histories straight away.

The classification codes C1, C3 and C5 are placeholders until the real scheme is set (`docs/AUDIT.md`).

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

**Inventory.** The bottom of the page lists the most recently changed VMs (up to 200) with name, platform, size, state and spec hash. VM states are PROVISIONING while it is built, RUNNING when ready, FAILED (rolled back), DELETED (removed or expired) and MISSING (gone from its cloud). Click a VM to look after it (see above). For counts by state across every VM, use **GET /api/v2/stats** in Swagger.

## Sign-in and roles

Sign-in is **off** by default, so anyone who can reach the server can use it. Keep it on a network you trust. An administrator can turn on either or both sign-in methods:

- **Microsoft Entra ID.** Callers send an Entra access token. Their role comes from the Entra app role they were given.
- **Client certificates (PKI).** Callers connect over HTTPS (port 8443) with a certificate from a trusted CA. An allowlist on the server names each permitted certificate and its role.

Every caller has one of six roles. Each role includes the ones below it.

| Role | Can |
| --- | --- |
| ADMIN | Everything, including cancelling anyone's request, changing anyone's VM and running the inventory check |
| OPERATOR | Publish catalog definitions, and resume or tear down anyone's run, plus everything REQUESTER can |
| AUDITOR | The decision log, the archive and replays, plus everything READER can |
| BATCH | Start batches and use the legacy JSON endpoint, plus everything READER can |
| REQUESTER | Preview, create, answer, confirm and cancel **their own** requests, look after **their own** VMs (renew, resize, power, snapshot, remove), start catalog runs and resume or tear down **their own**, approve **someone else's**, plus everything READER can |
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
