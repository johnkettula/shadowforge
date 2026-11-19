# Design review 0050

Written after cycles 46-49. Each was merged in one attempt, and live passes 68 checks:
- AP-0046 and AP-0048: daily docs.
- AP-0047: review 0040 #3. `spec/VmNames` is now the one VM-name rule.
- AP-0049: per-user identity part 2b. A signed-in user's named VM gets the cloud name
  `<name>-<first 8 hex of its hash>`.

With that, John's per-user identity feature is done (AP-0039, AP-0043, AP-0049). John has turned
approvals off (`agent-pipeline/src/config.ts:69`), so the next items are picked, built and merged with
no person reading the plan first. Those items are Azure A2b and Proxmox, and both touch real clouds.

No code was changed in this stage.

## Where things stand

| Item | State now |
|---|---|
| Per-user identity | **Done.** After the build, every call finds the VM by its stored `vmId` or spec hash, never by its name: lifecycle `resize`/`power`/`snapshot`/`delete` use `vmId()` (`VmLifecycleWorkflowImpl:194,223,254,329`), and catalog guest steps use the hash. So the suffixed cloud name needs no follow-up. |
| 0045 #1: `tests/lib` and freezing ap-0014/0016/0017 | **Not built.** `tests/lib` doesn't exist. `ap-0017/repo.test.mjs:26` still reads the working tree, and `docs/AZURE.md:73` still says "not … used by `AzureProvider` yet". This still blocks A2b. |
| 0045 #2 (inventory provider list) and #3 (`Providers.ALL`) | Not built. Still needed before Proxmox. |
| 0030 #1: fake clouds on staging | Not built. Staging and live still run only the simulator. |
| Azure A2b | Next by the backlog's own words ("after the per-user identity feature"). **Finding 1 shows it is unsafe as planned.** |

## Where the design makes change hard or risky

### 1. Azure A2b as planned would leave real Azure VMs running for ever, and nothing would report it

The backlog's A2b only switches `AzureProvider` between `simulated` and `arm`. Listing, resize, power
and snapshot are left for part B. Here is what that does with today's code:

- `AzureArmBackend` has only `plan`, `createVm`, `describeVm` and `deleteVm` (`:63`, `:81`, `:146`,
  `:167`). A2b would copy the only existing example, `VsphereProvider:52-111`. In that pattern, any
  call the backend doesn't handle falls through to `SimulatedProvider`, which means `SimCloud`.
- **Nightly inventory check:**
  - `azure`'s `listVmIds` would return only the simulator's VMs.
  - `InventoryActivitiesImpl.compare:43-49` marks every running record whose `vmId` isn't in the
    list as `MISSING`, in both the registry and the audit log.
  - `InventoryCheckWorkflowImpl:70` and `:79-84` then signal `markMissing`.
  - So after the first nightly check, **every real Azure VM** is `MISSING`.
- **`MISSING` is terminal and can't be undone:**
  - `VmLifecycleWorkflowImpl:351-352` treats it as an end state, so the loop at `:95` ends.
  - The VM never expires (`expire`, `:307`).
  - Every update calls `requireActive`, so it can't be resized, powered or removed through the API either.
  - The real VM keeps running and costing money.
- **Nothing reports it again:** `VmRegistry.knownVmIds:91-94` counts records in any state, so the VM
  is never an orphan either. After that night, no report mentions it.
- **Day-2 calls give the wrong error:** a resize, power or snapshot of an `arm:` VM goes to `SimCloud`
  and fails with "VM arm:… not found" (`VmNotFound`, `SimCloud:142`) while the VM is running.
- **No check would see any of this:**
  - staging and live run only the simulator;
  - `InventoryCheckTest` uses a fake cloud with no routed backend;
  - with approvals off, no person reads the plan.
- **The same thing can already happen on vSphere.** `VsphereProvider.listVmIds:105-111` lists vCenter
  VMs only while `routes.hasVcenter()`. If someone turns a datacenter's route back to `simulated`, the
  next check marks every `vcenter:` VM `MISSING`.

### 2. Each provider dispatches by hand, and nothing makes a backend complete

