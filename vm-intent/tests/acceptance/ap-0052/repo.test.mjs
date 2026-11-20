// AP-0052 acceptance, repository half (criteria 1-7 and 9): the inventory check holds back MISSING when a listing
// leaves out more than half (and more than 2) of a provider's running VMs, and reports MISSING VMs listed again.
// The rule is one shared threshold function that InventoryActivitiesImpl and TestFakes.FakeInventory both call; the
// unit tests for it exist and are active; the workflow, its activity interface, the report records, the replay
// histories and the OpenAPI files are untouched; the docs describe it.
//
// "This requirement's commits" are the non-merge commits whose subject starts with "AP-0052:". Files are read with
// git show as they were at the newest such commit (leaving out the pipeline's own "acceptance tests" and "record the
// requirement" commits) that changed them, and "before" is the parent of the oldest AP-0052 commit, so later
// requirements can change these files freely. Only sources are read, never build outputs; the build gates run
// mvn test (ReplayTest included).
//
//   node --test tests/acceptance/ap-0052/repo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = 'AP-0052';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const MAIN = 'backend/src/main/java/com/example/vmintent';
const IMPL = `${MAIN}/db/InventoryActivitiesImpl.java`;
const FAKES = 'backend/src/test/java/com/example/vmintent/workflow/TestFakes.java';
const CHECK_TEST = 'backend/src/test/java/com/example/vmintent/workflow/InventoryCheckTest.java';
const HISTORIES = 'vm-intent/backend/src/test/resources/histories/';

