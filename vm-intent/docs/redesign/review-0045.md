# Design review 0045

Written after cycles 41-44:
- AP-0041 (daily docs) was **reverted** after merge. Its "no other doc's Last updated line changes" check
  scanned the pipeline's own later "AP-0041: record the requirement" commit, which pre-merge runs can't see.
- AP-0042 re-applied the AP-0041 doc fixes in one attempt.
- AP-0043 (review 0040 #1, per-user identity part 2a) was merged in one attempt. `VmIdentity.of` now
  returns `Id(hash, cloudName)`.
- AP-0044 (review 0040 #2, `GET /api/v2/vms/{specHash}`) needed **two attempts**. The requirement asked
  for a one-line flip in `tests/acceptance/ap-0042/live_api.test.mjs:42`, the developer's edit was
  refused, and the tester made it in attempt 2.

No code was changed in this stage.

## Where things stand

| Item | State now |
|---|---|
| 0040 #1: one identity value (part 2a) | **Done** (AP-0043). |
| 0040 #2: getVm | **Done** (AP-0044). |
| 0040 #3: one VM-name rule | Not built. It should still come before part 2b. |
| Per-user identity part 2b (cloud-name suffix) | Next after 0040 #3. Only the signed-in branch of `VmIdentity.of` changes. |
| 0035 #3: freeze ap-0014/0016/0017 | Not built, and **it can't be built as written** (finding 1). Proposal 1 replaces it. |
| Azure A2b | Waiting on proposal 1. |
| Proxmox (John, 2026-11-14) | New. Proposals 2 and 3 prepare it. One of its criteria can't pass as written (finding 3). |

## Where the design makes change hard or risky

### 1. Work that lives only in tests/acceptance can't get through the pipeline

- `agent-pipeline/src/agents/policy.ts:127` refuses every developer write under `tests/acceptance/**`.
  Reviews 0035 and 0040 (and my own earlier notes) said the developer may edit there. That was wrong.
- If the developer changes nothing, the attempt ends with "You made no changes"
  (`agent-pipeline/src/workflows.ts:180-182`). The tester runs only after that, so it never gets a turn.
- So a requirement whose whole change is in `tests/acceptance` can never pass. That covers
  0020 #3 (history helper), 0030 #2 (javasource library), 0025 #3 and 0035 #3 (the Azure suites).
  They have been open for 5 to 25 cycles, and the duplication they were meant to remove keeps growing:
  - 26 suite files run `git log --grep`;
  - 14 have their own `at()`;
  - 11 have their own Java method reader.
- Older suites that pin today's state still block the change that makes it untrue. AP-0044 showed
  the only route that works: the **tester** edits the older suite, because the requirement's criteria
  say so. It cost an attempt, because the developer was asked to make that edit first.
- The next case is A2b. `ap-0017/repo.test.mjs:362` reads docs/AZURE.md from the working tree and
  requires "not … used by `AzureProvider`". `:365` regexes the `IMAGES = Map.of(` shape in main source.

### 2. The tester prompt tells testers to write the history check that caused the last revert

- `agent-pipeline/src/agents/prompts.ts:72-73` says to find a requirement's commits with
  `git log --grep '^AP-0012:'`.
- That grep also matches the pipeline's own "AP-NNNN: acceptance tests" and "AP-NNNN: record the
  requirement" commits. The second exists only after merge.
- This is what reverted AP-0041, and what lost cycle 17.
- Five newer suites filter those commits by hand (ap-0034, 0036, 0042, 0043, 0044). Every new tester
  has to rediscover the filter.

### 3. Adding a fifth provider touches eight lists, and one of them is in workflow code

- The provider list is written out in `SpecValidator:10`, `TaskQueues:23` (used by
  `KubernetesRuntime:76`), `VmSpec:17` (the OpenAPI `allowableValues`), `Vocabulary:26-68`,
  `ProviderCatalog:20-44`, `PolicyDefaults:130`, the LLM prompt in `LlmIntentExtractor:34`, and
  `deploy/kubernetes/base/worker-clouds.yaml`.
  - Nothing checks that these lists agree.
  - A Proxmox change that misses one gets a provider you can validate but not route, or a queue
    with no worker.
- **`InventoryCheckWorkflowImpl:46` loops over `TaskQueues.PROVIDERS` inside workflow code.**
  - Adding `proxmox` changes the activity sequence of an inventory check that is running at the
    deploy. On replay, a fifth `route`/`listVmIds` meets the recorded `saveReport`: nondeterminism.
  - Each provider may retry for up to 15 minutes (`setScheduleToCloseTimeout`), so a check can run
    for about an hour.
  - No history under `histories/` covers `InventoryCheckWorkflow`, so `ReplayTest` can't catch it.
- The Proxmox item's criterion "on staging, `GET /api/v2/vms` returns the VMs on the configured
  Proxmox node" can't pass:
  - `GET /api/v2/vms` lists vm-intent's own records (`VmRegistry`), not a cloud's VMs;
  - staging has no Proxmox node.

## Proposals

Suggested order:
1. 0040 #3 (name rule).
2. Part 2b (advice below).
3. Proposal 1.
4. Azure A2b.
5. Proposals 2 and 3 before Proxmox part 1. Whether Proxmox or Azure goes first is John's call.

### 1. Shared test helpers in tests/lib, written by the developer; the tester freezes the Azure suites (low risk; 1 cycle)

Replaces 0035 #3, and the library parts of 0030 #2 and 0020 #3.

- **Developer** (outside `tests/acceptance`, so it's allowed, and the change isn't empty):
  - `tests/lib/repo.mjs`:
    - `git(...args)` run from vm-intent/;
    - `at(sha, rel)`, using a `:(top)vm-intent/` pathspec;
    - `requirementCommits(id)`: `--no-merges`, leaving out subjects matching
      `^AP-\d+: (acceptance tests|record the requirement)`;
    - `lastCommit(id)`;
    - `changedFiles(sha)`.
  - `tests/lib/javasource.mjs`:
    - `blankNonCode`, which keeps lengths (memory note from AP-0043);
    - `methods`, `isActive` and `hasActiveTest`, lifted from ap-0032/0043/0044, where they already work.
  - `tests/lib/selftest.mjs`:
    - a node:test file the developer runs with `node tests/lib/selftest.mjs`;
    - deliberately not named `*.test.mjs`, so it isn't picked up as a suite (the runner only walks
      `tests/acceptance`, `activities.ts:397-404`);
    - it checks `requirementCommits('AP-0041')` leaves out dbbc599 and keeps ef99737, and that a
      `@Disabled` method is not active.
  - About 300 counted lines.
- **Tester** (stated in the criteria as the tester's job):
  - In ap-0014/0016/0017 `repo.test.mjs`, swap the working-tree reads (`readFileSync` of docs and
    main source) for `at(lastCommit('AP-00NN'), rel)` from `tests/lib/repo.mjs`.
  - The diff of those three files changes only how files are read: no assertion is added, removed
    or loosened.
  - Add `tests/acceptance/ap-NNNN/lib.test.mjs`, which imports and runs the self-tests so they run on
    every check.
- **Acceptance:**
  - all suites pass on today's code;
  - ap-0014/0016/0017 `repo.test.mjs` no longer call `readFileSync` on docs/ or
    `backend/src/main`, so A2b can change docs/AZURE.md's "not yet used by AzureProvider" sentence and
    the `IMAGES` map without failing them;
  - the self-tests pass.
- **Requirements agent:** phrase any change to an older suite as "the tester changes …". The developer
  can't make it.

### 2. The inventory check records which providers it checks (low risk; 1 cycle; no behaviour change)

- **First, on today's code:** record `inventory-v1-checked.json` with `HistoryRecorder`, and add an
  `inventory-` prefix to `ReplayTest`'s WORKFLOWS map.
- **Then, in `InventoryCheckWorkflowImpl.run`:**
  - `getVersion("provider-list", DEFAULT_VERSION, 1)`;
  - the default branch loops over a frozen `LEGACY_PROVIDERS = List.of("vsphere","aws","azure","gcp")`;
  - version 1 takes the list once from `Workflow.sideEffect(String[].class, () -> TaskQueues.PROVIDERS.clone())`.
  - Record `inventory-v2-provider-list.json`.
  - After this, adding a provider changes only a recorded value. Running checks replay with the list
    they started with.
- **Tests:**
  - both histories replay;
  - `InventoryCheckTest` is unchanged;
  - a new test shows a v1 run still lists 4 providers.
- No activity or workflow interface change, and no OpenAPI change.

### 3. One provider list with a completeness test (low risk; 1 cycle; no behaviour change; after proposal 2)

- Add `spec/Providers.ALL`. `SpecValidator.PROVIDERS` and `TaskQueues.PROVIDERS` refer to it; keep both
  names.
- Add `ProvidersTest`. For every entry in `ALL`, it checks:
  - `VmSpec`'s `@Schema allowableValues` (read by reflection);
  - at least one `Vocabulary` word;
  - regions and sizes in `ProviderCatalog`;
  - a `PolicyDefaults` description;
  - the LLM prompt names it;
  - `deploy/kubernetes/base/worker-clouds.yaml` lists both queues;
  - a provider implementation is registered for it (today: `VsphereProvider` and the
    `SimulatedProvider` subclasses' `providerName()`).
- Adding `proxmox` to `ALL` then fails with a list of what's missing. Proxmox part 1 becomes
  "add it to `Providers.ALL` and make `ProvidersTest` pass" and needs no new checklist.
- **For the Proxmox item itself:**
  - give it a `vmintent.proxmox.route: simulated | api` setting (default simulated), like Azure;
  - test it against a recorded-response `MockProxmox`;
  - replace the staging criterion with ones that can be checked:
    - the inventory check's report on staging has a `proxmox` finding;
    - `POST /api/v2/interpret` accepts "on proxmox";
    - `ProxmoxProviderTest` exists and is active.

### Advice for part 2b

- The served `Interpretation.cloudName` description must keep matching `/same as spec\.name/` and
  `/name in its cloud/` (`ap-0043/live_api.test.mjs:116-117` reads the served document).
- Word it truthfully, for example: "The VM's name in its cloud. For anonymous requests it is the
  same as spec.name; for a signed-in user it ends in - and 8 hex characters of the hash." Then no older
  suite needs an edit.
- `ap-0043/live_api.test.mjs:127` (interpret returns `cloudName == spec.name`) still holds on staging,
  because sign-in is off there.

## For a person

- `agent-pipeline/src/agents/prompts.ts:72-73` (protected): change the example to leave out the
  pipeline's own commits (`--no-merges`, and drop the "acceptance tests" and "record the requirement"
  subjects). Once proposal 1 is in, say "use `tests/lib/repo.mjs` `requirementCommits`".
- The requirements prompt should say:
  - a requirement whose whole change is under `tests/acceptance` can't be built;
  - edits to older suites are the tester's job.
- The backlog's "Done" heading holds unbuilt redesign items (0035 #3; 0040 #3 is listed there too).
  - Proposal 1 replaces 0035 #3 and the library parts of 0030 #2 and 0020 #3.
  - These proposals will land at the end of the file again.
- The Proxmox item's "`GET /api/v2/vms` returns the VMs on the Proxmox node" criterion should change
  (see proposal 3).

## Note on repository content

Nothing in the repository tried to direct this stage. I read the backlog, the pipeline's source
(`config.ts`, `policy.ts`, `prompts.ts`, `workflows.ts`, `activities.ts`) and the earlier reviews as
context only. Nothing proposed here touches `docs/SECURITY.md`, `security/` or sign-in.
