# The one-way link to domain 3

Last updated 2026-11-13.

vm-intent runs in **domain 2**. The VMs live in **domain 3** (AWS, Azure, Google Cloud, vSphere).
Between them is a one-way link, with a separate one-way return link in the opposite direction. Domain 2 can't
call a cloud in domain 3 directly, so for those clouds it sends **orders as files** and gets **answers
back as files**.

```
domain 2 (vm-intent)                                   domain 3
  build workflow ──writes──> outbox/ ──one-way link──> link agent ──> cloud API
        ▲                                                   │
        └─signal── ReturnLinkListener <── inbox/ <──return link── answer file
```

## Turning it on

| Setting (environment variable) | Meaning | Default |
|---|---|---|
| `VMINTENT_LINK_PROVIDERS` | Clouds reached over the link: `aws,azure`, or `*` for all | empty = all direct |
| `VMINTENT_LINK_OUTBOX` | Where order files are written | `~/.vm-intent/link/outbox` |
| `VMINTENT_LINK_INBOX` | Where the return link drops answer files | `~/.vm-intent/link/inbox` |
| `VMINTENT_LINK_REPLY_TIMEOUT` | Minutes a build waits for an answer before giving up and undoing | 120 |
| `VMINTENT_LINK_SIMULATE` | `true` = answer the orders here, as a pretend domain 3 | false |

To try it on one PC, set `VMINTENT_LINK_PROVIDERS=gcp` and `VMINTENT_LINK_SIMULATE=true` before
`2-start-backend.cmd` (for example in `ai-settings.cmd`, which those scripts already run), then
request a VM on Google Cloud. In the simulation, a VM whose name contains "fail" is refused.

Every process that runs workers must see the same outbox and inbox folders.

## What goes over the link

**Orders** (outbox, one file per order, named `<orderId>.json`). Each file is written under a
temporary name first and renamed when complete, so the link never carries half a file.

```json
{
  "orderId": "create-6f1c2b9e-...",
  "type": "CREATE",
  "replyTo": "vm-3af19a4e...",
  "provider": "gcp",
  "idempotencyKey": "3af19a4e...-1a2b3c4d",
  "specHash": "3af19a4e...",
  "spec": { "name": "web-01", "provider": "gcp", "region": "us-central", "vcpu": 2, "memoryGiB": 4, "...": "..." },
  "plan": { "nativeRegion": "us-central1", "nativeSize": "e2-medium", "nativeImage": "...", "summary": "..." },
  "vmId": null,
  "params": {},
  "requestedBy": "jdoe",
  "sentAt": "2026-10-23T02:21:01Z"
}
```

| type | Uses | Domain 3 should |
|---|---|---|
| `CREATE` | `spec`, `plan`, `idempotencyKey` | Build the VM. The same `idempotencyKey` must never build a second one |
| `DELETE` | `vmId`, or only `idempotencyKey` | Remove the VM. Without a `vmId`, remove whatever was built for that key (used to undo a build whose answer never came) |
| `RESIZE` | `vmId`, `params.vcpu`, `params.memoryGiB` | Change the size |
| `POWER` | `vmId`, `params.on` (`"true"` / `"false"`) | Power on or off |
| `SNAPSHOT` | `vmId`, `params.label` | Take a snapshot; put its ID in `detail` |

The `spec` in a CREATE order carries the VM's cloud-side name (`ReconcileRequest.cloudName`). A
signed-in user's named VM is called `<name>-<8 hex characters of its spec hash>` in the cloud, while the
API and the web app show the name asked for; with sign-in off, or for a generated `vm-<hash8>` name,
the cloud name is the spec's name. The VM record and the audit trail keep the name asked for. The
simulated domain 3 refuses a CREATE whose spec name contains "fail".

**Answers** (inbox, one file per answer, any name ending in `.json`). Copy `orderId`, `type`,
`replyTo`, `idempotencyKey` and `specHash` from the order:

```json
{
  "orderId": "create-6f1c2b9e-...",
  "type": "CREATE",
  "replyTo": "vm-3af19a4e...",
  "idempotencyKey": "3af19a4e...-1a2b3c4d",
  "specHash": "3af19a4e...",
  "ok": true,
  "vmId": "projects/p/zones/us-central1-a/instances/web-01",
  "ipAddress": "10.20.0.17",
  "detail": "built"
}
```

`ok: false` with a reason in `detail` means domain 3 refused or failed. The build rolls back and the
request shows the reason.

An answer goes to the workflow named in its `replyTo`. If `replyTo` is missing or blank, it goes to
`vm-<specHash>` for a CREATE answer and to `life-<specHash>` for any other type (`ReplyFile.workflowId()`).

## What happens to each answer file

The listener checks the inbox every 2 seconds and moves each file to a subfolder:

| Folder | Why |
|---|---|
| `inbox/processing/` | Being handled right now (stops two copies of the app handling the same file) |
| `inbox/done/` | Handed to its workflow |
| `inbox/unmatched/` | No workflow is waiting for it, for example a build that already gave up. Still written to the audit trail as `LINK_REPLY_UNMATCHED` |
| `inbox/bad/` | Not a readable answer |

Every answer is also an audit event (`LINK_REPLY`), so a late answer is never lost: if a build gave
up and then domain 3 reports it built the VM after all, the trail shows it, and the undo order
(DELETE by key) has already been sent.

## What changes when a cloud is behind the link

- The provider names (instance size, region, image) are worked out in domain 2 and sent with the order.
- The nightly inventory check skips that cloud. Domain 3 would need to run its own check and send the result back.
- Day-2 changes (resize, power, snapshot, remove) go over the link too, and wait for their answers.

## Tests

| Test | What it checks |
|---|---|
| `OneWayLinkTest` | a VM is built and changed through domain 3; no answer in time rolls back by key; a refusal from domain 3 rolls back; other clouds are still called directly |
| `LinkFilesTest` | an order file goes out and its answer comes back through the folders; a stray answer is set aside in `unmatched/` and audited, an unreadable one goes to `bad/` |
| `ReplyFileTest` | copying an answer's fields, and choosing the waiting workflow (`replyTo`, or `vm-`/`life-` + spec hash when `replyTo` is missing or blank) |
