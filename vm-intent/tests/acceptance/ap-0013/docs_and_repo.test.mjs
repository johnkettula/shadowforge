// AP-0013 acceptance, repository half: the contract script has the new checks and docs/API.md counts them; a
// VmController unit test covers 404 and 409; the API.md clarify/cancel rows are intact; and the commit scope.
// Covers criteria 5 (static part), 6, 7 (docs part) and 8. Reads files and git history only; it does not run mvn
// (the pipeline's build gates do) or the older acceptance suites (the pipeline runs them).
//
//   node --test tests/acceptance/ap-0013/docs_and_repo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const API_TEST_DIR = 'backend/src/test/java/com/example/vmintent/api/';
const CONTROLLER = 'vm-intent/backend/src/main/java/com/example/vmintent/api/VmController.java';

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

const ap0013Commits = () => {
  const shas = git('log', '--format=%H', '--no-merges', '--grep=^AP-0013:').split('\n').filter(Boolean);
  assert.ok(shas.length > 0, 'found the AP-0013 commits');
  return shas;
};

/** File content at a commit, or null if it doesn't exist there. */
function showAt(sha, path) {
  try {
    return execFileSync('git', ['show', `${sha}:${path}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
      .replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
}

/** The python call(...) statements of the contract script (not the def). */
function contractCalls(src) {
  const stmts = [];
  const re = /(^|[^\w.])call\(/gm;
  let m;
  while ((m = re.exec(src))) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const line = src.slice(lineStart, src.indexOf('\n', m.index));
    if (/^\s*#/.test(line) || /^\s*def\s+call\(/.test(line)) continue;
    // Take the statement up to the matching closing parenthesis.
    let i = m.index + m[0].length, depth = 1;
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
      i++;
    }
    stmts.push({ text: src.slice(m.index, i), before: src.slice(0, m.index) });
  }
  return stmts;
}

// ---- Criterion 5 (static) ----
test('5: tests/api_contract_test.py checks a change on an unknown spec hash -> 404', () => {
  const calls = contractCalls(read('tests/api_contract_test.py'));
  const hit = calls.find(({ text }) =>
    /"POST"/.test(text) && /\/(renew|resize|power|snapshot|decommission)"/.test(text)
    && /"0"\s*\*\s*64|'0'\s*\*\s*64|\b0{64}\b/.test(text) && /,\s*404\b/.test(text));
  assert.ok(hit, 'a call POSTs a change to /api/v2/vms/{"0"*64}/... and expects 404');
});

test('5: tests/api_contract_test.py checks a change on an already decommissioned VM -> 409', () => {
  const calls = contractCalls(read('tests/api_contract_test.py'));
  const firstDecommission = calls.findIndex(({ text }) => /"POST"/.test(text) && /\/decommission"/.test(text) && /,\s*200\b/.test(text));
  assert.ok(firstDecommission >= 0, 'the script decommissions a VM (200)');
  const later = calls.slice(firstDecommission + 1).find(({ text }) =>
    /"POST"/.test(text) && /\/(renew|resize|power|snapshot|decommission)"/.test(text) && /,\s*409\b/.test(text)
    && !/"0"\s*\*\s*64/.test(text));
  assert.ok(later, 'after the decommission, a change on the same VM expects 409');
});

test("5: docs/API.md 'Checking the contract' check count equals the call(...) statements, and is at least 55", () => {
  const s = section(read('docs/API.md'), /^#+ Checking the contract/).replace(/\s+/g, ' ');
  const m = /It runs (\d+) checks/.exec(s);
  assert.ok(m, `the section says "It runs N checks": ${s.slice(0, 400)}`);
  const n = contractCalls(read('tests/api_contract_test.py')).length;
  assert.equal(Number(m[1]), n, `API.md says ${m[1]} checks; the script has ${n} call(...) statements`);
  assert.ok(n >= 55, `at least 55 checks (${n})`);
});

// ---- Criterion 6 ----
/** Each @Test method body in the api test folder, with its file. */
function apiTestMethods() {
  const out = [];
  for (const f of readdirSync(join(ROOT, API_TEST_DIR)).filter((x) => x.endsWith('.java'))) {
    const src = read(API_TEST_DIR + f);
    for (const p of src.split(/\n\s*@Test\b/).slice(1)) {
      const end = p.search(/\n    }\n/);
      out.push({ f, src, body: end > 0 ? p.slice(0, end) : p });
    }
  }
  return out;
}

test('6: a unit test in the api test folder shows a change on a spec hash with no VmRegistry record gives 404', () => {
  const m = apiTestMethods().find(({ src, body }) => /VmController/.test(src) && /VmRegistry/.test(src)
    && /HttpStatus\.NOT_FOUND/.test(body) && /\b(renew|resize|power|snapshot|decommission)\(/.test(src));
  assert.ok(m, 'a @Test method uses VmController (with a VmRegistry) and expects HttpStatus.NOT_FOUND');
  assert.match(m.body, /assertThrows|assertEquals|isEqualTo/, 'it asserts the outcome');
});

test('6: a unit test shows a change on a VM with a registry record but no or closed lifecycle gives 409', () => {
  const methods = apiTestMethods().filter(({ src, body }) => /VmController/.test(src) && /HttpStatus\.CONFLICT/.test(body));
  assert.ok(methods.length > 0, 'a @Test method on VmController expects HttpStatus.CONFLICT');
  assert.ok(methods.some(({ body }) => /records?\.put|registry|VmRecord|record\(/.test(body)),
    'that test puts a registry record in place for the VM it changes');
});

test('6: the test runs under mvn test (a JUnit class under src/test/java ending in Test)', () => {
  const files = readdirSync(join(ROOT, API_TEST_DIR)).filter((f) => /Test\.java$/.test(f));
  const vm = files.filter((f) => /VmController/.test(read(API_TEST_DIR + f)) && /HttpStatus\.NOT_FOUND/.test(read(API_TEST_DIR + f)));
  assert.ok(vm.length > 0, `a *Test.java in ${API_TEST_DIR} covers VmController: ${files.join(', ')}`);
  for (const f of vm) assert.match(read(API_TEST_DIR + f), /import org\.junit\.jupiter\.api\.Test;/, `${f} is a JUnit 5 test`);
});

// ---- Criterion 7 (docs part; mvn test and the older suites run in the pipeline's gates) ----
test('7: docs/API.md clarifyRequest and cancelRequest rows still say "already finished" and 409', () => {
  const md = read('docs/API.md').split('\n');
  for (const id of ['clarifyRequest', 'cancelRequest']) {
    const row = md.find((l) => l.startsWith(`| \`${id}\``));
    assert.ok(row, `docs/API.md has a ${id} row`);
    assert.match(row, /already finished/, `${id} row: ${row}`);
    assert.match(row, /409/, `${id} row: ${row}`);
  }
});

