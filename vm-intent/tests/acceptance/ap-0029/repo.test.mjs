// AP-0029 acceptance, repository half: VmIdentity.buildKey / hashOfBuildKey exist and are tested; the workflow builds
// its key through them; each of vCenter, VCF Automation and Azure has tests for adopting a new run of the same spec,
// refusing a VM built for another spec, and the "no key" case; no AP-0029 commit adds a failure type, touches the
// recorded histories or the OpenAPI snapshot; the docs say when a VM is adopted (criteria 1-8, 10).
//
// Unit-test results are read from backend/target/surefire-reports, which the pipeline's build gate writes; this file
// never runs mvn. When there are no reports (a checkout that wasn't built), those checks are skipped, not passed.
//
//   node --test tests/acceptance/ap-0029/repo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const MAIN = join(ROOT, 'backend', 'src', 'main', 'java', 'com', 'example', 'vmintent');
const TEST = join(ROOT, 'backend', 'src', 'test', 'java', 'com', 'example', 'vmintent');
const REPORTS = join(ROOT, 'backend', 'target', 'surefire-reports');
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/** This requirement's commits, newest first (the pipeline's "AP-0029: ..." subjects). */
function commits() {
  const shas = git('log', '--format=%H', '--no-merges', '--grep=^AP-0029:').split('\n').filter(Boolean);
  assert.ok(shas.length > 0, 'found the AP-0029 commits');
  return shas;
}

// ---------------------------------------------------------------- surefire reports

/** { suite attrs, cases: [{ name, status }] } for one test class, or null when there's no report for it. */
function report(cls) {
  const f = join(REPORTS, `TEST-com.example.vmintent.${cls}.xml`);
  if (!existsSync(f)) return null;
  const xml = read(f);
  const head = /<testsuite\b([^>]*)>/.exec(xml);
  const attr = (s, k) => (new RegExp(`\\b${k}="([^"]*)"`).exec(s) || [])[1];
  const cases = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const body = m[2] || '';
    const status = /<(failure|error)\b/.test(body) ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed';
    cases.push({ name: attr(m[1], 'name'), status });
  }
  const n = (k) => Number(attr(head?.[1] || '', k) || 0);
  return { tests: n('tests'), failures: n('failures'), errors: n('errors'), cases };
}

const haveReports = existsSync(REPORTS) && readdirSync(REPORTS).some((f) => f.startsWith('TEST-') && f.endsWith('.xml'));

/** Asserts the test method passed in its class's surefire report (skips the check when nothing was built). */
function assertPassed(t, cls, method) {
  if (!haveReports) { t.diagnostic(`no surefire reports in ${REPORTS}; ${cls}.${method} not checked`); return; }
  const r = report(cls);
  assert.ok(r, `surefire report for ${cls} exists`);
  const runs = r.cases.filter((c) => c.name === method || c.name.startsWith(method + '(') || c.name.startsWith(method + ' '));
  assert.ok(runs.length > 0, `${cls}.${method} ran (report lists ${r.cases.map((c) => c.name).join(', ')})`);
  for (const c of runs) assert.equal(c.status, 'passed', `${cls}.${method} ${c.name}: ${c.status}`);
}

// ---------------------------------------------------------------- Java test sources

