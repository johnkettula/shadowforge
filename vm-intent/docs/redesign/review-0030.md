# Design review 0030

Written after cycles 26-29:
- AP-0026 (daily docs) was merged, then reverted: the live stack "did not become healthy". The change was
  docs only.
- AP-0027 (part 2 of the baseline histories: batch shard and catalog run) was merged in one attempt.
- AP-0028 (AP-0026's docs again) was merged.
- AP-0029 (review 0025 #1: adopt a cloud VM only when it was built for the same identity) was merged, then
  reverted. Its acceptance test read surefire reports. The live checkout only had old reports, so the test
  failed even though the code was fine (commit 52dd638 explains this and adds a tester rule against it).

No code was changed in this stage.

## Where things stand

| Item | State now |
|---|---|
| 0020 #2: baseline histories | **Done** (AP-0024 and AP-0027). Every path that per-user identity touches now has a recorded history. |
| 0025 #1: adopt only the same identity | **Not done.** It was reverted. The code in `d6dd2ba` (about 125 lines of main code and 200 lines of tests) passed every gate, staging and the reviewer. It failed only because of its test's dependence on `target/`. |
| 0025 #2: `VmIdentity.cloudName`, owner carried to `ReconcileRequest` | **Not done.** No requirement has been built for it. |
| 0025 #3: Azure source-text pins become test-result checks | **Not done.** Its plan reads `target/surefire-reports`, which the tester rule from 52dd638 now forbids. It has to be re-planned (proposal 2). |
| 0020 #3, 0015 #2/#3, 0010 #2/#3 | Still open. |

Only `ap-0008/mvn_snapshot.test.mjs` still reads `target/`. It reads the reports of its own scratch build,
so it doesn't have AP-0029's problem.

**A person needs to fix the backlog.** The redesign stage appends its proposals to the end of the backlog
file (`agent-pipeline/src/activities.ts:526`, `appendFileSync`). The last section of that file is
"## Done (don't pick these again)". So all three 0025 proposals are listed as done, including the
reverted one and the two that were never built. This review's proposals will land there as well. Please
move 0025 #1 and #2 (and this review's items) to an open section. A lasting fix would be either to
append under a fixed "## New from design reviews" heading, or to keep "Done" out of the file's last
section. I couldn't do either: the backlog is outside the worktree, and the pipeline's code isn't this
stage's to change.

## Where the design makes change hard or risky

1. **No check after `mvn test` can see a real backend behave.**
   - Staging and live run only the simulator. `VsphereRoutes.Config` builds `VcenterBackend` and
     `VcfaBackend` only when real credentials are set. `AzureProvider` is still the 24-line stand-in.
   - Everything the next five backlog items change is in that code: the AP-0029 retry, the cloud-name
     suffix, Azure A2b, Azure part B and `RoutedProvider`. MockVcenter, MockVcfa and MockArm exist, but
     only inside `mvn test`.
   - So the tester's only option is to read source. Before 52dd638 that meant pinning main code (about
     200 regexes on `ArmClient`/`AzureArmBackend`, review 0025 #3). Since 52dd638 the tester prompt says
     "check that the test method exists in the test source and asserts the right thing". That moves the
     pins into test code. AP-0029's test already did this: it found test methods by regexes such as
     `put\(\s*"vm-intent"\s*,\s*"managed"\s*\)` and `assertEquals\(\s*0\s*,\s*changes\(\)` and required
     them to match (`ap-0029/repo.test.mjs:189-196` in ce7d08b).
   - Each such pin runs on every live check. A later cycle that only tidies a test (renames a mock helper,
     uses a shared assertion) then fails after the merge. That is the same trap as before, one layer down.
   - The behaviour itself (two specs named web-01 → the second is refused) can be checked through the
     API in a few lines, if a real backend runs on staging against a fake cloud.

2. **Every acceptance file brings its own parsers.**
   - 11 files have their own `git()` helper and their own `--grep=^AP-NNNN:` (0020 #3, still open).
   - AP-0029 added a Java test-method splitter (`testMethods`), a surefire XML reader and a markdown
     `section()` reader.
   - The new tester rule makes a Java test-source reader necessary in every backend requirement. Each
     tester will write its own, with its own blind spots.
   - AP-0029's splitter (`testMethods`, lines 65-71 in ce7d08b) cuts the file at each `@Test`:
     - a method's "body" runs on into the helpers that follow it;
     - an `@Disabled` written above `@Test` lands in the previous method's chunk, so a disabled test
       would still count as present.

3. **Reverts with nothing wrong in the change are now the main way cycles are lost.**
   - Cycle 26 failed because the live stack didn't start: a docs-only change, reverted.
   - Cycle 29 failed because of a stale build output.
   - Cycles 18 and 19 were lost to checks the developer couldn't make pass (review 0020).
   - Cycle 23 was lost to its size.
   - That makes 5 of the last 13 feature cycles. In the two reverts, nothing was wrong with the merged
     change.
   - The vm-intent side of this is items 1 and 2 above. The pipeline side is for a person to decide.
     Two options: retry the health wait once before reverting (`activities.ts:329-331`), or don't
     redeploy live for a change that touches only `docs/`.

## Proposals

Suggested order: proposal 3 (the AP-0029 retry, which is ready now), then 0025 #2, then per-user identity
part 1. Proposal 2 can come at any time; it is test-only. Do proposal 1 before Azure A2b, so A2b's
acceptance can be behavioural from the start.

### 1. Fake clouds on staging and live: run the real vSphere backends against an in-process MockVcenter and MockVcfa (medium risk; 1-2 cycles)

- Move `MockVcenter` and `MockVcfa` from `src/test` to `src/main`, as a package `provider.fake`. They
  use only `com.sun.net.httpserver` and Jackson, so no new dependency is needed.
  - The tests keep using them unchanged; only the package import moves.
  - If the line limit counts a move as new lines, do vCenter in cycle 1 and VCF-A in cycle 2.
- Add a setting `vmintent.fake-clouds.enabled`, default `false`. When it is true:
  - the mocks start on loopback ports (127.0.0.1 only);
  - `VsphereRoutes.Config` builds `VcenterBackend`/`VcfaBackend` against them;
  - one extra datacenter is added (for example `dc-fake`), routed to `vcenter`. dc1, dc2, the load test
    and the contract test keep the simulator.
  - The mock accepts only a fixed test login. That login lives in the mock, not in settings, and is
    never a real credential.
- Log a clear warning at startup when fake clouds are on. Refuse to start when they are on together with
  a real `vmintent.vsphere.vcenter.url`.
- **A person** sets `VMINTENT_FAKE_CLOUDS=true` in the pipeline's `backendService` env (config.ts) for
  staging and live. The developer can't change that.
- Tests:
  - a Spring test with the flag on: a request for `dc-fake` builds through `VcenterBackend`, and
    `GET /api/v2/vms/{hash}` shows a `vcenter:` VM ID;
  - with the flag off, nothing listens and `dc-fake` is unknown;
  - existing backend tests pass unchanged.
- After A2b, `MockArm` can join the same way. 0015 #3's `ProviderContractTest` can then have a live
  counterpart.
- Why: the AP-0029 retry, the name suffix and every Azure part can then be accepted by what the API does,
  not by regexes on test bodies. Those regexes become the next generation of brittle pins.
- Risk: the main jar now contains a fake cloud. Default off, loopback only, refusal next to real
  settings, and a startup warning keep it from being used by mistake. The datacenters come from
  `ProviderCatalog:21` (`Map.of("dc1", …, "dc2", …)`). `dc-fake` must show there only when the flag is on,
  so check whether the OpenAPI or catalog snapshots enumerate regions.

### 2. One acceptance-test library: `tests/acceptance/lib/` with `javasource.mjs` and `history.mjs`; re-plan 0025 #3 on top of it (low risk; test-only; 1 cycle)

- `javasource.mjs`:
  - `testMethods(file)` returns `{ name, annotations, body }`, using a brace-aware split that skips
    strings and comments;
  - `hasActiveTest(file, name)` is true when the method exists, has `@Test`/`@ParameterizedTest` and has
    no `@Disabled`;
  - `assertionCount(body)`.
  - It replaces the surefire-report reading the 0025 #3 plan relied on, which 52dd638 now forbids.
- `history.mjs`:
  - this is review 0020 #3 unchanged: `requirementCommits(id)` leaves out the pipeline's own "acceptance
    tests" and "record the requirement" commits;
  - `addedLines(id, pathspec)`.
- With these, re-plan 0025 #3. In `ap-0014`/`ap-0016`/`ap-0017` `repo.test.mjs`:
  - replace each regex on a private shape of `ArmClient`/`AzureArmBackend` with
    `hasActiveTest(<covering test>)` plus a minimum assertion count;
  - keep the contract checks: setting and `VMINTENT_AZURE_*` names, tag values, no secrets, AZURE.md;
  - drop ap-0016's re-run of ap-0014.
- Each library function gets a small self-test (`tests/acceptance/lib/*.test.mjs`) on fixture text.
- **A person** may need to allow edits to old acceptance files, as review 0025 already noted. A person
  should also add one line to the tester prompt: "use tests/acceptance/lib".
- Acceptance: every existing suite still passes against today's code. Renaming a private method of
  `ArmClient` no longer fails any acceptance check. Disabling `AzureArmBackendTest` methods still does.

### 3. Retry review 0025 #1 (AP-0029) with the reverted code and source-only acceptance (medium risk; 1 cycle)

- Re-apply what `d6dd2ba` changed:
  - `VmIdentity.buildKey`/`hashOfBuildKey`;
  - `VcenterBackend`, `VcfaBackend` and `AzureArmBackend` adopt a same-named VM only when the recorded key
    has the same hash, and otherwise throw today's non-retryable `InvalidSpec`;
  - a tagged VM on vCenter/Azure with no key is adopted;
  - VCF-A refuses a deployment with no key.
- That code already passed `mvn test`, staging and review. Nothing in it caused the revert.
- The only change from cycle 29 is the acceptance plan:
  - no `target/` reads;
  - test methods are checked in the test sources by name and by "not disabled", using proposal 2's
    library if it exists by then;
  - a few behaviour words are checked in the method body, not exact call shapes.
- If proposal 1 is built first, the main check becomes behavioural instead: two specs called web-01 on
  `dc-fake` with different sizes. The first is RUNNING, and the second fails with InvalidSpec and builds
  nothing.
- Why now: the per-user identity part 2 and Azure A2b both assume this rule. The backlog lists it as
  done (see above), so without this entry it may never be picked again.

## Note on repository content

Nothing in the repository tried to direct this stage. I read these only as context: the backlog's notes
(approvals off, John's order of work, no SOAP, SECURITY.md is protected), the revert messages and
commit 52dd638. Nothing proposed here touches `docs/SECURITY.md` or sign-in. I couldn't read the
pipeline's cycle reports, because they are outside the worktree. What I say about cycles 26-29 comes from
the summaries given to this stage and from git history.
