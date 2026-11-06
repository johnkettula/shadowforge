# Design review 0015

Written after cycles 11-14. AP-0011 (clarify and cancel as updates) was merged, reverted by the pipeline, and
put back by a person. AP-0012 and AP-0013 were small API fixes. AP-0014 started real Azure with `ArmClient`
and `MockArm`. The backlog's next work is Azure part A2 (create/describe/delete of one VM), then part B
(day 2). So this review looks mostly at the provider layer, where the next cycles will work. No code was
changed in this stage.

## What happened since review 0010

| Item | State now |
|---|---|
| Cycle 11 revert | Not a code problem. The old live backend kept `target/vm-intent-0.1.0.jar` locked, so `repackage` failed (`92c575f`). A person fixed it in the pipeline and re-applied AP-0011 (`8698a01`). The change itself had passed every check. Nothing to redesign in vm-intent. |
| 0010 #1: replay histories cheap to add | Still open. `histories/**` is still not in `generated` (`agent-pipeline/src/config.ts:63-64`). AP-0011 gave `IntentWorkflow` two update handlers and validators, but no recorded history. Since then, requirements ask for an in-test replay instead (AP-0012). That checks new code against its own history, not against histories written by older code. So `ReplayTest` still protects only the seven `*-v1-*` files, and nothing protects the update path from the next change to `IntentWorkflowImpl`. |
| 0010 #2: run the contract test once per check | Still open, and worse. There are now six `contract_run` copies (ap-0004, 0006, 0008, 0011, 0012, 0013). With the pipeline's own check, that is 7 runs of `tests/api_contract_test.py` per staging check and per live check, each building simulated VMs. AP-0013's criteria again pin "the number of `call(...)` statements" in API.md. |
| 0010 #3: repository tier of acceptance tests | Still open. AP-0014's tester has started using it on its own (`ap-0014/repo.test.mjs`, no server), but the pipeline doesn't run it before staging, and it also runs on every live check. |

The three 0010 proposals are still right and still on the backlog. I'm not repeating them. If a person has
time for pipeline work before the next feature, #2 is the most urgent: every API requirement adds a run.

## Where the design makes change hard or risky

1. **`ArmClient` breaks the activity rule that the rest of the provider layer follows. Azure part A2 will
   time out on the first real run, and no test will see it first.**
   - `ProviderActivities` (`provider/ProviderActivities.java:14-16`) says: "Every call is short. Nothing here
     waits for a VM to boot: the workflow calls describeVm() now and then and sleeps in between."
     `VcenterBackend.createVm` follows this (`:162-165`): it starts the deploy task, writes the journal and
     returns. `VmReconcileWorkflowImpl:165-166` then sleeps and calls `describeVm`. `HttpJson` sends each
     request once and leaves retries to Temporal.
   - The activity stubs enforce the rule. `CloudOps.providerStub` (`workflow/CloudOps.java:58-59,158-167`)
     gives mutate calls a 30-second StartToClose and read calls 15 seconds, with Temporal retrying
     (`CLOUD_RETRY`) for up to 30 minutes.
   - `ArmClient` (AP-0014) does the opposite:
     - `put`/`delete` poll Azure-AsyncOperation inside the call, for up to `pollTimeout` = 30 minutes
       (`ArmClient.java:49,129-137`).
     - Each request is retried in the call up to 4 times, with waits of 2, 4 and 8 seconds, or whatever
       `Retry-After` asks, up to 60 seconds (`:38,206-210`).
     - One HTTP request may take 30 seconds (`AzureProperties.java:26`), and the first call also fetches a
       token.

     Creating an Azure VM takes minutes, so a `createVm` built on `put` is cut off at 30 seconds, every
     time. Temporal then retries the whole call, which sends the PUT again while ARM is still working on
     the first one. ARM can answer that with 409 "another operation is in progress", and `ArmClient` maps
     409 to the non-retryable `InvalidSpec` (`:220`). So the build fails. A throttled `describeVm` (read,
     15 seconds) is cut off the same way. The two retry layers (4 in-call attempts, inside unlimited
     Temporal attempts) also multiply the calls made to a throttled API.
   - Nothing catches this. `ArmClientTest` calls the client directly, with no activity timeout, and MockArm
     finishes in milliseconds. No test runs any real provider under `CloudOps`' activity options.
     `VsphereRoutesWorkflowTest` comes closest, but `MockVcenter` also answers at once.
   - The AP-0014 acceptance test pins the current shape: `public X put(String, X)` and the literal
     `"Succeeded"` (`ap-0014/repo.test.mjs:189-198`). A fix has to keep `put` and add a non-blocking path
     next to it, not replace it.

