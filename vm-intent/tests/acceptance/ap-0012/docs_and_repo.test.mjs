// AP-0012 acceptance, repository half: docs/API.md, docs/USER-GUIDE.md and docs/TEMPORAL-FEATURES.md describe
// the final states; the workflow unit tests cover COMPLETED-with-existing and PARTIAL and replay a history; and
// the commit scope. Covers criteria 5, 6, 7 and 9. Reads files and git history only; it does not run mvn (the
// pipeline's build gates do).
//
//   node --test tests/acceptance/ap-0012/docs_and_repo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const FINAL = ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'DUPLICATE'];
const TEST_DIR = 'backend/src/test/java/com/example/vmintent/workflow/';
const IFACE = 'vm-intent/backend/src/main/java/com/example/vmintent/workflow/IntentWorkflow.java';

/** The text of a markdown section, from its heading to the next heading of the same or higher level. */
function section(md, headingRe) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => headingRe.test(l));
  assert.ok(start >= 0, `found heading ${headingRe}`);
  const level = /^#+/.exec(lines[start])[0].length;
  let end = start + 1;
  while (end < lines.length && !(new RegExp(`^#{1,${level}} `).test(lines[end]))) end++;
  return lines.slice(start, end).join('\n');
}

const ap0012Commits = () => {
  const shas = git('log', '--format=%H', '--no-merges', '--grep=^AP-0012:').split('\n').filter(Boolean);
  assert.ok(shas.length > 0, 'found the AP-0012 commits');
  return shas;
};

