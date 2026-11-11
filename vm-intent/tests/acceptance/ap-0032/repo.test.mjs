// AP-0032 acceptance, repository half (criteria 1-8, 10-12): a real cloud backend adopts an existing same-named VM
// only when its recorded build key has the same spec hash. VmIdentity gains buildKey/hashOfBuildKey, the reconcile
// workflow uses buildKey, the three backends' unit tests cover adopt / refuse (InvalidSpec) / no-key, VSPHERE.md and
// AZURE.md say so, and AP-0032 commits stay inside backend/src/, those docs and this folder.
//
// Source and docs are read as they were at the newest AP-0032 commit that changed them, and "must not change" checks
// look only at AP-0032 commits, so later requirements can change these files without breaking this suite. The build
// gates run mvn test (criterion 1's pass/fail); this suite only reads sources, never build outputs.
//
//   node --test tests/acceptance/ap-0032/repo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..'); // vm-intent/
const MAIN = 'backend/src/main/java/com/example/vmintent';
const TEST = 'backend/src/test/java/com/example/vmintent';
const IDENTITY = `${MAIN}/spec/VmIdentity.java`;
const WORKFLOW = `${MAIN}/workflow/VmReconcileWorkflowImpl.java`;
const BACKENDS = {
  VcenterBackend: { main: `${MAIN}/provider/vsphere/VcenterBackend.java`, test: `${TEST}/provider/vsphere/VcenterBackendTest.java`, mock: 'MockVcenter' },
  VcfaBackend: { main: `${MAIN}/provider/vsphere/VcfaBackend.java`, test: `${TEST}/provider/vsphere/VcfaBackendTest.java`, mock: 'MockVcfa' },
  AzureArmBackend: { main: `${MAIN}/provider/azure/AzureArmBackend.java`, test: `${TEST}/provider/azure/AzureArmBackendTest.java`, mock: 'MockArm' },
};
const ALLOWED_DOCS = ['docs/VSPHERE.md', 'docs/AZURE.md', 'docs/TEMPORAL-FEATURES.md', 'docs/AGENT-REQUIREMENTS.md']
  .map((p) => `vm-intent/${p}`);
const PROTECTED = [
  /^agent-pipeline\//, /^\.github\//, /^\.gitlab-ci\.yml$/, /^vm-intent\/deploy\/azure\//, /^vm-intent\/deploy\/pki\//,
  /^vm-intent\/deploy\/catalog\/gitlab-ci/, /^vm-intent\/[^/]+\.cmd$/, /^vm-intent\/[^/]+\.ps1$/,
  /^vm-intent\/backend\/src\/main\/java\/com\/example\/vmintent\/security\//,
  /^vm-intent\/backend\/src\/main\/resources\/application-tls\.yml$/, /^vm-intent\/docs\/SECURITY\.md$/,
];

const git = (args) => execFileSync('git', args,
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

// Oldest first.
const COMMITS = git(['log', '--reverse', '--format=%H', '--grep', '^AP-0032:']).split('\n').filter(Boolean);

function changed(sha) {
  return git(['diff', '--name-status', '--no-renames', `${sha}^`, sha]).split('\n').filter(Boolean)
    .map((l) => l.split('\t'));
}
const CHANGES = new Map(COMMITS.map((sha) => [sha, changed(sha)]));
const touching = (prefix) => COMMITS.filter((sha) => CHANGES.get(sha).some(([, p]) => p.startsWith(prefix)));
const SRC_COMMITS = touching('vm-intent/backend/src/');
const FIRST = SRC_COMMITS[0];
const LAST = SRC_COMMITS[SRC_COMMITS.length - 1];

/** A vm-intent/ file as it was at a commit, or null if it didn't exist. */
function at(sha, rel) {
  try { return git(['show', `${sha}:vm-intent/${rel}`]).replace(/\r\n/g, '\n'); } catch { return null; }
}
/** A file as it was at the newest AP-0032 commit that changed it (or, failing that, that changed backend/src). */
function must(rel) {
  assert.ok(LAST, 'no AP-0032 commit changes vm-intent/backend/src/');
  const own = touching(`vm-intent/${rel}`);
  const sha = own.length ? own[own.length - 1] : LAST;
  const t = at(sha, rel);
  assert.ok(t !== null, `${rel} doesn't exist at ${sha.slice(0, 8)}`);
  return t;
}
/** Lines added to a file by the AP-0032 commits. */
function added(rel) {
  return COMMITS.flatMap((sha) => git(['diff', `${sha}^`, sha, '--', `:(top)vm-intent/${rel}`]).split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)));
}
const flat = (s) => s.replace(/\s+/g, ' ');

