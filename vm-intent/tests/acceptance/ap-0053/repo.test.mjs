// AP-0053 acceptance, repository half (criteria 1-7 and 9): CloudBackend is an interface with every provider call and
// no default methods; RoutedProvider is an abstract SimulatedProvider that VsphereProvider extends; VcenterBackend and
// VcfaBackend implement CloudBackend and keep their static owns and two-argument createVm; RoutedProviderTest covers
// the dispatch with a recording fake backend and a mocked SimCloud; the vSphere tests, the replay histories, the other
// providers, SimCloud, workflow/, security/ and the OpenAPI files are untouched; README and TEMPORAL-FEATURES name the
// new classes and test.
//
// "This requirement's commits" are the non-merge commits whose subject starts with "AP-0053:", leaving out the
// pipeline's own "acceptance tests" and "record the requirement" commits. Files are read with git show as they were at
// the newest such commit that changed them, and "before" is the parent of the oldest AP-0053 commit, so later
// requirements can change these files freely. Only sources are read, never build outputs; the build gates run
// mvn test (ReplayTest included).
//
//   node --test tests/acceptance/ap-0053/repo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = 'AP-0053';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const MAIN = 'backend/src/main/java/com/example/vmintent';
const PROV = `${MAIN}/provider`;
const CLOUD_BACKEND = `${PROV}/CloudBackend.java`;
const ROUTED = `${PROV}/RoutedProvider.java`;
const VSPHERE = `${PROV}/VsphereProvider.java`;
const VCENTER = `${PROV}/vsphere/VcenterBackend.java`;
const VCFA = `${PROV}/vsphere/VcfaBackend.java`;
const HISTORIES = 'vm-intent/backend/src/test/resources/histories/';