// ---- Criterion 8 ----
/** The body of VmController.requireOwner, brace-matched, whitespace normalised. */
function requireOwnerBody(src) {
  const start = src.indexOf('void requireOwner(');
  assert.ok(start >= 0, 'VmController has requireOwner');
  const open = src.indexOf('{', start);
  let i = open + 1, depth = 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(open, i).replace(/\s+/g, ' ').trim();
}

test('8: no AP-0013 commit changes the body of VmController.requireOwner', () => {
  for (const sha of ap0013Commits()) {
    const before = showAt(`${sha}^`, CONTROLLER);
    const after = showAt(sha, CONTROLLER);
    if (before === null || after === null || before === after) continue;
    assert.equal(requireOwnerBody(after), requireOwnerBody(before), `${sha.slice(0, 7)} changes requireOwner`);
  }
});

/** The Temporal-annotated method declarations of a workflow interface, normalised. */
function temporalMethods(src) {
  if (src === null) return [];
  const body = src.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const re = /(@(?:WorkflowMethod|SignalMethod|QueryMethod|UpdateMethod|UpdateValidatorMethod)\b[^;]*?;)/g;
  return (body.match(re) || []).map((s) => s.replace(/\s+/g, ' ').trim()).sort();
}

test('8: no AP-0013 commit adds, removes or renames a Temporal workflow, signal, query, update or validator method', () => {
  for (const sha of ap0013Commits()) {
    const files = git('show', '--name-only', '--format=', '--no-renames', sha).split('\n').filter((f) => f.endsWith('.java'));
    for (const f of files) {
      const a = showAt(`${sha}^`, f);
      const b = showAt(sha, f);
      if (!/@WorkflowInterface/.test(a || '') && !/@WorkflowInterface/.test(b || '')) continue;
      assert.deepEqual(temporalMethods(b), temporalMethods(a), `${sha.slice(0, 7)} changes the Temporal methods of ${f}`);
    }
  }
});

test('8: no AP-0013 commit touches protected paths or changes / deletes a replay history', () => {
  const protectedPath = [
    /(^|\/)backend\/src\/main\/java\/com\/example\/vmintent\/security\//,
    /(^|\/)backend\/src\/main\/resources\/catalog\//,
    /(^|\/)backend\/src\/main\/resources\/application[^/]*\.(ya?ml|properties)$/,
    /^vm-intent\/deploy\//,
    /^agent-pipeline\//,
  ];
  for (const sha of ap0013Commits()) {
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
