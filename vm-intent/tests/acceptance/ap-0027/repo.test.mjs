// AP-0027 acceptance, repository half (criteria 1-7): ReplayTest maps 'batchshard-' to BatchShardWorkflowImpl and
// requires all eleven histories; two new recorded histories (batchshard-v1-duplicate, catalog-v2-existing-vm) whose
// recording tests assert the scenario and replay the fetched history before HistoryRecorder.record; the
// TEMPORAL-FEATURES section 9 update; and no AP-0027 commit touching main code, the frontend, the API snapshot,
// protected files or an existing history.
//
// Files are read as they were at the newest AP-0027 commit, and "must not change" checks look only at AP-0027
// commits, so later requirements can change these files without breaking this suite. The build gates run mvn test;
// this suite only reads files.
//
//   node --test tests/acceptance/ap-0027/repo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const TF = 'docs/TEMPORAL-FEATURES.md';
const HISTORIES = 'backend/src/test/resources/histories';
const WF = 'backend/src/test/java/com/example/vmintent/workflow';
const REPLAY = `${WF}/ReplayTest.java`;
const RECORDER = `${WF}/HistoryRecorder.java`;

const V1 = ['intent-v1-completed', 'intent-v1-cancelled', 'intent-v1-open', 'reconcile-v1-completed',
  'catalog-v1-resumed', 'catalog-v1-torn-down', 'catalog-v1-approved'];
const AP24 = ['intent-v2-multi-existing', 'lifecycle-v1-renewed'];
const NEW = ['batchshard-v1-duplicate', 'catalog-v2-existing-vm'];
const ALL = [...V1, ...AP24, ...NEW];
const PREFIXES = { 'intent-': 'IntentWorkflowImpl', 'reconcile-': 'VmReconcileWorkflowImpl',
  'catalog-': 'CatalogRunWorkflowImpl', 'lifecycle-': 'VmLifecycleWorkflowImpl', 'batchshard-': 'BatchShardWorkflowImpl' };

