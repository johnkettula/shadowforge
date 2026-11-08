// AP-0024 acceptance, repository half (criteria 1-7): a test-only HistoryRecorder that writes a missing history only
// with -Dhistories.record=true, ReplayTest replaying every file in histories/ by file-name prefix (and still naming
// the seven v1 histories), two new recorded histories (intent-v2-multi-existing, lifecycle-v1-renewed), the
// TEMPORAL-FEATURES update, and no AP-0024 commit touching main code, the frontend, the API snapshot, protected files
// or an existing history.
//
// Files are read as they were at the newest AP-0024 commit, and "must not change" checks look only at AP-0024
// commits, so later requirements can change these files without breaking this suite. The build gates run mvn test;
// this suite only reads files.
//
//   node --test tests/acceptance/ap-0024/repo.test.mjs
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
const RECORDER_TEST = `${WF}/HistoryRecorderTest.java`;

const V1 = ['intent-v1-completed', 'intent-v1-cancelled', 'intent-v1-open', 'reconcile-v1-completed',
  'catalog-v1-resumed', 'catalog-v1-torn-down', 'catalog-v1-approved'];
const NEW = ['intent-v2-multi-existing', 'lifecycle-v1-renewed'];
const PREFIXES = { 'intent-': 'IntentWorkflowImpl', 'reconcile-': 'VmReconcileWorkflowImpl',
  'catalog-': 'CatalogRunWorkflowImpl', 'lifecycle-': 'VmLifecycleWorkflowImpl' };

