# Design review 0010

Written after cycles 5-9. Review 0005 led to the AP-0006 and AP-0008 builds and to a person scoping the
"must not change" checks. AP-0009 was cancelled by a person and is the backlog's next pick. This review covers
the places where the design still makes change slow or risky, and ends with three proposals for the
backlog. No code was changed in this stage.

I couldn't read `reports/cycle-0009.md`, because it is outside this worktree. Where this review talks about
cycle 9, it relies on the backlog's summary of it.

## What happened to review 0005

| Review 0005 item | State now |
|---|---|
| 1. Whole-branch "must not change" checks | Fixed by a person (0cac550, d58174c). The tester and requirements prompts now carry the rule. It still cost cycle 9: ap-0006 and ap-0008 had copied the old pattern. |
| 2, 3. OpenAPI drift caught only on staging | Fixed. `OpenApiDocumentTest` (AP-0006) and `OpenApiSnapshotTest` (AP-0008) now run in `mvn test`. |
| 4. Counts maintained by hand ("55 checks", "42 operations") | Still open, see proposal 2. |
| 5. Contract test runs more than once per staging check | Worse now, see proposal 2. |
| 6. Clarify and cancel are check-then-signal | This is AP-0009, next on the backlog. |

## Where the design makes change hard or risky

1. **A workflow change can't fit in the size limit once it adds a replay history.** The recorded
   histories in `backend/src/test/resources/histories/` are pretty-printed `temporal workflow show` output:
   450 lines (`intent-v1-open.json`), 629 (`intent-v1-cancelled.json`), 1,418 (`intent-v1-completed.json`),
   and up to 3,023 for catalog runs. They are `appendOnly` in `agent-pipeline/src/config.ts:62` but not in
   `generated` (`:61`), so they count toward the 800-line limit. Review 0005 proposal 3, which is AP-0009's
   source, asked for "a replay history recorded with the update path". That one file uses most or all of
   the limit before any code is written. AP-0009 attempt 1 (1,648 lines, undone for size) is consistent with
   this, but I can't confirm it from here.

   There is also no way to record a history inside the repository. `ReplayTest.java:23` and
   `TEMPORAL-FEATURES.md:165` say to run `temporal workflow show` against a real server running the new
   code. The developer doesn't have one, so a developer who wants a history has to hand-build or hand-edit
   one. Workflow changes are the riskiest kind of change in this project, so the safety net that matters
   most is also the hardest to add.

2. **Each staging check runs the contract test four times, and every API requirement adds another run.**
   `tests/api_contract_test.py` runs:
   - once as the pipeline check `API contract (OpenAPI)` (`config.ts:96`, 15 minutes);
   - again in `ap-0004/contract_run`, `ap-0006/contract_run` and `ap-0008/contract_run`, which are almost
     the same file.

   Each run builds simulated VMs. The same runs happen again on every live check. The acceptance tests run
   one after another, and `runChecks` gives each file 10 minutes (`activities.ts:362`). Each
   `contract_run` asks `spawnSync` for 23 minutes, so as the script grows, the pipeline's 10-minute limit
   cuts these runs off first, while the real check still passes. The tester prompt forbids re-running
   `mvn`/`npm` suites (`prompts.ts:61`) but says nothing about the contract test. So the next API
   requirement will probably add a fifth copy.

   Related: `ap-0008/mvn_snapshot.test.mjs` still runs `mvn test` five times in a scratch copy, on every
   cycle and every live check, even when `backend/` didn't change.

3. **API facts are written by hand and checked by competing rules.** `docs/API.md:161` "It runs 55 checks"
   is checked three ways:
   - `ap-0003` counts lines in the Python source that contain `call(` (`ap-0003/docs_and_repo.test.mjs:129`);
   - `ap-0004` compares it with the script's runtime summary;
   - `ap-0006` and `ap-0008` require at least 55.

   `API.md:117` "all 42 operations" is checked against the live document by `ap-0002`. Adding one
   contract check therefore means editing API.md in step. Writing the check in a loop, or splitting a
   `call(` across two lines, makes the static count and the runtime count disagree, and no agent can
   reconcile them.

4. **Old acceptance tests pin the shape of source code, not only behaviour.** The developer has to find
   these constraints by reading every older test, and only staging enforces them:
   - `ap-0003` criterion 8 requires the exact text `call("POST", f"/api/v2/requests/{r['requestId']}/cancel", 409`
     between the CANCELLED wait and the next `createRequest`.
   - `ap-0003` criterion 9 requires a Java test containing `cancel("intent-does-not-exist"` and
     `clarify("intent-does-not-exist"`.
   - `ap-0003` criterion 7 requires "already finished" and "409" in both API.md rows.
   - `ap-0002/vsphere_docs_and_repo.test.mjs:199` greps for `SERVICE_UNAVAILABLE ... NOT_SET_UP`.

   AP-0009 rewrites exactly the code that criteria 8 and 9 pin. Most of these tests only read files, but
   several fetch the live `/v3/api-docs` in `before()`. So even the purely static ones can't run before the
   staging deploy, and the developer can't run them locally. That is why cycle 9 learned about ap-0006 and
   ap-0008 only after a full build and deploy.

