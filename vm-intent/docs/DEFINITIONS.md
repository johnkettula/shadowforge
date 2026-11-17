# Catalog definitions and runs

Last updated 2026-11-17.

Technical operators describe repeatable provisioning jobs in YAML. vm-intent checks each file when
it's published and runs it as a Temporal workflow. There are two kinds of file:

- a **Provisioning definition**: the inputs a job takes and its steps, in order;
- a **Blueprint**: rules a VM must pass before it's built.

Conditions and computed values are written in **CEL**, the Common Expression Language
([cel.dev](https://cel.dev)), the same language Kubernetes and Google Cloud use for policies.

The examples that come with vm-intent are in `backend/src/main/resources/catalog/` and are published
at startup: `web-server`, `monitoring-agent`, and the blueprints `standard-vm` and
`production-guardrails`.

## A provisioning definition

```yaml
kind: Provisioning
name: web-server               # 2-41 lowercase letters, digits and dashes
version: 1                     # raise it each time you publish a change
description: A web server with nginx, the site's files and its settings.
owner: platform-team
classification: C3             # data classification code: how long runs are kept (see AUDIT.md)
blueprint: standard-vm         # every VM it builds must pass these rules
recovery:
  waitDays: 30                 # after a failed step: wait this long for a decision (1-30 days;
                               # or waitHours: 1-720). Default 30 days

inputs:
  app:  { type: string, required: true, description: Short name, used for the VM's name. }
  env:  { type: string, default: dev, allowed: [dev, test, staging, prod] }
  size: { type: string, default: small, allowed: [small, medium, large] }

steps:
  - id: approve
    action: approval.wait
    when: "params.env == 'prod'"           # skipped unless this is true
    with:
      message: "${ 'Production web server for ' + params.app }"

  - id: create
    action: vm.create
    with:
      name: "${ params.app + '-web-' + params.env }"
      provider: aws
      region: us-east
      os: ubuntu
      size: ${ params.size }
      env: ${ params.env }
    attempts: 2                 # tries before the run stops and waits (1-10, default 3)
    timeoutMinutes: 60          # longest one try may take (1-1440, default 30)

  - id: site
    action: files.copy
    with:
      vm: ${ steps.create.specHash }       # a later step reads an earlier one's output
      files: [web]
      to: /srv/www
```

Inputs have a `type` (`string`, `int`, `bool`, `list`), and may be `required`, have a `default`, or
be limited to `allowed` values. A run is refused if an input is missing, of the wrong type, not
allowed, or unknown.

## CEL in definitions

| Where | What it is | Names it can use |
|---|---|---|
| `when:` | a condition; the step runs only when it's true | `params`, `steps`, `run` |
| any value written `${ ... }` | worked out when the step runs | `params`, `steps`, `run` |
| `until:` (check.until) | a condition, without `${ }` | `params`, `steps`, `run`, `probe` |
| blueprint `check:` and `appliesWhen:` | conditions on the VM | `spec`, `params`, `run` |

- `params` are the run's inputs, with defaults filled in.
- `steps.<id>` is what an earlier step produced (for vm.create: `specHash`, `vmId`, `ipAddress`,
  `name`, `provider`, `region`, `vcpu`, `memoryGiB`). A skipped step has `skipped: true` and nothing else.
- `run` has `id`, `definition`, `version`, `requestedBy` and `classification`.

A value that is exactly `${ expr }` keeps its type (`vcpu: ${ params.cores * 2 }` is a number). Text
with `${ }` inside joins the results as text (`/srv/${ params.app }/in`). Quote values that contain
`: ` or start with a special character, as YAML needs.

What CEL can do here:

| | |
|---|---|
| Values | `1` `2.5` `'text'` `true` `null` `[1, 2]` `{'a': 1}` |
| Operators | `!` `-` `*` `/` `%` `+` `<` `<=` `>` `>=` `==` `!=` `in` `&&` `\|\|` `? :` |
| Fields | `spec.env`, `params['size']`, `has(params.size)` |
| Functions | `size()`, `int()`, `double()`, `string()`, `bool()` |
| Text | `startsWith` `endsWith` `contains` `matches` (regular expression) `lowerAscii` `upperAscii` `trim` `split` `join` |
| Lists | `all(x, cond)` `exists(x, cond)` `exists_one(x, cond)` `map(x, expr)` `filter(x, cond)` |

As in CEL, `1 + 1.5` is an error (convert with `double(1)`), and `&&` / `||` ignore an error on one
side if the other side decides (`false && anything` is `false`). Every expression is checked when the
definition is published (syntax, the names it uses, and that `steps.x` is an earlier step), and has
a cost limit when it runs, so none can run away.

This is vm-intent's own implementation of that part of CEL (`backend/.../cel/Cel.java`), because
Google's cel-java couldn't be fetched from this build's network. The syntax and meaning are CEL's,
so expressions stay valid if it's swapped for cel-java later.

## Actions

| Action | Settings (`with:`) | Tear down undoes it by | Running it again |
|---|---|---|---|
| `vm.create` | `provider`, `region`, `os`; optional `name`, `size` or `vcpu` + `memoryGiB`, `osVersion`, `diskGiB`, `diskTier`, `env`, `ttlDays`, `publicIp` | removing the VM | the VM is identified by its spec hash: one already built (or being built) is used, not built again |
| `vm.resize` | `vm`, `vcpu`, `memoryGiB` | resizing back | nothing to do if it already has that size |
| `vm.power` | `vm`, `on` | powering back | nothing to do if it's already on/off |
| `vm.snapshot` | `vm`, `label` | nothing (snapshots are kept) | a snapshot with that label isn't taken twice |
| `tools.stage` | `vm`, `bundle`, `version` | removing the bundle, or putting the earlier version back | skipped if installed at that version; a half install is removed and done again |
| `files.copy` | `vm`, `files` (paths or folders in the file store), `to` | deleting the files it copied (files that were there before are kept) | files already there with the same SHA-256 are skipped; leftover `.part` files are removed |
| `config.apply` | `vm`, `settings` (a map) | putting the old values back | only values that differ are written |
| `check.until` | `vm`, `until`; optional `everySeconds` (5-3600, default 30), `timeoutMinutes` (1-1440, default 30) | nothing (it only looks) | looks again |
| `approval.wait` | `message`; optional `approvers` (a list of names), `timeoutHours` (1-72, default 24) | nothing | waits again |
| `blueprint.deploy` | `blueprint`, `name` (the deployment's name); optional `version` (default: newest released), `inputs` (a map), `timeoutMinutes` (90), `everySeconds` (30) | removing the deployment | a deployment with that name that is running or done is used; a failed one is removed and asked for again |

A `with:` number outside its range is moved to the nearest end when the step runs. A step's own
`attempts` (1-10) or `timeoutMinutes` (1-1440) outside its range is refused when the definition is
published. If nobody answers an `approval.wait` within
`timeoutHours`, or the approval is rejected, the step fails and the run stops in **AWAITING_RECOVERY**
like any failed step (see below).

`blueprint.deploy` requests a VCF Automation 9 blueprint (cloud template) and waits until the deployment is done; its output has `deploymentId`, `resources` and `addresses`. See [VSPHERE.md](VSPHERE.md).

`vm.create` uses the same build workflow as plain-English requests, so the VM gets the same rollback,
the one-way link when its cloud is behind it, and a lifecycle workflow (expiry, renewal, day-2 changes).

**A VM's identity (spec hash).** A VM is identified by its spec hash: the SHA-256 of its spec's
canonical string (keys sorted, no `name` key when there is no name). The hash is computed in one place,
`VmIdentity` (in `spec/`), for every way in (plain English, multi-VM requests, batches, the legacy JSON
API and `vm.create`). Its build workflow ID is `vm-` + hash and its lifecycle workflow ID is
`life-` + hash. Each request also carries an owner, taken on the server from sign-in: the signed-in
name, or `anonymous` when sign-in is off. It is never taken from `userId`, `requestedBy` or anything
else the client sends; those are still only the names recorded in the audit trail. The owner is
part of the identity. With no one signed in (`anonymous`), the hash is the SHA-256 of the spec's
canonical string, as before. A signed-in user's hash also covers their user ID: it is the SHA-256 of
`owner:` + the user ID's length + `:` + the user ID + the canonical string, which no spec on its own
can produce. So duplicates are found within one user: the same spec from the same user is a duplicate,
while another user who asks for the same spec gets a VM of their own, with its own hash and its own
`vm-` build workflow. With sign-in off, everyone is `anonymous`, so the same spec from anyone is a
duplicate, as before. Existing VMs keep their hash: nothing recomputes it, because day-2 calls, the
lifecycle, the inventory check and the VM list all look a VM up by its stored hash.
Until the cloud-side name gets a per-user suffix (part 2 of per-user identity), the cloud name is
still just the spec's name: on a real vSphere route (vCenter 9 or VCF Automation 9), a second user's
VM with the same name as the first user's is refused with `InvalidSpec` by the rule below, so it never
takes over the first user's VM, while the simulated clouds (the default, keyed on the build key) build
both. Each build also gets a build key, which the cloud records on the VM it builds: the spec hash,
or the hash + `-` + the first 8 characters of the build's run ID (`VmIdentity.buildKey`). On a real
cloud route (vSphere with a real vCenter 9 or VCF Automation 9), an existing VM with the requested
name is reused only when its recorded build key has the same spec hash (`VmIdentity.sameBuild`, which
compares `hashOfBuildKey` of both keys): a retry, or a new run of the same spec. Otherwise that build
fails with the non-retryable `InvalidSpec` reason "... was built by vm-intent for another request;
choose another name" (or "... that vm-intent didn't build; choose another name" when vm-intent didn't
build it), and nothing is built or removed. The simulated clouds (the default) don't check names.

`probe` (for `check.until`) has `reachable`, `power`, `vcpu`, `memoryGiB`, `tools` (a list), `files`
(a count) and `config` (a map), for example `probe.reachable && 'nginx' in probe.tools`.

**Simulated systems.** On one PC, the file store (`VMINTENT_FILES_DIR`, `~/.vm-intent/files`) stands
in for MinIO or an SSH file server, and each VM has a folder (`VMINTENT_TARGETS_DIR`) standing in
for its disk. Swapping in real SSH or MinIO means changing `TargetStore` and `CatalogActivitiesImpl`;
the partial-work rules above stay the same.

## A run's states

`GET /api/v2/runs/{runId}` and the web app's Catalog card show the run's state:

| State | Meaning |
|---|---|
| `STARTING` | the workflow has started but hasn't set up its steps yet |
| `RUNNING` | steps are running, one after another |
| `AWAITING_APPROVAL` | an `approval.wait` step is waiting for an answer (the run can also be torn down here) |
| `AWAITING_RECOVERY` | a step failed; the run waits for Resume or Tear down (below) |
| `COMPLETED` | every step is done (the run has ended) |
| `TEARING_DOWN` | the run is undoing its steps, newest first |
| `TORN_DOWN` | everything the run did is undone (the run has ended) |
| `TEARDOWN_INCOMPLETE` | tear down finished but some undo failed; those steps are marked UNDO_FAILED (the run has ended) |

## When a step fails: resume or tear down, never start again

A step that fails (after its `attempts`) doesn't fail the run and isn't retried from the start. The
run stops in **AWAITING_RECOVERY** and waits for a person:

- **Resume** runs the failed step again. Steps before it are not run again. The step copes with its
  own partial work (the table above): a copy that did 3 of 4 files copies only the fourth.
- **Tear down** undoes every step that did something, newest first, including what the failed step
  had already done. The run ends **TORN_DOWN**, or **TEARDOWN_INCOMPLETE** if an undo failed (the
  step is marked UNDO_FAILED for someone to look at).
- **Nobody decides** within `recovery.waitDays` (30 days, the default and the longest): the run tears itself down, and
  the audit trail says "system".

Who may decide: the person who started the run, or an OPERATOR (or ADMIN). An approval can be
answered by anyone except the person who started the run, and only by someone on `approvers` when
the step lists them. Every decision is logged (see [AUDIT.md](AUDIT.md)).

A run's ID comes from the definition, its version and the inputs (`run-web-server-3f2a9c41d07e`).
Sending the same thing again while that run is going, or waiting for a decision, finds the same run
instead of starting a second one. After it has ended, the same inputs may run again.

Each step also keeps a small journal in the VM's folder, keyed by run and step, of what was there
before its first try. That's how Tear down knows which files to remove and which values to put back,
however many tries the step took.

## Blueprints

```yaml
kind: Blueprint
name: standard-vm
version: 1
appliesWhen: "spec.env == 'prod'"   # optional: also applies to every catalog VM where this is true
rules:
  - name: prod-needs-two-cpus
    check: "spec.env != 'prod' || spec.vcpu >= 2"
    message: Production VMs need at least 2 vCPU.
```

A blueprint applies to a definition's VMs when the definition names it, or when its `appliesWhen`
is true. A VM that fails a rule isn't built: the step fails at once (no retries) with every rule it
failed, and the run waits for a decision as usual. `spec` has the VM's fields: `name`, `provider`,
`region`, `vcpu`, `memoryGiB`, `os`, `osVersion`, `diskGiB`, `diskTier`, `env`, `ttlDays`, `publicIp`.

Plain-English requests still use the built-in policy checks; blueprints apply to catalog runs.

## Publishing

A published version never changes. To change a definition, raise `version` and publish again; runs
already going carry on with the version they started with (each run keeps a copy). Publishing the
same version with the same content again does nothing, so a pipeline can publish every file on every
merge. `POST /api/v2/definitions/{kind}/{name}/{version}/retire` stops new runs of a version.

The intended route is Git:

1. Definitions live in a repository, one YAML file each.
2. A change is a merge request. The pipeline checks every file
   (`deploy/catalog/publish.sh --check definitions/*.yaml`, which calls `POST /api/v2/definitions/validate`
   and lists every problem).
3. Reviewers approve the merge request in GitLab; who may approve is set by the repository's approval
   rules. That approval is the approval to publish.
4. On merge, the pipeline publishes (`deploy/catalog/publish.sh definitions/*.yaml`) with a token for
   a service that has the OPERATOR role. See `deploy/catalog/gitlab-ci.example.yml`.

Publishing straight to the API (`POST /api/v2/definitions` with the YAML, as an OPERATOR) works too,
for trying things out.

## API

| | |
|---|---|
| `GET /api/v2/definitions` | definitions and blueprints (newest versions; `?all=true` for every version) |
| `GET /api/v2/definitions/{kind}/{name}` | one, as data and as its YAML |
| `POST /api/v2/definitions/validate` | check YAML without publishing |
| `POST /api/v2/definitions` | publish (OPERATOR) |
| `POST /api/v2/definitions/{kind}/{name}/{version}/retire` | retire a version: stops new runs of it (OPERATOR) |
| `GET /api/v2/classifications` | the classification codes |
| `POST /api/v2/runs` | start a run: `{"definition": "web-server", "params": {"app": "shop"}}` |
| `GET /api/v2/runs`, `GET /api/v2/runs/{id}` | runs, and one run with every step |
| `POST /api/v2/runs/{id}/resume`, `/teardown`, `/approve` | decide |

## Tests

| Test | What it checks |
|---|---|
| `DefinitionParserTest` | the built-in examples are valid, every problem in a file is reported at once, steps may only read earlier steps, blueprint rules are checked as CEL |
| `CelTest` | the CEL engine: operators, fields, text and list functions, macros, clear errors, the cost limit |
| `CatalogRunWorkflowTest` | runs: steps in order, resume after a failed step, tear down newest first, approval, blueprint rules, reusing a run or a VM already built |
| `CatalogControllerTest` | the classifications' JSON shape and their schema in the API description |