const git = (args) => execFileSync('git', args,
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

// Oldest first.
const COMMITS = git(['log', '--reverse', '--format=%H', '--grep', '^AP-0027:']).split('\n').filter(Boolean);
const LAST = COMMITS[COMMITS.length - 1];
const FIRST = COMMITS[0];

/** A vm-intent/ file as it was at a commit, or null if it didn't exist. */
function at(sha, rel) {
  try { return git(['show', `${sha}:vm-intent/${rel}`]).replace(/\r\n/g, '\n'); } catch { return null; }
}
function must(sha, rel) {
  const t = at(sha, rel);
  assert.ok(t !== null, `${rel} doesn't exist at ${sha.slice(0, 8)}`);
  return t;
}
/** The text of a '## N. ...' section up to the next '## ' heading. */
function section(md, heading) {
  const i = md.indexOf('\n' + heading);
  assert.ok(i >= 0, `section "${heading}" not found`);
  const rest = md.slice(i + 1);
  const j = rest.indexOf('\n## ', 1);
  return j < 0 ? rest : rest.slice(0, j);
}
function historyFiles(sha) {
  return git(['ls-tree', '--full-tree', '--name-only', `${sha}:vm-intent/${HISTORIES}`])
    .split('\n').filter(Boolean).sort();
}
function events(sha, name) {
  const json = JSON.parse(must(sha, `${HISTORIES}/${name}.json`));
  assert.ok(Array.isArray(json.events) && json.events.length > 1, `${name} has no events`);
  return json.events;
}
const payloadText = (p) => Buffer.from(p.data || '', 'base64').toString('utf8');
const payloads = (ps) => (ps?.payloads || []).map(payloadText);
/** The vm-intent/-relative path of the test class that records history <name> through HistoryRecorder, or undefined. */
function testNaming(name) {
  let out = '';
  try {
    out = git(['grep', '-l', '-F', 'HistoryRecorder.record(', LAST, '--', `:(top)vm-intent/${WF}`]);
  } catch { return undefined; }
  // git grep prints cwd-relative paths (cwd is vm-intent/).
  return out.split('\n').filter(Boolean).map((l) => l.replace(`${LAST}:`, '').replace(/^vm-intent\//, ''))
    .find((rel) => rel !== RECORDER && must(LAST, rel).includes(`"${name}"`));
}
/** The @Test method of a class's source that records history <name> (from its @Test up to the record call's end). */
function recordingMethod(src, name) {
  const call = src.search(new RegExp(`HistoryRecorder\\.record\\([^;]*"${name}"\\)`));
  assert.ok(call >= 0, `${name} is not recorded through HistoryRecorder.record`);
  const start = src.lastIndexOf('@Test', call);
  assert.ok(start >= 0, `the method recording ${name} is not a @Test`);
  const end = src.indexOf(';', call);
  return src.slice(start, end + 1);
}

test('there is at least one AP-0027 commit', () => {
  assert.ok(COMMITS.length > 0, "no commit whose subject starts with 'AP-0027:'");
});

test("criterion 1: ReplayTest maps 'batchshard-' and keeps the four old prefixes and the unknown-prefix failure", () => {
  const r = must(LAST, REPLAY);
  for (const [prefix, cls] of Object.entries(PREFIXES)) {
    assert.match(r, new RegExp(`"${prefix}",\\s*${cls}\\.class`), `${prefix} is not mapped to ${cls}`);
  }
  assert.match(r, /@TestFactory|@ParameterizedTest/, 'no @TestFactory or @ParameterizedTest');
  assert.match(r, /Files\.(list|walk|newDirectoryStream)\(/, 'ReplayTest does not list the folder');
  assert.match(r, /WorkflowReplayer\.replayWorkflowExecution\(/);
  assert.match(r, /(AssertionError|fail)\(\s*"[^"]*"\s*\+\s*(file|name|path)/, 'no failure naming the file');
  assert.doesNotMatch(r, /Assumptions|assumeTrue|@Disabled/, 'ReplayTest can skip histories');
});

test('criterion 1: ReplayTest requires all eleven histories to be present', () => {
  const r = must(LAST, REPLAY);
  for (const n of ALL) assert.ok(r.includes(`"${n}"`), `ReplayTest doesn't name ${n}`);
  // Every named history sits in a List.of(...) that a @Test method checks for presence, failing "... is missing".
  assert.match(r, /is missing|missing history/);
  const lists = [...r.matchAll(/(\w+)\s*=\s*List\.of\(([^;]*)\);/g)].map((m) => ({ name: m[1], body: m[2] }));
  for (const n of ALL) {
    const l = lists.find((x) => x.body.includes(`"${n}"`));
    assert.ok(l, `${n} is not in a List.of(...) in ReplayTest`);
    const tests = [...r.matchAll(/@Test\s+void \w+\(\)[^{]*\{([\s\S]*?)\n    \}/g)].map((m) => m[1]);
    assert.ok(tests.some((b) => new RegExp(`\\b${l.name}\\b`).test(b)),
      `no @Test method checks the list ${l.name} that names ${n}`);
  }
  // The presence check fails when the file is missing (not just skipped).
  assert.match(r, /Files\.exists\([^;]*name \+ "\.json"\)+\s*fail\(/);
});

test('criterion 1/5: the folder holds the eleven histories and every one has a known prefix', () => {
  const files = historyFiles(LAST);
  for (const n of ALL) assert.ok(files.includes(`${n}.json`), `${n}.json is missing`);
  assert.ok(files.length >= 11, `expected at least eleven histories, got ${files.join(', ')}`);
  for (const f of files) {
    assert.ok(Object.keys(PREFIXES).some((p) => f.startsWith(p)), `${f} has no known prefix`);
    const ev = events(LAST, f.replace(/\.json$/, ''));
    assert.equal(ev[0].eventType, 'EVENT_TYPE_WORKFLOW_EXECUTION_STARTED', f);
  }
});

test('criterion 2: batchshard-v1-duplicate is a completed BatchShardWorkflow with a duplicate item and a vm- child', () => {
  const ev = events(LAST, 'batchshard-v1-duplicate');
  const started = ev[0].workflowExecutionStartedEventAttributes;
  assert.equal(started.workflowType.name, 'BatchShardWorkflow');

  // At least two items with the same spec.
  const input = JSON.parse(payloads(started.input)[0]);
  assert.ok(Array.isArray(input.items) && input.items.length >= 2, `the shard has fewer than two items: ${JSON.stringify(input)}`);
  const specs = input.items.map((i) => JSON.stringify(i.spec));
  assert.ok(specs.some((s, i) => specs.indexOf(s) !== i), 'no two items share a spec');

  const children = ev.filter((e) => e.eventType === 'EVENT_TYPE_START_CHILD_WORKFLOW_EXECUTION_INITIATED');
  assert.ok(children.some((e) => e.startChildWorkflowExecutionInitiatedEventAttributes.workflowId.startsWith('vm-')),
    'no START_CHILD_WORKFLOW_EXECUTION_INITIATED event with a vm- workflow ID');
  assert.equal(ev[ev.length - 1].eventType, 'EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED');

  // The recording test asserts running = 1, duplicate = 1 and exactly one created VM.
  const file = testNaming('batchshard-v1-duplicate');
  assert.ok(file, 'no test records batchshard-v1-duplicate');
  const src = must(LAST, file);
  assert.match(src, /TestWorkflowEnvironment/);
  const m = recordingMethod(src, 'batchshard-v1-duplicate');
  assert.match(m, /assertEquals\(1,\s*\w+\.running\(\)/, 'running = 1 is not asserted');
  assert.match(m, /assertEquals\(1,\s*\w+\.duplicate\(\)/, 'duplicate = 1 is not asserted');
  assert.match(m, /assertEquals\(1,\s*cloud\.created\.get\(\)/, 'exactly one created VM is not asserted');
});

test('criterion 3: catalog-v2-existing-vm is a CatalogRunWorkflow that used ExistingVm and started no vm- child for it', () => {
  const ev = events(LAST, 'catalog-v2-existing-vm');
  const started = ev[0].workflowExecutionStartedEventAttributes;
  assert.equal(started.workflowType.name, 'CatalogRunWorkflow');

  const existing = ev.filter((e) => e.eventType === 'EVENT_TYPE_ACTIVITY_TASK_SCHEDULED'
    && e.activityTaskScheduledEventAttributes.activityType.name === 'ExistingVm');
  assert.ok(existing.length >= 1, 'no ExistingVm activity was scheduled');
  const hashes = existing.flatMap((e) => payloads(e.activityTaskScheduledEventAttributes.input))
    .map((t) => { try { return JSON.parse(t); } catch { return t; } })
    .filter((h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h));
  assert.ok(hashes.length >= 1, 'the ExistingVm input is not a spec hash');

  // The VM was already RUNNING when the run looked it up.
  const found = ev.filter((e) => e.eventType === 'EVENT_TYPE_ACTIVITY_TASK_COMPLETED'
    && existing.some((s) => String(s.eventId) === String(e.activityTaskCompletedEventAttributes.scheduledEventId)));
  assert.ok(found.length >= 1, 'ExistingVm never completed');
  assert.ok(found.some((e) => /"state"\s*:\s*"RUNNING"/.test(payloads(e.activityTaskCompletedEventAttributes.result).join(' '))),
    'ExistingVm did not find a RUNNING VM');

  const childIds = ev.filter((e) => e.eventType === 'EVENT_TYPE_START_CHILD_WORKFLOW_EXECUTION_INITIATED')
    .map((e) => e.startChildWorkflowExecutionInitiatedEventAttributes.workflowId);
  for (const h of hashes) assert.ok(!childIds.includes('vm-' + h), `a vm-${h} child workflow was started`);

  // The recording test asserts the reuse: the "already built with this spec" text and no new create.
  const file = testNaming('catalog-v2-existing-vm');
  assert.ok(file, 'no test records catalog-v2-existing-vm');
  const src = must(LAST, file);
  assert.match(src, /TestWorkflowEnvironment/);
  const m = recordingMethod(src, 'catalog-v2-existing-vm');
  assert.match(m, /already built with this spec/, 'the step result text is not asserted');
  assert.match(m, /"RUNNING"/, 'the test does not check the VM is RUNNING before the recorded run');
  const before = /(\w+)\s*=\s*cloud\.created\.get\(\);/.exec(m);
  assert.ok(before, 'the create count before the recorded run is not captured');
  assert.match(m, new RegExp(`assertEquals\\(${before[1]},\\s*cloud\\.created\\.get\\(\\)`),
    "the test does not assert the create count didn't go up");
  assert.ok(m.indexOf(`${before[1]} = cloud.created.get()`) < m.lastIndexOf('start('),
    'the create count is captured after the recorded run started');
});

test('criterion 4: each recording scenario is an ordinary test that replays its fetched history before recording', () => {
  for (const name of NEW) {
    const file = testNaming(name);
    assert.ok(file, `no test records ${name}`);
    const src = must(LAST, file);
    const m = recordingMethod(src, name);
    assert.doesNotMatch(m, /@Disabled|assumeTrue|Assumptions|@EnabledIf|histories\.record/,
      `the ${name} scenario does not run in every mvn test`);
    const rec = new RegExp(`HistoryRecorder\\.record\\([^,]+,\\s*([^,]+?),\\s*"${name}"\\)`).exec(m);
    assert.ok(rec, `${name}: record call not found`);
    const id = rec[1].trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const replay = m.search(new RegExp(`WorkflowReplayer\\.replayWorkflowExecution\\(\\s*[^;]*fetchHistory\\(${id}\\)`));
    assert.ok(replay >= 0, `${name}: the fetched history (${rec[1]}) is not replayed with WorkflowReplayer`);
    assert.ok(replay < rec.index, `${name}: the replay comes after HistoryRecorder.record`);
  }
  // Not a disabled class either.
  for (const name of NEW) {
    const src = must(LAST, testNaming(name));
    assert.doesNotMatch(src.slice(0, src.indexOf('class ')), /@Disabled/);
  }
});

test('criterion 5: no tracked history file is modified or deleted in the working tree', () => {
  // A plain mvn test must write nothing; a changed or deleted tracked history would show up here.
  const st = git(['status', '--porcelain', '--', HISTORIES]).split('\n').filter(Boolean);
  const changed = st.filter((l) => !l.startsWith('??'));
  assert.deepEqual(changed, [], `tracked histories changed: ${changed.join('; ')}`);
  // Recording stays off by default.
  assert.doesNotMatch(must(LAST, 'backend/pom.xml'), /histories\.record/, 'pom.xml sets histories.record');
});

test('criterion 6: section 9 lists the batchshard- prefix and the two new histories, and keeps what it said', () => {
  const sec = section(must(LAST, TF), '## 9. Replay tests');
  const flat = sec.replace(/\s+/g, ' ');
  for (const p of Object.keys(PREFIXES)) assert.ok(flat.includes(`\`${p}\``), `section 9 doesn't name prefix ${p}`);
  assert.match(flat, /`batchshard-` → `BatchShardWorkflowImpl`/);
  assert.match(flat, /- `batchshard-v1-duplicate` is [^-]*(same spec|duplicate)/i, 'no description of batchshard-v1-duplicate');
  assert.match(flat, /- `catalog-v2-existing-vm` is [^]*?(already|existing|reus)/i, 'no description of catalog-v2-existing-vm');
  // Still there from before.
  assert.match(flat, /replays every file in `?backend\/src\/test\/resources\/histories`?/i);
  assert.match(flat, /prefix/i);
  assert.match(flat, /mvn test -Dhistories\.record=true/);
  assert.match(flat, /only (files that are missing|missing files)/i);
  assert.match(sec, /temporal workflow show --workflow-id [^\n]*--output json[^\n]*histories\//);
  for (const n of AP24) assert.ok(flat.includes(n), `section 9 doesn't name ${n}`);
});

test('criterion 7: AP-0027 commits only add histories, stay in backend/src/test, docs and tests/acceptance', () => {
  for (const sha of COMMITS) {
    const lines = git(['diff', '--name-status', '--no-renames', `${sha}^`, sha]).split('\n').filter(Boolean);
    for (const l of lines) {
      const [status, path] = l.split('\t');
      const short = sha.slice(0, 8);
      if (path.startsWith(`vm-intent/${HISTORIES}/`)) {
        assert.equal(status, 'A', `${short} ${status === 'D' ? 'deletes' : 'modifies'} existing history ${path}`);
      }
      assert.ok(!path.startsWith('vm-intent/backend/src/main/'), `${short} touches ${path}`);
      assert.ok(!path.startsWith('vm-intent/frontend/'), `${short} touches ${path}`);
      assert.ok(!/^vm-intent\/docs\/(openapi\.(json|ya?ml)|SECURITY\.md)$/.test(path), `${short} touches ${path}`);
      // The pipeline's protected paths (agent-pipeline/src/config.ts).
      assert.ok(!/^(agent-pipeline\/|\.github\/|\.gitlab-ci\.yml$)/.test(path), `${short} touches ${path}`);
      assert.ok(!/^vm-intent\/(deploy\/(azure|pki)\/|deploy\/catalog\/gitlab-ci|[^/]+\.(cmd|ps1)$)/.test(path),
        `${short} touches ${path}`);
      if (status === 'A') {
        assert.ok(/^vm-intent\/(backend\/src\/test\/|docs\/|tests\/acceptance\/)/.test(path),
          `${short} adds ${path} outside backend/src/test, docs and tests/acceptance`);
      }
    }
  }
  // Each of the nine older histories is byte-for-byte what it was before AP-0027.
  for (const n of [...V1, ...AP24]) {
    assert.equal(at(LAST, `${HISTORIES}/${n}.json`), at(`${FIRST}^`, `${HISTORIES}/${n}.json`), `${n} changed`);
  }
});
