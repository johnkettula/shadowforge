# Design review 0020

Written after cycles 16-19:
- AP-0016 (ArmClient fits the activity time limits) and AP-0017 (AzureArmBackend) were merged. AP-0017 took
  3 attempts.
- Cycle 18 (daily docs) was abandoned because the developer couldn't delete a scratch file. A person fixed
  the pipeline (`6e936ad`) and made the doc edits by hand (`301014f`).
- Cycle 19 (AP-0019, per-user VM identity) built and tested fine, but one criterion needed the protected
  docs/SECURITY.md, so it could never pass (pipeline fix `2530e3e`).

The backlog's next work is the per-user identity retry, then Azure A2b. So this review looks at how a VM's
identity is built, and at the kind of failure that cost cycles 17-19. No code was changed in this stage.

## What happened since review 0015

| Item | State now |
|---|---|
| 0015 #1: ArmClient fits the activity contract | Done (AP-0016). AP-0017 uses `begin`/`operation`/`get` only. |
| 0015 #2: `CloudBackend` / `RoutedProvider` / `CloudFailures` | Still open. `AzureArmBackend` is a fourth backend that reads `spec.name()` and has its own static `owns`. A2b will add a second hand-written route switch, in `AzureProvider`. |
| 0015 #3: `ProviderContractTest` | Still open. |
| 0010 #1: replay histories cheap to add | Still open. `histories/**` is still `appendOnly` and not `generated` (`agent-pipeline/src/config.ts:65-66`). There are still only the seven `*-v1-*` files. None covers a multi-VM request (`buildMany`), batch shards, the lifecycle workflow, or the AP-0011 updates. `ReplayTest` names each file in its own method (`ReplayTest.java:29-62`), so a new file does nothing until someone also adds a method for it. |
| 0010 #2 and #3 (one contract run per check; repository tier) | Still open. There are still 6 `contract_run` copies, so the contract test runs 7 times per check. |
| Lost attempts in cycles 17-19 | All three had one cause: a check that nothing the developer could change would make pass. Cycle 17 attempt 3 failed on the tester's own commit (item 3 below). Cycle 18 needed a file deleted. Cycle 19 needed a protected file. The pipeline now handles the last two. |

## Where the design makes change hard or risky

