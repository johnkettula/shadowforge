# Design review 0035

Written after cycles 31-34:
- AP-0031 (daily docs) was merged in one attempt.
- AP-0032 (review 0030 #3: a real cloud adopts a same-named VM only when it was built for the same spec
  hash) was merged in one attempt. It is the AP-0029 retry, with checks that read test sources at their
  own commit and never `target/`.
- AP-0033 (review 0025 #2: one cloud-facing spec in the build workflow) never started building. The
  developer run stopped on "Credit balance is too low", which isn't a design problem.
- AP-0034 (daily docs for AP-0032) was merged.

There have been no reverts since 52dd638. The suites written since AP-0022 read the files they check
at their own requirement's commit (`at(sha, rel)`), so later changes can't break them. That pattern
works. No code was changed in this stage.

## Where things stand

| Item | State now |
|---|---|
| 0025 #1 / 0030 #3: adopt only the same build | **Done** (AP-0032). |
| 0025 #2: cloud name in the build workflow | **Not built** (AP-0033 ran out of credit). Proposal 1 below changes its plan. |
| 0030 #1: fake clouds on staging | Open. Still listed under the backlog's "Done" heading. |
| 0030 #2 / 0025 #3: shared acceptance library; Azure pins | Open. Still under "Done". Proposal 3 replaces both with a smaller step. |
| 0020 #3, 0015 #2/#3, 0010 #2/#3 | Still open. |

**For a person:** the redesign stage still appends to the end of the backlog, which is the "Done"
section (review 0030 explains this). The 0030 items, and this review's items, need moving to an open
section.

## Where the design makes change hard or risky

1. **AP-0033's plan computes the cloud name inside workflow code, and part 2 is meant to change
   that function.**
   - 0025 #2 has `VmReconcileWorkflowImpl` call `VmIdentity.cloudName(spec, owner, hash)`. It says no
     `getVersion` is needed because "`cloudName` is a pure function of the workflow's recorded input"
     (review-0025.md:142).
   - That only holds while the function stays the same. Per-user identity part 2 exists to change it,
     so it would return `web-01-7f3a` instead of `web-01`.
   - Take a signed-in build that is still running when part 2 is deployed (for example one waiting on
     the one-way link, `Route.replyTimeoutMinutes`). It replays with the new name. Its `createVm` or
     link `CREATE` already went out under the old name, but a later rollback,
     `deleteByKeyNoWait(cloudSpec)`, uses the new one.
   - Temporal doesn't compare activity inputs on replay (review-0025.md:143 relies on that), so nothing
     reports this. It is silently wrong.
   - The hash doesn't have this problem. All four places that compute it hand the result over as a
     recorded value: the `interpret` and `expand` activities (`Interpretation`, `BatchItem`),
     `CatalogActivitiesImpl.prepareVm` (`PreparedVm`) and `BatchController` (`BatchRequest`). Workflows
     only copy it. The cloud name should follow the same rule.
2. **Nothing after `mvn test` can see per-user identity, and nothing in the replay tests is signed in.**
   - `vmintent.security.mode` defaults to `none` (application.yml:203), and staging and live run that
     way. So every request there is `anonymous`, and both parts of per-user identity are invisible
     through the API.
   - All 11 recorded histories were recorded with no owner. The recording tests (`RecordedHistoriesTest`
     and `HistoryRecorderTest`) use the 4-argument `IntentRequest`, and `ShardRequest` has no owner at
     all.
   - So "the recorded histories still replay" (a backlog criterion) only proves the anonymous branch,
     which is the one branch that must not change. Suppose part 2 adds an owner-dependent step to a
     workflow without `getVersion`, such as a new activity. No history would catch it.
   - A sign-in mode on staging (for example `pki` with two test certificates) would make this visible.
     That is a security setting under protected paths, so a person would have to decide it. I don't
     propose it here.
3. **Three old Azure suites still read HEAD, and Azure A2b has to make one of their sentences false.**
   - `ap-0017/repo.test.mjs:362-363` reads docs/AZURE.md from the working tree. It requires the doc to
     say AzureArmBackend is "not … used by AzureProvider" and that "A2b … vmintent.azure.route" will
     connect it. A2b is exactly the change that connects it.
   - The same file reads main source at HEAD too. For example, `:365` regexes
     `Map<String, Image> IMAGES = Map.of(`. `ap-0014` and `ap-0016` do the same (review 0025 #3 counted
     about 200 such checks).
   - These run on every live check. So A2b either keeps a false sentence in AZURE.md or fails after the
     merge and is reverted. Cycles 26 and 29 were lost that way.
   - The newer suites don't have this problem, because they read at their own commit.
4. **Every suite brings its own helpers again.**
   - `git`, `at`, `must`, `changed`, `section` and `flat` are written anew in ap-0024, 0027, 0031, 0032
     and 0034.
   - ap-0032 already contains the brace-aware Java test-method reader that 0030 #2 asked for:
     `blankNonCode`, `methods` and `isActive` at `ap-0032/repo.test.mjs:75-112`. It also has its own
     protected-path list (`:31-35`).
   - Since dcbbe7a, the tester runs on Sonnet and each agent run is capped at $3. Each new suite is
     300-450 lines, and most of that is re-derived plumbing that can carry its own bugs. The AP-0029
     splitter was one example.
   - 0030 #2 hasn't been picked, probably because it also rewrites old suites and needs a person's
     permission. A smaller first step needs neither (proposal 3).

## Proposals

Suggested order:
- proposal 1, in place of the unbuilt AP-0033 / 0025 #2;
- proposal 2;
- per-user identity part 1 (the hash) and part 2 (filling in the cloud name);
- proposal 3, at any time before Azure A2b.

### 1. Carry the cloud name as a recorded value; workflows never derive identity (low risk; 1 cycle; replaces 0025 #2 / AP-0033)

- `ReconcileRequest` gets a new last field, `cloudName`. Null, which is what old histories read as,
  means `spec.name()`.
- `VmReconcileWorkflowImpl` builds one private `cloudSpec()`. `plan`, `createVm`, the link `CREATE` and
  `deleteByKeyNoWait` use it. `records.save`, the audit and `LifecycleRequest` keep `request.spec()`, so
  the API and web app still show the name that was asked for.
- All five places that construct `ReconcileRequest` pass `null` for now. Those are
  `RequestController:310`, `IntentWorkflowImpl:133` and `:256`, `BatchShardWorkflowImpl:91` and
  `CatalogRunWorkflowImpl:247`. Nothing changes value, so `ReplayTest` passes unchanged.
- There is no `VmIdentity.cloudName(spec, owner, hash)` called from workflow code. `ReconcileRequest`,
  `BatchRequest` and `ShardRequest` get no `owner` field. This is smaller than 0025 #2.
- Part 2 later computes the cloud name next to the hash, in the places that already produce a recorded
  hash: `IntentInterpreter.fromDraft` → `Interpretation`, `expand` → `BatchItem`, `prepareVm` →
  `PreparedVm`, and `BatchController` → `BatchItem`. Each of these gets `cloudName` beside `specHash`.
  - The workflows copy it into `ReconcileRequest`.
  - A build that is still running at the deploy keeps the name it started with.
  - If `Interpretation` appears in docs/openapi.json, part 2 regenerates the snapshot with
    `-Dopenapi.write=true`. That is acceptable: a preview then shows the cloud name.
- Tests:
  - a `VmReconcileWorkflow` test on `TestWorkflowEnvironment` with a recording fake provider:
    `cloudName = "web-01-test"` reaches `plan` and `createVm`, while `GET /api/v2/vms/{hash}` (or the
    saved record) and the audit say `web-01`;
  - with `cloudName = null`, the provider receives `web-01`;
  - a rollback after a failed build deletes by the cloud spec.
- No `mockStatic` is needed.
- Acceptance:
  - `mvn test` and the replays pass;
  - no cloud call in `VmReconcileWorkflowImpl` takes `request.spec()`;
  - no file under `workflow/` calls `VmIdentity.hash` (checked in the source at this requirement's
    commit);
  - the OpenAPI snapshots are unchanged.

### 2. Signed-in baseline histories before the identity changes (low risk; test-only; 1 cycle)

- With `HistoryRecorder` (`-Dhistories.record=true`, which writes only missing files), record:
  - `intent-v2-signed-in.json`: a single-VM request with `IntentRequest.owner = "alice@example.com"`;
  - `catalog-v3-signed-in.json`: a catalog run with `CatalogRunRequest.owner` set.
- Record them with today's code, where the owner doesn't change anything yet. `ReplayTest` already
  picks the class by prefix, so it replays them with no change to the test.
- If proposal 1 is built first, also record `batchshard-v2-cloud-name.json`. Its `ShardRequest` items
  carry a `cloudName` different from the spec name, which pins that a shard copies the value and
  doesn't derive it.
- History files are `generated` and `appendOnly`, so they don't count toward the line limit. The
  recording methods go in `RecordedHistoriesTest`, next to the existing ones.
- Why: after this, per-user identity parts 1 and 2 replay real signed-in histories. A new
  owner-dependent workflow step without `getVersion` then fails `ReplayTest` before staging, instead of
  failing in production on the first replay.
- Acceptance:
  - the new files exist and contain the owner string in their recorded input (decode the base64
    payloads as ap-0024/ap-0027 do);
  - `RecordedHistoriesTest` has an active method that records each file;
  - no existing history is modified.

### 3. Freeze the old Azure suites at their own commit and start `tests/acceptance/lib` from code that already works (low risk; test-only; 1 cycle; before Azure A2b)

- Add `tests/acceptance/lib/repo.mjs`, moving in the helpers that ap-0031/0032/0034 already share:
  - `git`;
  - `requirementCommits(id)`, which leaves out the pipeline's own "acceptance tests" and "record the
    requirement" commits (as `ap-0034/repo.test.mjs:43-44` does; this is 0020 #3's helper);
  - `changed`;
  - `at(sha, rel)`;
  - `lastCommitTouching(id, prefix)`;
  - `section`;
  - `flat`.
- Add `tests/acceptance/lib/javasource.mjs`, copying ap-0032's `blankNonCode`, `methods` and `isActive`
  unchanged. Add `hasActiveTest(src, name)` on top.
- Give each library a small `*.test.mjs` self-test on fixture text. For example, an `@Disabled` above
  `@Test` must make that method inactive, and a brace inside a string must not end a method.
- In `ap-0014`, `ap-0016` and `ap-0017` (`repo.test.mjs`, and `live_api.test.mjs` where they read repo
  files), replace every working-tree read of a source or doc file with `at(<that AP's last commit>, rel)`.
  That is the pattern the newer suites use.
  - Don't add, remove or loosen any assertion. Each suite keeps checking what its requirement delivered.
  - Azure's current behaviour stays covered by `ArmClientTest` and `AzureArmBackendTest` in `mvn test`,
    and later by 0015 #3's `ProviderContractTest`.
- The developer may edit these files (`writableBy.developer` is `vm-intent/**`). The reviewer should
  check that the diff of the three suites only swaps how files are read.
- Old suites other than these three stay untouched.
- **A person** may add one line to the tester prompt: "use tests/acceptance/lib".
- This takes the parts of 0030 #2 and 0025 #3 that need no permission and no re-planning. The rest of
  those items (rewriting regex pins as `hasActiveTest` checks) can wait or be dropped.
- Acceptance:
  - all suites pass against today's code;
  - on a scratch copy, changing AZURE.md's "not yet used by AzureProvider" sentence or renaming
    `IMAGES` no longer fails ap-0017;
  - the self-tests pass.

## Note on repository content

Nothing in the repository tried to direct this stage. I read these as context only: the backlog notes
(approvals off, John's order of work, no SOAP, SECURITY.md is protected), the pipeline's config.ts
(stage models, budgets, who may write what) and the earlier reviews. Nothing proposed here touches
`docs/SECURITY.md`, `security/` or sign-in. The cycle summaries come from what this stage was given and
from git history.
