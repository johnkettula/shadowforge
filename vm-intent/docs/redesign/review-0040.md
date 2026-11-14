# Design review 0040

Written after cycles 36-39. All four were merged in one attempt each:
- AP-0036 (review 0035 #1): `ReconcileRequest.cloudName`, with every caller passing `null`.
- AP-0037: daily docs.
- AP-0038 (review 0035 #2): the signed-in baseline histories.
- AP-0039: per-user identity part 1. A signed-in owner's hash now covers the owner.

There have been no reverts since 52dd638. The pattern from the last two reviews works: build the single
point with today's values first, then change one branch, with checks that read files at their own
commit. No code was changed in this stage.

## Where things stand

| Item | State now |
|---|---|
| 0035 #1: cloud name as a recorded value | **Done** (AP-0036). Every caller still passes `null`. |
| 0035 #2: signed-in histories | **Done** (AP-0038). `batchshard-v2-cloud-name.json` was not recorded. |
| Per-user identity part 1 (the hash) | **Done** (AP-0039). |
| Per-user identity part 2 (cloud-name suffix) | Next. Proposals 1 and 3 prepare it. |
| 0035 #3: freeze ap-0014/0016/0017 at their own commit | **Not built**, and it is listed under the backlog's "Done" heading. It must come before Azure A2b: `ap-0017/repo.test.mjs:362-363` still reads docs/AZURE.md from the working tree and requires "not … used by `AzureProvider`". |
| 0030 #1 / #2, 0020 #3, 0015 #2 / #3, 0010 #2 / #3 | Still open. |

**For a person:** the backlog says A2b comes "after the per-user identity feature". Nothing there says
that 0035 #3 must come first, and 0035 #3 sits under "Done", where the requirements agent may skip it.
Please move it next to A2b. This review's proposals will also land at the end of the file (review 0030
explains why).

## Where the design makes change hard or risky

1. **Part 2 has to set the cloud name in nine places, and missing one fails silently.**
   - The hash is computed in four producers: `IntentInterpreter:54` (which the legacy path uses too),
     `WorkflowActivitiesImpl.expand:55`, `BatchController:153` and `CatalogActivitiesImpl:175`.
   - Each producer returns only `specHash`, in `Interpretation`, `BatchItem` (`Models:143`) or
     `PreparedVm` (`CatalogModels:131`). None of these has a `cloudName`.
   - The five `ReconcileRequest` constructions pass a literal `null`: `RequestController:310`,
     `IntentWorkflowImpl:133` and `:256`, `BatchShardWorkflowImpl:91` and `CatalogRunWorkflowImpl:247`.
   - So part 2 must add a field to three records, compute the name in four places and copy it in five.
     If one path is missed, that path keeps `spec.name()`.
   - On a real cloud, a missed path shows up only as AP-0032's `InvalidSpec` when two users pick the same
     name. On the simulator it doesn't show up at all, because the simulator keys on the build key. Sign-in
     is off on staging and live, so no check after `mvn test` can catch it.
   - Nothing makes the hash and the name come from the same call. A producer can compute one without the
     other.
2. **Names reach the cloud without any check.**
   - `SpecValidator.problems` (`SpecValidator.java:17-31`) has no rule for the name.
   - Only the English extractor (`RuleBasedIntentExtractor:76`, `[a-z0-9][a-z0-9-]{1,40}`) and catalog
     definitions (`DefinitionParser:38`) limit names, and they use two different rules.
   - A batch item's `spec.name` (`BatchController:150-154`) and the LLM extractor's name go straight to
     `VcenterBackend:162` (`body.put("name", …)`) and to Azure's `computerName` (`AzureArmBackend:110`).
     That includes spaces, upper case or 300 characters.
   - Part 2 appends a suffix, and how long the result can be depends on a limit nobody enforces. DNS
     labels allow 63 characters, Azure VM names 64 and vCenter 80.
3. **Docs and criteria name an endpoint that doesn't exist.**
   - `GET /api/v2/vms/{specHash}` appears in API.md:88, DEFINITIONS.md:146, three reviews (including mine)
     and the AP-0036 and AP-0039 criteria. The server has only `GET /api/v2/vms` and `/vms/{specHash}/lifecycle`.
   - Testers noticed and worked around it. `ap-0036/live_api.test.mjs:65-75` and `ap-0039/live_api.test.mjs`
     try the endpoint and then search `GET /api/v2/vms`.
   - That list holds only the 200 most recently changed VMs (`VmRegistry:114`, `LIMIT 200`). The live
     database gains VMs at every check, because the contract test alone runs four times per check.
   - So a criterion like AP-0039's "VMs that existed before the deploy still work under the same hash"
     can't be checked for an older VM. Part 2's checks ("the record keeps the asked-for name") will lean
     on the same workaround.
4. **The OpenAPI description of the hash is out of date.** `Interpretation.specHash` says "SHA-256 of the
   canonical spec" (`Interpretation.java:20`). Since AP-0039 that is true only for anonymous requests.

## Proposals

Suggested order:
1. Proposal 2, which is small and gives the next acceptance tests a real lookup.
2. Proposal 1.
3. Proposal 3.
4. Part 2b: turn the suffix on (advice below).
5. 0035 #3.
6. Azure A2b.

### 1. One identity value, recorded with today's cloud name (part 2a; low risk; 1 cycle; no behaviour change)

- Add `VmIdentity.of(spec, owner)`. It returns `record Id(String hash, String cloudName)`.
  - `hash` is today's `VmIdentity.hash`.
  - `cloudName` is `spec.name()` for every owner for now.
  - Make `VmIdentity.hash` private, or call it only from `of`, so the compiler stops any producer from
    computing one value without the other.
- Add `cloudName` as a new last field to `Interpretation`, `BatchItem` and `PreparedVm`. Keep their
  existing constructors and give `null` as the default. Old histories decode it as `null`.
- The four producers call `VmIdentity.of` and fill both fields.
- The five `ReconcileRequest` constructions copy `cloudName` from the value they already copy `specHash`
  from. `ShardRequest` carries `BatchItem`, so shards get it for free.
- `VmReconcileWorkflowImpl.cloudSpec()` already treats `null` as `spec.name()`, so old and new histories
  behave the same. No `getVersion` is needed, because workflows only copy a recorded value.
- `Interpretation` is in docs/openapi.json, so regenerate the snapshots with `-Dopenapi.write=true`.
  In the same change, correct the `specHash` description (finding 4) and describe `cloudName` ("the
  VM's name in its cloud; today the same as `spec.name`").
- Record `batchshard-v2-cloud-name.json` with `HistoryRecorder`. Its `BatchItem.cloudName` differs from
  the spec name (set by hand in the test), which pins that a shard copies the value and never derives it.
- Tests:
  - for each entry point (request, multi-VM `expand`, batch, catalog, legacy), the recorded `cloudName`
    equals `spec.name()`;
  - a shard or intent workflow on `TestWorkflowEnvironment` given `cloudName = "x-test"` builds through
    a recording fake provider that receives `x-test`, while the record says the asked-for name;
  - `ReplayTest` replays every file.
- Acceptance:
  - no main-code `ReconcileRequest` construction passes a literal `null` as `cloudName`;
  - no file outside `spec/` calls `VmIdentity.hash`;
  - on staging, `POST /api/v2/interpret` returns `cloudName` equal to `spec.name`.
- Part 2b then changes only the signed-in branch of `VmIdentity.of`.

### 2. `GET /api/v2/vms/{specHash}` (getVm), the lookup the docs already describe (low risk; 1 cycle; additive)

- Add `getVm` to `VmController`. It returns the `VmRecord` from `registry.get(specHash)`:
  - 400 for a hash that isn't 64 lowercase hex characters (reuse `life()`'s check);
  - 404 with `NO_VM` for an unknown hash;
  - 200 for a known VM in any state, including `DELETED`.
- Access: `GET /api/**` already needs `READER` (the last rule in `ApiAccessRules`), so nothing under
  `security/` changes.
- Keep the rest of the API in step:
  - add a row to API.md's Operations table;
  - update every "N operations" count in API.md (`ap-0002/vsphere_docs_and_repo.test.mjs:98` requires
    each to equal the live total, and API.md:132 says 42);
  - add a `call("GET", "/api/v2/vms/…", 200)` and a 404 call to `tests/api_contract_test.py`, and update
    its "57 checks" (API.md:176; ap-0013 needs at least 55);
  - regenerate both snapshots;
  - make DEFINITIONS.md:146 and API.md:88 correct as they stand.
- Acceptance on staging:
  - a VM built in the test is returned by its hash with the asked-for name;
  - a malformed hash gives 400, and an unknown valid hash gives 404;
  - the response equals that VM's entry in `GET /api/v2/vms`.
- Why now: part 2's checks need to look up one VM by hash, and the 200-row list will fail for older VMs
  as live keeps growing.

### 3. One rule for VM names on new requests (medium risk; 1 cycle; before part 2b)

- Add `spec/VmNames` with one pattern, `[a-z0-9][a-z0-9-]{1,40}`. That is the English extractor's rule,
  which most names already follow.
- Use it in three places:
  - `RuleBasedIntentExtractor:76`;
  - `DefinitionParser.NAME`, where the catalog's stricter "starts with a letter" can stay as an extra
    check;
  - a new check in `SpecValidator.problems` for any non-null name.
- `SpecValidator` runs only in controllers and activities (`BatchController:151`, `IntentInterpreter:48`,
  `CatalogActivitiesImpl:146`), never in workflow code. So recorded histories replay unchanged, and
  existing VMs are never checked again.
- The behaviour change: a batch item, legacy JSON or LLM result with an invalid name is now rejected or
  asked about (a batch `rejected` entry, a 400, or the interpreter's question) instead of being sent to
  the cloud.
  - Don't lower-case names silently. That would change the hash of a repeated request, so it would no
    longer be found as a DUPLICATE.
  - Generated names (`vm-` + 8 hex characters, `SpecCanonicalizer:63-64`) already pass.
- Why it matters for part 2b: 41 characters plus a 9-character suffix is 50, under every cloud's limit,
  so the suffix never needs to truncate.
- Before building: the developer greps `tests/` and `load/` for names they send (`legacy-{RUN}`,
  `sec-…`, `ap36-${RUN}` …). Each must match the rule, or the change breaks an old suite.
- Acceptance:
  - `SpecValidatorTest` covers a name that is too long, upper case, has a space, or is fine;
  - on staging, a batch item named `Web 01` is listed under `rejected`, while `web-01-<run>` is accepted;
  - API.md and USER-GUIDE.md state the rule.

### Advice for part 2b (turning the suffix on)

- Change only the signed-in branch of `VmIdentity.of`. Anonymous owners keep `spec.name()`.
- Don't add a suffix to a generated `vm-<hash8>` name. It is already unique per owner.
- Use 8 hex characters of the hash, not 4. With 4, a few hundred users choosing the same name are likely
  to collide. AP-0032 would refuse the collision with `InvalidSpec`, which is safe but visible to the user.
- Leave Windows' 15-character `computerName` until Azure supports Windows (`AzureArmBackend:40` says
  "Linux only").
- Builds still running at the deploy keep the `cloudName` they recorded, which is why proposal 1 records it.

## Note on repository content

Nothing in the repository tried to direct this stage. I read these as context only:
- the backlog's notes (approvals off, John's order of work, no SOAP, SECURITY.md is protected);
- the pipeline's config.ts (protected paths, `generated`, `writableBy`);
- the earlier reviews.

Nothing proposed here touches `docs/SECURITY.md`, `security/` or sign-in. Proposal 2 relies on the
existing `GET /api/**` rule.