// ---- Criterion 5 ----
test('5: docs/API.md Conventions name all five final request states', () => {
  const conv = section(read('docs/API.md'), /^## Conventions/);
  const line = conv.split(/\n(?=- )/).find((b) => /Final request states/i.test(b));
  assert.ok(line, 'Conventions has a "Final request states" item');
  for (const s of FINAL) assert.match(line, new RegExp(`\\b${s}\\b`), `${s} is named: ${line}`);
});

test('5: docs/API.md clarifyRequest and cancelRequest rows still say "already finished" and 409', () => {
  const md = read('docs/API.md').split('\n');
  for (const id of ['clarifyRequest', 'cancelRequest']) {
    const row = md.find((l) => l.startsWith(`| \`${id}\``));
    assert.ok(row, `docs/API.md has a ${id} row`);
    assert.match(row, /already finished/, `${id} row: ${row}`);
    assert.match(row, /409/, `${id} row: ${row}`);
  }
});

test('5: docs/USER-GUIDE.md final-state table: some existed + rest built -> COMPLETED; PARTIAL = at least one failed', () => {
  const rows = read('docs/USER-GUIDE.md').split('\n').filter((l) => l.startsWith('| '));
  const completed = rows.find((l) => /^\|\s*COMPLETED\s*\|/.test(l));
  const partial = rows.find((l) => /^\|\s*PARTIAL\s*\|/.test(l));
  assert.ok(completed && partial, 'the table has COMPLETED and PARTIAL rows');
  assert.match(completed, /already existed/i, `COMPLETED row covers VMs that already existed: ${completed}`);
  assert.match(completed, /rest (were )?built|others (were )?built|remaining|missing/i, `COMPLETED row: the rest built: ${completed}`);
  assert.match(completed, /several|multi/i, `COMPLETED row is about a request for several VMs: ${completed}`);
  assert.match(partial, /at least one (VM )?failed|one or more failed/i, `PARTIAL row says at least one VM failed: ${partial}`);
  for (const s of FINAL) assert.ok(rows.some((l) => new RegExp(`^\\|\\s*${s}\\s*\\|`).test(l)), `table has a ${s} row`);
});

test('5: docs/TEMPORAL-FEATURES.md section 8 says the same', () => {
  const s8 = section(read('docs/TEMPORAL-FEATURES.md'), /^## 8\. /).replace(/\s+/g, ' ');
  assert.match(s8, /COMPLETED/);
  assert.match(s8, /already existed/i, `section 8 says VMs that already existed still give COMPLETED: ${s8}`);
  assert.match(s8, /COMPLETED[^.]*already existed/i, `already existed is tied to COMPLETED: ${s8}`);
  assert.match(s8, /PARTIAL \([^)]*at least one failed/i, `PARTIAL means at least one failed: ${s8}`);
  assert.doesNotMatch(s8, /PARTIAL \(some failed\)/, 'the old PARTIAL wording is gone');
});

// ---- Criteria 6 and 7 (presence; mvn test itself runs in the pipeline's build gate) ----
function workflowTests() {
  return readdirSync(join(ROOT, TEST_DIR)).filter((f) => f.endsWith('.java'))
    .map((f) => ({ f, src: read(TEST_DIR + f) }));
}

/** Each @Test method body in the workflow test folder. */
function testMethods() {
  const out = [];
  for (const { f, src } of workflowTests()) {
    const parts = src.split(/\n\s*@Test\b/).slice(1);
    for (const p of parts) {
      const end = p.search(/\n    }\n/);
      out.push({ f, body: end > 0 ? p.slice(0, end) : p });
    }
  }
  return out;
}

test('6a: a unit test runs a multi-VM request where some existed -> COMPLETED naming them, nothing rebuilt', () => {
  const m = testMethods().find(({ body }) =>
    /"COMPLETED"/.test(body) && /already existed/.test(body) && /servers?|vms?/i.test(body)
    && (body.match(/start\(/g) || []).length >= 2);
  assert.ok(m, 'a test starts two multi-VM requests and expects COMPLETED with "already existed"');
  assert.doesNotMatch(m.body, /assertEquals\(\s*"PARTIAL"/, 'that test does not expect PARTIAL');
  assert.match(m.body, /created/, 'it checks how many VMs were created (nothing rebuilt for the existing ones)');
});

test('6b: a unit test where some VMs build and one fails -> PARTIAL, only the failed one rolled back', () => {
  const m = testMethods().find(({ body }) => /assertEquals\(\s*"PARTIAL"/.test(body));
  assert.ok(m, 'a test expects PARTIAL');
  assert.match(m.body, /deleted/, 'it checks what was deleted (rolled back)');
  assert.match(m.body, /deleted\.size\(\)\)|deleted\.size\(\),|assertEquals\(\s*1\s*,\s*\w+\.deleted\.size\(\)/,
    'it checks the number of rolled-back VMs');
});

test('6c: the existing all-built COMPLETED, all-failed FAILED and all-existing DUPLICATE tests are unchanged', () => {
  // Every @Test method in IntentWorkflowTest before the first AP-0012 commit is still there with the same body.
  const shas = ap0012Commits();
  const oldest = shas[shas.length - 1];
  const path = `vm-intent/${TEST_DIR}IntentWorkflowTest.java`;
  const before = git('show', `${oldest}^:${path}`).replace(/\r\n/g, '\n');
  const now = read(TEST_DIR + 'IntentWorkflowTest.java');
  const methods = (src) => {
    const map = new Map();
    for (const p of src.split(/\n\s*@Test\b/).slice(1)) {
      const name = /void\s+(\w+)\s*\(/.exec(p)?.[1];
      const end = p.search(/\n    }\n/);
      if (name) map.set(name, (end > 0 ? p.slice(0, end) : p).trim());
    }
    return map;
  };
  const was = methods(before);
  const is = methods(now);
  assert.ok(was.size > 0, 'found the earlier tests');
  const outcomes = [...was.values()].join('\n');
  for (const s of ['"COMPLETED"', '"FAILED"', '"DUPLICATE"']) assert.ok(outcomes.includes(s), `an earlier test checks ${s}`);
  for (const [name, body] of was) {
    assert.ok(is.has(name), `IntentWorkflowTest.${name} still exists`);
    assert.equal(is.get(name), body, `IntentWorkflowTest.${name} is unchanged`);
  }
});

test('7: a new test replays a fetched history against IntentWorkflowImpl; ReplayTest histories untouched', () => {
  const replaying = testMethods().filter(({ body }) =>
    /WorkflowReplayer\.replayWorkflowExecution\(\s*[^;]*fetchHistory\([^;]*IntentWorkflowImpl\.class/.test(body));
  assert.ok(replaying.some(({ body }) => /assertEquals\(\s*"PARTIAL"/.test(body)
    || (/"COMPLETED"/.test(body) && /already existed/.test(body))),
  'the COMPLETED-with-existing or PARTIAL test replays its own history');
  const replay = read(TEST_DIR + 'ReplayTest.java');
  assert.match(replay, /histories/, 'ReplayTest still replays the histories folder');
});

// ---- Criterion 9 ----
/** The Temporal-annotated method declarations of IntentWorkflow, normalised. */
function temporalMethods(src) {
  const body = src.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const re = /(@(?:WorkflowMethod|SignalMethod|QueryMethod|UpdateMethod|UpdateValidatorMethod)\b[^;]*?;)/g;
  return (body.match(re) || []).map((s) => s.replace(/\s+/g, ' ').trim()).sort();
}

test('9: no AP-0012 commit changes the IntentWorkflow interface or adds Workflow.getVersion', () => {
  for (const sha of ap0012Commits()) {
    const files = git('show', '--name-only', '--format=', '--no-renames', sha).split('\n').filter(Boolean);
    if (files.includes(IFACE)) {
      const a = temporalMethods(git('show', `${sha}^:${IFACE}`).replace(/\r\n/g, '\n'));
      const b = temporalMethods(git('show', `${sha}:${IFACE}`).replace(/\r\n/g, '\n'));
      assert.deepEqual(b, a, `${sha.slice(0, 7)} changes IntentWorkflow's Temporal methods`);
    }
    const added = git('show', '--format=', '-U0', sha, '--', '*.java').split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    for (const l of added) assert.doesNotMatch(l, /\bgetVersion\s*\(/, `${sha.slice(0, 7)} adds a getVersion call: ${l}`);
  }
});

test('9: no AP-0012 commit touches protected paths or changes / deletes a replay history', () => {
  const protectedPath = [
    /(^|\/)backend\/src\/main\/java\/com\/example\/vmintent\/security\//,
    /(^|\/)backend\/src\/main\/resources\/catalog\//,
    /(^|\/)backend\/src\/main\/resources\/application[^/]*\.(ya?ml|properties)$/,
    /^vm-intent\/deploy\//,
    /^agent-pipeline\//,
  ];
  for (const sha of ap0012Commits()) {
    const changes = git('show', '--name-status', '--format=', '--no-renames', sha).split('\n').filter(Boolean)
      .map((l) => l.split('\t'));
    for (const [st, path] of changes) {
      for (const re of protectedPath) assert.doesNotMatch(path, re, `${sha.slice(0, 7)} touches protected ${path}`);
      if (/backend\/src\/test\/resources\/histories\//.test(path)) {
        assert.equal(st, 'A', `${sha.slice(0, 7)} changes or deletes existing history ${path} (${st})`);
      }
    }
  }
});