const git = (args) => execFileSync('git', args,
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

// Oldest first.
const COMMITS = git(['log', '--reverse', '--format=%H', '--grep', '^AP-0024:']).split('\n').filter(Boolean);
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
/** The table rows ('| `Name` | text |') of a section, as name -> description. */
function tableRows(sec) {
  const rows = new Map();
  for (const l of sec.split('\n')) {
    const m = /^\|\s*`(\w+)`\s*\|\s*(.*?)\s*\|\s*$/.exec(l);
    if (m) rows.set(m[1], m[2]);
  }
  return rows;
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
/** The vm-intent/-relative path of the test class that records history <name> through HistoryRecorder, or undefined. */
function testNaming(name) {
  let out = '';
  try {
    out = git(['grep', '-l', '-F', `HistoryRecorder.record(`, LAST, '--', `:(top)vm-intent/${WF}`]);
  } catch { return undefined; }
  return out.split('\n').filter(Boolean).map((l) => l.replace(`${LAST}:`, '').replace(/^vm-intent\//, ''))
    .find((rel) => rel !== RECORDER && must(LAST, rel).includes(`"${name}"`));
}
/** The body of a Java method (from its name up to the closing brace at 4-space indent). */
function method(java, name) {
  const m = new RegExp(`\\b${name}\\s*\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n    \\}`).exec(java);
  assert.ok(m, `method ${name} not found`);
  return m[1];
}

test('there is at least one AP-0024 commit', () => {
  assert.ok(COMMITS.length > 0, "no commit whose subject starts with 'AP-0024:'");
});

test('criterion 1: HistoryRecorder is test-only and writes a missing file only with histories.record=true', () => {
  const src = must(LAST, RECORDER);
  assert.equal(at(LAST, 'backend/src/main/java/com/example/vmintent/workflow/HistoryRecorder.java'), null,
    'HistoryRecorder must not be in src/main');
  assert.match(src, /^package com\.example\.vmintent\.workflow;/m);
  // Takes a WorkflowClient, a workflow ID and a file name.
  assert.match(src, /\brecord\s*\(\s*WorkflowClient \w+,\s*String \w+,\s*String \w+\s*\)/);
  // Standard protobuf JSON of the fetched history.
  assert.match(src, /fetchHistory\(/);
  assert.match(src, /JsonFormat\.printer\(\)/);
  // The default target is backend/src/test/resources/histories/<name>.json.
  assert.match(src, /"src",\s*"test",\s*"resources",\s*"histories"|src\/test\/resources\/histories/);
  assert.match(src, /name \+ "\.json"/);
  // Only when the property is exactly "true", and only a missing file; never overwrite or delete.
  assert.match(src, /"histories\.record"/);
  assert.match(src, /"true"\.equals\(System\.getProperty\(|Boolean\.parseBoolean\(System\.getProperty\(/);
  assert.match(src, /Files\.exists\(/);
  assert.match(src, /CREATE_NEW/);
  assert.doesNotMatch(src, /TRUNCATE_EXISTING|Files\.delete|deleteIfExists|\.delete\(\)|REPLACE_EXISTING|Files\.move/);
  // The property check comes before any write.
  const prop = src.indexOf('System.getProperty(');
  const write = src.search(/Files\.write/);
  assert.ok(prop >= 0 && write > prop, 'the property is not checked before writing');

  // The Maven build must not switch recording on by default.
  const pom = must(LAST, 'backend/pom.xml');
  assert.doesNotMatch(pom, /histories\.record/, 'pom.xml sets histories.record');
});

test('criterion 1: HistoryRecorderTest shows unset -> nothing, true -> written and parsable, existing -> unchanged', () => {
  const t = must(LAST, RECORDER_TEST);
  assert.match(t, /@TempDir/);
  assert.match(t, /HistoryRecorder\.record\([^;]*,\s*dir\)/, 'the unit test does not target the temporary folder');

  const tests = [...t.matchAll(/@Test\s+void (\w+)\(\)[^{]*\{([\s\S]*?)\n    \}/g)].map((m) => ({ name: m[1], body: m[2] }));
  const unset = tests.find((x) => /clearProperty\(/.test(x.body) && /assertFalse\(HistoryRecorder\.record/.test(x.body));
  assert.ok(unset, 'no test that records with the property unset and expects nothing');
  assert.match(unset.body, /Files\.list\(dir\)[\s\S]*assertEquals\(0,/, 'the unset test does not check the folder is empty');

  const written = tests.find((x) => /setProperty\([^)]*"true"\)/.test(x.body) && /assertTrue\(HistoryRecorder\.record/.test(x.body));
  assert.ok(written, 'no test that records with the property true and expects a file');
  assert.match(written.body, /ReplayTest\.(parse|history)\(/, 'the written file is not read back the way ReplayTest reads it');
  assert.match(written.body, /EVENT_TYPE_WORKFLOW_EXECUTION_STARTED/);

  const existing = tests.find((x) => /assertArrayEquals\(/.test(x.body) && /assertFalse\(HistoryRecorder\.record/.test(x.body));
  assert.ok(existing, 'no test that leaves an existing file byte-for-byte unchanged');
  assert.match(existing.body, /setProperty\([^)]*"true"\)/, 'the existing-file test does not switch recording on');
  assert.match(existing.body, /Files\.readAllBytes\(/);
});

test('criterion 2: ReplayTest replays every *.json in the folder, by file-name prefix, and fails on an unknown one', () => {
  const r = must(LAST, REPLAY);
  assert.match(r, /@TestFactory|@ParameterizedTest/, 'no @TestFactory or @ParameterizedTest');
  assert.match(r, /Files\.(list|walk|newDirectoryStream)\(/, 'ReplayTest does not list the folder');
  assert.match(r, /\.json/);
  for (const [prefix, cls] of Object.entries(PREFIXES)) {
    assert.match(r, new RegExp(`"${prefix}",\\s*${cls}\\.class`), `${prefix} is not mapped to ${cls}`);
  }
  assert.match(r, /WorkflowReplayer\.replayWorkflowExecution\(/);
  // An unmatched prefix fails with the file's name.
  assert.match(r, /(AssertionError|fail)\(\s*"[^"]*"\s*\+\s*(file|name|path)/, 'no failure naming the file');
  assert.doesNotMatch(r, /Assumptions|assumeTrue|@Disabled/, 'ReplayTest can skip histories');

  // The seven v1 names are still there and asserted present.
  for (const n of V1) assert.ok(r.includes(`"${n}"`), `ReplayTest doesn't name ${n}`);
  assert.match(r, /is missing|missing history/);
  assert.match(r, /static WorkflowExecutionHistory history\(String name\)/);
  assert.match(r, /"\/histories\/" \+ name \+ "\.json"/);
});

test('criterion 2/5: the folder holds the nine histories and every one has a known prefix', () => {
  const files = historyFiles(LAST);
  for (const n of [...V1, ...NEW]) assert.ok(files.includes(`${n}.json`), `${n}.json is missing`);
  assert.equal(files.length, 9, `expected nine histories at AP-0024, got ${files.join(', ')}`);
  for (const f of files) {
    assert.ok(Object.keys(PREFIXES).some((p) => f.startsWith(p)), `${f} has no known prefix`);
  }
  // Every one is standard protobuf JSON that starts with a STARTED event.
  for (const f of files) {
    const ev = events(LAST, f.replace(/\.json$/, ''));
    assert.equal(ev[0].eventType, 'EVENT_TYPE_WORKFLOW_EXECUTION_STARTED', f);
  }
});

test('criterion 3: intent-v2-multi-existing is a completed IntentWorkflow for two VMs with a vm- child', () => {
  const ev = events(LAST, 'intent-v2-multi-existing');
  const started = ev[0].workflowExecutionStartedEventAttributes;
  assert.equal(ev[0].eventType, 'EVENT_TYPE_WORKFLOW_EXECUTION_STARTED');
  assert.equal(started.workflowType.name, 'IntentWorkflow');
  const input = (started.input?.payloads || []).map(payloadText).join(' ');
  assert.match(input, /\b(2|two)\b/i, `the request does not ask for two VMs: ${input}`);

  const children = ev.filter((e) => e.eventType === 'EVENT_TYPE_START_CHILD_WORKFLOW_EXECUTION_INITIATED');
  assert.ok(children.length >= 1, 'no START_CHILD_WORKFLOW_EXECUTION_INITIATED event');
  assert.ok(children.some((e) => e.startChildWorkflowExecutionInitiatedEventAttributes.workflowId.startsWith('vm-')),
    'no child workflow ID starts with vm-');
  assert.equal(ev[ev.length - 1].eventType, 'EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED');

  // The result says one of the two already existed.
  const result = (ev[ev.length - 1].workflowExecutionCompletedEventAttributes.result?.payloads || [])
    .map(payloadText).join(' ');
  assert.match(result, /COMPLETED/);
  assert.match(result, /1 already existed/);

  // The recording test asserts COMPLETED and one already-existing VM, and records through HistoryRecorder.
  const file = testNaming('intent-v2-multi-existing');
  assert.ok(file, 'no test names intent-v2-multi-existing');
  const src = must(LAST, file);
  assert.match(src, /TestWorkflowEnvironment/);
  const body = src.slice(0, src.indexOf('"intent-v2-multi-existing"'));
  const last = body.slice(body.lastIndexOf('@Test'));
  assert.match(last, /assertEquals\("COMPLETED"/);
  assert.match(last, /1 already existed/);
  assert.match(src, /HistoryRecorder\.record\([^;]*"intent-v2-multi-existing"\)/);
});

test('criterion 4: lifecycle-v1-renewed is a life- VmLifecycleWorkflow that took a renew update', () => {
  const ev = events(LAST, 'lifecycle-v1-renewed');
  const started = ev[0].workflowExecutionStartedEventAttributes;
  assert.equal(started.workflowType.name, 'VmLifecycleWorkflow');

  const accepted = ev.filter((e) => e.eventType === 'EVENT_TYPE_WORKFLOW_EXECUTION_UPDATE_ACCEPTED');
  const completed = ev.filter((e) => e.eventType === 'EVENT_TYPE_WORKFLOW_EXECUTION_UPDATE_COMPLETED');
  assert.ok(accepted.length >= 1, 'no UPDATE_ACCEPTED event');
  assert.ok(completed.length >= 1, 'no UPDATE_COMPLETED event');
  assert.ok(accepted.some((e) => e.workflowExecutionUpdateAcceptedEventAttributes.acceptedRequest.input.name === 'renew'),
    'no accepted update is named renew');

  // The workflow's own ID isn't in its history: it is "life-" + spec hash, started by the "vm-" + spec hash build.
  const input = JSON.parse(payloadText(started.input.payloads[0]));
  assert.match(input.specHash, /^[0-9a-f]{64}$/);
  assert.equal(started.parentWorkflowExecution.workflowId, 'vm-' + input.specHash);
  const ident = must(LAST, 'backend/src/main/java/com/example/vmintent/spec/VmIdentity.java');
  assert.match(ident, /return "life-" \+ hash;/);

  const file = testNaming('lifecycle-v1-renewed');
  assert.ok(file, 'no test names lifecycle-v1-renewed');
  const src = must(LAST, file);
  const m = /HistoryRecorder\.record\([^,]+,\s*(\w+),\s*"lifecycle-v1-renewed"\)/.exec(src);
  assert.ok(m, 'lifecycle-v1-renewed is not recorded through HistoryRecorder');
  assert.match(src, new RegExp(`${m[1]} = VmLifecycleWorkflowImpl\\.workflowId\\(`));
  assert.match(src, new RegExp(`assertTrue\\(${m[1]}\\.startsWith\\("life-"\\)`));
  assert.match(src, /\.renew\(/);
});

test('criterion 5: no tracked history file is modified or deleted in the working tree', () => {
  // A plain mvn test must write nothing; a changed or deleted tracked history would show up here.
  const st = git(['status', '--porcelain', '--', HISTORIES]).split('\n').filter(Boolean);
  const changed = st.filter((l) => !l.startsWith('??'));
  assert.deepEqual(changed, [], `tracked histories changed: ${changed.join('; ')}`);
});

test("criterion 6: section 9 describes replay-everything, prefixes, in-repo recording and the new histories", () => {
  const sec = section(must(LAST, TF), '## 9. Replay tests');
  const flat = sec.replace(/\s+/g, ' ');
  assert.match(flat, /replays every file in `?backend\/src\/test\/resources\/histories`?/i);
  for (const p of Object.keys(PREFIXES)) assert.ok(flat.includes(`\`${p}\``), `section 9 doesn't name prefix ${p}`);
  assert.match(flat, /prefix/i);
  assert.match(flat, /TestWorkflowEnvironment/);
  assert.match(flat, /mvn test -Dhistories\.record=true/);
  assert.match(flat, /only (files that are missing|missing files)/i);
  for (const n of NEW) assert.ok(flat.includes(n), `section 9 doesn't name ${n}`);
  assert.match(sec, /temporal workflow show --workflow-id [^\n]*--output json[^\n]*histories\//);
  // The old instruction to add a @Test method per file is gone.
  assert.doesNotMatch(flat, /A new file on its own is never replayed/);
});

test("criterion 6: section 12's ReplayTest and HistoryRecorder rows match the code", () => {
  const rows = tableRows(section(must(LAST, TF), '## 12. Time-skipping tests'));
  const r = rows.get('ReplayTest');
  assert.ok(r, 'no ReplayTest row');
  assert.match(r, /every saved history/i);
  assert.match(r, /prefix/i);
  assert.match(r, /seven/i);
  const h = rows.get('HistoryRecorderTest');
  if (h) {
    assert.match(h, /-Dhistories\.record=true/);
    assert.match(h, /missing file/i);
    assert.match(h, /byte-for-byte|unchanged/i);
  }
  for (const name of rows.keys()) {
    if (/Recorder|Recorded/.test(name)) assert.ok(at(LAST, `${WF}/${name}.java`) !== null, `${name} in the table has no class`);
  }
});

test('criterion 7: AP-0024 commits only add histories, stay in backend/src/test, docs and tests/acceptance', () => {
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
  // Each of the seven old histories is byte-for-byte what it was before AP-0024.
  for (const n of V1) {
    assert.equal(at(LAST, `${HISTORIES}/${n}.json`), at(`${FIRST}^`, `${HISTORIES}/${n}.json`), `${n} changed`);
  }
});