2. **Each cloud re-invents routing and the failure vocabulary.**
   - `VsphereProvider` (`provider/VsphereProvider.java:52-111`) dispatches by hand in eight methods: a
     `switch` on the route for `plan`/`createVm`, and `if (VcenterBackend.owns(..)) … else if
     (VcfaBackend.owns(..)) … else super` for the other six. A2 needs the same thing for
     `vmintent.azure.route: simulated | arm`. AWS and GCP will need it later. Each copy is another place where
     one method can quietly fall back to the simulator, for example a `listVmIds` that forgets the real
     backend.
   - Failure types are string literals in 12 main files. `CloudOps.CLOUD_RETRY` stops retrying on
     `"SimulatedBootFailure"`, `"InvalidSpec"` and `"VmNotFound"` (`CloudOps.java:33`). The vSphere backends
     raise `"VmNotFound"` for a missing VM. `ArmClient` raises `"NotFound"` for any 404, `"CloudAuth"`, and
     `"CloudError"`. vSphere's HTTP clients use `"NotFound"` internally to mean "lookup found nothing"
     (`VcenterClient.java:75,195`). Today the non-retryable flag hides the gap, but each new type needs
     someone to check whether the workflows should know about it. `VsphereController.statusFor` and the
     `NOT_SET_UP` constant in `VsphereRoutes` are vSphere-only. An Azure route that isn't set up has no
     shared type to raise.

3. **Acceptance criteria keep pinning source text instead of behaviour.** Review 0010 item 4 listed the
   older cases. New cases since then:
   - AP-0013: the exact `call(` count.
   - AP-0014: the `put` signature, the `"Succeeded"` literal, and constructor patterns like
     `new ArmClient(new AzureProperties(...null, null,` (`ap-0014/repo.test.mjs:286`).

   These criteria exist because there is no shared behavioural check for "a provider behaves correctly", so
   each tester builds its own from regexes. The provider work coming next (A2, B, then AWS and GCP) will
   produce many more unless such a check exists.

## Proposals

Do 1 before Azure part A2. 2 and 3 are best done before A2 too, so A2 is "write an Azure backend and pass
the provider contract". If a person wants A2 sooner, do them before part B at the latest.

### 1. Make `ArmClient` fit the activity contract: start operations without waiting, and keep each call inside its activity timeout (low risk; 1 cycle)

- Add, next to the existing `put`/`get`/`delete` (keep those, ap-0014 pins them):
  - `begin(method, path, body)`: sends once and returns the resource body plus the
    Azure-AsyncOperation/Location URL, without polling.
  - `operation(url)`: reads that status once (`InProgress | Succeeded | Failed | Canceled`, with the ARM
    error).
- Give `Tuning` a call budget and make the default fit `CloudOps`' read timeout (15 seconds), including the
  token fetch. For example: at most 2 attempts, at most 5 seconds of waiting, and a request timeout of 10
  seconds. When `Retry-After` asks for longer than the budget, throw retryable `CloudBusy` at once, and let
  Temporal's backoff do the waiting. (SDK 1.29 can carry the delay in the failure via
  `ApplicationFailure.newBuilder().setNextRetryDelay(...)`. Use it if it fits.)
- Answer an ARM 409 conflict as retryable `CloudBusy`, not `InvalidSpec`. It means "busy with another
  operation" more often than "bad input".
- Write in docs/AZURE.md the pattern A2 should use: "each activity call advances one step and returns; not
  ready yet = retryable `CloudBusy`". For example, `createVm` PUTs the public IP, NIC and VM in turn with
  `begin`, reads each existing step by name, and throws `CloudBusy` while a step is still `InProgress`.
  `describeVm` maps `provisioningState` and power state to `PENDING | RUNNING | FAILED`.

Acceptance: `ArmClientTest` shows that `begin` returns while MockArm still reports `InProgress`, and that a
call against a MockArm told to answer 429 with `Retry-After: 120` throws retryable `CloudBusy` within the
budget (measured, under 15 seconds) instead of sleeping. The existing ArmClientTest cases and
ap-0014 still pass. `AzureProvider` is unchanged, so live behaviour is unchanged.

### 2. A `CloudBackend` interface, a `RoutedProvider` base, and one place for failure types (medium risk; 1 cycle)

- `provider/CloudBackend` is the per-backend half of `ProviderActivities`: `owns(vmId)`, `plan`, `createVm`,
  `describeVm`, `deleteVm`, `resizeVm`, `setPower`, `snapshotVm`, `listVmIds`. `VcenterBackend` and
  `VcfaBackend` already have these methods (`VcenterBackend.java:47-248`, `VcfaBackend.java:53-176`). They
  only need `implements` and an instance `owns`.