1. **A VM's identity is built in about 20 places, and per-user identity has to change all of them the same
   way.**
   - The hash is computed in 4 places:
     - `IntentInterpreter.fromDraft:47`, inside the `interpret` activity;
     - `WorkflowActivitiesImpl.expand:55`, for each VM of a multi-VM request;
     - `BatchController:151`;
     - `CatalogActivitiesImpl:175`.
   - Workflow IDs are put together by hand:
     - `"vm-" + hash` in 5 places: `RequestController:296`, `IntentWorkflowImpl:128,251`,
       `BatchShardWorkflowImpl:82` and `CatalogRunWorkflowImpl:241`;
     - `"life-" + hash` in 3 places: `VmController:214`, `CatalogActivitiesImpl:628` and
       `VmLifecycleWorkflowImpl:46`.
     - (`SpecCanonicalizer.withGeneratedName`'s `"vm-"` is a VM-name prefix, not a workflow ID.)
   - The name sent to the cloud is read from `spec.name()` separately in each backend: `SimulatedProvider:42`,
     `VcenterBackend:120-150`, `VcfaBackend:124-128` and `AzureArmBackend:88`. A per-user name suffix would
     have to be added four times. A2b, AWS and GCP would each need it again.
   - The two activities that compute hashes don't know who is asking: `interpret(String text)` and
     `expand(Interpretation)`. The obvious workaround is to mix the user into the hash in workflow code. That
     changes the child workflow IDs when open runs replay (`intent-v1-open` is a run waiting for
     confirmation), unless it is behind `getVersion`.
   - No test pins today's hash value. "Existing VMs keep their hash" is a backlog requirement, but only
     indirect tests check it.

2. **"Who is asking" means three different things, and with sign-in off the client chooses it.**
   - The name that reaches the workflows comes from different places:
     - `Caller.nameOr(body.userId(), "demo-user")` (`RequestController:107`);
     - `body.requestedBy()` or `"batch-api"` (`BatchController:112`);
     - `"legacy-api"` (`RequestController:305`);
     - a claimed name in `CatalogController:457`.
   - It travels as `IntentRequest.userId`, `BatchRequest.requestedBy` and `ReconcileRequest.requestedBy`.
   - That is fine for audit labels, but wrong for identity. The backlog says the owner must come from the
     server's own view of who is signed in, with a fixed "anonymous" when sign-in is off. A developer who
     uses `request.userId()`, the field already at hand in `IntentWorkflowImpl`, gets two failures:
     - with sign-in off, two clients that send different `userId`s get two VMs;
     - the same spec sent through the API and through a batch gets two different identities.
   - The one helper that answers correctly, `Caller.signedIn()`, lives in `security/Caller.java`, which is
     protected. So any new helper has to go outside `security/`.

3. **Acceptance checks that scan git history can fail in a way no code change can fix.**
   - 12 acceptance test files, in 9 of the 11 suites (ap-0004 to ap-0017), run `git log --grep=^AP-00NN:`.
     Most requirements since AP-0003 have "No commit for this requirement…" criteria.
   - That grep also matches the pipeline's own commits ("AP-0017: acceptance tests (attempt 2)", "…record
     the requirement").
   - In cycle 17, the check "no AP-0017 commit adds a secret" failed on `061e1a6`, the tester's own commit,
     because the test file contains the patterns it searches for. The developer could only reply "no code
     change this round". The tester fixed the scan in attempt 3 (`74e0d85`).
   - 11 files each define their own `git()` helper and their own commit filter, so the next suite can make
     the same mistake.
   - These checks also run on every live check. They describe how a change was made, not how the live
     system behaves. Running them again after the merge proves nothing.

## Proposals

Suggested order:
1. Proposal 2 (baseline histories).
2. Proposal 1 (VmIdentity), as part 1 of the per-user identity feature.
3. The feature itself, which then mostly changes one method.

Proposal 3 can be done at any time. A person does its pipeline part.

### 1. `VmIdentity`: one place for a VM's identity hash, its workflow IDs and its owner. No behaviour change (low risk; 1 cycle; build it as part 1 of per-user identity)

- Add `spec/VmIdentity` with:
  - `hash(VmSpec spec, String owner)`. For a null or `"anonymous"` owner it returns exactly today's
    `SpecCanonicalizer.hash(spec)`. In this cycle it returns the same value for every owner. The feature
    cycle then changes only the non-anonymous branch.
  - `buildWorkflowId(hash)`, which returns `"vm-" + hash`.
  - `lifecycleWorkflowId(hash)`, which returns `"life-" + hash`.
- Use these in the 4 hash call sites and the 8 places that build workflow IDs. No string changes value, so
  every history replays.
- Add `api/RequestOwner.current()` (outside the protected `security/`). It returns `Caller.signedIn()`, or
  `"anonymous"` when nobody is signed in, and never uses a name the client sent. The owner is captured in the
  controllers and passed on:
  - `IntentRequest` gets a new last field, `owner`. Old histories have no such field, so it reads as null,
    which means anonymous.
  - `interpret` and `expand` take the owner as an argument. The activity names stay the same; on replay,
    Temporal matches activities by name, not by their inputs.
  - `BatchController` and the legacy path use the owner directly.
  - The catalog run request carries it to `CatalogActivitiesImpl.prepare`.
  - `userId` and `requestedBy` stay as they are, as audit labels.
- Tests:
  - A `VmIdentityTest` pins the hex hash of two fixed specs (one named, one unnamed), computed with today's
    code. These golden values protect "existing VMs keep their hash" in every later cycle.
  - A test with a recording fake shows that each hash site receives `"anonymous"` when sign-in is off, even
    when the body has a `userId`, and the signed-in name when a `SecurityContext` is set.
  - `ReplayTest` passes unchanged.

Acceptance: `mvn test` passes, including `ReplayTest` and the new tests. The contract test and all older
acceptance suites pass on staging. The same request on staging gives the same `specHash` as before the
change. The reviewer checks that no other place in the main code builds a `vm-` or `life-` workflow ID.
That is a review item, not a regex in an acceptance test.

### 2. Record baseline histories of the paths that identity touches, before identity changes (low risk, test-only; 1 cycle; a person goes first)

- Person, first: add `histories/**` to `generated` in `agent-pipeline/src/config.ts`. It stays `appendOnly`.
  Without this, four histories of 450 to 3,000 lines each break the 800-line limit. This is backlog item
  0010 #1, and it is still not done.
- Developer:
  - Add the test-only `HistoryRecorder` from 0010 #1 (`-Dhistories.record=true` writes missing files only).
  - Record 4 histories with today's code: a multi-VM request where one VM already exists, a batch shard, a
    catalog run with an existing VM, and a lifecycle workflow with a renew update.
  - Make `ReplayTest` replay every file under `histories/`. It picks the workflow class from the file-name
    prefix (`intent-`, `reconcile-`, `catalog-`, `batch-`, `life-`), so adding a history no longer needs
    code.
- Why first: the per-user identity criterion "recorded histories still replay" today covers none of the
  paths that it changes (`buildMany`, batch shards, catalog builds, lifecycle IDs). Histories written before
  the change are the only ones that can catch a child workflow ID that changed on replay.

Acceptance: `ReplayTest` reports at least 11 replayed histories, all passing. A test shows that a file
with an unknown prefix fails the test instead of being skipped. No main code changes.

### 3. One helper for "this requirement's commits", and history checks only at the gate (low risk; test-only, plus a small pipeline edit by a person)

- Add `tests/acceptance/lib/history.mjs` with two functions:
  - `requirementCommits('AP-NNNN')`: the `--no-merges --grep=^AP-NNNN:` commits, minus the pipeline's own
    (subjects ending in "acceptance tests (attempt N)" or "record the requirement").
  - `addedLines(sha)`: the lines a commit adds, leaving out `tests/acceptance/**`.
- Switch the 12 test files to the helper and keep their assertions. Whoever the pipeline lets edit old
  acceptance files does this: the tester, or the developer if `writableBy` allows it.
- Person, in the pipeline:
  - The tester prompt says history checks must use this helper.
  - History checks go in a separate `*.history.test.mjs` file per requirement. They run at the gate
    before merge, and are skipped on staging and live checks.
- With `2530e3e` (protected files) and `6e936ad` (single-file deletes), this covers the three known ways a
  check could be impossible for the developer to pass.

Acceptance: every existing suite still passes. A check of `requirementCommits('AP-0017')` returns the
developer's commits `8dda572` and `da8d3f1` and not `061e1a6`, `74e0d85` or `28d021e`. A live check no
longer runs the history-scanning checks.

## Advice for the per-user identity requirement

These are not proposals. They are limits the requirement will run into:
- Take the owner from the server (`Caller.signedIn()`, or "anonymous"). Don't use `request.userId()` or
  `requestedBy`, because the client sets those when sign-in is off (item 2). Don't add the helper under
  `security/`, which is protected. Don't write a criterion that needs docs/SECURITY.md.
- Compute the identity in controllers or activities, not in workflow code. If it must be in workflow code,
  put it behind `Workflow.getVersion`. Open runs such as `intent-v1-open` must still build with the hash
  their history already holds.
- Choose the cloud-side name once, and carry it with the build: for example a `cloudName` field on
  `BatchItem`/`ReconcileRequest`, where null means `spec.name()`. Then the reconcile workflow hands the
  backends a spec with that name. Don't add the suffix in four backends.
  - VM IDs already contain the cloud name (vCenter `Ref(region, name)`, Azure `arm:<rg>:<name>`), so
    day-2 calls follow on their own.
  - Today `VcenterBackend:126-129` refuses (`InvalidSpec`) a same-named VM it didn't build. Two users who
    ask for the same name hit exactly that.
- Confirm compares the client's `specHash` with the interpretation's (`IntentWorkflowImpl:156`). The client
  reads the hash from GET, so it still matches. Keep the API field name `specHash`. DEFINITIONS.md should
  say that it is now the identity hash (the spec, plus the owner when there is one).

## Note on repository content

Nothing in the repository tried to direct this stage. The backlog's notes ("John has turned approvals off",
the order of work) are for the requirements agent, and I read them as context only. As the backlog asks, I
haven't proposed moving vSphere to the SOAP API, and nothing here needs docs/SECURITY.md to change. I
couldn't read the pipeline's cycle reports, which are outside the worktree. What I say about cycles 16-19
comes from the summaries given to this stage, from docs/AGENT-REQUIREMENTS.md, and from git history.
