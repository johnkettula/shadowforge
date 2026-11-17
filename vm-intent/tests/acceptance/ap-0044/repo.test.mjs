// AP-0044 acceptance, repository half (criteria 4-10): GET /api/v2/vms/{specHash} (getVm).
// - docs/openapi.json and docs/openapi.yaml have getVm (200 VmRecord, 400, 404); the lifecycle and five day-2 operations
//   keep their operationIds, paths and response codes; openapi.json has 43 operations.
// - VmControllerTest has active tests for 200 / 400 / 404; ReplayTest and OpenApiDocumentTest are still active.
// - API.md has a getVm row, its operation counts equal the served count, and its check count equals the number of
//   call(...) statements in tests/api_contract_test.py (at least 60), which calls getVm for 200, 400 and 404.
// - tests/acceptance/ap-0042/live_api.test.mjs: only the "GET /api/v2/vms/{specHash} is not served" assertion (and the
//   test title) is changed, to "is served".
// - No commit touches security/**, workflow/activity interfaces or the replay histories.
//
// "This requirement's commits" are the non-merge commits whose subject starts with "AP-0044:", leaving out the
// pipeline's own "acceptance tests" and "record the requirement" commits. Files are read with git show as they were at
// the newest such commit that changed them (or, for files it didn't change, the newest such commit), so later
// requirements can change them freely. "Before" is the parent of the oldest AP-0044 commit. Only sources are read,
// never build outputs; the build gates run mvn test.
//
//   node --test tests/acceptance/ap-0044/repo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = 'AP-0044';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const MAIN = 'backend/src/main/java/com/example/vmintent';
const TEST = 'backend/src/test/java/com/example/vmintent';
const AP42_LIVE = 'tests/acceptance/ap-0042/live_api.test.mjs';
const SERVED_OPERATIONS = 43;

const git = (args) => execFileSync('git', args,
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

// Oldest first; subjects are checked here, because --grep also matches body lines.
const ALL = git(['log', '--no-merges', '--reverse', '--format=%H %s', '--grep', `^${ID}:`]).split('\n').filter(Boolean)
  .map((l) => ({ sha: l.slice(0, 40), subject: l.slice(41) })).filter((c) => c.subject.startsWith(`${ID}:`));
const isPipeline = (c) => /^AP-\d+: (acceptance tests|record the requirement)\b/.test(c.subject);
const COMMITS = ALL.filter((c) => !isPipeline(c)).map((c) => c.sha);
const NEWEST = COMMITS[COMMITS.length - 1];
const BEFORE = ALL.length ? git(['rev-parse', `${ALL[0].sha}^`]).trim() : null;
const nameStatus = (sha) => git(['diff', '--name-status', '--no-renames', `${sha}^`, sha]).split('\n').filter(Boolean)
  .map((l) => { const [status, path] = l.split('\t'); return { status, path }; });
const CHANGES = new Map(COMMITS.map((sha) => [sha, nameStatus(sha)]));
const touching = (rel) => COMMITS.filter((sha) => CHANGES.get(sha).some((c) => c.path === `vm-intent/${rel}`));

function at(sha, rel) {
  try { return git(['show', `${sha}:vm-intent/${rel}`]).replace(/\r\n/g, '\n'); } catch { return null; }
}
/** A file as it was at the newest AP-0044 commit that changed it (or the newest AP-0044 commit). */
function now(rel) {
  assert.ok(NEWEST, `no ${ID} commit`);
  const own = touching(rel);
  const t = at(own.length ? own[own.length - 1] : NEWEST, rel);
  assert.ok(t !== null, `${rel} doesn't exist at the ${ID} commit`);
  return t;
}
const squash = (s) => s.replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ Java source helpers

/** Java source with comments removed (string literals kept). */
function noComments(src) {
  let out = '';
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === '"' || c === '\'') {
      if (src.startsWith('"""', i)) { const j = src.indexOf('"""', i + 3); out += src.slice(i, j + 3); i = j + 3; continue; }
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1); i = j + 1;
    } else if (src.startsWith('//', i)) { const j = src.indexOf('\n', i); i = j < 0 ? src.length : j; }
    else if (src.startsWith('/*', i)) { const j = src.indexOf('*/', i + 2); i = j + 2; out += ' '; }
    else { out += c; i++; }
  }
  return out;
}
/** Source with string and char literals blanked (same length), so brackets inside them don't count. */
const blank = (m) => m[0] + ' '.repeat(m.length - 2) + m[0];
const noStrings = (src) => src.replace(/"(?:[^"\\\n]|\\.)*"/g, blank).replace(/'(?:[^'\\\n]|\\.)'/g, blank);