/** Strips Java comments and string/char literals' contents' braces, keeping offsets, so braces can be matched. */
function blankNonCode(src) {
  let out = '';
  for (let i = 0; i < src.length;) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { const e = src.indexOf('\n', i); const j = e < 0 ? src.length : e; out += ' '.repeat(j - i); i = j; }
    else if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); const j = e < 0 ? src.length : e + 2; out += src.slice(i, j).replace(/[^\n]/g, ' '); i = j; }
    else if (c === '"' && src.startsWith('"""', i)) { const e = src.indexOf('"""', i + 3); const j = e < 0 ? src.length : e + 3; out += src.slice(i, j).replace(/[{}]/g, ' '); i = j; }
    else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      j = Math.min(j + 1, src.length);
      out += src.slice(i, j).replace(/[{}]/g, ' '); i = j;
    } else { out += c; i++; }
  }
  return out;
}

/** Every method in a Java source: its name, the annotations right before it and its body (comments kept). */
function methods(src) {
  const code = blankNonCode(src);
  const out = [];
  const re = /((?:@\w+(?:\.\w+)*(?:\([^)]*\))?\s+)*)(?:(?:public|protected|private|static|final|synchronized)\s+)*(?:<[^>]+>\s+)?[\w.<>\[\], ?]+\s+(\w+)\s*\([^;{)]*(?:\)[^;{]*)?\{/g;
  let m;
  while ((m = re.exec(code))) {
    const open = m.index + m[0].length - 1;
    let depth = 0, k = open;
    for (; k < code.length; k++) {
      if (code[k] === '{') depth++;
      else if (code[k] === '}' && --depth === 0) break;
    }
    const annotations = m[1] || '';
    out.push({ name: m[2], annotations, body: src.slice(open, k + 1) });
    re.lastIndex = open + 1; // nested methods (in anonymous classes) are found too; harmless
  }
  return out.filter((x) => !['if', 'for', 'while', 'switch', 'catch', 'synchronized', 'try', 'else', 'do', 'return', 'new'].includes(x.name));
}
const isActive = (m) => /@(?:Test|ParameterizedTest)\b/.test(m.annotations) && !/@Disabled\b/.test(m.annotations);
const classDisabled = (src, cls) => new RegExp(`@Disabled\\b[^;{]*\\bclass\\s+${cls}\\b`).test(src);

/** Every Java test source under backend/src/test/java (current tree), as {rel, src}. */
function testSources() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.java')) out.push({ rel, src: readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n') });
    }
  };
  walk('backend/src/test/java');
  return out;
}

/** The active test methods, in the backend's own test class (as of AP-0032) or a class that uses the backend and its mock. */
function activeTestsFor(backend) {
  const { test: rel, mock } = BACKENDS[backend];
  const out = [];
  const own = must(rel);
  const cls = rel.split('/').pop().replace('.java', '');
  if (!classDisabled(own, cls)) out.push(...methods(own).filter(isActive).map((m) => ({ ...m, file: rel })));
  for (const { rel: r, src } of testSources()) {
    if (r === rel || !src.includes(backend) || !src.includes(mock)) continue;
    const c = r.split('/').pop().replace('.java', '');
    if (classDisabled(src, c)) continue;
    out.push(...methods(src).filter(isActive).map((m) => ({ ...m, file: r })));
  }
  return out;
}
const count = (s, re) => (s.match(re) || []).length;
const describe = (ms) => ms.map((m) => `${m.file.split('/').pop()}#${m.name}`).join(', ') || '(none)';

// ---------------------------------------------------------------- criterion 1

test('criterion 1: the unit-test classes the gate runs exist in the test sources', () => {
  for (const cls of ['ReplayTest', 'VcenterBackendTest', 'VcfaBackendTest', 'AzureArmBackendTest', 'VmIdentityTest']) {
    const hit = testSources().find((s) => s.rel.endsWith(`/${cls}.java`));
    assert.ok(hit, `${cls}.java is missing from backend/src/test/java`);
    assert.ok(methods(hit.src).some(isActive), `${cls} has no active test method`);
  }
});

