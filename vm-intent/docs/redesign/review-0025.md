# Design review 0025

Written after cycles 21-24:
- AP-0021 (`VmIdentity` and `RequestOwner`, review 0020 #1) was merged in one attempt.
- AP-0022 (daily docs) was merged.
- AP-0023 (baseline histories, all four at once) stopped when the developer agent reached its $3 budget.
- AP-0024 (the same work, split: `HistoryRecorder`, replaying every file, two histories) was merged in one attempt.

The backlog's next work is per-user VM identity, then Azure A2b. So this review asks what still makes those
risky after the groundwork. No code was changed in this stage.

## What happened since review 0020

| Item | State now |
|---|---|
| 0020 #1: `VmIdentity` | Done (AP-0021). Every hash site calls `VmIdentity.hash(spec, owner)` with an owner taken from sign-in. For the hash, the per-user feature now only has to change the non-anonymous branch of `VmIdentity.hash` (`spec/VmIdentity.java:23-27`). |
| 0020 #2: baseline histories | Half done (AP-0024): `intent-v2-multi-existing` and `lifecycle-v1-renewed`, plus the recorder. **Part 2 (a batch shard, and a catalog run with an existing VM) is not built.** The backlog still lists the whole item, so it reads as either open or done. |
| 0020 #3: history-check helper | Still open. There is no `tests/acceptance/lib/`, and 11 files still run `git log --grep`. |
| 0015 #2 and #3, 0010 #2 and #3 | Still open. Four of the five open redesign items need a person to change the pipeline first, so the requirements agent doesn't pick them. 0010 #2 and #3 have waited 15 cycles. |
| AP-0023's lost cycle | It was a size problem, not a design problem. Splitting it worked. Requirements that record histories or run `mvn test` several times should be split from the start. |
| **No AP-0021 acceptance suite** | There is no `tests/acceptance/ap-0021/` folder and no "AP-0021: acceptance tests" commit. So the live checks don't re-check its criteria: that the `specHash` from POST /api/v2/interpret is the canonical SHA-256 computed independently, and that a `userId` in the body doesn't change it. `VmIdentityTest` still pins the hashes in `mvn test`. **A person should look at the cycle 21 report.** I couldn't read it, because it is outside the worktree. |

## Where the design makes change hard or risky

1. **Every real backend treats "a vm-intent VM with this name already exists" as "this is my VM", even when
   it was built for a different identity.**
   - The simulator keys VMs on the idempotency key (`SimCloud.create:56-59`, `ON CONFLICT (idempotency_key)`).
     Two specs with the same name give two VMs.
   - The three real backends key VMs on the name:
     - vCenter: `VcenterBackend.createVm:125-131` finds a tagged VM with the name, records it with
       `journal.found` and returns its ID.
     - VCF Automation: `VcfaBackend.createVm:124-125` returns any deployment with that name. It doesn't check
       the tag or anything else.
     - Azure: `AzureArmBackend.createVm:89-92` returns any VM with that name that has the `managed` tag.
   - Each of them records the build key: in the vCenter VM's description ("Key …", line 151), in the VCF-A
     deployment's description ("key …", line 129) and in Azure's `vm-intent-key` tag (line 94). None of them
     reads the key back when it finds an existing VM.
   - Today this already happens without per-user identity. Take "web-01, small" and then "web-01, large".
     They have different spec hashes, so they are different VMs and get different `vm-` workflows. On a
     real cloud, the second build adopts the first VM. Both registry records then point at one cloud VM, a
     resize of one changes the other, and decommissioning one deletes the other.
   - Per-user identity makes this the normal case: when Bob asks for Alice's "web-01", Bob's build would
     adopt Alice's VM.
   - The cloud-side name suffix (feature part 2) fixes this only for signed-in owners. Anonymous requests
     keep plain names.
   - Staging and live run only the simulator, so no check after the developer can see any of this.
     `VcenterBackendTest.aRetriedCreateDoesNotDeployTwice:81` even adopts with a new key, which is the
     intended case (same VM, a new run). No test covers a different VM with the same name.

2. **The name the cloud sees is still read from the user's spec in many places, so the suffix has no single
   home.**
   - `VmReconcileWorkflowImpl.reconcile` passes `request.spec()` to every cloud call: `plan` (:96),
     `createVm` (:110), the link `CREATE` (:105) and the link undo `deleteByKeyNoWait` (:103).
   - It also passes the same spec to `records.save`, which is what the API and the web app show (:92, 97,
     119, 126).
   - `ReconcileRequest(spec, specHash, requestedBy, requestId)` has no owner. So the build workflow can't
     tell whether a suffix applies.
   - The batch path doesn't carry the owner past `BatchController`. `CatalogRunWorkflowImpl` has
     `req.owner()`, and `IntentWorkflowImpl` has `request.owner()`, but neither passes it to the build.
   - Without one place, part 2 has two options, and both are wrong:
     - edit `spec.name()` in the four backends (review 0020 already advised against this);
     - give the reconcile workflow a renamed spec, which then also shows up in the registry, the API and
       the expiry warnings. The backlog requires the asked-for name to stay visible.

3. **The Azure code is pinned by about 200 checks on its source text, and they run on every live check.**
   - `ap-0014/repo.test.mjs`, `ap-0016/repo.test.mjs` and `ap-0017/repo.test.mjs` hold 59, 70 and 79 regex or
     text assertions on `ArmClient.java` and `AzureArmBackend.java`. Some examples:
     - ap-0016 #1 requires the blocking `put`/`delete` to stay and to call the private `awaitIfAsync(`.
       Review 0015 said activities must not use those methods.
     - ap-0017 #3 requires `createVm`'s body to end in `return vmId(<x>);` and requires the tags to be
       built as `Map.of(TAG, MANAGED, KEY_TAG, <key>)`.
     - ap-0016's test at line 126 runs all of ap-0014 again.
   - The next three Azure items all edit these classes:
     - A2b, which maps a missing VM to `VmNotFound` and switches routes;
     - Part B, day 2;
     - 0015 #2, `RoutedProvider`.
     Proposal 1 below edits them too. Each of these must keep these regexes matching as well as its own
     criteria, or a live check fails after the merge.
   - The behaviour these checks protect is already tested in `ArmClientTest` and `AzureArmBackendTest`
     against `MockArm`. `mvn test` is a gate before staging.
   - Review 0015 described the same pattern for vSphere: "keep `VsphereRoutes.NOT_SET_UP` as an alias
     because ap-0002 greps for it".

## Proposals

Suggested order:
1. Proposal 1, before the per-user identity feature. It is required before part 2 (the name suffix) and
   before Azure A2b.
2. The per-user identity feature, part 1 (the hash).
3. Proposal 2.
4. Part 2 (the suffix), which then changes one method.
5. Proposal 3 can be done at any time before A2b.

AP-0024's part 2 (a batch-shard history and a catalog-run history) should come before proposal 2, because
proposal 2 changes the input records of those workflows.

### 1. Adopt an existing cloud VM only when it was built for the same identity (medium risk; 1 cycle)

- Add `VmIdentity.buildKey(hash, runIdPrefix)` and `VmIdentity.hashOfBuildKey(key)`.
  - The build key is the hash, or the hash plus "-" plus 8 characters of the run ID
    (`VmReconcileWorkflowImpl:81-83`).
  - `hashOfBuildKey` returns the part before the first "-".
  - `VmReconcileWorkflowImpl` uses `buildKey`. The string is unchanged, so histories replay.
- In `VcenterBackend`, `VcfaBackend` and `AzureArmBackend`, when `createVm` finds an existing vm-intent VM
  with the name:
  - read the key it recorded: the vCenter description, the VCF-A deployment description, or the Azure
    `vm-intent-key` tag;
  - adopt the VM only if `hashOfBuildKey` of that key equals `hashOfBuildKey` of the new key;
  - otherwise throw today's non-retryable `InvalidSpec`, with "… already has a VM called 'web-01' that was
    built for another request; choose another name";
  - on vCenter and Azure, where the ownership tag already shows that vm-intent built the VM, still adopt a
    tagged VM that has no readable key, as today. VMs built before keys were recorded keep working.
- VCF-A has no ownership tag, so the key in the deployment's description is its only sign that vm-intent
  built it.
  - With this change, a deployment with that name and no vm-intent key is refused.
  - Today any deployment with the name is adopted. This is a behaviour change, but only on the VCF-A route.
- No new failure type string, no API change, and no workflow change. The simulator already behaves this way.
- Keep the ap-0017 shape pins: `createVm` still ends in `return vmId(name);`, and the tags map is unchanged.
- Tests:
  - one parameterised test over `MockVcenter`, `MockVcfa` and `MockArm`. Same name and same hash with a new
    run key: adopted, nothing new is built. Same name and a different hash: `InvalidSpec`, nothing built,
    nothing deleted;
  - `aRetriedCreateDoesNotDeployTwice` still passes;
  - this test can become the first case of 0015 #3's `ProviderContractTest`.

Acceptance: `mvn test` passes, including the new test and the existing backend tests. Staging and live
behave as before, because they run the simulator.

### 2. One cloud-facing spec in the build workflow, and the owner carried to it. No behaviour change (low risk; 1 cycle; groundwork for the name suffix)

- Add `VmIdentity.cloudName(VmSpec spec, String owner, String hash)`. In this cycle it returns `spec.name()`
  for every owner, just as AP-0021's `hash` did. Part 2 changes only its non-anonymous branch.
- `ReconcileRequest` gets a new last field, `owner`. Old histories don't have it, so it reads as null, which
  means anonymous. The callers fill it in:
  - `IntentWorkflowImpl`, single-VM and multi-VM: `request.owner()`;
  - `CatalogRunWorkflowImpl`: `req.owner()`;
  - the batch path: `BatchController` passes `RequestOwner.current()` through the batch and shard requests,
    each as a new last field.
- `VmReconcileWorkflowImpl.reconcile` builds `cloudSpec = spec.withName(VmIdentity.cloudName(...))` once,
  and uses it for `plan`, `createVm`, the link `CREATE` and `deleteByKeyNoWait`.
  - `records.save`, the audit and `LifecycleRequest` keep `request.spec()`, the name the user asked for.
  - `cloudName` is a pure function of the workflow's recorded input, so it needs no `getVersion`.
  - Temporal doesn't compare activity inputs on replay.
- Tests:
  - a recording fake `ProviderActivities`, with `cloudName` stubbed (by `mockStatic`, as AP-0021's tests
    did) to return "web-01-test". The provider receives "web-01-test", and `GET /api/v2/vms/{hash}` and the
    audit still say "web-01";
  - with the stub off, the provider receives "web-01";
  - a signed-in batch carries its owner to `ReconcileRequest`;
  - `ReplayTest` passes on every history.

Acceptance: `mvn test` passes. The OpenAPI snapshots are unchanged, because `ReconcileRequest` is
internal. The reviewer checks that no cloud call in `VmReconcileWorkflowImpl` uses `request.spec()`.

### 3. Turn the Azure source-text pins into checks of the tests that cover the behaviour (low risk; test-only; 1 cycle)

- In `ap-0014`, `ap-0016` and `ap-0017` `repo.test.mjs`, replace the checks that regex private shapes with a
  check that the unit test covering that behaviour exists and passed. Examples of private shapes:
  `awaitIfAsync(`, the blocking `put`/`delete`, the `Map.of(TAG, MANAGED, KEY_TAG, …)` layout, and the last
  statement of `createVm`.
  - The check reads `backend/target/surefire-reports/TEST-*ArmClientTest.xml` and
    `TEST-*AzureArmBackendTest.xml`.
  - Each named test method must be present, with no failure or error.
- Keep the checks that state contracts:
  - setting names, and the `VMINTENT_AZURE_*` variable names;
  - no secret in a file or a log;
  - the `managed` and `vm-intent-key` tag values;
  - the docs/AZURE.md statements.
- Drop ap-0016 test 126, which runs ap-0014 again.
- Whoever the pipeline lets edit old acceptance files does this, as for 0020 #3. **A person may need to
  allow it.**
- Trade-off: a later change could weaken a unit test without renaming it. The reviewer already checks
  deleted assertions, and ap-0016's "no commit removes an ArmClientTest assertion" can stay as a gate-only
  history check.

Acceptance: every suite still passes against today's code. After the change, `ArmClient`'s private
methods can be renamed without failing any acceptance check, and an `ArmClientTest` method that fails or
goes missing still makes the suite fail.

## Advice for the per-user identity requirement

These are not proposals. They are limits the requirement will run into:
- Signed-in users' existing VMs keep the hash without an owner. After the change, the same user asking for
  the same spec gets a new hash and a second VM. With sign-in off on staging and live, nobody is affected
  today. The requirement should say so, instead of promising "same user = DUPLICATE" across the cutover.
- Generated names (`SpecCanonicalizer.withGeneratedName`, "vm-" + 8 characters of the hash) already differ
  per identity once the hash includes the owner. `cloudName` can leave them unchanged.
- Day-2 permission (`VmController:186-200`) checks the lifecycle's `requestedBy`. With sign-in on, that
  equals `RequestOwner.current()`, because `Caller.nameOr` lets the signed-in name win. Keep it that way.
  Don't change who may act on a VM in this feature: that is a security matter.

## Note on repository content

Nothing in the repository tried to direct this stage. I read the backlog's notes as context only: that
John has turned approvals off, and the order of work. As the backlog asks, I haven't proposed moving
vSphere to SOAP, and nothing here needs docs/SECURITY.md. What I say about cycles 21-24 comes from the
summaries given to this stage, docs/AGENT-REQUIREMENTS.md and git history. The pipeline's cycle reports
are outside the worktree, so I couldn't read them.