function matchBracket(src, open) {
  const pairs = { '(': ')', '{': '}' };
  const o = src[open]; const c = pairs[o];
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === o) depth++;
    else if (src[i] === c && --depth === 0) return i + 1;
  }
  throw new Error(`unbalanced ${o} at ${open}`);
}

/** void methods with their annotations (the text between the previous member and the name) and bodies. */
function methods(src) {
  const s = noComments(src);
  const ns = noStrings(s);
  const out = [];
  for (const m of s.matchAll(/\bvoid\s+(\w+)\s*\(/g)) {
    const before = s.slice(0, m.index);
    const prev = Math.max(before.lastIndexOf(';'), before.lastIndexOf('}'), before.lastIndexOf('{'));
    const po = m.index + m[0].length - 1;
    const bo = s.indexOf('{', matchBracket(ns, po));
    out.push({ name: m[1], annotations: s.slice(prev + 1, m.index), body: s.slice(bo, matchBracket(ns, bo)) });
  }
  return out;
}
const classDisabled = (src) => /@Disabled\b/.test(noComments(src).split(/\bclass\s+\w+/)[0]);
function activeTests(src) {
  if (classDisabled(src)) return [];
  return methods(src).filter((m) => /@(Test|TestFactory|ParameterizedTest)\b/.test(m.annotations) && !/@Disabled\b/.test(m.annotations));
}

test(`there is an ${ID} commit (other than the pipeline's own)`, () => {
  assert.ok(COMMITS.length > 0, `no non-pipeline commit subject starts with ${ID}:`);
});

// ------------------------------------------------------------------ 4-5. OpenAPI files

const opsOf = (doc) => Object.entries(doc.paths).flatMap(([p, o]) => Object.entries(o)
  .filter(([m]) => ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'].includes(m)).map(([m, op]) => ({ m, p, op })));

test('criterion 4: docs/openapi.json has GET /api/v2/vms/{specHash} getVm with 200 (VmRecord), 400 and 404 (ApiError)', () => {
  const doc = JSON.parse(now('docs/openapi.json'));
  const op = doc.paths['/api/v2/vms/{specHash}']?.get;
  assert.ok(op, 'no GET /api/v2/vms/{specHash}');
  assert.equal(op.operationId, 'getVm');
  assert.equal(op.responses?.['200']?.content?.['application/json']?.schema?.$ref, '#/components/schemas/VmRecord');
  for (const code of ['400', '404']) {
    assert.equal(op.responses?.[code]?.content?.['application/json']?.schema?.$ref, '#/components/schemas/ApiError', `getVm ${code}`);
  }
  assert.ok(op.parameters?.some((p) => p.name === 'specHash' && p.in === 'path' && p.required), 'no required specHash path parameter');
});

test('criterion 4: the lifecycle and the five day-2 POST operations keep their operationIds, paths and response codes', () => {
  const after = JSON.parse(now('docs/openapi.json'));
  const before = JSON.parse(at(BEFORE, 'docs/openapi.json'));
  const day2 = opsOf(before).filter(({ p }) => p.startsWith('/api/v2/vms/{specHash}/'));
  assert.deepEqual(day2.map(({ m, op }) => `${m} ${op.operationId}`).sort(),
    ['get getVmLifecycle', 'post decommissionVm', 'post powerVm', 'post renewVm', 'post resizeVm', 'post snapshotVm']);
  for (const { m, p, op } of day2) {
    const now_ = after.paths[p]?.[m];
    assert.ok(now_, `${m.toUpperCase()} ${p} is gone`);
    assert.equal(now_.operationId, op.operationId, `${m.toUpperCase()} ${p} operationId`);
    assert.deepEqual(Object.keys(now_.responses).sort(), Object.keys(op.responses).sort(), `${op.operationId} response codes`);
  }
});

test(`criterion 4/7: docs/openapi.json has ${SERVED_OPERATIONS} operations (one more than before), operationIds unique`, () => {
  const after = opsOf(JSON.parse(now('docs/openapi.json')));
  const before = opsOf(JSON.parse(at(BEFORE, 'docs/openapi.json')));
  assert.equal(after.length, SERVED_OPERATIONS);
  assert.equal(after.length, before.length + 1);
  const ids = after.map(({ op }) => op.operationId);
  assert.equal(new Set(ids).size, ids.length, 'duplicate operationIds');
});

test('criterion 5: docs/openapi.json and docs/openapi.yaml were regenerated by an AP-0044 commit', () => {
  assert.ok(touching('docs/openapi.json').length > 0, 'no AP-0044 commit changes docs/openapi.json');
  assert.ok(touching('docs/openapi.yaml').length > 0, 'no AP-0044 commit changes docs/openapi.yaml');
});

test('criterion 5: docs/openapi.yaml has GET /api/v2/vms/{specHash} getVm with 200, 400 and 404', () => {
  const lines = now('docs/openapi.yaml').split('\n');
  const i = lines.findIndex((l) => l === '  /api/v2/vms/{specHash}:');
  assert.ok(i >= 0, 'openapi.yaml has no /api/v2/vms/{specHash} path');
  let j = i + 1;
  while (j < lines.length && (lines[j].trim() === '' || /^ {3,}/.test(lines[j]))) j++;
  const block = lines.slice(i, j).join('\n');
  assert.match(block, /^ {4}get:$/m, 'no get: under the path');
  assert.match(block, /operationId: getVm$/m);
  for (const code of ['200', '400', '404']) assert.match(block, new RegExp(`^ {8}"${code}":$|^ {8}'${code}':$|^ {8}${code}:$`, 'm'), `no ${code}`);
  assert.match(block, /\$ref: "?'?#\/components\/schemas\/VmRecord/, 'the 200 response isn\'t a VmRecord');
});

test('criterion 5: OpenApiDocumentTest and ReplayTest still have active tests', () => {
  assert.ok(activeTests(now(`${TEST}/api/OpenApiDocumentTest.java`)).length > 0, 'OpenApiDocumentTest has no active test');
  assert.ok(activeTests(now(`${TEST}/workflow/ReplayTest.java`)).length > 0, 'ReplayTest has no active test');
});

// ------------------------------------------------------------------ 6. VmControllerTest

test('criterion 6: VmController has GET /vms/{specHash} returning a VmRecord; 400 for a malformed hash, 404 for an unknown one', () => {
  const src = noComments(now(`${MAIN}/api/VmController.java`));
  assert.match(src, /@GetMapping\(\s*"\/vms\/\{specHash\}"\s*\)\s*public\s+VmRecord\s+\w+\s*\(/, 'no @GetMapping("/vms/{specHash}") returning VmRecord');
  assert.match(src, /operationId\s*=\s*"getVm"/);
});

test('criterion 6: VmControllerTest has active tests for 200 with the record, 400 for a malformed hash and 404 for an unknown hash', () => {
  const tests = activeTests(now(`${TEST}/api/VmControllerTest.java`));
  const getVm = tests.filter((t) => /controller\.vm\s*\(/.test(t.body));
  assert.ok(getVm.length >= 3, `only ${getVm.length} active tests call controller.vm(...): ${getVm.map((t) => t.name).join(', ')}`);
  const ok = getVm.filter((t) => /assertEquals\s*\(\s*\w+\s*,\s*[\w.()]*\.specHash\(\)\s*\)/.test(t.body)
    && /assertEquals\s*\([^;]*\.spec\(\)\.name\(\)/.test(t.body));
  assert.ok(ok.length > 0, 'no active test asserts the returned record\'s specHash and spec name');
  const bad = getVm.filter((t) => /HttpStatus\.BAD_REQUEST/.test(t.body) && /assertThrows/.test(t.body));
  assert.ok(bad.length > 0, 'no active test asserts 400 (BAD_REQUEST) for a malformed hash');
  assert.ok(bad.some((t) => /"abc"|\.repeat\(\s*63\s*\)|"A"\s*\.repeat\(\s*64\s*\)|\.toUpperCase\(\)/.test(t.body)),
    'the 400 test uses no malformed hash');
  const notFound = getVm.filter((t) => /HttpStatus\.NOT_FOUND/.test(t.body) && /assertThrows/.test(t.body));
  assert.ok(notFound.length > 0, 'no active test asserts 404 (NOT_FOUND) for an unknown hash');
});

// ------------------------------------------------------------------ 7. API.md

test('criterion 7: API.md\'s operations table has a getVm row for GET /api/v2/vms/{specHash}', () => {
  assert.match(now('docs/API.md'), /^\|\s*`getVm`\s*\|\s*`GET \/api\/v2\/vms\/\{specHash\}`\s*\|[^\n]*\|\s*$/m);
});

test(`criterion 7: every operation count in API.md equals ${SERVED_OPERATIONS} (the operations served)`, () => {
  const api = now('docs/API.md');
  const counts = [...api.matchAll(/\b(\d+)\s+(?:\w+\s+)?operations\b/gi)].map((m) => m[0]);
  assert.ok(counts.length > 0, 'API.md states no operation count');
  for (const c of counts) assert.equal(Number(c.match(/\d+/)[0]), SERVED_OPERATIONS, `API.md says "${c}"`);
  assert.match(api, new RegExp(`generates all ${SERVED_OPERATIONS} operations`));
  const table = api.split('\n').filter((l) => /^\|\s*`[a-z]\w*`\s*\|\s*`(GET|POST|PUT|DELETE|PATCH) \//.test(l));
  assert.equal(table.length, SERVED_OPERATIONS, `the operations table has ${table.length} rows`);
});

// ------------------------------------------------------------------ 8. the contract script

const CONTRACT = 'tests/api_contract_test.py';
const callStatements = (py) => py.split('\n').filter((l) => /^\s*(\w+\s*=\s*)?call\(/.test(l));

test('criterion 8: the check count in API.md\'s "Checking the contract" equals the call(...) statements (at least 60)', () => {
  const api = now('docs/API.md');
  const i = api.indexOf('## Checking the contract');
  assert.ok(i >= 0, 'API.md has no "## Checking the contract" section');
  const j = api.indexOf('\n## ', i + 1);
  const section = api.slice(i, j < 0 ? api.length : j);
  const m = /It runs (\d+) checks/.exec(squash(section));
  assert.ok(m, `the section states no "It runs N checks":\n${section.slice(0, 600)}`);
  const n = callStatements(now(CONTRACT)).length;
  assert.equal(Number(m[1]), n, `API.md says ${m[1]} checks; the script has ${n} call(...) statements`);
  assert.ok(n >= 60, `only ${n} checks`);
});

test('criterion 8: the contract script calls getVm for a built VM (200), a malformed hash (400) and an unknown hash (404)', () => {
  const py = now(CONTRACT);
  // Statements may span lines: take each call( up to its closing bracket.
  const stmts = [];
  for (const m of py.matchAll(/(^|\n)\s*(?:\w+\s*=\s*)?call\(/g)) {
    const open = m.index + m[0].length - 1;
    stmts.push(py.slice(open, matchBracket(py, open)));
  }
  const getVm = stmts.filter((s) => /"GET",\s*f?"\/api\/v2\/vms\/(\{h\}|"\s*\+\s*"0"\s*\*\s*64|abc|\{[^}]+\})"?\s*,/.test(s) && !/\/lifecycle/.test(s));
  const built = getVm.find((s) => /f"\/api\/v2\/vms\/\{h\}",\s*200/.test(s));
  assert.ok(built, `no getVm call on the built VM's hash expecting 200:\n${getVm.join('\n')}`);
  assert.match(built, /\["specHash"\]\s*==\s*h/, 'the built-VM getVm call doesn\'t check the returned specHash');
  assert.ok(getVm.some((s) => /"\/api\/v2\/vms\/abc",\s*400/.test(s)), `no getVm call with a malformed hash expecting 400:\n${getVm.join('\n')}`);
  assert.ok(getVm.some((s) => /"\/api\/v2\/vms\/"\s*\+\s*"0"\s*\*\s*64,\s*404/.test(s)), `no getVm call with 64 zeros expecting 404:\n${getVm.join('\n')}`);
  // The built hash h is a completed request's VM.
  assert.match(py, /if done\["state"\] == "COMPLETED":\s*\n\s*h = done\["interpretation"\]\["specHash"\]/);
});

// ------------------------------------------------------------------ 9. ap-0042's live suite

test('criterion 9: an AP-0044 commit changes tests/acceptance/ap-0042/live_api.test.mjs', () => {
  assert.ok(touching(AP42_LIVE).length > 0, `no ${ID} commit changes ${AP42_LIVE}, so its "GET /api/v2/vms/{specHash} is not served" assertion still stands`);
});

test('criterion 9: ap-0042/live_api.test.mjs now asserts GET /api/v2/vms/{specHash} IS served, with a matching title', () => {
  const src = now(AP42_LIVE);
  assert.ok(!/assert\.ok\(\s*!\s*doc\.paths\[['"]\/api\/v2\/vms\/\{specHash\}['"]\]/.test(src),
    'ap-0042/live_api.test.mjs still asserts GET /api/v2/vms/{specHash} is NOT served');
  assert.match(src, /assert\.ok\(\s*doc\.paths\[['"]\/api\/v2\/vms\/\{specHash\}['"]\]\?*\.get\b/,
    'ap-0042/live_api.test.mjs has no assertion that GET /api/v2/vms/{specHash} is served');
  const titles = [...src.matchAll(/test\(\s*(['"`])(.*?)\1/g)].map((m) => m[2]);
  assert.ok(!titles.some((t) => /not GET \/api\/v2\/vms\/\{specHash\}(?!\/)/.test(t)), `a title still says "not GET /api/v2/vms/{specHash}": ${titles.join(' | ')}`);
});

test('criterion 9: the AP-0044 diff of ap-0042/live_api.test.mjs changes no other assertion', () => {
  const own = touching(AP42_LIVE);
  assert.ok(own.length > 0, `no ${ID} commit changes ${AP42_LIVE}`);
  const diff = git(['diff', '--no-renames', '-U0', BEFORE, own[own.length - 1], '--', `:(top)vm-intent/${AP42_LIVE}`]).replace(/\r/g, '');
  const changed = diff.split('\n').filter((l) => /^[+-](?![+-])/.test(l));
  const removed = changed.filter((l) => l[0] === '-' && /\bassert\./.test(l));
  const added = changed.filter((l) => l[0] === '+' && /\bassert\./.test(l));
  assert.equal(removed.length, 1, `removed assertion lines:\n${removed.join('\n')}`);
  assert.match(removed[0], /!\s*doc\.paths\[['"]\/api\/v2\/vms\/\{specHash\}['"]\]/);
  assert.equal(added.length, 1, `added assertion lines:\n${added.join('\n')}`);
  assert.match(added[0], /assert\.ok\(\s*doc\.paths\[['"]\/api\/v2\/vms\/\{specHash\}['"]\]/);
  // Every other assertion in the file is the same, in the same order.
  const asserts = (s) => s.split('\n').filter((l) => /\bassert\./.test(l) && !/\/api\/v2\/vms\/\{specHash\}['"]\]\?*\.get/.test(l)).map((l) => l.trim());
  assert.deepEqual(asserts(at(own[own.length - 1], AP42_LIVE)), asserts(at(BEFORE, AP42_LIVE)));
});

// ------------------------------------------------------------------ 10. untouched areas

test('criterion 10: no AP-0044 commit touches security/**, the replay histories or a workflow/activity interface', () => {
  const bad = [];
  for (const sha of COMMITS) {
    for (const { status, path } of CHANGES.get(sha)) {
      const rel = path.replace(/^vm-intent\//, '');
      if (rel.startsWith(`${MAIN}/security/`)) bad.push(`${sha.slice(0, 8)} ${status} ${path} (security)`);
      if (rel.startsWith('backend/src/test/resources/histories/')) bad.push(`${sha.slice(0, 8)} ${status} ${path} (histories)`);
      if (rel.startsWith(`${MAIN}/`) && rel.endsWith('.java')) {
        const was = at(`${sha}^`, rel) || '';
        const is = at(sha, rel) || '';
        if (/@(WorkflowInterface|ActivityInterface)\b/.test(was + is)) bad.push(`${sha.slice(0, 8)} ${status} ${path} (workflow/activity interface)`);
      }
    }
  }
  assert.deepEqual(bad, []);
});