const git = (args) => execFileSync('git', args,
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

// Oldest first; subjects are checked here, because --grep also matches body lines.
const ALL = git(['log', '--no-merges', '--reverse', '--format=%H %s', '--grep', `^${ID}:`]).split('\n').filter(Boolean)
  .map((l) => ({ sha: l.slice(0, 40), subject: l.slice(41) })).filter((c) => c.subject.startsWith(`${ID}:`));
const isPipeline = (c) => /^AP-\d+: (acceptance tests|record the requirement)\b/.test(c.subject);
const KEPT = ALL.filter((c) => !isPipeline(c));
const COMMITS = KEPT.map((c) => c.sha);
const NEWEST = COMMITS[COMMITS.length - 1];
const BEFORE = ALL.length ? git(['rev-parse', `${ALL[0].sha}^`]).trim() : null;
/** "STATUS<tab>path" lines (repo-root paths) for one commit. */
const nameStatus = (sha) => git(['diff', '--name-status', '--no-renames', `${sha}^`, sha]).split('\n').filter(Boolean)
  .map((l) => { const [s, p] = l.split('\t'); return { status: s, path: p }; });
const CHANGES = new Map(ALL.map((c) => [c.sha, nameStatus(c.sha)]));
const touching = (rel) => COMMITS.filter((sha) => CHANGES.get(sha).some((c) => c.path === `vm-intent/${rel}`));

function at(sha, rel) {
  try { return git(['show', `${sha}:vm-intent/${rel}`]).replace(/\r\n/g, '\n'); } catch { return null; }
}
/** A file as it was at the newest kept AP-0053 commit that changed it (or the newest kept AP-0053 commit). */
function now(rel) {
  assert.ok(NEWEST, `no ${ID} commit`);
  const own = touching(rel);
  const sha = own.length ? own[own.length - 1] : NEWEST;
  const t = at(sha, rel);
  assert.ok(t !== null, `${rel} doesn't exist at ${sha.slice(0, 8)}`);
  return t;
}
/** Every file (vm-intent/-relative) at the newest kept commit. */
let files;
function allFiles() {
  if (!files) {
    files = git(['ls-tree', '-r', '--full-tree', '--name-only', NEWEST]).split('\n').filter((f) => f.startsWith('vm-intent/'))
      .map((f) => f.slice('vm-intent/'.length));
    assert.ok(files.length > 100, `ls-tree listed only ${files.length} files (test bug)`);
  }
  return files;
}
const squash = (s) => s.replace(/\s+/g, ' ').trim();

/** Java source with comments removed; with blank=true string literal contents become spaces (lengths kept). */
function noComments(src, blank = false) {
  let out = '';
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      out += blank ? '"' + ' '.repeat(Math.max(0, j - i - 1)) + '"' : src.slice(i, j + 1); i = j + 1;
    } else if (c === '\'') {
      let j = i + 1;
      while (j < src.length && src[j] !== '\'') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1); i = j + 1;
    } else if (src.startsWith('//', i)) { const j = src.indexOf('\n', i); i = j < 0 ? src.length : j; }
    else if (src.startsWith('/*', i)) { const j = src.indexOf('*/', i + 2); i = j < 0 ? src.length : j + 2; out += ' '; }
    else { out += c; i++; }
  }
  return out;
}
/** Every method named `name` with a body: { head, body } where head is the text since the previous member. */
function methods(src, name) {
  const out = [];
  const re = new RegExp(`[\\w<>,\\[\\]\\s]\\s+${name}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf('{', m.index);
    const semi = src.indexOf(';', m.index);
    if (open < 0 || (semi >= 0 && semi < open)) continue; // a call or abstract declaration
    let depth = 0; let j = open;
    for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}' && --depth === 0) break; }
    const before = src.slice(0, m.index);
    const cut = Math.max(before.lastIndexOf('}'), before.lastIndexOf(';'), before.lastIndexOf('{'));
    out.push({ head: before.slice(cut + 1), body: src.slice(open, j + 1) });
  }
  return out;
}
/** The @Test / @ParameterizedTest methods of a class source; asserts the class itself isn't @Disabled. */
function testMethods(src) {
  const code = noComments(src);
  const cls = code.search(/\bclass\s+\w+/);
  assert.ok(cls >= 0, 'no class');
  assert.doesNotMatch(code.slice(0, cls), /@Disabled\b/, 'the test class is @Disabled');
  const out = [];
  for (const m of code.matchAll(/void\s+(\w+)\s*\(/g)) {
    for (const x of methods(code, m[1])) {
      if (/@(Test|ParameterizedTest)\b/.test(x.head)) out.push({ name: m[1], ...x });
    }
  }
  return out.filter((x, i, a) => a.findIndex((y) => y.name === x.name && y.body === x.body) === i);
}
const isActive = (m) => !/@Disabled\b/.test(m.head);
/** The statements of a body that assert or verify something, squashed. */
const assertions = (body) => body.split(/;\s*/).filter((s) => /\b(assert\w*|verify\w*)\s*\(/.test(s)).map(squash);
/** The body of the top-level type named `name` (from its declaration to its matching brace). */
function typeBody(code, re) {
  const m = code.match(re);
  assert.ok(m, `no declaration matching ${re}`);
  const open = code.indexOf('{', m.index);
  let depth = 0; let j = open;
  for (; j < code.length; j++) { if (code[j] === '{') depth++; else if (code[j] === '}' && --depth === 0) break; }
  return { decl: code.slice(m.index, open), body: code.slice(open + 1, j) };
}

test(`there is an ${ID} commit (other than the pipeline's own)`, () => {
  assert.ok(COMMITS.length > 0, `no non-pipeline commit subject starts with ${ID}:`);
});

// ------------------------------------------------------------------ 1. replay histories untouched

test('criterion 1: no AP-0053 commit modifies or deletes an existing file under backend/src/test/resources/histories/', () => {
  const bad = [];
  for (const c of ALL) {
    for (const ch of CHANGES.get(c.sha)) {
      if (ch.path.startsWith(HISTORIES) && ch.status !== 'A') bad.push(`${c.sha.slice(0, 8)} ${ch.status} ${ch.path}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('criterion 1: ReplayTest is still there, active, and replays the files under histories/', () => {
  const file = allFiles().find((f) => f.startsWith('backend/src/test/java/') && f.endsWith('/ReplayTest.java'));
  assert.ok(file, 'no ReplayTest.java under backend/src/test/java');
  const src = at(NEWEST, file);
  assert.match(src, /histories/, 'ReplayTest no longer reads histories/');
  const tests = testMethods(src);
  assert.ok(tests.length > 0 && tests.every(isActive), 'ReplayTest has no active test method');
  assert.ok(allFiles().some((f) => f.startsWith('backend/src/test/resources/histories/')), 'histories/ is empty');
});

// ------------------------------------------------------------------ 2. CloudBackend

test('criterion 2: CloudBackend is a public interface with the nine methods, no default methods and no owns', () => {
  const code = noComments(now(CLOUD_BACKEND), true);
  assert.match(code, /^\s*package\s+com\.example\.vmintent\.provider\s*;/m, 'CloudBackend is not in com.example.vmintent.provider');
  const { decl, body } = typeBody(code, /\bpublic\s+interface\s+CloudBackend\b/);
  assert.match(decl, /public\s+interface\s+CloudBackend/);
  assert.doesNotMatch(body, /\bdefault\b/, 'CloudBackend has a default method');
  // Every method declaration in the interface body (abstract, so ends with ";").
  const decls = [...body.matchAll(/([\w<>\[\],.?\s]+?)\s+(\w+)\s*\(([^)]*)\)\s*(?:throws[^;{]*)?([;{])/g)]
    .map((m) => ({ ret: squash(m[1]).split(' ').pop(), name: m[2], params: squash(m[3]), end: m[4] }));
  const names = decls.map((d) => d.name);
  assert.ok(!names.includes('owns'), `CloudBackend has a method named owns: ${names}`);
  const withBody = decls.filter((d) => d.end === '{').map((d) => d.name);
  assert.deepEqual(withBody, [], 'CloudBackend has methods with bodies (default or static)');
  for (const n of ['handles', 'plan', 'createVm', 'describeVm', 'deleteVm', 'resizeVm', 'setPower', 'snapshotVm', 'listVmIds']) {
    assert.ok(names.includes(n), `CloudBackend doesn't declare ${n}: ${names}`);
  }
  const handles = decls.find((d) => d.name === 'handles');
  assert.match(handles.params, /^(final\s+)?String\s+\w+$/, `handles takes (${handles.params}), not (String)`);
  const create = decls.filter((d) => d.name === 'createVm');
  assert.ok(create.some((d) => /^(final\s+)?VmSpec\s+\w+\s*,\s*(final\s+)?ProviderPlan\s+\w+\s*,\s*(final\s+)?String\s+\w+$/.test(d.params)),
    `createVm doesn't take (VmSpec spec, ProviderPlan plan, String key): ${create.map((d) => d.params).join(' | ')}`);
});

// ------------------------------------------------------------------ 3. RoutedProvider and VsphereProvider

test('criterion 3: RoutedProvider declares an abstract class that extends SimulatedProvider', () => {
  const code = noComments(now(ROUTED), true);
  assert.match(code, /^\s*package\s+com\.example\.vmintent\.provider\s*;/m, 'RoutedProvider is not in com.example.vmintent.provider');
  assert.match(code, /\babstract\s+(?:public\s+)?class\s+RoutedProvider\s+extends\s+SimulatedProvider\b|\bpublic\s+abstract\s+class\s+RoutedProvider\s+extends\s+SimulatedProvider\b/,
    'no "abstract class RoutedProvider extends SimulatedProvider"');
});

test('criterion 3: VsphereProvider extends RoutedProvider and no longer calls VcenterBackend.owns or VcfaBackend.owns', () => {
  const code = noComments(now(VSPHERE), true);
  assert.match(code, /\bclass\s+VsphereProvider\s+extends\s+RoutedProvider\b/, 'VsphereProvider does not extend RoutedProvider');
  const calls = [...code.matchAll(/\b(?:[\w.]*\.)?(VcenterBackend|VcfaBackend)\s*\.\s*owns\s*\(/g)].map((m) => squash(m[0]));
  assert.deepEqual(calls, [], 'VsphereProvider still calls owns');
  // It had them before (so the check above isn't vacuous).
  assert.match(noComments(at(BEFORE, VSPHERE) ?? '', true), /\b(VcenterBackend|VcfaBackend)\s*\.\s*owns\s*\(/,
    'VsphereProvider did not call owns before AP-0053 (test assumption)');
});

test('criterion 3: VsphereProvider keeps its public (SimCloud, VsphereRoutes) constructor and its two task queues', () => {
  const code = noComments(now(VSPHERE), true);
  assert.match(code, /\bpublic\s+VsphereProvider\s*\(\s*(final\s+)?SimCloud\s+\w+\s*,\s*(final\s+)?VsphereRoutes\s+\w+\s*\)/,
    'no public VsphereProvider(SimCloud, VsphereRoutes) constructor');
  const ann = code.match(/@ActivityImpl\s*\(([^)]*)\)/);
  assert.ok(ann, 'no @ActivityImpl(...) annotation');
  assert.match(ann[1], /\bTaskQueues\.VSPHERE\b(?!_)/, `@ActivityImpl doesn't name TaskQueues.VSPHERE: ${squash(ann[1])}`);
  assert.match(ann[1], /\bTaskQueues\.VSPHERE_READ\b/, `@ActivityImpl doesn't name TaskQueues.VSPHERE_READ: ${squash(ann[1])}`);
  const cls = code.search(/\bclass\s+VsphereProvider\b/);
  assert.ok(ann.index < cls, '@ActivityImpl is not on the VsphereProvider class');
});

// ------------------------------------------------------------------ 4. VcenterBackend and VcfaBackend

for (const [name, path] of [['VcenterBackend', VCENTER], ['VcfaBackend', VCFA]]) {
  test(`criterion 4: ${name} implements CloudBackend and keeps static owns(String) and createVm(VmSpec spec, String idempotencyKey)`, () => {
    const code = noComments(now(path), true);
    const decl = code.match(new RegExp(`\\bclass\\s+${name}\\b([^{]*)\\{`));
    assert.ok(decl, `no class ${name}`);
    assert.match(decl[1], /\bimplements\b[^{]*\bCloudBackend\b/, `${name} doesn't declare implements CloudBackend: ${squash(decl[1])}`);
    assert.match(code, /\bimport\s+com\.example\.vmintent\.provider\.CloudBackend\s*;|\bcom\.example\.vmintent\.provider\.CloudBackend\b/,
      `${name} doesn't refer to com.example.vmintent.provider.CloudBackend`);
    assert.match(code, /\bpublic\s+static\s+boolean\s+owns\s*\(\s*(final\s+)?String\s+\w+\s*\)/, `${name} has no public static boolean owns(String)`);
    assert.match(code, /\bpublic\s+String\s+createVm\s*\(\s*(final\s+)?VmSpec\s+spec\s*,\s*(final\s+)?String\s+idempotencyKey\s*\)/,
      `${name} has no public String createVm(VmSpec spec, String idempotencyKey)`);
  });
}

// ------------------------------------------------------------------ 5. RoutedProviderTest

function routedTest() {
  const f = allFiles().filter((p) => /^backend\/src\/test\/java\/(.+\/)?provider\/RoutedProviderTest\.java$/.test(p));
  assert.equal(f.length, 1, `RoutedProviderTest.java under backend/src/test/java/**/provider/: ${f}`);
  const src = now(f[0]);
  const code = noComments(src);
  const tests = testMethods(src).filter(isActive);
  assert.ok(tests.length >= 5, `only ${tests.length} active test methods`);
  // The recording fake: a class implementing CloudBackend that keeps a record of its calls.
  const fake = code.match(/\bclass\s+(\w+)\s+implements\s+(?:[\w.]+\.)?CloudBackend\b/) || code.match(/new\s+CloudBackend\s*\(\s*\)\s*\{/);
  assert.ok(fake, 'no fake class implementing CloudBackend');
  const prefix = (code.match(/boolean\s+handles\s*\(\s*String\s+\w+\s*\)\s*\{[^}]*startsWith\(\s*"([^"]+)"/) || [])[1];
  assert.ok(prefix, 'the fake\'s handles() doesn\'t match its IDs by a prefix (can\'t tell the fake\'s IDs apart)');
  const sim = (code.match(/\b(\w+)\s*=\s*(?:Mockito\.)?mock\(\s*SimCloud\.class\s*\)/) || code.match(/@Mock\s+(?:private\s+)?SimCloud\s+(\w+)/) || [])[1];
  assert.ok(sim, 'no Mockito mock of SimCloud');
  return { code, tests, prefix, sim };
}

test('criterion 5: RoutedProviderTest exists, has active tests, a recording fake CloudBackend and a mocked SimCloud', () => {
  const { code } = routedTest();
  const fakeName = (code.match(/\bclass\s+(\w+)\s+implements\s+(?:[\w.]+\.)?CloudBackend\b/) || [])[1];
  const fakeBody = typeBody(code, new RegExp(`\\bclass\\s+${fakeName}\\b`)).body;
  assert.match(fakeBody, /\b(List|Deque|Queue|Collection)<[^>]*>\s+\w+\s*=|\b\w+\.add\(/, 'the fake records nothing');
  for (const n of ['plan', 'createVm', 'describeVm', 'deleteVm', 'resizeVm', 'setPower', 'snapshotVm', 'listVmIds']) {
    const m = methods(fakeBody, n);
    assert.ok(m.length >= 1, `the fake has no ${n}`);
    assert.match(m[0].body, /\.add\(|\+\+|record/, `the fake's ${n} doesn't record the call`);
  }
});

test('criterion 5a: a build routed to the fake calls its plan and createVm and returns the fake\'s vmId', () => {
  const { tests, prefix } = routedTest();
  const ok = tests.filter((t) => {
    const b = t.body; const a = assertions(b).join('\n');
    return /\.plan\(/.test(b) && /\.createVm\(/.test(b)
      && /plan/.test(a) && /create/i.test(a)
      && new RegExp(`assertEquals\\(\\s*"${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"]*"\\s*,`).test(a);
  });
  assert.ok(ok.length >= 1, 'no active test builds through the fake, checks its plan and createVm calls and asserts the fake\'s vmId');
});

test('criterion 5b: a build with no backend for its spec goes to the simulator', () => {
  const { tests, sim } = routedTest();
  const ok = tests.filter((t) => {
    const b = t.body; const a = assertions(b).join('\n');
    return /\.createVm\(/.test(b)
      && new RegExp(`verify\\(\\s*${sim}\\s*\\)\\.create\\(`).test(a)
      && /\.isEmpty\(\)|verifyNoInteractions\(\s*(?!${sim}\b)\w+|never\(\)/.test(a);
  });
  assert.ok(ok.length >= 1, `no active test builds with no backend, verifies ${sim}.create and that the fake got nothing`);
});

test('criterion 5c: resize, power, snapshot, describe and delete of a handled ID reach the fake and SimCloud gets no call', () => {
  const { tests, prefix, sim } = routedTest();
  const ops = { resizeVm: /resize/, setPower: /power/i, snapshotVm: /snapshot/, describeVm: /describe/, deleteVm: /delete/ };
  const missing = [];
  for (const [op, word] of Object.entries(ops)) {
    const ok = tests.some((t) => {
      const b = t.body; const a = assertions(b).join('\n');
      return new RegExp(`\\.${op}\\(`).test(b) && b.includes(`"${prefix}`)
        && new RegExp(`verifyNoInteractions\\([^)]*\\b${sim}\\b`).test(b)
        && word.test(a) && !/NOT_SET_UP|NotSetUp/.test(b);
    });
    if (!ok) missing.push(op);
  }
  assert.deepEqual(missing, [], 'calls no active test shows reaching the fake with verifyNoInteractions on SimCloud');
});

test('criterion 5d: a handled ID whose backend isn\'t set up fails with a non-retryable NotSetUp ApplicationFailure and SimCloud gets no call', () => {
  const { tests, prefix, sim } = routedTest();
  const ok = tests.filter((t) => {
    const b = t.body;
    return /ApplicationFailure/.test(b) && /assertThrows\(/.test(b)
      && /NOT_SET_UP|"NotSetUp"/.test(b) && /\.getType\(\)/.test(b) && /assertTrue\([^;]*isNonRetryable\(\)/.test(b)
      && b.includes(`"${prefix}`) && new RegExp(`verifyNoInteractions\\([^)]*\\b${sim}\\b`).test(b);
  });
  assert.ok(ok.length >= 1, 'no active test checks a handled ID with a not-set-up backend fails NotSetUp, non-retryable, without touching SimCloud');
  // NOT_SET_UP is the "NotSetUp" type.
  const routes = allFiles().find((f) => f.startsWith('backend/src/main/java/') && f.endsWith('/VsphereRoutes.java'));
  if (ok.every((t) => !/"NotSetUp"/.test(t.body))) {
    assert.ok(routes, 'no VsphereRoutes.java');
    assert.match(noComments(at(NEWEST, routes)), /NOT_SET_UP\s*=\s*"NotSetUp"/, 'VsphereRoutes.NOT_SET_UP is not "NotSetUp"');
  }
});

test('criterion 5e: listVmIds is the simulator\'s IDs plus the fake\'s, and leaves out a backend that isn\'t set up', () => {
  const { tests, prefix, sim } = routedTest();
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const listAsserts = tests.flatMap((t) => assertions(t.body).filter((a) => /listVmIds\(\)/.test(a)).map((a) => ({ t, a })));
  const both = listAsserts.filter(({ t, a }) => new RegExp(`"${esc}`).test(a) && /"(?!\s)[^"]*"/.test(a.replace(new RegExp(`"${esc}[^"]*"`, 'g'), ''))
    && new RegExp(`when\\(\\s*${sim}\\.list\\(`).test(t.body));
  assert.ok(both.length >= 1, 'no active test asserts listVmIds() is the stubbed simulator IDs plus the fake\'s');
  const without = listAsserts.filter(({ t, a }) => !new RegExp(`"${esc}`).test(a) && /"[^"]+"/.test(a)
    && new RegExp(`when\\(\\s*${sim}\\.list\\(`).test(t.body) && /\bfalse\b|notSetUp|NotSetUp/i.test(t.body));
  assert.ok(without.length >= 1, 'no active test asserts listVmIds() leaves out a backend that isn\'t set up');
});

// ------------------------------------------------------------------ 6. the vSphere tests untouched

test('criterion 6: VsphereRoutesWorkflowTest, VcenterBackendTest and VcfaBackendTest are present with active tests', () => {
  for (const n of ['VsphereRoutesWorkflowTest', 'VcenterBackendTest', 'VcfaBackendTest']) {
    const f = allFiles().filter((p) => p.startsWith('backend/src/test/java/') && p.endsWith(`/${n}.java`));
    assert.equal(f.length, 1, `${n}.java: ${f}`);
    const t = testMethods(at(NEWEST, f[0])).filter(isActive);
    assert.ok(t.length >= 1, `${n} has no active test method`);
  }
});

test('criterion 6: no AP-0053 commit changes backend/src/test/java/.../provider/vsphere/ or VsphereRoutesWorkflowTest.java', () => {
  const bad = KEPT.flatMap((c) => CHANGES.get(c.sha)
    .filter((ch) => ch.path.startsWith('vm-intent/backend/src/test/java/com/example/vmintent/provider/vsphere/')
      || ch.path.endsWith('/VsphereRoutesWorkflowTest.java'))
    .map((ch) => `${c.sha.slice(0, 8)} ${ch.status} ${ch.path}`));
  assert.deepEqual(bad, []);
});

// ------------------------------------------------------------------ 7. scope

test('criterion 7: no AP-0053 commit changes azure/, the other providers, SimCloud, workflow/, security/ or the OpenAPI files', () => {
  const m = `vm-intent/${MAIN}`;
  const forbidden = (p) => p.startsWith(`${m}/provider/azure/`)
    || [`${m}/provider/AzureProvider.java`, `${m}/provider/AwsProvider.java`, `${m}/provider/GcpProvider.java`, `${m}/provider/SimCloud.java`].includes(p)
    || p.startsWith(`${m}/workflow/`) || p.startsWith(`${m}/security/`)
    || ['vm-intent/docs/openapi.json', 'vm-intent/docs/openapi.yaml'].includes(p);
  const bad = KEPT.flatMap((c) => CHANGES.get(c.sha).filter((ch) => forbidden(ch.path)).map((ch) => `${c.sha.slice(0, 8)} ${ch.status} ${ch.path}`));
  assert.deepEqual(bad, []);
  // The paths exist (so the check above isn't vacuous).
  for (const f of [`${PROV}/AzureProvider.java`, `${PROV}/AwsProvider.java`, `${PROV}/GcpProvider.java`, `${PROV}/SimCloud.java`, 'docs/openapi.json']) {
    assert.ok(allFiles().includes(f), `${f} doesn't exist (test assumption)`);
  }
});

// ------------------------------------------------------------------ 9. docs

/** The code-map entry for provider/ in README: the "provider/" line and the indented lines after it. */
function providerEntry() {
  const lines = now('README.md').split('\n');
  const i = lines.findIndex((l) => /^\s*provider\/\s/.test(l));
  assert.ok(i >= 0, 'README has no code-map line starting "provider/"');
  const indent = lines[i].search(/\S/);
  const out = [lines[i]];
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (!l.trim() || l.search(/\S/) <= indent) break;
    out.push(l);
  }
  return out.join('\n');
}

test('criterion 9: README\'s code-map entry for provider/ names CloudBackend and RoutedProvider', () => {
  const e = providerEntry();
  assert.match(e, /\bCloudBackend\b/, `provider/ entry doesn't name CloudBackend:\n${e}`);
  assert.match(e, /\bRoutedProvider\b/, `provider/ entry doesn't name RoutedProvider:\n${e}`);
});

test('criterion 9: TEMPORAL-FEATURES\' test table has a RoutedProviderTest row describing what it covers', () => {
  const row = now('docs/TEMPORAL-FEATURES.md').split('\n').find((l) => /^\|\s*`?RoutedProviderTest`?\s*\|/.test(l));
  assert.ok(row, 'no "| RoutedProviderTest |" table row');
  const cells = row.split('|').map((c) => c.trim()).filter(Boolean);
  assert.ok(cells.length >= 2 && cells[1].length >= 40, `the row has no real description: ${row}`);
  const d = cells.slice(1).join(' ');
  assert.match(d, /CloudBackend|backend/i, d);
  assert.match(d, /SimCloud|simulator/i, d);
  assert.match(d, /NotSetUp|not set up/i, d);
  assert.match(d, /listVmIds|list/i, d);
});

/** Lines added to vm-intent/*.md docs by the kept AP-0053 commits: [{ path, line }]. */
function addedDocLines() {
  const out = [];
  for (const sha of COMMITS) {
    let file = null;
    for (const l of git(['diff', '-U0', `${sha}^`, sha, '--', ':(top)vm-intent/*.md', ':(top)vm-intent/**/*.md']).split('\n')) {
      if (l.startsWith('+++ ')) file = l.replace(/^\+\+\+ (b\/)?/, '');
      else if (l.startsWith('+') && file) out.push({ path: file, line: l.slice(1) });
    }
  }
  return out;
}

test('criterion 9: every class or method name this change adds to a doc exists under backend/src', () => {
  const names = new Set();
  for (const { line } of addedDocLines()) {
    if (/^Last updated /.test(line)) continue;
    for (const m of line.matchAll(/`([A-Za-z_]\w*)(?:\(\))?`/g)) if (/[A-Z]/.test(m[1].slice(1)) || /^[A-Z]/.test(m[1])) names.add(m[1]);
    for (const m of line.replace(/`[^`]*`/g, ' ').matchAll(/\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+)\b/g)) names.add(m[1]);
  }
  assert.ok(names.has('RoutedProviderTest') && names.has('CloudBackend'), `didn't find the expected names (test bug?): ${[...names]}`);
  const missing = [...names].filter((n) => {
    try { return !git(['grep', '-l', '-w', '-F', n, NEWEST, '--', ':(top)vm-intent/backend/src']).trim(); } catch { return true; }
  });
  assert.deepEqual(missing, [], 'names added to docs that appear nowhere under vm-intent/backend/src');
});

/** The UTC dates (YYYY-MM-DD) of a commit's author and committer timestamps. */
function utcDates(sha) {
  return git(['show', '-s', '--format=%at %ct', sha]).trim().split(/\s+/).map((s) => new Date(Number(s) * 1000).toISOString().slice(0, 10));
}

test('criterion 9: line 3 of each doc AP-0053 edits is "Last updated <the build date>."', () => {
  const docs = new Set(KEPT.flatMap((c) => CHANGES.get(c.sha)).filter((ch) => /\.md$/.test(ch.path) && ch.status !== 'D')
    .map((ch) => ch.path.slice('vm-intent/'.length)).filter((p) => !p.startsWith('tests/')));
  assert.ok(docs.has('README.md') && docs.has('docs/TEMPORAL-FEATURES.md'), `docs edited: ${[...docs]}`);
  for (const d of docs) {
    const own = touching(d);
    const dates = new Set(own.flatMap(utcDates));
    const line3 = now(d).split('\n')[2];
    const ok = [...dates].some((x) => line3 === `Last updated ${x}.`);
    assert.ok(ok, `${d} line 3 is "${line3}", expected "Last updated <one of ${[...dates].join(', ')}>."`);
  }
});

test('criterion 9: no AP-0053 commit changes the "Last updated" line of a doc it doesn\'t otherwise edit', () => {
  const bad = [];
  for (const sha of COMMITS) {
    for (const ch of CHANGES.get(sha)) {
      if (!/\.md$/.test(ch.path) || ch.status !== 'M') continue;
      const before = git(['show', `${sha}^:${ch.path}`]).replace(/\r\n/g, '\n').split('\n');
      const after = git(['show', `${sha}:${ch.path}`]).replace(/\r\n/g, '\n').split('\n');
      if (before[2] === after[2]) continue;
      const rest = (ls) => ls.filter((_, i) => i !== 2).join('\n');
      if (rest(before) === rest(after)) bad.push(`${sha.slice(0, 8)} ${ch.path}`);
    }
  }
  assert.deepEqual(bad, []);
});