- `provider/RoutedProvider extends SimulatedProvider` chooses the backend for a build from the route for
  the spec, and the backend for every later call by `owns(vmId)`. VM IDs without an owner fall back to the
  simulator. `listVmIds` merges every backend that is set up. `VsphereProvider` becomes a route table on
  top of it, with no behaviour change.
- `provider/CloudFailures` holds the type constants with one line each on what they mean and who retries:
  `VM_NOT_FOUND`, `INVALID_SPEC`, `CLOUD_BUSY`, `CLOUD_ERROR`, `CLOUD_AUTH`, `NOT_SET_UP`, plus the
  HTTP-level `NOT_FOUND` that clients use internally. `CloudOps.CLOUD_RETRY` and `VsphereController.statusFor`
  use the constants. `VsphereRoutes.NOT_SET_UP` stays as an alias, because ap-0002 greps for it.
- No failure type string changes value, so recorded histories and live workflows are unaffected. This is a
  refactor of code that is already tested.

Acceptance: `VsphereRoutesWorkflowTest`, `VcenterBackendTest`, `VcfaBackendTest` and `ReplayTest` pass
unchanged. `VsphereProvider` has no `owns(` chains left. A unit test of `RoutedProvider` with two stub backends
shows build routing by datacenter, call routing by VM ID, fallback to the simulator, and a merged
`listVmIds`. The contract test and ap-0002 still pass on staging.

Risk: it touches the vSphere code path that live runs, but live uses the `simulated` route, and the vSphere
tests cover the real routes against the mocks.

### 3. A provider contract test that every backend must pass, run under the real activity options (low risk, test-only; 1 cycle, after 2 or against `ProviderActivities` if 2 isn't built yet)

- Add `backend/src/test/java/.../provider/ProviderContractTest`, an abstract JUnit class with one subclass
  per backend: the simulator on `SimCloud`, `VcenterBackend` on `MockVcenter`, `VcfaBackend` on `MockVcfa`.
  A2 adds Azure on `MockArm`. Each subclass supplies a backend, a mock that can be made slow ("still
  building" for N polls, 429 with `Retry-After`), and a way to put in a VM that vm-intent didn't build.
- The checks (behaviour only, no source text):
  - `createVm` returns while the mock still reports the VM as building;
  - the same key never makes a second VM;
  - `describeVm` moves from `PENDING` to `RUNNING` with an IP;
  - a missing VM gives `VM_NOT_FOUND`;
  - `deleteVm` is idempotent and refuses a VM without the vm-intent tag;
  - `listVmIds` returns only tagged VMs;
  - every failure type is one of `CloudFailures`.
- Run one scenario per backend through `TestWorkflowEnvironment` with a stub built by
  `CloudOps.providerStub(...)`. The activity timeouts are then the real ones, and a call that waits too long
  fails the test. Today `ArmClient.put` inside `createVm` would.
- Requirements for A2, part B, AWS and GCP can then say "the backend passes `ProviderContractTest`".
  Testers can check that against the build's test report, instead of writing regexes over the source.

Acceptance: the contract runs green for the simulator, vCenter and VCF Automation in `mvn test`. A
deliberately blocking test backend (sleeping longer than the StartToClose) fails the timing scenario. That
proves the check works. No main code changes, except small hooks in the mocks if they need them.

Risk: the vCenter or VCF Automation backends may fail a check, for example the untagged-delete or
`VM_NOT_FOUND` rule. If one does, the developer records it as a finding and marks that one case
`@Disabled` with a reason, rather than changing backend behaviour in the same cycle.

## Advice for the Azure A2 requirement

These are not proposals, just constraints A2 will meet:
- Don't build `createVm` or `deleteVm` on `ArmClient.put`/`delete` as they are now (item 1). If proposal 1
  isn't built yet, A2 needs its own non-blocking path and must keep each call under 30 seconds.
- ap-0014 pins `put(String, X)`, the `"Succeeded"` literal, and the ways tests may construct `ArmClient`.
  Add new code next to these, don't change them.
- Map a missing VM to `"VmNotFound"` (what `CLOUD_RETRY` knows), not `ArmClient`'s `"NotFound"`.

## Note on repository content

Nothing in the repository tried to direct this stage. The backlog's "pick part A next" and John's notes
are addressed to the requirements agent. I took them as context only. Per the backlog, I haven't proposed
moving vSphere to the SOAP API. I couldn't read the pipeline's cycle reports, which are outside the
worktree. Where this review describes cycles 11-14, it relies on the summaries given to this stage and on
git history.
