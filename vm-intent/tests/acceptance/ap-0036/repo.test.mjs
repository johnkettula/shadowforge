// AP-0036 acceptance, repository half (criteria 1-7, 9, 10): ReconcileRequest gets a fifth component cloudName,
// every main-code caller passes null, VmReconcileWorkflowImpl gives the cloud a spec named cloudName (null = as asked)
// while records and the lifecycle keep the asked-for spec, the workflows never compute the name, a TestWorkflowEnvironment
// test covers it, TEMPORAL-FEATURES.md says so, and the AP-0036 commits stay inside backend/src/ and the two docs.
//
// Sources are read as they were at the newest AP-0036 commit that changed backend/src (or the file itself), and the
// "must not change" checks look only at AP-0036 commits, so later requirements can change these files freely. The
// build gates run mvn test (criterion 6's pass/fail); this suite only reads sources, never build outputs.
//
//   node --test tests/acceptance/ap-0036/repo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const MAIN = 'backend/src/main/java/com/example/vmintent';
const TEST = 'backend/src/test/java/com/example/vmintent';
const MODELS = `${MAIN}/workflow/Models.java`;
const RECONCILE = `${MAIN}/workflow/VmReconcileWorkflowImpl.java`;
const VMSPEC = `${MAIN}/spec/VmSpec.java`;
const IDENTITY = `${MAIN}/spec/VmIdentity.java`;
const DOC = 'docs/TEMPORAL-FEATURES.md';
const CALLERS = {
  [`${MAIN}/api/RequestController.java`]: 1,
  [`${MAIN}/workflow/IntentWorkflowImpl.java`]: 2,
  [`${MAIN}/workflow/BatchShardWorkflowImpl.java`]: 1,
  [`${MAIN}/workflow/CatalogRunWorkflowImpl.java`]: 1,
};
const PROTECTED = [
  /^agent-pipeline\//, /^\.github\//, /^\.gitlab-ci\.yml$/, /^vm-intent\/deploy\//, /^vm-intent\/frontend\//,
  /^vm-intent\/[^/]+\.cmd$/, /^vm-intent\/[^/]+\.ps1$/,
  /^vm-intent\/backend\/src\/main\/java\/com\/example\/vmintent\/security\//,
  /^vm-intent\/backend\/src\/main\/resources\/application-tls\.yml$/, /^vm-intent\/docs\/SECURITY\.md$/,
];

const git = (args) => execFileSync('git', args,
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
const subject = (sha) => git(['log', '-1', '--format=%s', sha]).trim();

// Oldest first.
const COMMITS = git(['log', '--reverse', '--format=%H', '--grep', '^AP-0036:']).split('\n').filter(Boolean);
const WORK = COMMITS.filter((sha) => !/^AP-0036: (acceptance tests|record the requirement)\b/.test(subject(sha)));
const changed = (sha) => git(['diff', '--name-only', '--no-renames', `${sha}^`, sha]).split('\n').filter(Boolean);
const CHANGES = new Map(COMMITS.map((sha) => [sha, changed(sha)]));
const touching = (prefix) => COMMITS.filter((sha) => CHANGES.get(sha).some((p) => p.startsWith(prefix)));
const SRC_COMMITS = touching('vm-intent/backend/src/');
const LAST = SRC_COMMITS[SRC_COMMITS.length - 1];

function at(sha, rel) {
  try { return git(['show', `${sha}:vm-intent/${rel}`]).replace(/\r\n/g, '\n'); } catch { return null; }
}
/** A file as it was at the newest AP-0036 commit that changed it (or, failing that, that changed backend/src). */
function must(rel) {
  assert.ok(LAST, 'no AP-0036 commit changes vm-intent/backend/src/');
  const own = touching(`vm-intent/${rel}`);
  const sha = own.length ? own[own.length - 1] : LAST;
  const t = at(sha, rel);
  assert.ok(t !== null, `${rel} doesn't exist at ${sha.slice(0, 8)}`);
  return t;
}
const flat = (s) => s.replace(/\s+/g, ' ');

/** Blanks comments and string/char literal contents (same length), so code can be searched and parens matched. */
function code(src) {
  let out = '';
  for (let i = 0; i < src.length;) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { const e = src.indexOf('\n', i); const j = e < 0 ? src.length : e; out += ' '.repeat(j - i); i = j; }
    else if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); const j = e < 0 ? src.length : e + 2; out += src.slice(i, j).replace(/[^\n]/g, ' '); i = j; }
    else if (c === '"' && src.startsWith('"""', i)) { const e = src.indexOf('"""', i + 3); const j = e < 0 ? src.length : e + 3; out += '"' + src.slice(i + 1, j - 1).replace(/[^\n]/g, ' ') + '"'; i = j; }
    else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      j = Math.min(j + 1, src.length);
      out += c + ' '.repeat(Math.max(0, j - i - 2)) + (j - i >= 2 ? src[j - 1] : ''); i = j;
    } else { out += c; i++; }
  }
  return out;
}

