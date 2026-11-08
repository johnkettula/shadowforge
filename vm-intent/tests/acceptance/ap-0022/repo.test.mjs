// AP-0022 acceptance, repository half (criteria 1-6): the daily-docs update for 2026-11-08.
// TEMPORAL-FEATURES.md section 12 gains rows for RequestControllerTest, VmControllerTest and RequestOwnerFlowTest
// (keeping every old row), section 9 says where the histories live, which ones predate which features and how a
// new one gets replayed; README's code map names VmIdentity (spec/) and RequestOwner (api/); both files say
// 'Last updated 2026-11-08.'; and no AP-0022 commit touches code, the API snapshot, protected files or adds a file.
//
// Doc text and class files are read as they were at the newest AP-0022 commit, and "must not change" checks look
// only at AP-0022 commits, so later requirements can change these files without breaking this suite.
//
//   node --test tests/acceptance/ap-0022/repo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const README = 'README.md';
const TF = 'docs/TEMPORAL-FEATURES.md';
const HISTORIES = 'backend/src/test/resources/histories';
const REPLAY = 'backend/src/test/java/com/example/vmintent/workflow/ReplayTest.java';

const git = (args) => execFileSync('git', args,
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

// Oldest first.
const COMMITS = git(['log', '--reverse', '--format=%H', '--grep', '^AP-0022:']).split('\n').filter(Boolean);
const LAST = COMMITS[COMMITS.length - 1];
const FIRST = COMMITS[0];

/** A vm-intent/ file as it was at a commit, or null if it didn't exist. */
function at(sha, rel) {
  try { return git(['show', `${sha}:vm-intent/${rel}`]).replace(/\r\n/g, '\n'); } catch { return null; }
}
function exists(sha, rel) {
  try { git(['cat-file', '-e', `${sha}:vm-intent/${rel}`]); return true; } catch { return false; }
}
/** The text of a '## N. ...' section up to the next '## ' heading. */
function section(md, heading) {
  const i = md.indexOf('\n' + heading);
  assert.ok(i >= 0, `section "${heading}" not found`);
  const rest = md.slice(i + 1);
  const j = rest.indexOf('\n## ', 1);
  return j < 0 ? rest : rest.slice(0, j);
}
/** First line after the title, skipping blank lines. */
function lineUnderTitle(md) {
  const lines = md.split('\n');
  assert.match(lines[0], /^# /, 'first line is not a title');
  return lines.slice(1).find((l) => l.trim() !== '');
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
/** The code block under README's 'How the code is organised'. */
function codeMap(md) {
  const i = md.indexOf('How the code is organised');
  assert.ok(i >= 0, "README has no 'How the code is organised'");
  const start = md.indexOf('```', i);
  const end = md.indexOf('```', start + 3);
  assert.ok(start > 0 && end > start, 'no code block after the heading');
  return md.slice(md.indexOf('\n', start) + 1, end);
}
/** A code-map entry ('  spec/  ...') plus its indented continuation lines, joined. */
function entry(block, dir) {
  const lines = block.split('\n');
  const i = lines.findIndex((l) => l.startsWith(`  ${dir}/ `));
  assert.ok(i >= 0, `no ${dir}/ line in the code map`);
  const out = [lines[i]];
  for (let j = i + 1; j < lines.length && /^ {6,}\S/.test(lines[j]); j++) out.push(lines[j]);
  return out.join(' ').replace(/\s+/g, ' ');
}

test('there is at least one AP-0022 commit', () => {
  assert.ok(COMMITS.length > 0, "no commit whose subject starts with 'AP-0022:'");
});

test('criterion 1: section 12 has the three new rows and keeps every old one', () => {
  const now = tableRows(section(at(LAST, TF), '## 12. Time-skipping tests'));

  const rc = now.get('RequestControllerTest');
  assert.ok(rc, 'no RequestControllerTest row');
  assert.match(rc, /answer/i);
  assert.match(rc, /cancel/i);
  assert.match(rc, /409/);
  assert.match(rc, /finished/i);
  assert.match(rc, /404/);
  assert.match(rc, /unknown ID/i);

  const vc = now.get('VmControllerTest');
  assert.ok(vc, 'no VmControllerTest row');
  assert.match(vc, /day-2/i);
  assert.match(vc, /404[^|]*spec hash[^|]*no VM/i);
  assert.match(vc, /409[^|]*exists[^|]*can't be changed/i);
  assert.match(vc, /400[^|]*malformed hash/i);

  const ro = now.get('RequestOwnerFlowTest');
  assert.ok(ro, 'no RequestOwnerFlowTest row');
  assert.match(ro, /owner/i);
  assert.match(ro, /sign-in/i);
  assert.match(ro, /anonymous/);
  assert.match(ro, /sign-in is off/i);
  assert.match(ro, /never from `?userId`? or `?requestedBy`?/);
  for (const w of [/single request/i, /multi-VM request/i, /batch/i, /preview/i, /legacy endpoint/i]) {
    assert.match(ro, w, `RequestOwnerFlowTest row doesn't mention ${w}`);
  }

  const before = tableRows(section(at(`${FIRST}^`, TF), '## 12. Time-skipping tests'));
  assert.ok(before.size >= 5, 'could not read the old table');
  for (const [name, text] of before) {
    assert.equal(now.get(name), text, `old row ${name} is missing or changed`);
  }
});

test('criterion 2: section 9 says where the histories are, which predate what, and how a new one is replayed', () => {
  const sec = section(at(LAST, TF), '## 9. Replay tests');
  const flat = sec.replace(/\s+/g, ' ');
  assert.match(flat, /backend\/src\/test\/resources\/histories/);
  assert.doesNotMatch(flat, /recorded from the code \*?before\*? these features were added/i,
    'still says all histories predate these features');
  assert.match(flat, /`intent-v1-\*`/);
  assert.match(flat, /`reconcile-v1-\*`/);
  assert.match(flat, /before\*? the lifecycle, update and link features/i);
  assert.match(flat, /three `catalog-v1-\*` histories are real catalog runs \(resumed, torn down, approved\)/i);
  assert.match(sec, /temporal workflow show --workflow-id [^\n]*--output json[^\n]*histories\//);
  assert.match(flat, /`@Test` method/);
  assert.match(flat, /`ReplayTest`/);
  assert.match(flat, /history\("<file name without \.json>"\)/);
  assert.match(flat, /workflow class to replay it against/i);
  assert.match(flat, /IntentWorkflowImpl\.class/);
  // The instructions come after the temporal command.
  assert.ok(sec.indexOf('history("<file name') > sec.indexOf('temporal workflow show'));
});

test("criterion 3: README's code map names VmIdentity and RequestOwner and nothing else changes", () => {
  const block = codeMap(at(LAST, README));
  const spec = entry(block, 'spec');
  assert.match(spec, /VmIdentity/);
  assert.match(spec, /one place/i);
  assert.match(spec, /spec hash/i);
  assert.match(spec, /vm-\/life- workflow IDs/);
  const api = entry(block, 'api');
  assert.match(api, /RequestOwner/);
  assert.match(api, /owner/i);
  assert.match(api, /sign-in/i);
  assert.match(api, /'anonymous' when sign-in is off/);

  // Every other line of the block is as it was before AP-0022.
  const strip = (b) => b.split('\n').filter((l, i, all) => {
    if (/^  (spec|api)\/ /.test(l)) return false;
    // continuation lines of spec/ and api/
    if (/^ {6,}\S/.test(l)) {
      let k = i - 1;
      while (k >= 0 && /^ {6,}\S/.test(all[k])) k--;
      if (k >= 0 && /^  (spec|api)\/ /.test(all[k])) return false;
    }
    return true;
  }).join('\n');
  assert.equal(strip(block), strip(codeMap(at(`${FIRST}^`, README))), 'other code-map lines changed');
});

test('criterion 4: the named classes, the seven histories and ReplayTest match the docs', () => {
  for (const rel of [
    'backend/src/test/java/com/example/vmintent/api/RequestControllerTest.java',
    'backend/src/test/java/com/example/vmintent/api/VmControllerTest.java',
    'backend/src/test/java/com/example/vmintent/api/RequestOwnerFlowTest.java',
    'backend/src/main/java/com/example/vmintent/spec/VmIdentity.java',
    'backend/src/main/java/com/example/vmintent/api/RequestOwner.java',
  ]) assert.ok(exists(LAST, rel), `${rel} doesn't exist`);

  const vmId = at(LAST, 'backend/src/main/java/com/example/vmintent/spec/VmIdentity.java');
  assert.match(vmId, /"vm-"\s*\+/);
  assert.match(vmId, /"life-"\s*\+/);
  assert.match(vmId, /static String hash\(/);
  assert.match(at(LAST, 'backend/src/main/java/com/example/vmintent/api/RequestOwner.java'), /anonymous/);

  const files = git(['ls-tree', '--full-tree', '--name-only', `${LAST}:vm-intent/${HISTORIES}`]).split('\n').filter(Boolean).sort();
  assert.deepEqual(files, [
    'catalog-v1-approved.json', 'catalog-v1-resumed.json', 'catalog-v1-torn-down.json',
    'intent-v1-cancelled.json', 'intent-v1-completed.json', 'intent-v1-open.json',
    'reconcile-v1-completed.json',
  ]);

  const replay = at(LAST, REPLAY);
  const tests = [...replay.matchAll(/@Test\b[\s\S]*?\{([\s\S]*?)\n    \}/g)].map((m) => m[1]);
  for (const f of files) {
    const name = f.replace(/\.json$/, '');
    const owners = tests.filter((b) => b.includes(`history("${name}")`));
    assert.equal(owners.length, 1, `history("${name}") should be named in exactly one @Test method`);
  }
  assert.match(replay, /static WorkflowExecutionHistory history\(String name\)/);
  assert.match(replay, /"\/histories\/" \+ name \+ "\.json"/);
});

test("criterion 5: 'Last updated 2026-11-08.' under the title of README and TEMPORAL-FEATURES only", () => {
  for (const rel of [README, TF]) {
    assert.equal(lineUnderTitle(at(LAST, rel)), 'Last updated 2026-11-08.', `${rel}`);
    assert.equal(lineUnderTitle(at(`${FIRST}^`, rel)), 'Last updated 2026-11-07.', `${rel} before AP-0022`);
  }
  for (const sha of COMMITS) {
    const changed = git(['diff', '--name-only', `${sha}^`, sha, '--', '*.md']).split('\n').filter(Boolean);
    for (const f of changed) {
      if (f === `vm-intent/${README}` || f === `vm-intent/${TF}`) continue;
      const diff = git(['diff', '-U0', `${sha}^`, sha, '--', f]);
      assert.doesNotMatch(diff, /^[-+]Last updated/m, `${sha.slice(0, 8)} changes ${f}'s Last updated line`);
    }
  }
});

test('criterion 6: no AP-0022 commit touches code, the API snapshot or protected files, or adds files', () => {
  for (const sha of COMMITS) {
    const lines = git(['diff', '--name-status', '--no-renames', `${sha}^`, sha]).split('\n').filter(Boolean);
    for (const l of lines) {
      const [status, path] = l.split('\t');
      const short = sha.slice(0, 8);
      assert.ok(!path.startsWith('vm-intent/backend/'), `${short} touches ${path}`);
      assert.ok(!path.startsWith('vm-intent/frontend/'), `${short} touches ${path}`);
      assert.ok(!/^vm-intent\/docs\/(openapi\.(json|ya?ml)|SECURITY\.md)$/.test(path), `${short} touches ${path}`);
      // The pipeline's protected paths (agent-pipeline/src/config.ts).
      assert.ok(!/^(agent-pipeline\/|\.github\/|\.gitlab-ci\.yml$)/.test(path), `${short} touches ${path}`);
      assert.ok(!/^vm-intent\/(deploy\/(azure|pki)\/|deploy\/catalog\/gitlab-ci|[^/]+\.(cmd|ps1)$)/.test(path),
        `${short} touches ${path}`);
      if (path.startsWith('vm-intent/tests/')) {
        assert.ok(path.startsWith('vm-intent/tests/acceptance/'), `${short} touches ${path}`);
      }
      if (status === 'A') {
        assert.ok(path.startsWith('vm-intent/tests/acceptance/'), `${short} adds ${path} outside tests/acceptance/`);
      }
    }
  }
});