test('criterion 1: no AP-0032 acceptance check reads a build output directory', () => {
  const dirs = ['tar' + 'get', 'di' + 'st', 'bu' + 'ild'];
  const re = new RegExp(`['"\`/\\\\](?:${dirs.join('|')})['"\`/\\\\]`);
  for (const f of readdirSync(HERE).filter((n) => /\.(m?js|py)$/.test(n))) {
    const lines = readFileSync(join(HERE, f), 'utf8').split('\n');
    const bad = lines.filter((l) => re.test(l) && !/^\s*(\/\/|#)/.test(l));
    assert.deepEqual(bad, [], `${f} refers to a build output directory`);
  }
});

// ---------------------------------------------------------------- criterion 2

test('criterion 2: VmIdentity declares public static buildKey(String, String) and hashOfBuildKey(String)', () => {
  const src = blankNonCode(must(IDENTITY));
  assert.match(src, /public\s+static\s+(?:final\s+)?String\s+buildKey\s*\(\s*(?:final\s+)?String\s+\w+\s*,\s*(?:final\s+)?String\s+\w+\s*\)/,
    'VmIdentity has no public static String buildKey(String hash, String runIdPrefix)');
  assert.match(src, /public\s+static\s+(?:final\s+)?String\s+hashOfBuildKey\s*\(\s*(?:final\s+)?String\s+\w+\s*\)/,
    'VmIdentity has no public static String hashOfBuildKey(String key)');
});

test('criterion 2: an active VmIdentityTest method covers buildKey with null / "" / "abcd1234" and hashOfBuildKey', () => {
  const rel = `${TEST}/spec/VmIdentityTest.java`;
  const src = must(rel);
  assert.ok(!classDisabled(src, 'VmIdentityTest'), 'VmIdentityTest is @Disabled');
  const ms = methods(src).filter(isActive).filter((m) => m.body.includes('buildKey') && m.body.includes('hashOfBuildKey'));
  assert.ok(ms.length > 0, `no active VmIdentityTest method mentions both buildKey and hashOfBuildKey: ${describe(methods(src).filter(isActive).map((m) => ({ ...m, file: rel })))}`);
  const body = ms.map((m) => m.body).join('\n');
  const f = flat(body);
  assert.match(f, /buildKey\(\s*[\w.]+\s*,\s*null\s*\)/, 'buildKey(h, null) is not covered');
  assert.match(f, /buildKey\(\s*[\w.]+\s*,\s*""\s*\)/, 'buildKey(h, "") is not covered');
  assert.match(f, /buildKey\(\s*[\w.]+\s*,\s*"abcd1234"\s*\)/, 'buildKey(h, "abcd1234") is not covered');
  assert.ok(f.includes('"-abcd1234"'), 'the expected h + "-abcd1234" is not asserted');
  assert.ok(count(f, /assert\w*\(/g) >= 6, 'too few assertions to cover the three buildKey and three hashOfBuildKey cases');
  assert.ok(count(f, /hashOfBuildKey\(/g) >= 3, 'hashOfBuildKey is not checked for each of the three keys');
});

// ---------------------------------------------------------------- criterion 3

test('criterion 3: VmReconcileWorkflowImpl builds its key with VmIdentity.buildKey, not by joining specHash() + "-" + a run ID', () => {
  const src = blankNonCode(must(WORKFLOW));
  assert.match(src, /VmIdentity\s*\.\s*buildKey\s*\(/, 'VmReconcileWorkflowImpl does not call VmIdentity.buildKey');
  const f = flat(src);
  assert.doesNotMatch(f, /specHash\(\)\s*\+\s*"-"/, 'specHash() + "-" is still joined by hand');
  assert.doesNotMatch(f, /"-"\s*\+\s*Workflow\.getInfo\(\)\.getRunId\(\)/, '"-" + the run ID is still joined by hand');
});

test('criterion 3: no AP-0032 commit modifies or deletes a recorded history', () => {
  for (const [sha, files] of CHANGES) {
    const bad = files.filter(([, p]) => p.startsWith('vm-intent/backend/src/test/resources/histories/'));
    assert.deepEqual(bad, [], `${sha.slice(0, 8)} touches recorded histories`);
  }
});

// ---------------------------------------------------------------- criterion 4

for (const backend of Object.keys(BACKENDS)) {
  test(`criterion 4a: an active ${backend} test adopts a same-named VM whose key has the same hash and another run suffix`, () => {
    const all = activeTestsFor(backend);
    const ms = all.filter((m) => /adopt/i.test(m.name) && /createVm/.test(m.body) && !m.body.includes('InvalidSpec')
      && count(m.body, /buildKey\(|"[0-9a-f]{6,}-\w+"/g) >= 2 && !/no\s*key|without.*key|nokey/i.test(m.name));
    assert.ok(ms.length > 0, `no active adopt-same-hash test for ${backend} among ${describe(all)}`);
  });

  test(`criterion 4b: an active ${backend} test refuses (InvalidSpec) a same-named VM built for another spec hash`, () => {
    const all = activeTestsFor(backend);
    const ms = all.filter((m) => m.body.includes('InvalidSpec') && /createVm/.test(m.body)
      && /another|other|different/i.test(m.name + m.body) && count(m.body, /buildKey\(|"[0-9a-f]{6,}-\w+"/g) >= 2);
    assert.ok(ms.length > 0, `no active refuse-other-hash InvalidSpec test for ${backend} among ${describe(all)}`);
  });
}

// ---------------------------------------------------------------- criterion 5

for (const backend of ['VcenterBackend', 'AzureArmBackend']) {
  test(`criterion 5: an active ${backend} test still adopts a tagged VM with no readable vm-intent key`, () => {
    const all = activeTestsFor(backend);
    const ms = all.filter((m) => /adopt/i.test(m.name) && /no\w*key|without\w*key/i.test(m.name)
      && /createVm/.test(m.body) && !m.body.includes('InvalidSpec'));
    assert.ok(ms.length > 0, `no active no-key-adopted test for ${backend} among ${describe(all)}`);
  });
}

test('criterion 5: an active VcfaBackend test refuses (InvalidSpec) a same-named deployment with no vm-intent key', () => {
  const all = activeTestsFor('VcfaBackend');
  const ms = all.filter((m) => /no\w*key|without\w*key/i.test(m.name) && /refus/i.test(m.name)
    && m.body.includes('InvalidSpec') && /createVm/.test(m.body));
  assert.ok(ms.length > 0, `no active no-key-refused test for VcfaBackend among ${describe(all)}`);
});

// ---------------------------------------------------------------- criterion 6

test('criterion 6: VcenterBackendTest.aRetriedCreateDoesNotDeployTwice still exists, @Test, not @Disabled', () => {
  const src = must(BACKENDS.VcenterBackend.test);
  assert.ok(!classDisabled(src, 'VcenterBackendTest'), 'VcenterBackendTest is @Disabled');
  const m = methods(src).find((x) => x.name === 'aRetriedCreateDoesNotDeployTwice');
  assert.ok(m, 'aRetriedCreateDoesNotDeployTwice is gone');
  assert.match(m.annotations, /@Test\b/, 'aRetriedCreateDoesNotDeployTwice is not @Test');
  assert.doesNotMatch(m.annotations, /@Disabled\b/, 'aRetriedCreateDoesNotDeployTwice is @Disabled');
});

// ---------------------------------------------------------------- criterion 7

test('criterion 7: AP-0032 adds no new ApplicationFailure type string', () => {
  assert.ok(FIRST, 'no AP-0032 commit changes vm-intent/backend/src/');
  const before = git(['grep', '-h', '-o', '-E', '"[A-Z][A-Za-z]+"', `${FIRST}^`, '--', ':(top)vm-intent/backend/src/main/']);
  const known = new Set(before.split('\n').map((l) => l.trim()).filter(Boolean));
  const types = new Set();
  for (const sha of COMMITS) {
    const diff = git(['diff', '-U0', `${sha}^`, sha, '--', ':(top)vm-intent/backend/src/main/']);
    const plus = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
    // The type is the last argument of ApplicationFailure.newFailure / newNonRetryableFailure(...).
    for (const m of plus.matchAll(/,\s*("[A-Z][A-Za-z]+")\s*\)/g)) types.add(m[1]);
    for (const m of plus.matchAll(/ApplicationFailure\s*\.\s*new\w*Failure\w*\s*\(\s*[^;]*?,\s*("[A-Z][A-Za-z]+")/g)) types.add(m[1]);
  }
  const fresh = [...types].filter((t) => !known.has(t));
  assert.deepEqual(fresh, [], `AP-0032 adds ApplicationFailure-like type strings that did not exist before: ${fresh.join(', ')}`);
  assert.ok(known.has('"InvalidSpec"'), '"InvalidSpec" did not exist before AP-0032');
});

test('criterion 7: the new refusals in VcenterBackend, VcfaBackend and AzureArmBackend use InvalidSpec', () => {
  for (const name of ['VcenterBackend', 'VcfaBackend']) {
    const plus = added(BACKENDS[name].main).join('\n');
    assert.ok(plus.includes('"InvalidSpec"'), `AP-0032's additions to ${name}.java don't use "InvalidSpec"`);
  }
  const rel = BACKENDS.AzureArmBackend.main;
  const plus = added(rel).join('\n');
  const helper = /static\s+ApplicationFailure\s+invalid\s*\([^)]*\)\s*\{[^}]*"InvalidSpec"/.test(must(rel));
  assert.ok(plus.includes('"InvalidSpec"') || (/\binvalid\(/.test(plus) && helper),
    'AP-0032\'s additions to AzureArmBackend.java refuse neither with "InvalidSpec" nor through its InvalidSpec helper');
});

// ---------------------------------------------------------------- criterion 8 (repo half)

test('criterion 8: no AP-0032 commit modifies docs/openapi.json or docs/openapi.yaml', () => {
  for (const [sha, files] of CHANGES) {
    const bad = files.filter(([, p]) => p === 'vm-intent/docs/openapi.json' || p === 'vm-intent/docs/openapi.yaml');
    assert.deepEqual(bad, [], `${sha.slice(0, 8)} changes the OpenAPI snapshot`);
  }
});

// ---------------------------------------------------------------- criterion 10

test('criterion 10: AZURE.md says a same-named VM is adopted only with the same spec hash in its vm-intent key, else InvalidSpec', () => {
  const f = flat(must('docs/AZURE.md'));
  const para = f.split(/(?= - \*\*|\n)/).find((p) => /adopted only when/i.test(p)) || f;
  assert.match(para, /adopted only when[^.]*vm-intent key[^.]*same spec hash/i,
    'AZURE.md does not say an existing VM is adopted only when its recorded vm-intent key has the same spec hash');
  assert.match(para, /otherwise[^.]*refused[^.]*InvalidSpec/i, 'AZURE.md does not say it is otherwise refused with InvalidSpec');
});

test('criterion 10: VSPHERE.md says the same for vCenter, and that VCF Automation refuses a same-named deployment with no key', () => {
  const md = must('docs/VSPHERE.md');
  const i = md.indexOf('\n## VCF Automation');
  assert.ok(i > 0, 'VSPHERE.md has no "## VCF Automation" section');
  const vcenter = flat(md.slice(0, i));
  const vcfa = flat(md.slice(i).split('\n## ').slice(0, 2).join('\n## '));
  assert.match(vcenter, /adopted only when[^.]*vm-intent key[^.]*same spec hash/i,
    'VSPHERE.md (vCenter) does not say a VM is adopted only when its recorded vm-intent key has the same spec hash');
  assert.match(vcenter, /Otherwise[^.]*InvalidSpec/i, 'VSPHERE.md (vCenter) does not say it is otherwise refused with InvalidSpec');
  assert.match(vcfa, /adopted only when[^.]*vm-intent key[^.]*same spec hash/i,
    'VSPHERE.md (VCF Automation) does not say a deployment is adopted only with the same spec hash');
  assert.match(vcfa, /otherwise[^.]*InvalidSpec/i, 'VSPHERE.md (VCF Automation) does not say it is otherwise refused with InvalidSpec');
  assert.match(vcfa, /without (?:a|any) vm-intent key[^.]*refused|refused[^.]*without (?:a|any) vm-intent key|same-named deployment[^.]*without[^.]*key[^.]*refused/i,
    'VSPHERE.md does not say a same-named deployment without a vm-intent key is refused on the VCF Automation route');
});

// ---------------------------------------------------------------- criteria 11 and 12

test('criterion 11: AP-0032 commits change only backend/src/, the four allowed docs and tests/acceptance/', () => {
  assert.ok(COMMITS.length > 0, 'no AP-0032 commits');
  for (const [sha, files] of CHANGES) {
    for (const [, p] of files) {
      if (p.startsWith('vm-intent/tests/acceptance/')) continue;
      assert.ok(p.startsWith('vm-intent/backend/src/') || ALLOWED_DOCS.includes(p), `${sha.slice(0, 8)} changes ${p}`);
      assert.ok(!PROTECTED.some((re) => re.test(p)), `${sha.slice(0, 8)} changes protected file ${p}`);
      assert.ok(!p.startsWith('vm-intent/frontend/') && !p.startsWith('vm-intent/deploy/'), `${sha.slice(0, 8)} changes ${p}`);
    }
  }
});

test('criterion 12: AP-0032 commits leave the existing acceptance suites (ap-0002 to ap-0031) unchanged', () => {
  for (const [sha, files] of CHANGES) {
    const bad = files.filter(([, p]) => p.startsWith('vm-intent/tests/acceptance/') && !p.startsWith('vm-intent/tests/acceptance/ap-0032/'));
    assert.deepEqual(bad, [], `${sha.slice(0, 8)} changes another suite`);
  }
});