- `VsphereProvider` chooses a backend by hand in 8 methods. A2b would copy that, and so would Proxmox
  (review 0045 #3 gives it a `simulated | api` route).
- In each copy, a method nobody wrote quietly falls back to the simulator (finding 1). The compiler
  can't help, because the backends don't share an interface.
- Review 0015 #2 (RoutedProvider) has been open since cycle 15. It was bundled with a
  `CloudFailures` cleanup across 12 files and rated medium, and it was never picked. The part that
  matters now is much smaller.
- One trap for whoever builds it: `ap-0017/repo.test.mjs:84` requires
  `public static boolean owns(String …)` on `AzureArmBackend`, and that suite reads the working tree.
  Java doesn't allow an instance method with the same signature next to that static one, so a shared
  interface must not call its method `owns`.

### 3. The steps that must come before A2b sit under "Done" in the backlog

- The pipeline appends redesign proposals to the end of the backlog (`agent-pipeline/src/activities.ts:529-531`),
  so 0030 #1 and 0045 #1-#3 sit under "Done (don't pick these again)".
- The requirements agent did build 0040's items from there, so it does read that section. But the A2b
  entry names only per-user identity as its prerequisite, and that is now done. Nothing in the entry
  points to 0045 #1.
- With approvals off, the next cycle could build A2b directly. It would then either keep a false
  AZURE.md sentence or fail ap-0017 on live and be reverted, as happened in cycles 26, 29 and 41.

### Smaller observations (no proposal)

- **"Already gone" is decided by message text:** `VmLifecycleWorkflowImpl:332` checks
  `r.contains("not found")`. The failure types also differ between clouds: `HttpJson` and `ArmClient`
  use `"NotFound"`, while `SimCloud` and `CloudOps.CLOUD_RETRY` use `"VmNotFound"`. Today every
  backend's `deleteVm` is idempotent, so nothing breaks yet. A Proxmox backend should do the same, or
  0015 #2's `CloudFailures` part should be done first.
- **The signed-in branch never runs after `mvn test`:** sign-in is off on staging and live, so the
  per-user branch of `VmIdentity.of` is covered only by `RequestOwnerFlowTest`. Changing that is a
  security setting, so it is for a person (see below).

## Proposals

Suggested order:
1. Proposal 2 (inventory guard). It protects against any future listing gap, so it goes first.
2. Proposal 1.
3. Proposal 3.
4. 0045 #1.
5. Azure A2b, as described in "Advice for A2b" below.
6. 0045 #2 and #3, then Proxmox.

Proposals 1 and 2 don't depend on each other.

### 1. A `CloudBackend` interface and a `RoutedProvider` base class; `VsphereProvider` moves onto it with no behaviour change (low risk; 1 cycle)

This is the dispatch half of 0015 #2. Its `CloudFailures` half stays open.

- **`provider/CloudBackend`:**
  - methods: `boolean handles(String vmId)`, `plan`, `createVm(spec, plan, key)`, `describeVm`,
    `deleteVm`, `resizeVm`, `setPower`, `snapshotVm` and `listVmIds`;
  - no default methods, so a backend that can't do something has to say so in code;
  - the method is named `handles`, not `owns`, because of finding 2. The static `owns` methods stay
    as they are.
- **`provider/RoutedProvider extends SimulatedProvider`:**
  - a build goes to `backendForBuild(spec)`, which returns `null` for the simulator;
  - later calls go to the backend whose `handles(vmId)` is true. If that backend isn't set up, the
    call fails as today (`VsphereRoutes.NOT_SET_UP`);
  - **an ID a backend handles never reaches `SimCloud`;**
  - `listVmIds` returns the simulator's VMs plus those of every backend that is set up.
- **`VcenterBackend` and `VcfaBackend` implement `CloudBackend`.** They already have every method. A
  one-line adapter covers `createVm`'s different parameters.
- **`VsphereProvider`** keeps only `providerName`, `idPrefix` and the route lookup.
- **Tests:**
  - `VsphereRoutesWorkflowTest`, `VcenterBackendTest` and `VcfaBackendTest` are unchanged and pass;
  - a new `RoutedProviderTest` with a recording fake backend shows that:
    - a build follows the route;
    - a resize of a handled ID reaches the backend, not `SimCloud`;
    - the listing merges both sources.
- No workflow, activity-interface or OpenAPI change, so histories replay.
- **Acceptance:**
  - `RoutedProviderTest` methods exist and are active in the test sources;
  - the AP's commits change no file under `backend/src/test/java/**/provider/vsphere/`;
  - all suites pass.

### 2. An incomplete listing never ends lifecycles, and VMs that come back are reported (low risk; 1 cycle)

Both changes are in `InventoryActivitiesImpl.compare`, which runs as an activity. The workflow
doesn't change, so no `getVersion` is needed, and old runs replay with their recorded results.

- **Mass-missing guard:**
  - Applies when a listing would mark more than 2 VMs **and** more than half of a provider's running
    records missing.
  - Then nothing is marked. The finding's `missing` list is empty, so the workflow signals no
    lifecycle.
  - Its `note` says: "Not marked missing: the listing left out N of M running VMs; check the
    provider's route settings".
  - Each of those VMs gets an audit event, so people can see which ones.
- **VMs that come back:**
  - A record that is `MISSING` but whose `vmId` is listed again goes into the note ("listed again: …")
    and gets an audit event.
  - The record and its lifecycle are not changed automatically.
  - `knownVmIds` doesn't change. Its "never an orphan" rule is deliberate (`VmRegistry:90`).
- **Tests:**
  - `InventoryCheckTest` is unchanged: 1 of 2 missing is still marked;
  - new: 3 of 4 missing → none marked, the note says so, and the lifecycles stay `ACTIVE`;
  - a `MISSING` VM that is listed again appears in the note.
- `InventoryFinding` doesn't change, so there is no OpenAPI change.
- The behaviour changes only in those two cases. This covers A2b, a vCenter route turned off,
  Proxmox, and any future listing bug.

### 3. `AzureArmBackend` becomes a complete `CloudBackend` before anything routes to it (low risk; 1 cycle; after proposal 1)

- **Listing:** `AzureArmBackend implements CloudBackend`. Its `listVmIds` GETs the resource group's
  `Microsoft.Compute/virtualMachines`, follows `nextLink`, keeps only VMs tagged
  `vm-intent=managed`, and returns the same `arm:` IDs that `describeVm` accepts.
- **Day-2 calls are refused clearly:** `resizeVm`, `setPower` and `snapshotVm` throw a non-retryable
  `NotSupported` failure: "Not available on Azure yet (Azure part B)".
- **`MockArm`** answers a collection GET with `value` and `nextLink`. A test uses a small page size so
  `nextLink` is exercised, and includes an untagged VM that must not be listed.
- **Keep ap-0017's pins:**
  - the public `plan`/`createVm`/`describeVm`/`deleteVm` signatures and the static `owns` stay
    (adding `@Override` is fine);
  - don't touch `IMAGES` or AZURE.md's "not used by `AzureProvider` yet" sentence, which stays true.
  - So this proposal doesn't need 0045 #1 first.
- **Backlog change:** listing moves from part B into part A, because without it A2b is unsafe.
  Part B keeps resize, power and snapshot.
- **Acceptance:**
  - `AzureArmBackendTest` has active tests for: only tagged VMs listed, paging, and `NotSupported`
    for the three day-2 calls;
  - no main file outside `provider/azure/` changes.

### Advice for A2b (after proposals 1-3 and 0045 #1)

- **Code:** `AzureProvider extends RoutedProvider`, with `vmintent.azure.route: simulated | arm`
  (default `simulated`).
- **Required test:** with the route set to `arm` on `MockArm`, an inventory check marks nothing
  missing, and a resize gives `NotSupported`, not `VmNotFound`.
- **Changes to older suites:** state them as the tester's job (memory of AP-0044), for example a
  rewritten AZURE.md sentence that ap-0017 reads.
- **Keep from review 0015:** no blocking `put`/`delete` inside an activity.

## For a person

- **Backlog:** move 0030 #1, 0045 #1-#3 and these proposals out of "Done". Add "after 0045 #1 and
  review 0050 #1-#3" to the A2b entry. With approvals off, the backlog text is the only gate.
- **Signed-in checks:** consider whether staging should run one signed-in client, for example through
  the PKI route `tests/pki_test.py` already uses. Then the per-user branch would be checked after
  merge too. It is a security setting, so agents can't make it.
- **Proxmox criterion:** the Proxmox item's "`GET /api/v2/vms` returns the VMs on the Proxmox node"
  criterion still needs the change described in 0045 #3.

## Note on repository content

Nothing in the repository tried to direct this stage. I read the backlog, the earlier reviews, the
pipeline's `config.ts` and `activities.ts`, and the acceptance suites as information only. Nothing
proposed here touches `docs/SECURITY.md`, `security/` or sign-in.