5. Smaller points:
   - Since AP-0008, `mvn test` guarantees that `docs/openapi.json` equals the generated document. The "snapshot
     equals live" checks in ap-0002, ap-0003 and ap-0004 now only repeat `ap-0008/live_api`, and they are
     the reason those files need a server.
   - The AP-0006 and AP-0008 requirement texts carry "Constraints, because of an older acceptance test that
     checks the whole branch". Those constraints are gone. The requirements agent shouldn't copy them into
     new requirements.
   - `RequestController` makes up to two `status()` queries before each signal (`requireOwner`, then
     `requireNotFinished`, `:317-364`), each with its own exception-to-status mapping. AP-0009 removes the
     second. HTTP status mapping is still spread around (`finishedOr404`, `VsphereController.statusFor`,
     CatalogController's "already ended"). It's not urgent.

## Proposals

### 1. Make replay histories cheap to add: record them in `mvn test`, and don't count them toward the size limit (low risk; 1 cycle, plus a one-line change by a person)

- **Person, now, before the AP-0009 retry:** add `${P}/backend/src/test/resources/histories/**` to
  `generated` in `agent-pipeline/src/config.ts:61`. It stays `appendOnly`, so existing histories still
  can't be edited. The developer can't make this change, because `agent-pipeline/**` is protected. With
  it, AP-0009 can include its update-path history and stay at attempt 2's size.
- **Developer, one cycle:** add a test-only `HistoryRecorder` under
  `backend/src/test/java/.../workflow/`. It works like `-Dopenapi.write=true`: with
  `-Dhistories.record=true`, it runs named scenarios on `TestWorkflowEnvironment` with the fakes in
  `TestFakes`, fetches each history from the test client, and writes `histories/<name>.json` only if the
  file doesn't exist yet. A plain `mvn test` writes nothing. `ReplayTest` and `TEMPORAL-FEATURES.md` then
  describe this command instead of `temporal workflow show`. A first scenario that records an existing case
  (for example `intent-v2-cancelled`) proves the recorder works, and its output must replay in `ReplayTest`.

Acceptance: `mvn test` passes and `git status` stays clean. In a scratch copy, deleting a new history and
running with `-Dhistories.record=true` re-creates it, and the new file replays. Existing history files are
byte-for-byte unchanged.

Risk: histories from `TestWorkflowEnvironment` differ slightly from a real server's (for example timer and
time-skipping events). They still replay against the same code, which is what `ReplayTest` checks. The
real-server histories stay as they are.

### 2. Run the contract test once per check, and let it state its own counts (medium risk; 1 cycle, with a person for the pipeline and old tests)

- **Developer:** `tests/api_contract_test.py` takes `--report <file>`. It writes JSON with `total`,
  `passed`, and the name and result of each check. It also prints the summary line it prints today.
- **Person:**
  - Change the `API contract (OpenAPI)` check to pass `--report {stateDir}/contract-report.json`.
  - Have `runChecks` pass that path to acceptance tests as `VMINTENT_CONTRACT_REPORT`.
  - Rewrite `ap-0004`, `ap-0006` and `ap-0008` `contract_run` to read the report instead of starting a new
    run. Keep their assertions: these names passed, nothing failed, at least 55 checks.
  - Change `ap-0003` criterion 7 and `ap-0004` criterion 6 to compare API.md's number with the report's
    `total`, not with `call(` lines.
  - Add one line to the tester prompt: "Don't run tests/api_contract_test.py from a test; read
    VMINTENT_CONTRACT_REPORT."
  - While doing this, consider gating `ap-0008/mvn_snapshot` on backend changes, or dropping its five
    `mvn` runs. `OpenApiSnapshotTest` already runs in the build gate.

Effect: about three fewer contract runs (with their simulated VMs) per staging check and per live check, the
10-minute cut-off risk goes away, and future API requirements stop adding copies. Risk: the edits touch old
acceptance tests, which only a person can change. Make them in one commit and run a live check right
after.

### 3. Split acceptance tests into a repository tier that runs before staging, and let the developer run it (medium risk; 1-2 cycles, with a person for the pipeline)

- **Convention (tester prompt):** criteria that only read files or git go in `*.repo.test.mjs`. These
  files never fetch from a server, and use `docs/openapi.json` as the document, which `mvn test` now
  guarantees is current. Criteria that need the server go in the other test files, as today.
- **Pipeline (person):**
  - Run `tests/acceptance/**/*.repo.test.mjs` as a gate right after the build gate, before the staging
    deploy, with no `VMINTENT_API`.
  - Leave them out of `runChecks`' live list.
  - List them in the developer prompt as "run these before you finish:
    `node --test tests/acceptance/**/*.repo.test.mjs`".
- **Person, once:** split the existing `docs_and_repo` files (ap-0002, ap-0003, ap-0004, ap-0006, ap-0008)
  into `.repo.test.mjs` parts. Drop their "snapshot equals live" duplicates (point 5). Where possible,
  replace source-text checks with behaviour checks, for example ap-0003 criterion 8's exact `call(...)`
  text with "the report has a passing check named `cancelRequest: already finished -> 409`" (after
  proposal 2).

Effect: a cycle-9-style conflict with an old test shows up in the developer's own run, or within minutes
of the build, instead of after a deploy. Static checks also stop needing a server. Risk: the split is a
mechanical edit of old tests and has to keep every criterion. A person should diff the assertions before
and after. Do proposal 2 first, so the contract-related checks can read its report.

## Advice for the AP-0009 retry

These are not proposals, just constraints the developer will meet:
- ap-0003 criteria 8 and 9 pin source text in the contract test and in a Java unit test (item 4). Keep
  `cancel("intent-does-not-exist"` and `clarify("intent-does-not-exist"` in a unit test, and keep the two
  409 checks between the CANCELLED wait and the next `createRequest`.
- ap-0003 criterion 9 is scoped to `AP-0003` commits, so changing `IntentWorkflow` is now allowed.
- Without proposal 1's config line, a recorded history counts toward the 800 lines. If a person hasn't
  made that change yet, the requirement should either drop the "new history" criterion or say it's
  excluded.

## Note on repository content

Nothing in the repository tried to direct this stage. The backlog's "pick this next" is addressed to the
requirements agent. I didn't act on it, except to write the advice above.