/** The text between the bracket at `open` and its partner (exclusive), in blanked code. */
function inside(cd, open) {
  const pairs = { '(': ')', '{': '}' };
  const o = cd[open], cl = pairs[o];
  let depth = 0;
  for (let k = open; k < cd.length; k++) {
    if (cd[k] === o) depth++;
    else if (cd[k] === cl && --depth === 0) return { text: cd.slice(open + 1, k), end: k };
  }
  return { text: cd.slice(open + 1), end: cd.length };
}

/** Splits an argument list at its top-level commas. */
function args(text) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of text) {
    if ('([{<'.includes(ch)) depth++;
    if (')]}>'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The argument lists of every call matching `re` (which must end right before the opening paren). */
function calls(cd, re) {
  const out = [];
  const g = new RegExp(re.source, 'g');
  let m;
  while ((m = g.exec(cd))) {
    const open = m.index + m[0].length;
    if (cd[open] !== '(') continue;
    out.push(inside(cd, open).text);
  }
  return out;
}

/** The body of a method named `name` (blanked code), or null. */
function methodBody(cd, name) {
  const m = new RegExp(`[\\w<>\\[\\]]+\\s+${name}\\s*\\(([^)]*)\\)[^;{]*\\{`).exec(cd);
  if (!m) return null;
  return inside(cd, m.index + m[0].length - 1).text;
}

/** Every method (name, annotations, body) in a Java source; bodies keep comments and strings. */
function methods(src) {
  const cd = code(src);
  const out = [];
  const re = /((?:@\w+(?:\.\w+)*(?:\([^)]*\))?\s+)*)(?:(?:public|protected|private|static|final|synchronized)\s+)*(?:<[^>]+>\s+)?[\w.<>\[\], ?]+\s+(\w+)\s*\([^;{)]*(?:\)[^;{]*)?\{/g;
  let m;
  while ((m = re.exec(cd))) {
    const open = m.index + m[0].length - 1;
    const { end } = inside(cd, open);
    out.push({ name: m[2], annotations: m[1] || '', body: src.slice(open, end + 1) });
    re.lastIndex = open + 1;
  }
  return out.filter((x) => !['if', 'for', 'while', 'switch', 'catch', 'synchronized', 'try', 'else', 'do', 'return', 'new'].includes(x.name));
}

test('there is an AP-0036 commit that changes backend/src', () => {
  assert.ok(WORK.length > 0, 'no AP-0036 work commit');
  assert.ok(LAST, 'no AP-0036 commit changes vm-intent/backend/src/');
});

test('criterion 1: ReconcileRequest has exactly spec, specHash, requestedBy, requestId, String cloudName', () => {
  const cd = flat(code(must(MODELS)));
  const m = /record\s+ReconcileRequest\s*\(([^)]*)\)/.exec(cd);
  assert.ok(m, 'record ReconcileRequest not found in Models.java');
  const comps = args(m[1]).map((c) => c.replace(/@\w+(\([^)]*\))?\s*/g, '').trim().split(/\s+/));
  assert.deepEqual(comps.map((c) => c[c.length - 1]), ['spec', 'specHash', 'requestedBy', 'requestId', 'cloudName'],
    `components: ${m[1]}`);
  assert.equal(comps[4].slice(0, -1).join(' '), 'String', `cloudName's type: ${comps[4].join(' ')}`);
});

test('criterion 2: the five main-code ReconcileRequest constructions pass the literal null as cloudName', () => {
  let total = 0;
  for (const [rel, count] of Object.entries(CALLERS)) {
    const found = calls(code(must(rel)), /new\s+(?:Models\s*\.\s*)?ReconcileRequest\s*/);
    assert.equal(found.length, count, `${rel}: expected ${count} 'new ReconcileRequest(' calls, found ${found.length}`);
    for (const a of found) {
      const list = args(a);
      assert.equal(list.length, 5, `${rel}: 'new ReconcileRequest(${flat(a)})' has ${list.length} arguments`);
      assert.equal(list[4], 'null', `${rel}: fifth argument is '${list[4]}', not null`);
    }
    total += found.length;
  }
  // No other main-code file builds a ReconcileRequest.
  const files = git(['ls-tree', '-r', '--name-only', LAST, '--', `:(top)vm-intent/${MAIN}`]).split('\n')
    .filter((f) => f.endsWith('.java'));
  assert.ok(files.length > 20, `only ${files.length} main Java files listed at ${LAST.slice(0, 8)}`);
  const others = files.map((f) => f.replace(/^vm-intent\//, ''))
    .filter((f) => !(f in CALLERS))
    .filter((f) => calls(code(at(LAST, f) || ''), /new\s+(?:Models\s*\.\s*)?ReconcileRequest\s*/).length > 0);
  assert.deepEqual(others, [], `other main files construct a ReconcileRequest: ${others.join(', ')}`);
  assert.equal(total, 5);
});

test('criterion 3: the cloud gets cloudSpec (cloudName or the spec as asked); records and the lifecycle keep request.spec()', () => {
  const src = must(RECONCILE);
  const cd = code(src);
  const body = methodBody(cd, 'cloudSpec');
  const reconcile = methodBody(cd, 'reconcile');
  assert.ok(reconcile, 'reconcile method not found');
  if (body) {
    const b = flat(body);
    assert.match(b, /request\s*\.\s*cloudName\s*\(\s*\)\s*==\s*null|null\s*==\s*request\s*\.\s*cloudName\s*\(\s*\)/,
      `cloudSpec doesn't test request.cloudName() for null: ${b}`);
    assert.match(b, /request\s*\.\s*spec\s*\(\s*\)\s*\.\s*withName\s*\(\s*request\s*\.\s*cloudName\s*\(\s*\)\s*\)/,
      `cloudSpec doesn't return request.spec().withName(request.cloudName()): ${b}`);
    assert.match(b, /\?\s*request\s*\.\s*spec\s*\(\s*\)\s*:|return\s+request\s*\.\s*spec\s*\(\s*\)\s*;/,
      `cloudSpec doesn't return request.spec() when cloudName is null: ${b}`);
    assert.equal((cd.match(/\bcloudSpec\s*\(\s*request\s*\)/g) || []).length, 1, 'cloudSpec(request) is called once');
  } else {
    assert.match(flat(reconcile), /VmSpec\s+\w+\s*=\s*request\s*\.\s*cloudName\s*\(\s*\)\s*==\s*null/,
      'neither a cloudSpec method nor a single local built from request.cloudName() was found');
  }
  // withName copies every other component of VmSpec.
  const spec = flat(code(at(LAST, VMSPEC)));
  const rec = /record\s+VmSpec\s*(?=\()/.exec(spec);
  assert.ok(rec, 'record VmSpec not found');
  const comps = inside(spec, rec.index + rec[0].length).text;
  const names = args(comps.replace(/@\w+(\((?:[^()]|\([^()]*\))*\))?/g, ''))
    .map((c) => c.trim().split(/\s+/).pop());
  assert.ok(names.length >= 5, `VmSpec components: ${names.join(', ')}`);
  const withName = methodBody(code(at(LAST, VMSPEC)), 'withName');
  assert.ok(withName, 'VmSpec.withName not found');
  const ctor = calls(withName, /new\s+VmSpec\s*/);
  assert.equal(ctor.length, 1, 'withName builds one new VmSpec');
  const passed = args(ctor[0]);
  const paramName = /withName\s*\(\s*String\s+(\w+)\s*\)/.exec(spec)[1];
  assert.deepEqual(passed, [paramName, ...names.slice(1)], `withName passes ${passed.join(', ')} for ${names.join(', ')}`);
  assert.equal(names[0], 'name');

  for (const re of [/cloud\s*\.\s*plan\s*/, /cloud\s*\.\s*sendAndWait\s*/, /\.\s*createVm\s*/, /cloud\s*\.\s*deleteByKeyNoWait\s*/]) {
    const found = calls(cd, re);
    assert.ok(found.length > 0, `no call matching ${re.source} in VmReconcileWorkflowImpl`);
    for (const a of found) {
      assert.doesNotMatch(a, /request\s*\.\s*spec\s*\(\s*\)/, `${re.source}(${flat(a)}) still takes request.spec()`);
    }
  }
  const saves = calls(cd, /records\s*\.\s*save\s*/);
  assert.ok(saves.length >= 3, `only ${saves.length} records.save( calls`);
  for (const a of saves) {
    assert.match(args(a)[1] || '', /^request\s*\.\s*spec\s*\(\s*\)$/, `records.save(${flat(a)}) doesn't save request.spec()`);
  }
  const life = methodBody(cd, 'startLifecycle');
  assert.ok(life, 'startLifecycle not found');
  const lr = calls(life, /new\s+(?:Models\s*\.\s*)?LifecycleRequest\s*/);
  assert.equal(lr.length, 1, 'startLifecycle builds one LifecycleRequest');
  assert.match(args(lr[0])[0], /^request\s*\.\s*spec\s*\(\s*\)$/, `LifecycleRequest(${flat(lr[0])}) doesn't use request.spec()`);
});

test('criterion 4: no workflow impl calls VmIdentity.hash or a VmIdentity cloudName(; VmIdentity declares no cloudName', () => {
  const files = git(['ls-tree', '-r', '--name-only', LAST, '--', `:(top)vm-intent/${MAIN}/workflow/`]).split('\n')
    .filter((f) => /\/workflow\/[^/]+WorkflowImpl\.java$/.test(f));
  assert.ok(files.length >= 5, `only ${files.length} *WorkflowImpl.java files`);
  for (const f of files) {
    const cd = code(at(LAST, f.replace(/^vm-intent\//, '')));
    assert.doesNotMatch(cd, /VmIdentity\s*\.\s*hash\b/, `${f} calls VmIdentity.hash`);
    assert.doesNotMatch(cd, /VmIdentity\s*\.\s*cloudName\s*\(/, `${f} calls VmIdentity.cloudName(`);
    // a static import would allow a bare cloudName(...) call to VmIdentity
    assert.doesNotMatch(cd, /import\s+static\s+com\.example\.vmintent\.spec\.VmIdentity\.(?:\*|cloudName|hash)\s*;/,
      `${f} statically imports from VmIdentity`);
  }
  const id = code(at(LAST, IDENTITY));
  assert.doesNotMatch(id, /\b[\w<>\[\]]+\s+cloudName\s*\(/, 'VmIdentity declares a cloudName method');
  // ...nor any other main source file declares it inside a class named VmIdentity
  const all = git(['grep', '-l', 'class VmIdentity', LAST, '--', `:(top)vm-intent/${MAIN}`]).split('\n').filter(Boolean);
  // git grep prints paths relative to the current folder
  assert.deepEqual(all.map((l) => l.replace(/^[^:]+:/, '').replace(/^vm-intent\//, '')), [IDENTITY]);
});

test('criterion 5: a TestWorkflowEnvironment test checks cloud name to the cloud, asked-for name to records, null, and rollback', () => {
  const dir = `vm-intent/${TEST}/workflow/`;
  const added = WORK.flatMap((sha) => CHANGES.get(sha)).filter((p) => p.startsWith(dir) && p.endsWith('Test.java'));
  const candidates = [...new Set(added)].map((p) => p.replace(/^vm-intent\//, ''))
    .map((rel) => ({ rel, src: must(rel) }))
    .filter(({ src }) => /web-01-test/.test(src));
  assert.ok(candidates.length > 0, 'no AP-0036 test under workflow/ mentions web-01-test');
  const all = candidates.map((c) => c.src).join('\n');
  const { rel, src } = candidates.find((c) => /TestWorkflowEnvironment/.test(c.src)) || candidates[0];
  assert.match(src, /TestWorkflowEnvironment/, `${rel} doesn't use TestWorkflowEnvironment`);
  assert.match(src, /VmReconcileWorkflow\b/, `${rel} doesn't run VmReconcileWorkflow`);
  assert.doesNotMatch(all, /mockStatic/, 'mockStatic is used');
  assert.doesNotMatch(src, /@Disabled\b[^;{]*\bclass\b/, `${rel} is disabled`);
  // The fake provider records the specs it receives in plan and createVm.
  assert.match(code(src), /ProviderPlan\s+plan\s*\(\s*VmSpec\s+\w+/, 'the fake cloud does not override plan(VmSpec)');
  assert.match(code(src), /String\s+createVm\s*\(\s*VmSpec\s+\w+/, 'the fake cloud does not override createVm(VmSpec, ...)');

  const active = methods(src).filter((m) => /@(?:Test|ParameterizedTest)\b/.test(m.annotations) && !/@Disabled\b/.test(m.annotations));
  assert.ok(active.length >= 3, `${rel} has ${active.length} active tests`);
  const reconciles = (b, cloudName) => new RegExp(`new\\s+ReconcileRequest\\s*\\([^;]*,\\s*${cloudName}\\s*\\)`).test(flat(b));

  // (a) cloudName web-01-test, spec web-01: plan and create get web-01-test; record and audit say web-01.
  const a = active.find((m) => reconciles(m.body, '"web-01-test"') && /"web-01"/.test(m.body)
    && /\bplan\w*/i.test(m.body) && /creat\w*/i.test(m.body) && /(audit|events)/i.test(m.body) && /(saved|record)/i.test(m.body)
    && !/fail/i.test(m.body) && !/autoAnswer/.test(m.body));
  assert.ok(a, `no active test (a): cloudName web-01-test to plan/create, records and audit with web-01`);
  assert.match(flat(a.body), /assert\w*\s*\([^;]*"web-01-test"[^;]*plan/i, `(a) ${a.name} doesn't assert plan got web-01-test`);
  assert.match(flat(a.body), /assert\w*\s*\([^;]*"web-01-test"[^;]*creat/i, `(a) ${a.name} doesn't assert createVm got web-01-test`);
  assert.match(flat(a.body), /assert\w*\s*\([^;]*(audit|events)/i, `(a) ${a.name} doesn't assert on the audit entries`);
  assert.match(flat(a.body), /assert\w*\s*\([^;]*"web-01"[^;]*/, `(a) ${a.name} doesn't assert the record says web-01`);

  // (b) cloudName null: the provider gets web-01.
  const b = active.find((m) => reconciles(m.body, 'null') && /"web-01"/.test(m.body) && !/"web-01-test"/.test(m.body));
  assert.ok(b, 'no active test (b): cloudName null gives the provider web-01');
  assert.match(flat(b.body), /assert\w*\s*\([^;]*"web-01"[^;]*(plan|creat)/i, `(b) ${b.name} doesn't assert the provider got web-01`);

  // (c) a failed build is rolled back with the cloud name.
  const c = active.find((m) => reconciles(m.body, '"web-01-test"') && /(fail|autoAnswer\s*=\s*false)/i.test(m.body)
    && /(delet|undo|DELETE)/i.test(m.body));
  assert.ok(c, 'no active test (c): the rollback deletes web-01-test');
  assert.match(flat(c.body), /assert\w*\s*\([^;]*"web-01-test"[^;]*(delet|undo|nameById)/i,
    `(c) ${c.name} doesn't assert the deleted VM is web-01-test`);
});

test('criterion 6: ReplayTest exists and no AP-0036 commit touches backend/src/test/resources/histories/', () => {
  assert.ok(at(LAST, `${TEST}/workflow/ReplayTest.java`) !== null, 'ReplayTest.java is missing');
  const bad = COMMITS.filter((sha) => CHANGES.get(sha).some((p) => p.startsWith('vm-intent/backend/src/test/resources/histories/')));
  assert.deepEqual(bad.map((s) => s.slice(0, 8)), [], 'AP-0036 commits touch recorded histories');
});

test('criterion 7: no AP-0036 commit changes docs/openapi.json or docs/openapi.yaml', () => {
  const bad = COMMITS.filter((sha) => CHANGES.get(sha).some((p) => /^vm-intent\/docs\/openapi\.(json|yaml)$/.test(p)));
  assert.deepEqual(bad.map((s) => s.slice(0, 8)), []);
});

test('criterion 9: TEMPORAL-FEATURES.md says the cloud name comes from ReconcileRequest.cloudName and names the test', () => {
  const doc = flat(must(DOC));
  assert.match(doc, /ReconcileRequest\.cloudName/, 'ReconcileRequest.cloudName not mentioned');
  assert.match(doc, /ReconcileRequest\.cloudName`?\s*\(\s*null\s*=/, 'the null meaning is not stated next to ReconcileRequest.cloudName');
  assert.match(doc, /never (work|compute|calculat|derive)/i, "it doesn't say the workflows never compute the name");
  const cls = git(['diff', '--name-only', '--diff-filter=A', `${COMMITS[0]}^`, LAST, '--', `:(top)vm-intent/${TEST}/workflow/`])
    .split('\n').filter((p) => p.endsWith('Test.java')).map((p) => p.split('/').pop().replace(/\.java$/, ''));
  const named = ['CloudNameTest', ...cls].filter((n) => doc.includes(n));
  assert.ok(named.length > 0, `TEMPORAL-FEATURES.md doesn't name the new test class (${cls.join(', ') || 'CloudNameTest'})`);
});

test('criterion 10: AP-0036 work commits stay in backend/src/ and the two docs; none touches protected, frontend or deploy', () => {
  const allowed = (p) => p.startsWith('vm-intent/tests/acceptance/') || p.startsWith('vm-intent/backend/src/')
    || p === 'vm-intent/docs/TEMPORAL-FEATURES.md' || p === 'vm-intent/docs/AGENT-REQUIREMENTS.md';
  const outside = WORK.flatMap((sha) => CHANGES.get(sha).filter((p) => !allowed(p)).map((p) => `${sha.slice(0, 8)} ${p}`));
  assert.deepEqual(outside, [], 'files outside the allowed places');
  const prot = COMMITS.flatMap((sha) => CHANGES.get(sha).filter((p) => PROTECTED.some((r) => r.test(p))).map((p) => `${sha.slice(0, 8)} ${p}`));
  assert.deepEqual(prot, [], 'protected, frontend or deploy files touched');
});