const git = (args) => execFileSync('git', args,
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

// Oldest first; subjects are checked here, because --grep also matches body lines.
const ALL = git(['log', '--no-merges', '--reverse', '--format=%H %s', '--grep', `^${ID}:`]).split('\n').filter(Boolean)
  .map((l) => ({ sha: l.slice(0, 40), subject: l.slice(41) })).filter((c) => c.subject.startsWith(`${ID}:`));
const isPipeline = (c) => /^AP-\d+: (acceptance tests|record the requirement)\b/.test(c.subject);
const COMMITS = ALL.filter((c) => !isPipeline(c)).map((c) => c.sha);
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
/** A file as it was at the newest kept AP-0052 commit that changed it (or the newest kept AP-0052 commit). */
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
const plain = (s) => squash(s.replace(/`/g, '').replace(/\*/g, ''));

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
/** Every method named `name` (any return type): { head, body } where head is the text since the previous member. */
function methods(src, name) {
  const out = [];
  const re = new RegExp(`[\\w<>,\\[\\]\\s]\\s+${name}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf('{', m.index);
    const semi = src.indexOf(';', m.index);
    if (open < 0 || (semi >= 0 && semi < open)) continue; // a call, not a declaration
    let depth = 0; let j = open;
    for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}' && --depth === 0) break; }
    const before = src.slice(0, m.index);
    const cut = Math.max(before.lastIndexOf('}'), before.lastIndexOf(';'), before.lastIndexOf('{'));
    out.push({ head: before.slice(cut + 1), body: src.slice(open, j + 1) });
  }
  return out;
}
/** Names of the @Test methods of a class source, with their bodies; asserts the class itself isn't @Disabled. */
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
/** The statements of a body that assert something, squashed. */
const assertions = (body) => body.split(/;\s*/).filter((s) => /\bassert\w*\s*\(/.test(s)).map(squash);

/** The blank-line-separated paragraph containing `needle`. */
function paragraph(text, needle) {
  const p = text.split(/\n\s*\n/).find((x) => x.includes(needle));
  assert.ok(p, `no paragraph containing ${needle}`);
  return p;
}

test(`there is an ${ID} commit (other than the pipeline's own)`, () => {
  assert.ok(COMMITS.length > 0, `no non-pipeline commit subject starts with ${ID}:`);
});

// ------------------------------------------------------------------ the shared threshold function

/**
 * The shared threshold function: a static boolean method declared under backend/src/main that InventoryActivitiesImpl
 * calls through its class. Returns { cls, fn, file }.
 */
let shared;
function threshold() {
  if (shared) return shared;
  const impl = noComments(now(IMPL));
  const compares = methods(impl, 'compare');
  assert.equal(compares.length, 1, 'InventoryActivitiesImpl has no single compare method');
  const calls = [...compares[0].body.matchAll(/\b([A-Z]\w*)\.([a-z]\w*)\s*\(/g)].map((m) => ({ cls: m[1], fn: m[2] }));
  const found = [];
  for (const { cls, fn } of calls) {
    const file = allFiles().find((f) => f.startsWith('backend/src/main/java/') && f.endsWith(`/${cls}.java`));
    if (!file) continue;
    const src = noComments(at(NEWEST, file) ?? '');
    if (new RegExp(`static\\s+boolean\\s+${fn}\\s*\\(\\s*(final\\s+)?(int|long)\\s+\\w+\\s*,\\s*(final\\s+)?(int|long)\\s+\\w+\\s*\\)`).test(src)
      && !found.some((x) => x.fn === fn)) found.push({ cls, fn, file });
  }
  assert.equal(found.length, 1, `InventoryActivitiesImpl.compare should call exactly one shared static boolean (int, int) rule; found ${JSON.stringify(found)}`);
  shared = found[0];
  return shared;
}

/** Which result means "held back"? Read off the name: holdBack...() true = held back; mark...() true = marked. */
const heldMeansTrue = (fn) => !/^(mark|shouldMark|canMark)/i.test(fn);

// ------------------------------------------------------------------ 1. replay histories untouched

test('criterion 1: no AP-0052 commit modifies or deletes an existing file under backend/src/test/resources/histories/', () => {
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

// ------------------------------------------------------------------ 2. the old test still marks 1 of 2

test('criterion 2: findsMissingVmsAndOrphans is still present, active, with the same assertions as before', () => {
  const cur = testMethods(now(CHECK_TEST)).filter((m) => m.name === 'findsMissingVmsAndOrphans');
  const old = testMethods(at(BEFORE, CHECK_TEST) ?? '').filter((m) => m.name === 'findsMissingVmsAndOrphans');
  assert.equal(old.length, 1, 'the test was not there before AP-0052 (test assumption)');
  assert.equal(cur.length, 1, 'findsMissingVmsAndOrphans is not a @Test method of InventoryCheckTest any more');
  assert.ok(isActive(cur[0]), 'findsMissingVmsAndOrphans is @Disabled');
  assert.deepEqual(assertions(cur[0].body), assertions(old[0].body), 'its assertions changed');
  // The assertions that matter here: 1 of 2 AWS VMs marked MISSING, and the lifecycle ends MISSING.
  const a = assertions(cur[0].body).join('\n');
  assert.match(a, /assertEquals\(1, report\.missingCount\(\)\)/);
  assert.match(a, /assertEquals\(2, aws\.recordedRunning\(\)\)/);
  assert.match(a, /assertEquals\("MISSING", records\.state\.get\(gone\)\)/);
  assert.match(a, /assertEquals\("MISSING", records\.lifecycles\.get\(gone\)\.state\(\)\)/);
  assert.match(cur[0].body, /cloud\.vanished\.add\(/);
  assert.equal((cur[0].body.match(/(?<!\.)\bbuild\(\s*"/g) || []).length, 2, 'it no longer builds 2 VMs');
});

// ------------------------------------------------------------------ 3. new InventoryCheckTest method: 3 of 4 held back

test('criterion 3: a new active InventoryCheckTest method makes 3 of 4 VMs vanish and checks nothing is marked missing', () => {
  const all = testMethods(now(CHECK_TEST));
  const oldNames = new Set(testMethods(at(BEFORE, CHECK_TEST) ?? '').map((m) => m.name));
  const cands = all.filter((m) => !oldNames.has(m.name) && m.body.includes('"Not marked missing"') && m.body.includes('"3 of 4"'));
  assert.equal(cands.length, 1, `expected one new test method asserting "Not marked missing" and "3 of 4"; found ${cands.map((m) => m.name)}`);
  const m = cands[0];
  assert.ok(isActive(m), `${m.name} is @Disabled`);
  const b = m.body;
  const a = assertions(b).join('\n');
  // 4 VMs on one provider, 3 of them vanished.
  const builds = [...b.matchAll(/(?<!\.)\bbuild\(\s*"[^"]*"\s*\)/g)].length;
  const specs = [...b.matchAll(/TestFakes\.spec\(/g)].length;
  assert.ok(builds + specs >= 4, `${m.name} builds ${builds + specs} VMs, not 4`);
  assert.match(b, /cloud\.vanished\.add/, `${m.name} makes no VM vanish`);
  assert.match(b, /subList\(\s*1\s*,\s*4\s*\)|vanished\.add[\s\S]*vanished\.add[\s\S]*vanished\.add/, `${m.name} doesn't make 3 VMs vanish`);
  // The finding's missing list is empty, its note says so, the report's missingCount is 0.
  assert.match(a, /assertEquals\((List\.of\(\)|java\.util\.List\.of\(\)|Collections\.emptyList\(\)), \w+\.missing\(\)\)|assertTrue\(\w+\.missing\(\)\.isEmpty\(\)/,
    'no assertion that the finding\'s missing list is empty');
  assert.match(a, /\.note\(\)\.contains\("Not marked missing"\)/, 'no assertion that the note contains "Not marked missing"');
  assert.match(a, /\.note\(\)\.contains\("3 of 4"\)/, 'no assertion that the note contains "3 of 4"');
  assert.match(a, /assertEquals\(0, report\.missingCount\(\)\)/, 'no assertion that missingCount is 0');
  // All 4 records still RUNNING (asserted in a loop over all hashes), the vanished lifecycles not ended MISSING.
  assert.match(b, /for\s*\(\s*String\s+(\w+)\s*:\s*hashes\s*\)\s*assertEquals\("RUNNING", records\.state\.get\(\1\)\)/,
    'no assertion that every one of the 4 records is still RUNNING');
  assert.match(b, /List\.of\(\s*build\("[^"]*"\),\s*build\("[^"]*"\),\s*build\("[^"]*"\),\s*build\("[^"]*"\)\s*\)/,
    'the 4 hashes are not built together');
  assert.match(a, /assertNotEquals\("MISSING", records\.lifecycles\.get\(\w+\)\.state\(\)\)/,
    'no assertion that the vanished VMs\' lifecycles did not end MISSING');
  assert.match(a, /WORKFLOW_EXECUTION_STATUS_RUNNING/, 'no assertion that the vanished VMs\' lifecycle workflows are still running');
});

// ------------------------------------------------------------------ 4. unit test of the threshold at the boundaries

test('criterion 4: an active unit test pins the threshold function at 2/2 and 3/6 (marked) and 3/5 and 3/4 (held back)', () => {
  const { cls, fn } = threshold();
  const testFiles = allFiles().filter((f) => f.startsWith('backend/src/test/java/') && f.endsWith('.java'));
  assert.ok(testFiles.length > 10, 'no test files found (test bug)');
  const call = (m, n) => new RegExp(`${cls}\\.${fn}\\(\\s*${m}\\s*,\\s*${n}\\s*\\)`);
  const heldIsTrue = heldMeansTrue(fn);
  const held = heldIsTrue ? 'assertTrue' : 'assertFalse';
  const marked = heldIsTrue ? 'assertFalse' : 'assertTrue';
  const want = [[2, 2, marked], [3, 6, marked], [3, 5, held], [3, 4, held]];
  const found = new Map();
  for (const f of testFiles) {
    const src = at(NEWEST, f) ?? '';
    if (!src.includes(fn)) continue;
    let ms;
    try { ms = testMethods(src).filter(isActive); } catch { continue; }
    for (const m of ms) {
      for (const [a, b, kind] of want) {
        const re = new RegExp(`${kind}\\(\\s*${call(a, b).source}`);
        const eq = new RegExp(`assertEquals\\(\\s*${kind === 'assertTrue'}\\s*,\\s*${call(a, b).source}`);
        if (re.test(m.body) || eq.test(m.body)) found.set(`${a}/${b}`, `${f.split('/').pop()}#${m.name}`);
      }
    }
  }
  const missing = want.filter(([a, b]) => !found.has(`${a}/${b}`)).map(([a, b, k]) => `${k}(${cls}.${fn}(${a}, ${b}))`);
  assert.deepEqual(missing, [], 'boundary cases no active test asserts');
});

test('criterion 4: the threshold function itself is "more than 2 and more than half"', () => {
  // Read the rule from its source and evaluate it on the boundaries (and around them).
  const { fn, file } = threshold();
  const src = noComments(now(file));
  const decl = src.match(new RegExp(`static\\s+boolean\\s+${fn}\\s*\\(\\s*(?:final\\s+)?(?:int|long)\\s+(\\w+)\\s*,\\s*(?:final\\s+)?(?:int|long)\\s+(\\w+)\\s*\\)\\s*\\{\\s*return\\s+([^;]+);\\s*\\}`));
  assert.ok(decl, `${fn} is not a one-line "return <expression>;" (can't evaluate it here; the unit test covers it)`);
  const [, a, b, expr] = decl;
  assert.match(expr, /^[\w\s()<>=!&|*/+\-.]+$/, `unexpected expression: ${expr}`);
  // A "/" would be integer division in Java but not in JavaScript, so it can't be evaluated faithfully here.
  assert.doesNotMatch(expr, /\//, `the rule divides (${expr}); integer division could move the boundary`);
  const rule = new Function(a, b, `return (${expr.replace(/\b(\d+)L\b/g, '$1')});`);
  const held = (m, n) => (m > 2 && m * 2 > n);
  const heldIsTrue = heldMeansTrue(fn);
  for (let n = 0; n <= 12; n++) {
    for (let m = 0; m <= n; m++) {
      const got = Boolean(rule(m, n));
      assert.equal(heldIsTrue ? got : !got, held(m, n), `${fn}(${m}, ${n})`);
    }
  }
});

// ------------------------------------------------------------------ 5. InventoryActivitiesImplTest

test('criterion 5: an active InventoryActivitiesImpl test class uses Mockito mocks of VmRegistry and AuditLog and no database', () => {
  const f = allFiles().filter((p) => p.startsWith('backend/src/test/java/') && p.endsWith('/InventoryActivitiesImplTest.java'));
  assert.equal(f.length, 1, `InventoryActivitiesImplTest.java: ${f}`);
  assert.ok(!at(BEFORE, f[0]), 'the class existed before AP-0052 (should be new)');
  const src = noComments(now(f[0]));
  assert.match(src, /mock\(\s*VmRegistry\.class\s*\)|@Mock\s+(private\s+)?VmRegistry\b/, 'no Mockito mock of VmRegistry');
  assert.match(src, /mock\(\s*AuditLog\.class\s*\)|@Mock\s+(private\s+)?AuditLog\b/, 'no Mockito mock of AuditLog');
  assert.match(src, /new\s+InventoryActivitiesImpl\s*\(/, 'it does not build the real InventoryActivitiesImpl');
  assert.doesNotMatch(src, /@SpringBootTest|@DataJdbcTest|@JdbcTest|@Testcontainers|DataSource|DriverManager|EmbeddedDatabase/,
    'it uses a database or Spring context');
  assert.ok(testMethods(src).filter(isActive).length >= 2, 'fewer than 2 active test methods');
});

function implTests() {
  const f = allFiles().find((p) => p.startsWith('backend/src/test/java/') && p.endsWith('/InventoryActivitiesImplTest.java'));
  assert.ok(f, 'no InventoryActivitiesImplTest.java');
  return testMethods(now(f)).filter(isActive);
}
/** The audit event names compare() records, and which of them are new in AP-0052. */
function events() {
  const ev = (src) => new Set([...noComments(src ?? '').matchAll(/audit\.record\([^;]*?"([A-Z][A-Z_]+)"/g)].map((m) => m[1]));
  const cur = ev(now(IMPL));
  const old = ev(at(BEFORE, IMPL));
  return { cur, added: [...cur].filter((e) => !old.has(e)) };
}

test('criterion 5: held back - markMissing is never called, one audit event per held-back VM, the note contains "Not marked missing"', () => {
  const { added } = events();
  const ms = implTests().filter((m) => m.body.includes('"Not marked missing"'));
  assert.ok(ms.length >= 1, 'no active InventoryActivitiesImplTest method asserts the note contains "Not marked missing"');
  const problems = [];
  for (const m of ms) {
    const b = squash(m.body);
    const p = [];
    if (!/\.note\(\)\.contains\("Not marked missing"\)/.test(b)) p.push('note contains "Not marked missing"');
    if (!/verify\(\s*\w+\s*,\s*never\(\)\s*\)\.markMissing\(/.test(b)) p.push('verify(registry, never()).markMissing');
    const evName = added.find((e) => b.includes(`"${e}"`));
    if (!evName) p.push(`an audit event named one of ${added}`);
    else {
      // Count of held-back VMs in the listing vs. times(n), or one verify per held-back hash.
      const times = b.match(new RegExp(`verify\\(\\s*\\w+\\s*,\\s*times\\((\\d+)\\)\\s*\\)\\.record\\([^;]*"${evName}"`));
      const perHash = new RegExp(`for\\s*\\(\\s*String\\s+(\\w+)\\s*:[^)]*\\)\\s*\\{?\\s*verify\\(\\s*\\w+\\s*\\)\\.record\\([^;]*eq\\(\\1\\)[^;]*"${evName}"`).test(b);
      if (!times && !perHash) p.push(`one ${evName} audit event per held-back VM (times(n) or a verify per hash)`);
      if (times && Number(times[1]) < 3) p.push(`times(${times[1]}) is fewer than the 3 a hold-back needs`);
    }
    if (!p.length) return;
    problems.push(`${m.name}: missing ${p.join('; ')}`);
  }
  assert.fail(problems.join('\n'));
});

test('criterion 5: listed again - the MISSING VM\'s spec hash follows "listed again" in the note, it gets an audit event, markMissing is not called', () => {
  const { added } = events();
  const ms = implTests().filter((m) => /"[^"]*listed again[^"]*"/.test(m.body));
  assert.ok(ms.length >= 1, 'no active InventoryActivitiesImplTest method mentions "listed again"');
  const problems = [];
  for (const m of ms) {
    const b = squash(m.body);
    const p = [];
    // e.g. note().contains("listed again: hback"), where "hback" is a spec hash the mocked registry returns.
    const lit = b.match(/\.note\(\)\.contains\("([^"]*listed again[^"]*)"\)/);
    const hash = lit && lit[1].replace(/^.*listed again:?\s*/, '').split(/[\s,]/)[0];
    if (!hash) p.push('note().contains("listed again: <spec hash>")');
    else if (!new RegExp(`"${hash}"`).test(b.replace(lit[0], ''))) p.push(`"${hash}" is not a spec hash the test's mocks return`);
    if (!/when\(\s*\w+\.\w+\([^)]*\)\s*\)\.thenReturn\([^;]*"vm-[^"]*"\s*,\s*"/.test(b) && !/when\(\s*\w+\.\w+\(/.test(b)) p.push('a mocked registry');
    const evName = added.find((e) => e !== 'MISSING' && new RegExp(`verify\\(\\s*\\w+\\s*\\)\\.record\\([^;]*eq\\("${hash}"\\)[^;]*"${e}"`).test(b));
    if (!evName) p.push(`verify(audit).record(..., eq("${hash}"), <new event>, ...)`);
    if (!/verify\(\s*\w+\s*,\s*never\(\)\s*\)\.markMissing\(/.test(b)) p.push('verify(registry, never()).markMissing');
    if (!p.length) return;
    problems.push(`${m.name}: missing ${p.join('; ')}`);
  }
  assert.fail(problems.join('\n'));
});

// ------------------------------------------------------------------ 6. one shared function, no copies

test('criterion 6: TestFakes.FakeInventory and InventoryActivitiesImpl both call the same threshold function', () => {
  const { cls, fn } = threshold();
  const fakes = noComments(now(FAKES));
  const fi = fakes.search(/class\s+FakeInventory\b/);
  assert.ok(fi >= 0, 'no FakeInventory class in TestFakes');
  const fakeCompare = methods(fakes.slice(fi), 'compare')[0];
  assert.ok(fakeCompare, 'FakeInventory has no compare method');
  assert.match(fakeCompare.body, new RegExp(`\\b${cls}\\.${fn}\\s*\\(`), `FakeInventory.compare does not call ${cls}.${fn}`);
  assert.match(noComments(now(IMPL)), new RegExp(`\\b${cls}\\.${fn}\\s*\\(`), `InventoryActivitiesImpl does not call ${cls}.${fn}`);
  assert.ok(now(FAKES).includes(fn) && now(IMPL).includes(fn), `${fn} doesn't appear in both files`);
});

test('criterion 6: neither InventoryActivitiesImpl nor FakeInventory has its own numeric threshold for the rule', () => {
  const numeric = /(?:[<>]=?|\*|\/)\s*\(?\s*\d|\d\s*\)?\s*(?:[<>]=?|\*|\/)(?!\/)|\b0?\.\d+|\bhalf\b/i;
  const fakes = noComments(now(FAKES), true);
  const fi = fakes.search(/class\s+FakeInventory\b/);
  const fakeCompare = methods(fakes.slice(fi), 'compare')[0];
  const implSrc = noComments(now(IMPL), true);
  const implCompare = methods(implSrc, 'compare')[0];
  for (const [what, body] of [['FakeInventory.compare', fakeCompare.body], ['InventoryActivitiesImpl.compare', implCompare.body]]) {
    const bad = body.split('\n').filter((l) => numeric.test(l)).map((l) => l.trim());
    assert.deepEqual(bad, [], `${what} has numeric comparisons of its own`);
  }
  // No numeric constant in InventoryActivitiesImpl other than the old list cap.
  const consts = [...implSrc.matchAll(/static\s+final\s+\w+\s+(\w+)\s*=\s*[\d.]+/g)].map((m) => m[1]);
  const oldConsts = [...noComments(at(BEFORE, IMPL) ?? '', true).matchAll(/static\s+final\s+\w+\s+(\w+)\s*=\s*[\d.]+/g)].map((m) => m[1]);
  assert.deepEqual(consts.filter((c) => !oldConsts.includes(c)), [], 'InventoryActivitiesImpl has a new numeric constant');
});

// ------------------------------------------------------------------ 7. scope

test('criterion 7: no AP-0052 commit changes InventoryCheckWorkflow*, InventoryActivities.java or the OpenAPI files', () => {
  const forbidden = (p) => /^vm-intent\/backend\/src\/main\/java\/com\/example\/vmintent\/workflow\/InventoryCheckWorkflow[^/]*$/.test(p)
    || p === `vm-intent/${MAIN}/workflow/InventoryActivities.java`
    || ['vm-intent/docs/openapi.json', 'vm-intent/docs/openapi.yaml'].includes(p);
  const bad = ALL.flatMap((c) => CHANGES.get(c.sha).filter((ch) => forbidden(ch.path)).map((ch) => `${c.sha.slice(0, 8)} ${ch.path}`));
  assert.deepEqual(bad, []);
  // The workflow files exist (so the check above isn't vacuous).
  assert.ok(allFiles().some((f) => f === `${MAIN}/workflow/InventoryCheckWorkflowImpl.java`), 'no InventoryCheckWorkflowImpl.java');
  assert.ok(allFiles().some((f) => f === `${MAIN}/workflow/InventoryActivities.java`), 'no InventoryActivities.java');
});

test('criterion 7: the InventoryFinding and InventoryReport records are unchanged by AP-0052', () => {
  const rec = (src, name) => {
    const s = noComments(src ?? '');
    const i = s.search(new RegExp(`record\\s+${name}\\s*\\(`));
    assert.ok(i >= 0, `no record ${name}`);
    const j = s.indexOf('{', s.indexOf(')', i));
    // From the annotations before it (back to the previous member) to the record body's opening brace.
    const k = Math.max(s.lastIndexOf('}', i), s.lastIndexOf(';', i));
    return squash(s.slice(k + 1, j + 1));
  };
  assert.ok(allFiles().includes(`${MAIN}/workflow/Models.java`), 'no Models.java');
  const models = `${MAIN}/workflow/Models.java`;
  for (const name of ['InventoryFinding', 'InventoryReport']) {
    assert.equal(rec(now(models), name), rec(at(BEFORE, models), name), `record ${name} changed`);
  }
});

// ------------------------------------------------------------------ 9. docs

test('criterion 9: TEMPORAL-FEATURES\' inventory-check bullets say a listing leaving out more than half (and more than 2) isn\'t trusted, what the note says, and listed-again handling', () => {
  const p = plain(paragraph(now('docs/TEMPORAL-FEATURES.md'), '**Missing:**'));
  assert.match(p, /more than half \(and more than (2|two)\)|more than (2|two),? and more than half|more than half and more than (2|two)/i,
    `no "more than half (and more than 2)":\n${p}`);
  assert.match(p, /running VMs/, p);
  assert.match(p, /none of them is marked missing|not marked missing|aren't marked missing|are not marked missing/i, p);
  assert.match(p, /note says:? Not marked missing/i, `doesn't say what the note says:\n${p}`);
  assert.match(p, /Not marked missing: the listing left out N of M running VMs/, `doesn't quote the note:\n${p}`);
  assert.match(p, /MISSING VM[^.]*listing again[^.]*reported in the note/i, `no "a MISSING VM listed again is reported in the note":\n${p}`);
  assert.match(p, /listed again/i, p);
  assert.match(p, /Nothing changes the VM|not changed|is left unchanged|unchanged/i, `doesn't say a listed-again VM is not changed:\n${p}`);
});

test('criterion 9: USER-GUIDE\'s Missing: bullet says the same', () => {
  const line = now('docs/USER-GUIDE.md').split('\n').find((l) => /^\s*- \*\*Missing:\*\*/.test(l));
  assert.ok(line, 'USER-GUIDE has no "- **Missing:**" bullet');
  const p = plain(line);
  assert.match(p, /more than half \(and more than (2|two)\)|more than (2|two),? and more than half|more than half and more than (2|two)/i, p);
  assert.match(p, /running VMs/, p);
  assert.match(p, /none of them is marked missing|not marked missing|aren't marked missing|are not marked missing/i, p);
  assert.match(p, /note says:? Not marked missing/i, `doesn't say what the note says:\n${p}`);
  assert.match(p, /MISSING VM[^.]*listing again[^.]*reported in the note/i, p);
  assert.match(p, /listed again/i, p);
  assert.match(p, /not changed|unchanged|nothing changes/i, `doesn't say a listed-again VM is not changed:\n${p}`);
});

test('criterion 9: README\'s audit-event list names the new audit events, and each is a string literal under backend/src/main/java', () => {
  const { added } = events();
  assert.ok(added.length >= 2, `expected new audit events for "held back" and "listed again"; found ${added}`);
  const list = squash(paragraph(now('README.md'), 'INVENTORY_CHECK'));
  for (const e of added) {
    assert.match(list, new RegExp(`\\b${e}\\b`), `README's audit-event list doesn't name ${e}`);
    const hits = git(['grep', '-l', '--full-name', '-F', `"${e}"`, NEWEST, '--', ':(top)vm-intent/backend/src/main/java']).trim();
    assert.ok(hits, `"${e}" is not a string literal under backend/src/main/java`);
  }
});