/** The @Test methods of a Java test source: [{ name, body }]. The body runs to the next @Test (good enough here). */
function testMethods(src) {
  const parts = src.split(/@Test\b|@ParameterizedTest\b/).slice(1);
  return parts.map((p) => {
    const m = /void\s+(\w+)\s*\(/.exec(p);
    return { name: m ? m[1] : '?', body: p };
  });
}

/** VmIdentity.buildKey(<hash expr>, "<suffix>") calls in a method body. */
function buildKeyCalls(body) {
  return [...body.matchAll(/VmIdentity\.buildKey\(\s*([\w.]+)\s*,\s*"([^"]*)"\s*\)/g)].map((m) => ({ hash: m[1], run: m[2] }));
}

const BACKENDS = [
  { cls: 'provider.vsphere.VcenterBackendTest', file: join(TEST, 'provider', 'vsphere', 'VcenterBackendTest.java'), mock: /\bvc\.|MockVcenter/ },
  { cls: 'provider.vsphere.VcfaBackendTest', file: join(TEST, 'provider', 'vsphere', 'VcfaBackendTest.java'), mock: /\bvcfa\.|MockVcfa/ },
  { cls: 'provider.azure.AzureArmBackendTest', file: join(TEST, 'provider', 'azure', 'AzureArmBackendTest.java'), mock: /\barm\.|MockArm/ },
];

// ---------------------------------------------------------------- criterion 1

test('1: surefire reports show 0 failures and 0 errors, with ReplayTest and the three backend tests run', (t) => {
  if (!haveReports) { t.skip(`no surefire reports in ${REPORTS}`); return; }
  const bad = [];
  for (const f of readdirSync(REPORTS).filter((x) => x.startsWith('TEST-') && x.endsWith('.xml'))) {
    const head = /<testsuite\b([^>]*)>/.exec(read(join(REPORTS, f)));
    const failures = Number((/\bfailures="(\d+)"/.exec(head?.[1] || '') || [])[1] || 0);
    const errors = Number((/\berrors="(\d+)"/.exec(head?.[1] || '') || [])[1] || 0);
    if (failures || errors) bad.push(`${f}: ${failures} failures, ${errors} errors`);
  }
  assert.deepEqual(bad, [], 'every surefire report has 0 failures and 0 errors');
  for (const cls of ['workflow.ReplayTest', ...BACKENDS.map((b) => b.cls), 'spec.VmIdentityTest']) {
    const r = report(cls);
    assert.ok(r, `surefire report for ${cls}`);
    assert.ok(r.tests > 0, `${cls} ran tests`);
    assert.equal(r.failures + r.errors, 0, `${cls}: ${r.failures} failures, ${r.errors} errors`);
  }
});

// ---------------------------------------------------------------- criterion 2

test('2: VmIdentity has public static buildKey(String hash, String runIdPrefix) and hashOfBuildKey(String key)', () => {
  const src = read(join(MAIN, 'spec', 'VmIdentity.java'));
  assert.match(src, /public\s+static\s+String\s+buildKey\s*\(\s*String\s+hash\s*,\s*String\s+runIdPrefix\s*\)/);
  assert.match(src, /public\s+static\s+String\s+hashOfBuildKey\s*\(\s*String\s+key\s*\)/);
});

test('2: a VmIdentity unit test pins buildKey(h, null/""), buildKey(h, "abcd1234") and hashOfBuildKey, and passes', (t) => {
  const src = read(join(TEST, 'spec', 'VmIdentityTest.java'));
  const m = testMethods(src).find((x) => /buildKey\(/.test(x.body) && /hashOfBuildKey\(/.test(x.body));
  assert.ok(m, 'VmIdentityTest has a test calling buildKey and hashOfBuildKey');
  const b = m.body;
  assert.match(b, /assertEquals\(\s*(\w+)\s*,\s*VmIdentity\.buildKey\(\s*\1\s*,\s*null\s*\)\s*\)/, 'buildKey(h, null) == h');
  assert.match(b, /assertEquals\(\s*(\w+)\s*,\s*VmIdentity\.buildKey\(\s*\1\s*,\s*""\s*\)\s*\)/, 'buildKey(h, "") == h');
  assert.match(b, /assertEquals\(\s*(\w+)\s*\+\s*"-abcd1234"\s*,\s*VmIdentity\.buildKey\(\s*\1\s*,\s*"abcd1234"\s*\)\s*\)/,
    'buildKey(h, "abcd1234") == h + "-abcd1234"');
  assert.match(b, /assertEquals\(\s*(\w+)\s*,\s*VmIdentity\.hashOfBuildKey\(\s*\1\s*\)\s*\)/, 'hashOfBuildKey(h) == h');
  assert.match(b, /assertEquals\(\s*(\w+)\s*,\s*VmIdentity\.hashOfBuildKey\(\s*\1\s*\+\s*"-abcd1234"\s*\)\s*\)/,
    'hashOfBuildKey(h + "-abcd1234") == h');
  assertPassed(t, 'spec.VmIdentityTest', m.name);
});

// ---------------------------------------------------------------- criterion 3

test('3: VmReconcileWorkflowImpl builds its key through VmIdentity.buildKey, not by joining specHash + "-" + runId', () => {
  const src = read(join(MAIN, 'workflow', 'VmReconcileWorkflowImpl.java'));
  assert.match(src, /VmIdentity\.buildKey\(\s*request\.specHash\(\)/, 'buildKey is called with the spec hash');
  assert.match(src, /VmIdentity\.buildKey\([\s\S]{0,200}getRunId\(\)\.substring\(0,\s*8\)/, 'and the first 8 characters of the run ID');
  assert.doesNotMatch(src, /specHash\(\)\s*\+\s*"-"/, 'no hand-joined specHash + "-"');
  assert.doesNotMatch(src, /\+\s*"-"\s*\+\s*Workflow\.getInfo\(\)\.getRunId\(\)/, 'no hand-joined "-" + runId');
});

test('3: no AP-0029 commit modifies or deletes a recorded history', () => {
  const changed = [];
  for (const sha of commits()) {
    const out = git('show', '--name-status', '--format=', sha, '--', ':(top)vm-intent/backend/src/test/resources/histories');
    for (const line of out.split('\n').filter(Boolean)) if (!line.startsWith('A')) changed.push(`${sha.slice(0, 8)} ${line}`);
  }
  assert.deepEqual(changed, [], 'histories modified or deleted');
});

// ---------------------------------------------------------------- criteria 4, 5, 6

for (const b of BACKENDS) {
  const name = b.cls.split('.').pop();

  test(`4a: ${name}: a new run of the same spec (same hash, other run suffix) adopts the existing VM; nothing new is built`, (t) => {
    const methods = testMethods(read(b.file));
    const m = methods.find((x) => {
      const calls = buildKeyCalls(x.body);
      const sameHash = calls.length >= 2 && calls.every((c) => c.hash === calls[0].hash) && new Set(calls.map((c) => c.run)).size >= 2;
      return sameHash && !/assertThrows/.test(x.body) && /assertEquals\(\s*\w+\s*,\s*backend\.createVm\(/.test(x.body) && b.mock.test(x.body);
    });
    assert.ok(m, `${name} has a test building with one hash, then createVm with the same hash and another run suffix, `
      + `asserting the same vmId and checking the mock (methods: ${methods.map((x) => x.name).join(', ')})`);
    // Nothing new: the mock's deploy / deployment / VM count is checked.
    assert.match(m.body, /assertEquals\(\s*(?:1|vms)\s*,|tasks\.size\(\)|deployments\.size\(\)|changes\(\)/, `${m.name} checks nothing new was built`);
    assertPassed(t, b.cls, m.name);
  });

  test(`4b: ${name}: the same name with another spec hash is refused with non-retryable InvalidSpec and left alone`, (t) => {
    const methods = testMethods(read(b.file));
    const m = methods.find((x) => {
      const calls = buildKeyCalls(x.body);
      return new Set(calls.map((c) => c.hash)).size >= 2 && /assertThrows\(\s*ApplicationFailure\.class/.test(x.body)
        && /"InvalidSpec"/.test(x.body) && /isNonRetryable\(\)/.test(x.body) && /assertTrue\([^;]*isNonRetryable/.test(x.body);
    });
    assert.ok(m, `${name} has a test where another spec hash gets a non-retryable InvalidSpec (methods: ${methods.map((x) => x.name).join(', ')})`);
    assert.match(m.body, /assertEquals\(\s*"InvalidSpec"\s*,\s*\w+\.getType\(\)\s*\)/, `${m.name} asserts the type is InvalidSpec`);
    assert.match(m.body, /assertEquals\(\s*(?:1|vms)\s*,[^;]*(?:size\(\)|vms\(\))/, `${m.name} checks the VM or deployment count is unchanged`);
    assert.match(m.body, /DELETE|not removed|still there|untouched|status/, `${m.name} checks the existing VM isn't deleted`);
    assertPassed(t, b.cls, m.name);
  });
}

test('5: vCenter: a VM tagged as vm-intent\'s with no readable key in its notes is still adopted', (t) => {
  const methods = testMethods(read(BACKENDS[0].file));
  const m = methods.find((x) => /addTaggedVm\(/.test(x.body) && !/assertThrows/.test(x.body) && !/Key \w/.test((/addTaggedVm\(([^)]*)\)/.exec(x.body) || [])[1] || ''));
  assert.ok(m, `VcenterBackendTest adopts a tagged VM whose notes have no key (methods: ${methods.map((x) => x.name).join(', ')})`);
  assert.match(m.body, /assertEquals\(\s*"vcenter:[^"]+"\s*,\s*backend\.createVm\(/, `${m.name} checks createVm returns the VM's ID`);
  assert.match(m.body, /tasks\.isEmpty\(\)|deployBodies\.isEmpty\(\)/, `${m.name} checks nothing was deployed`);
  assertPassed(t, BACKENDS[0].cls, m.name);
});

test('5: Azure: a VM tagged vm-intent=managed with no vm-intent-key tag is still adopted', (t) => {
  const methods = testMethods(read(BACKENDS[2].file));
  const m = methods.find((x) => /put\(\s*"vm-intent"\s*,\s*"managed"\s*\)/.test(x.body) && !/vm-intent-key"\s*,/.test(x.body.replace(/path\("vm-intent-key"\)/g, ''))
    && !/assertThrows/.test(x.body));
  assert.ok(m, `AzureArmBackendTest adopts a managed VM without a key tag (methods: ${methods.map((x) => x.name).join(', ')})`);
  assert.match(m.body, /assertEquals\(\s*"arm:"[^;]*backend\.createVm\(/, `${m.name} checks createVm returns the VM's ID`);
  assert.match(m.body, /assertEquals\(\s*0\s*,\s*changes\(\)/, `${m.name} checks nothing was sent`);
  assertPassed(t, BACKENDS[2].cls, m.name);
});

test('5: VCF Automation: a same-named deployment with no vm-intent key in its description is refused (InvalidSpec)', (t) => {
  const methods = testMethods(read(BACKENDS[1].file));
  const m = methods.find((x) => /addDeployment\(/.test(x.body) && /assertThrows\(\s*ApplicationFailure\.class/.test(x.body)
    && /"InvalidSpec"/.test(x.body) && /isNonRetryable\(\)/.test(x.body));
  assert.ok(m, `VcfaBackendTest refuses a deployment without a key (methods: ${methods.map((x) => x.name).join(', ')})`);
  const desc = (/addDeployment\(\s*"[^"]*"\s*,\s*"([^"]*)"/.exec(m.body) || [])[1];
  assert.ok(desc !== undefined, `${m.name} gives the deployment a literal description`);
  assert.doesNotMatch(desc, /vm-intent build/, `the description "${desc}" carries no vm-intent key`);
  assertPassed(t, BACKENDS[1].cls, m.name);
});

test('6: VcenterBackendTest.aRetriedCreateDoesNotDeployTwice still exists and passes', (t) => {
  const methods = testMethods(read(BACKENDS[0].file));
  assert.ok(methods.some((x) => x.name === 'aRetriedCreateDoesNotDeployTwice'), 'the test method exists');
  assertPassed(t, BACKENDS[0].cls, 'aRetriedCreateDoesNotDeployTwice');
});

// ---------------------------------------------------------------- criterion 7

test('7: no AP-0029 commit adds a new ApplicationFailure type string; the refusal is InvalidSpec', () => {
  const shas = commits();
  const base = shas[shas.length - 1] + '^';
  const types = new Set();
  for (const sha of shas) {
    const diff = git('show', '--format=', '--unified=0', sha, '--', ':(top)vm-intent/backend/src/main');
    const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n');
    for (const call of added.matchAll(/ApplicationFailure\.new\w*\(([\s\S]*?)\);/g)) {
      const lits = [...call[1].matchAll(/"([^"\\]*)"/g)].map((x) => x[1]).filter((s) => /^[A-Z][A-Za-z]+$/.test(s));
      if (lits.length) types.add(lits[lits.length - 1]);
    }
  }
  assert.ok(types.has('InvalidSpec'), `the new refusals throw InvalidSpec (found: ${[...types].join(', ') || 'none'})`);
  const fresh = [...types].filter((ty) => {
    try {
      return !git('grep', '-l', '-F', `"${ty}"`, base, '--', ':(top)vm-intent/backend/src/main').trim();
    } catch { return true; } // git grep exits 1 when nothing matches
  });
  assert.deepEqual(fresh, [], 'failure types that did not exist before AP-0029');
});

// ---------------------------------------------------------------- criterion 8

test('8: no AP-0029 commit modifies docs/openapi.json or docs/openapi.yaml', () => {
  const changed = [];
  for (const sha of commits()) {
    const out = git('show', '--name-only', '--format=', sha, '--', ':(top)vm-intent/docs/openapi.json', ':(top)vm-intent/docs/openapi.yaml');
    if (out.trim()) changed.push(`${sha.slice(0, 8)}: ${out.trim()}`);
  }
  assert.deepEqual(changed, []);
});

// ---------------------------------------------------------------- criterion 10

/** The text of a markdown section from its heading to the next heading of the same or higher level. */
function section(md, heading) {
  const lines = md.split('\n');
  const i = lines.findIndex((l) => /^#+\s/.test(l) && heading.test(l));
  if (i < 0) return '';
  const level = /^#+/.exec(lines[i])[0].length;
  let j = i + 1;
  while (j < lines.length && !(/^#+\s/.test(lines[j]) && /^#+/.exec(lines[j])[0].length <= level)) j++;
  return lines.slice(i, j).join('\n');
}

const flat = (s) => s.replace(/\s+/g, ' ');
const ADOPT = /adopted only when[^.]*vm-intent key[^.]*same spec hash/i;

test('10: docs/VSPHERE.md says a same-named VM is adopted only with the same spec hash, otherwise InvalidSpec', () => {
  const md = flat(read(join(ROOT, 'docs', 'VSPHERE.md')));
  assert.match(md, ADOPT, 'VSPHERE.md: adopted only when its recorded vm-intent key has the same spec hash');
  const at = md.search(ADOPT);
  assert.match(md.slice(at, at + 600), /InvalidSpec/, 'VSPHERE.md: otherwise refused with InvalidSpec');
});

test('10: docs/VSPHERE.md notes that on the VCF Automation route a same-named deployment without a key is refused', () => {
  const md = read(join(ROOT, 'docs', 'VSPHERE.md'));
  const vcfa = flat(section(md, /VCF Automation|Aria/i)) || flat(md);
  assert.match(vcfa, /deployment[^.]*without a vm-intent key[^.]*refused|refused[^.]*deployment[^.]*without a vm-intent key/i,
    'the VCF Automation part says a same-named deployment without a vm-intent key is refused');
});

test('10: docs/AZURE.md (or README/DEFINITIONS Azure section) says the same for Azure', () => {
  let text = '';
  if (existsSync(join(ROOT, 'docs', 'AZURE.md'))) text = read(join(ROOT, 'docs', 'AZURE.md'));
  else for (const f of ['README.md', join('docs', 'DEFINITIONS.md')]) if (existsSync(join(ROOT, f))) text += section(read(join(ROOT, f)), /Azure/i);
  const md = flat(text);
  assert.match(md, ADOPT, 'Azure docs: adopted only when its recorded vm-intent key has the same spec hash');
  const at = md.search(ADOPT);
  assert.match(md.slice(at, at + 600), /InvalidSpec/, 'Azure docs: otherwise refused with InvalidSpec');
});
