// AP-0043 acceptance, repository half (criteria 1-8 and 11): per-user identity part 2a. VmIdentity.of(spec, owner)
// gives an Id(hash, cloudName); Interpretation, BatchItem and PreparedVm carry a cloudName (shorter constructors kept);
// the four entry points take both values from one VmIdentity.of call; every ReconcileRequest passes the cloudName of
// what it takes specHash from; unit and workflow tests cover it; a new replay history pins it; the OpenAPI files and
// docs describe it.
//
// "This requirement's commits" are the non-merge commits whose subject starts with "AP-0043:", leaving out the
// pipeline's own "acceptance tests" and "record the requirement" commits. Files are read with git show as they were at
// the newest such commit that changed them (or, for files it didn't change, the newest such commit), so later
// requirements can change them freely. "Before" is the parent of the oldest AP-0043 commit. Only sources are read,
// never build outputs; the build gates run mvn test.
//
//   node --test tests/acceptance/ap-0043/repo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = 'AP-0043';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const MAIN = 'backend/src/main/java/com/example/vmintent';
const TEST = 'backend/src/test/java/com/example/vmintent';
const VM_IDENTITY = `${MAIN}/spec/VmIdentity.java`;
const VM_IDENTITY_TEST = `${TEST}/spec/VmIdentityTest.java`;
const HISTORIES = 'backend/src/test/resources/histories/';
const NEW_HISTORY = `${HISTORIES}batchshard-v2-cloud-name.json`;

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
/** A file as it was at the newest AP-0043 commit that changed it (or the newest AP-0043 commit). */
function now(rel) {
  assert.ok(NEWEST, `no ${ID} commit`);
  const own = touching(rel);
  const t = at(own.length ? own[own.length - 1] : NEWEST, rel);
  assert.ok(t !== null, `${rel} doesn't exist at the ${ID} commit`);
  return t;
}
const squash = (s) => s.replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ Java source helpers

/** Java source with comments removed and string/char literals' contents kept (so literals can still be matched). */
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

/** Index just after the bracket matching the one at `open`. */
function matchBracket(src, open) {
  const pairs = { '(': ')', '{': '}', '<': '>' };
  const o = src[open]; const c = pairs[o];
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === o) depth++;
    else if (src[i] === c && --depth === 0) return i + 1;
  }
  throw new Error(`unbalanced ${o} at ${open}`);
}
/** Splits an argument or parameter list at top-level commas. */
function splitTop(s) {
  const parts = []; let depth = 0; let cur = '';
  for (const ch of s) {
    if ('(<{['.includes(ch)) depth++;
    if (')>}]'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}
/** Removes annotations (after noStrings, so @Schema(description = "") has no nested brackets). */
const noAnnotations = (s) => s.replace(/@[\w.]+(\s*\([^()]*\))?/g, ' ');

/** A record's components ("Type name"), its constructors' parameter counts and their bodies. */
function record(src, name) {
  const s = noStrings(noComments(src));
  const m = new RegExp(`\\brecord\\s+${name}\\s*\\(`).exec(s);
  assert.ok(m, `no record ${name}`);
  const open = m.index + m[0].length - 1;
  const close = matchBracket(s, open);
  const components = splitTop(noAnnotations(s.slice(open + 1, close - 1))).map(squash);
  let bodyOpen = s.indexOf('{', close);
  const semi = s.indexOf(';', close);
  const body = semi >= 0 && semi < bodyOpen ? '' : s.slice(bodyOpen, matchBracket(s, bodyOpen));
  const ctors = [];
  for (const c of body.matchAll(new RegExp(`public\\s+${name}\\s*\\(`, 'g'))) {
    const po = c.index + c[0].length - 1;
    const pc = matchBracket(body, po);
    const bo = body.indexOf('{', pc);
    ctors.push({ params: splitTop(body.slice(po + 1, pc - 1)).map(squash), body: body.slice(bo, matchBracket(body, bo)) });
  }
  return { components, ctors };
}

/** Methods with their annotations (the text between the previous member and the name) and bodies. */
function methods(src) {
  const s = noComments(src);
  const out = [];
  for (const m of s.matchAll(/\bvoid\s+(\w+)\s*\(/g)) {
    const before = s.slice(0, m.index);
    const prev = Math.max(before.lastIndexOf(';'), before.lastIndexOf('}'), before.lastIndexOf('{'));
    const annotations = s.slice(prev + 1, m.index);
    const po = m.index + m[0].length - 1;
    const bo = s.indexOf('{', matchBracket(noStrings(s), po));
    out.push({ name: m[1], annotations, body: s.slice(bo, matchBracket(noStrings(s), bo)) });
  }
  return out;
}
const classDisabled = (src) => /@Disabled\b/.test(noComments(src).split(/\bclass\s+\w+/)[0]);
/** Active (not @Disabled) @Test methods of a test source. */
function activeTests(src) {
  if (classDisabled(src)) return [];
  return methods(src).filter((m) => /@Test\b/.test(m.annotations) && !/@Disabled\b/.test(m.annotations));
}
/** All Java test sources under backend/src/test/java at the newest AP-0043 commit. */
function testSources() {
  const files = git(['ls-tree', '--full-tree', '-r', '--name-only', NEWEST, 'vm-intent/backend/src/test/java/'])
    .split('\n').filter((f) => f.endsWith('.java'));
  return files.map((f) => ({ path: f, src: at(NEWEST, f.replace(/^vm-intent\//, '')) }));
}
/** Every main-code Java file at the newest AP-0043 commit. */
function mainSources() {
  const files = git(['ls-tree', '--full-tree', '-r', '--name-only', NEWEST, 'vm-intent/backend/src/main/java/'])
    .split('\n').filter((f) => f.endsWith('.java'));
  return files.map((f) => ({ path: f, src: at(NEWEST, f.replace(/^vm-intent\//, '')) }));
}

test(`there is an ${ID} commit (other than the pipeline's own)`, () => {
  assert.ok(COMMITS.length > 0, `no non-pipeline commit subject starts with ${ID}:`);
});

// ------------------------------------------------------------------ 1. VmIdentity.of and Id

test('criterion 1: VmIdentity has public static of(VmSpec, String) returning a record with exactly String hash, String cloudName', () => {
  const src = noComments(now(VM_IDENTITY));
  const m = src.match(/public\s+static\s+(?:[\w.]+\.)?(\w+)\s+of\s*\(\s*(?:final\s+)?VmSpec\s+\w+\s*,\s*(?:final\s+)?String\s+\w+\s*\)/);
  assert.ok(m, 'VmIdentity has no public static of(VmSpec spec, String owner)');
  const rec = record(now(VM_IDENTITY), m[1]);
  assert.deepEqual(rec.components, ['String hash', 'String cloudName'], `${m[1]}'s components`);
});

test('criterion 1: VmIdentity.of takes the hash from VmIdentity.hash and the cloud name from the (generated) spec name', () => {
  const src = noComments(now(VM_IDENTITY));
  const i = src.search(/\bstatic\s+[\w.]+\s+of\s*\(/);
  const bo = src.indexOf('{', i);
  const body = src.slice(bo, matchBracket(noStrings(src), bo));
  assert.match(body, /\bhash\s*\(\s*spec\s*,\s*owner\s*\)/, `of() doesn't use hash(spec, owner):\n${body}`);
  assert.match(body, /\.name\(\)/, `of() doesn't take the spec's name:\n${body}`);
  assert.ok(!/["']-|\+\s*"/.test(body), `of() appends something to the name (no suffix yet):\n${body}`);
});

test('criterion 1: VmIdentityTest has active @Test methods asserting hash and cloudName of VmIdentity.of for null, "anonymous" and a signed-in owner', () => {
  const tests = activeTests(now(VM_IDENTITY_TEST)).filter((t) => /VmIdentity\.of\s*\(/.test(t.body));
  assert.ok(tests.length > 0, 'no active @Test method in VmIdentityTest calls VmIdentity.of');
  const found = { null: false, anonymous: false, signedIn: false };
  for (const t of tests) {
    for (const m of t.body.matchAll(/(\w+)\s*=\s*VmIdentity\.of\s*\(\s*(\w+)\s*,\s*(null|"[^"]*")\s*\)/g)) {
      const [, v, , owner] = m;
      const hashAsserted = new RegExp(`assertEquals\\s*\\([^;]*\\b${v}\\.hash\\(\\)`).test(t.body);
      const nameAsserted = new RegExp(`assertEquals\\s*\\([^;]*\\b${v}\\.cloudName\\(\\)`).test(t.body);
      if (!hashAsserted || !nameAsserted) continue;
      if (owner === 'null') found.null = true;
      else if (owner === '"anonymous"') found.anonymous = true;
      else found.signedIn = true;
    }
  }
  assert.deepEqual(found, { null: true, anonymous: true, signedIn: true },
    `owners whose VmIdentity.of result has both hash() and cloudName() asserted (in ${tests.map((t) => t.name).join(', ')})`);
});

test('criterion 1: those VmIdentityTest assertions compare with today\'s hashes and the spec name', () => {
  const body = activeTests(now(VM_IDENTITY_TEST)).filter((t) => /VmIdentity\.of\s*\(/.test(t.body)).map((t) => t.body).join('\n');
  // The anonymous hash is a pinned constant or SpecCanonicalizer.hash; the signed-in one a pinned constant or VmIdentity.hash.
  assert.match(body, /assertEquals\s*\(\s*(?:[A-Z_]+HASH|SpecCanonicalizer\.hash\([^)]*\))\s*,\s*\w+\.hash\(\)/,
    'no assertion compares an anonymous VmIdentity.of hash with today\'s hash');
  assert.match(body, /assertEquals\s*\(\s*(?:[A-Z_]*ALICE[A-Z_]*HASH|VmIdentity\.hash\([^)]*"\w+"\))\s*,\s*\w+\.hash\(\)/,
    'no assertion compares a signed-in VmIdentity.of hash with the owner-including hash');
  assert.match(body, /assertEquals\s*\(\s*(?:"[\w-]+"|\w+\.name\(\))\s*,\s*\w+\.cloudName\(\)/,
    'no assertion compares a VmIdentity.of cloudName with the spec name');
});

// ------------------------------------------------------------------ 2. cloudName components

const RECORDS = [
  ['Interpretation', `${MAIN}/intent/Interpretation.java`],
  ['BatchItem', `${MAIN}/workflow/Models.java`],
  ['PreparedVm', `${MAIN}/catalog/CatalogModels.java`],
];

for (const [name, rel] of RECORDS) {
  test(`criterion 2: ${name} has a new last component String cloudName; its earlier components are unchanged`, () => {
    const after = record(now(rel), name);
    const before = record(at(BEFORE, rel), name);
    assert.equal(after.components[after.components.length - 1], 'String cloudName', `${name}'s last component`);
    assert.deepEqual(after.components.slice(0, -1), before.components, `${name}'s earlier components changed`);
  });

  test(`criterion 2: ${name} keeps its existing shorter constructors; the one without cloudName passes null`, () => {
    const after = record(now(rel), name);
    const before = record(at(BEFORE, rel), name);
    const arities = (r) => [r.components.length, ...r.ctors.map((c) => c.params.length)];
    for (const n of arities(before)) {
      assert.ok(after.ctors.some((c) => c.params.length === n),
        `${name} has no constructor with ${n} parameters any more (has ${after.ctors.map((c) => c.params.length).join(', ')} + canonical)`);
    }
    const shorter = after.ctors.find((c) => c.params.length === after.components.length - 1);
    assert.ok(shorter, `${name} has no constructor without cloudName`);
    assert.deepEqual(shorter.params.map((p) => p.split(' ').pop()), after.components.slice(0, -1).map((p) => p.split(' ').pop()),
      `${name}'s shorter constructor doesn't take the old components`);
    const call = shorter.body.match(/\bthis\s*\(([\s\S]*)\)\s*;/);
    assert.ok(call, `${name}'s shorter constructor doesn't call this(...)`);
    const args = splitTop(call[1]);
    assert.equal(args.length, after.components.length, `${name}'s shorter constructor calls this() with ${args.length} args`);
    assert.equal(args[args.length - 1], 'null', `${name}'s shorter constructor passes ${args[args.length - 1]} for cloudName`);
  });
}

// ------------------------------------------------------------------ 3. one VmIdentity.of per entry point

const ENTRY_POINTS = [
  ['IntentInterpreter', `${MAIN}/intent/IntentInterpreter.java`, null],
  ['WorkflowActivitiesImpl.expand', `${MAIN}/workflow/WorkflowActivitiesImpl.java`, 'expand'],
  ['BatchController', `${MAIN}/api/BatchController.java`, null],
  ['CatalogActivitiesImpl', `${MAIN}/catalog/CatalogActivitiesImpl.java`, null],
];

/** The body of a method (any return type) named `name`. */
function methodBody(src, name) {
  const s = noComments(src);
  const m = new RegExp(`\\b${name}\\s*\\([^;{]*\\)\\s*(?:throws[^{]*)?\\{`).exec(noStrings(s));
  assert.ok(m, `no method ${name}`);
  const bo = m.index + m[0].length - 1;
  return s.slice(bo, matchBracket(noStrings(s), bo));
}

for (const [what, rel, method] of ENTRY_POINTS) {
  test(`criterion 3: ${what} gets the hash and the cloud name from one VmIdentity.of(...) call`, () => {
    const code = method ? methodBody(now(rel), method) : noComments(now(rel));
    const calls = [...code.matchAll(/(\w+)\s*=\s*VmIdentity\.of\s*\(/g)];
    assert.equal([...code.matchAll(/VmIdentity\.of\s*\(/g)].length, 1, `${what} has ${[...code.matchAll(/VmIdentity\.of\s*\(/g)].length} VmIdentity.of calls`);
    assert.equal(calls.length, 1, `${what}'s VmIdentity.of result isn't kept in a variable`);
    const v = calls[0][1];
    assert.match(code, new RegExp(`\\b${v}\\.hash\\(\\)`), `${what} doesn't use ${v}.hash()`);
    assert.match(code, new RegExp(`\\b${v}\\.cloudName\\(\\)`), `${what} doesn't use ${v}.cloudName()`);
    assert.ok(!/VmIdentity\.hash\s*\(/.test(code), `${what} still calls VmIdentity.hash`);
  });
}

test('criterion 3: no main-code file outside spec/ calls VmIdentity.hash (or imports it statically)', () => {
  const bad = [];
  for (const { path, src } of mainSources()) {
    if (path.startsWith('vm-intent/backend/src/main/java/com/example/vmintent/spec/')) continue;
    const code = noComments(src);
    if (/VmIdentity\s*(\.|::)\s*hash\b/.test(code) || /import\s+static\s+[\w.]*VmIdentity\.(hash|\*)\s*;/.test(code)) bad.push(path);
  }
  assert.deepEqual(bad, []);
});

// ------------------------------------------------------------------ 4. ReconcileRequest constructions

test('criterion 4: ReconcileRequest\'s components are unchanged: spec, specHash, requestedBy, requestId, cloudName', () => {
  const rec = record(now(`${MAIN}/workflow/Models.java`), 'ReconcileRequest');
  assert.deepEqual(rec.components.map((c) => c.split(' ').pop()), ['spec', 'specHash', 'requestedBy', 'requestId', 'cloudName']);
  assert.deepEqual(rec.components, record(at(BEFORE, `${MAIN}/workflow/Models.java`), 'ReconcileRequest').components);
});

test('criterion 4: every main-code new ReconcileRequest( passes, fifth, the cloudName of what it takes specHash from', () => {
  const found = []; const bad = [];
  for (const { path, src } of mainSources()) {
    const s = noStrings(noComments(src));
    for (const m of s.matchAll(/new\s+(?:Models\.)?ReconcileRequest\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      const args = splitTop(s.slice(open + 1, matchBracket(s, open) - 1)).map(squash);
      const where = `${path.split('/').pop()}: new ReconcileRequest(${args.join(', ')})`;
      found.push(where);
      const hashOf = /^(\w+)\.specHash\(\)$/.exec(args[1] || '');
      if (args.length !== 5) bad.push(`${where} has ${args.length} args`);
      else if (args[4] === 'null') bad.push(`${where} passes null`);
      else if (!hashOf) bad.push(`${where} doesn't take specHash from a value's specHash()`);
      else if (args[4] !== `${hashOf[1]}.cloudName()`) bad.push(`${where}: fifth argument isn't ${hashOf[1]}.cloudName()`);
    }
  }
  assert.ok(found.length >= 4, `only ${found.length} constructions found:\n${found.join('\n')}`);
  assert.deepEqual(bad, [], `constructions checked:\n${found.join('\n')}`);
});

// ------------------------------------------------------------------ 5. unit tests per entry point

const ENTRY_TESTS = [
  ['a single request via the interpreter', /requestAndConfirm|\.preview\s*\(|\.interpret\s*\(|IntentInterpreter/],
  ['a multi-VM request via expand', /\.expand\s*\(/],
  ['a batch via BatchController', /batches\.submit\s*\(|runBatch\s*\(|BatchController/],
  ['a catalog run via CatalogActivitiesImpl', /prepareVm|PreparedVm|CatalogRunWorkflow|CatalogActivitiesImpl/],
  ['the legacy path', /legacy/i],
];

test('criterion 5: for each entry point an active @Test asserts the recorded cloudName equals spec.name()', () => {
  const all = testSources().flatMap(({ path, src }) => activeTests(src).map((t) => ({ ...t, path })));
  // A test counts when it asserts a cloudName() against a spec's name() or a name literal.
  const checksCloudName = (b) => /assertEquals\s*\(\s*(?:[\w.()]*\.name\(\)|"[\w-]+"|List\.of\([^;]*\))\s*,[^;]*\bcloudName\b/.test(b)
    || /assertEquals\s*\([^;]*\bcloudName\(\)[^;]*,\s*[\w.]*spec\(\)\.name\(\)/.test(b)
    || /\.map\(\s*BatchItem::cloudName\)/.test(b);
  const missing = [];
  const seen = [];
  for (const [what, marker] of ENTRY_TESTS) {
    const hits = all.filter((t) => marker.test(t.body) && /cloudName/.test(t.body) && checksCloudName(t.body));
    if (!hits.length) missing.push(what);
    else seen.push(`${what}: ${hits.map((t) => `${t.path.split('/').pop()}#${t.name}`).join(', ')}`);
  }
  assert.deepEqual(missing, [], `found:\n${seen.join('\n')}`);
});

test('criterion 5: the per-entry-point tests are the ones this requirement added', () => {
  const want = {
    [`${TEST}/api/RequestOwnerFlowTest.java`]: ['aSingleRequestRecordsTheSpecNameAsItsCloudName',
      'aMultiVmRequestRecordsEachVmsNameAsItsCloudName', 'aBatchRecordsEachSpecNameAsItsCloudName',
      'theLegacyPathRecordsTheSpecNameAsItsCloudName'],
    [`${TEST}/workflow/CatalogRunWorkflowTest.java`]: ['aCatalogRunRecordsTheSpecNameAsItsCloudName'],
  };
  for (const [rel, names] of Object.entries(want)) {
    const tests = activeTests(now(rel));
    for (const n of names) {
      const t = tests.find((x) => x.name === n);
      assert.ok(t, `${rel} has no active @Test ${n}`);
      assert.match(t.body, /cloudName\(\)/, `${n} doesn't look at cloudName()`);
    }
  }
  // The multi-VM test goes through expand; the catalog test through the real prepareVm (CatalogActivitiesImpl).
  const flow = activeTests(now(`${TEST}/api/RequestOwnerFlowTest.java`));
  assert.match(flow.find((x) => x.name === 'aMultiVmRequestRecordsEachVmsNameAsItsCloudName').body, /\.expand\s*\(/);
  assert.match(now(`${TEST}/workflow/CatalogRunWorkflowTest.java`), /super\.prepareVm\s*\(/,
    'CatalogRunWorkflowTest doesn\'t run the real CatalogActivitiesImpl.prepareVm');
});

// ------------------------------------------------------------------ 6. workflow test with cloudName x-test

test('criterion 6: an active workflow test gives a BatchItem/Interpretation cloudName "x-test" (spec "web-01"); the fake cloud gets x-test, the record keeps web-01', () => {
  const hits = [];
  for (const { path, src } of testSources()) {
    if (!/TestWorkflowEnvironment/.test(src)) continue;
    for (const t of activeTests(src)) {
      const b = t.body;
      if (!/new\s+(?:Models\.)?(?:BatchItem|Interpretation)\s*\([^;]*"x-test"\s*\)/.test(b)) continue;
      if (!/spec\s*\(\s*"web-01"|withName\s*\(\s*"web-01"\)|"web-01"/.test(b)) continue;
      const cloudGetsXTest = /assert\w*\s*\([^;]*"x-test"[^;]*\b(createdNames|created|planned|cloud)\b/.test(b);
      const recordKeepsWeb01 = /assert\w*\s*\([^;]*savedNames[^;]*"web-01"|assert\w*\s*\([^;]*"web-01"[^;]*savedNames/.test(b);
      if (cloudGetsXTest && recordKeepsWeb01) hits.push({ path, t, src });
    }
  }
  assert.ok(hits.length > 0, 'no active @Test (in a TestWorkflowEnvironment test) builds with cloudName "x-test" and checks both names');
  // The fake provider records the name it is asked to create, and the fake record store the name it saves.
  const { src } = hits[0];
  assert.match(src, /createdNames\.add\s*\(\s*\w+\.name\(\)\s*\)/, 'the fake cloud does not record the created name');
  assert.match(src, /savedNames\.add\s*\(\s*\w+\.name\(\)\s*\)/, 'the fake record store does not record the saved name');
});

// ------------------------------------------------------------------ 7. the new history

function startedInput(historyJson) {
  const h = JSON.parse(historyJson);
  const ev = h.events.find((e) => e.eventType === 'EVENT_TYPE_WORKFLOW_EXECUTION_STARTED');
  assert.ok(ev, 'the history has no WorkflowExecutionStarted event');
  const p = ev.workflowExecutionStartedEventAttributes.input.payloads[0];
  return { type: ev.workflowExecutionStartedEventAttributes.workflowType.name, input: JSON.parse(Buffer.from(p.data, 'base64').toString('utf8')) };
}

test('criterion 7: batchshard-v2-cloud-name.json was added; its BatchItem input has a cloudName that differs from the spec name', () => {
  assert.ok(COMMITS.some((sha) => CHANGES.get(sha).some((c) => c.path === `vm-intent/${NEW_HISTORY}` && c.status === 'A')),
    `no ${ID} commit adds ${NEW_HISTORY}`);
  const { type, input } = startedInput(now(NEW_HISTORY));
  assert.equal(type, 'BatchShardWorkflow');
  assert.ok(Array.isArray(input.items) && input.items.length > 0, 'the recorded shard has no items');
  const odd = input.items.filter((it) => it.cloudName && it.spec?.name && it.cloudName !== it.spec.name);
  assert.ok(odd.length > 0, `no recorded BatchItem has a cloudName differing from spec.name: ${JSON.stringify(input.items)}`);
  // The child build got that cloud name.
  const h = JSON.parse(now(NEW_HISTORY));
  const child = h.events.find((e) => e.eventType === 'EVENT_TYPE_START_CHILD_WORKFLOW_EXECUTION_INITIATED');
  assert.ok(child, 'the shard started no child workflow');
  const req = JSON.parse(Buffer.from(child.startChildWorkflowExecutionInitiatedEventAttributes.input.payloads[0].data, 'base64').toString('utf8'));
  assert.equal(req.cloudName, odd[0].cloudName, 'the vm- child was started with another cloudName');
  assert.equal(req.spec?.name, odd[0].spec.name, 'the vm- child was started with another spec name');
});

test('criterion 7: the history is recorded with HistoryRecorder from an active @Test method', () => {
  const hits = testSources().flatMap(({ path, src }) => activeTests(src)
    .filter((t) => /HistoryRecorder\.record\s*\([^;]*"batchshard-v2-cloud-name"\s*\)/.test(t.body)).map((t) => `${path}#${t.name}`));
  assert.ok(hits.length > 0, 'no active @Test calls HistoryRecorder.record(..., "batchshard-v2-cloud-name")');
});

test('criterion 7: ReplayTest replays every .json file under histories/ (batchshard- -> BatchShardWorkflowImpl) and checks the new one is there', () => {
  const src = noComments(now(`${TEST}/workflow/ReplayTest.java`));
  assert.match(src, /Files\.list\s*\(\s*HistoryRecorder\.DIR\s*\)/, 'ReplayTest doesn\'t list the histories folder');
  assert.match(src, /"batchshard-"[\s\S]{0,200}BatchShardWorkflowImpl/, 'ReplayTest has no batchshard- prefix');
  assert.match(src, /"batchshard-v2-cloud-name"/, 'ReplayTest doesn\'t name batchshard-v2-cloud-name');
  const tf = activeTests(now(`${TEST}/workflow/ReplayTest.java`));
  assert.ok(methods(now(`${TEST}/workflow/ReplayTest.java`)).some((m) => /@TestFactory/.test(m.annotations) && !/@Disabled/.test(m.annotations))
    || tf.length > 0, 'ReplayTest has no active test');
});

test('criterion 7: no AP-0043 commit modifies or deletes a history file that existed before', () => {
  const existed = new Set(git(['ls-tree', '--full-tree', '-r', '--name-only', BEFORE, `vm-intent/${HISTORIES}`]).split('\n').filter(Boolean));
  assert.ok(existed.size > 0, 'no histories before AP-0043?');
  const bad = [];
  for (const sha of COMMITS) {
    for (const c of CHANGES.get(sha)) {
      if (!c.path.startsWith(`vm-intent/${HISTORIES}`)) continue;
      if (c.status !== 'A' || existed.has(c.path)) bad.push(`${sha.slice(0, 8)} ${c.status} ${c.path}`);
    }
  }
  assert.deepEqual(bad, []);
  for (const p of existed) {
    assert.equal(at(NEWEST, p.replace(/^vm-intent\//, '')), at(BEFORE, p.replace(/^vm-intent\//, '')), `${p} changed`);
  }
});

// ------------------------------------------------------------------ 8. OpenAPI files

function interpretationSchema(doc) {
  const s = doc.components?.schemas?.Interpretation;
  assert.ok(s, 'no Interpretation schema');
  return s;
}
function checkInterpretation(s, where) {
  const d = s.properties?.specHash?.description || '';
  assert.notEqual(squash(d).replace(/\.$/, ''), 'SHA-256 of the canonical spec', `${where}: specHash still reads only "SHA-256 of the canonical spec"`);
  assert.match(d, /signed-in/i, `${where}: specHash description doesn't mention a signed-in user: ${d}`);
  assert.match(d, /user ID/i, `${where}: specHash description doesn't say the hash covers the user ID: ${d}`);
  assert.match(d, /SHA-256/, `${where}: specHash description: ${d}`);
  const c = s.properties?.cloudName;
  assert.ok(c, `${where}: Interpretation has no cloudName property`);
  assert.equal(c.type, 'string', `${where}: cloudName type`);
  assert.match(c.description || '', /name in its cloud/i, `${where}: cloudName description: ${c.description}`);
  assert.match(c.description || '', /same as spec\.name/i, `${where}: cloudName description doesn't say it's today the same as spec.name: ${c.description}`);
}

test('criterion 8: docs/openapi.json: specHash covers the user ID for a signed-in user; cloudName is the VM\'s name in its cloud', () => {
  checkInterpretation(interpretationSchema(JSON.parse(now('docs/openapi.json'))), 'openapi.json');
});

/** A "    Name:" block of components.schemas in the YAML, with folded/escaped scalars joined. */
function yamlSchema(yaml, name) {
  const lines = yaml.split('\n');
  const i = lines.findIndex((l) => l === `    ${name}:`);
  assert.ok(i >= 0, `openapi.yaml has no schema ${name}`);
  let j = i + 1;
  while (j < lines.length && (lines[j].trim() === '' || /^ {5,}/.test(lines[j]))) j++;
  return lines.slice(i, j).join('\n').replace(/\\\n\s*\\ /g, ' ').replace(/\\\n\s*/g, '').replace(/\n\s+(?![\w-]+:)/g, ' ');
}

test('criterion 8: docs/openapi.yaml matches docs/openapi.json for Interpretation (specHash and cloudName descriptions)', () => {
  const json = interpretationSchema(JSON.parse(now('docs/openapi.json')));
  const y = squash(yamlSchema(now('docs/openapi.yaml'), 'Interpretation'));
  for (const p of ['specHash', 'cloudName']) {
    const d = squash(json.properties[p].description);
    assert.ok(y.includes(d), `openapi.yaml's Interpretation doesn't have the ${p} description "${d}":\n${y}`);
  }
  assert.match(y, /cloudName: type: string/, 'openapi.yaml\'s Interpretation has no string cloudName');
});

test('criterion 8: openapi.json and openapi.yaml have the same schemas and paths (names)', () => {
  const json = JSON.parse(now('docs/openapi.json'));
  const yaml = now('docs/openapi.yaml');
  for (const name of Object.keys(json.components.schemas)) {
    assert.ok(new RegExp(`^ {4}${name}:$`, 'm').test(yaml), `openapi.yaml has no schema ${name}`);
  }
  for (const p of Object.keys(json.paths)) {
    assert.ok(yaml.includes(`  ${p}:`), `openapi.yaml has no path ${p}`);
  }
});

// ------------------------------------------------------------------ 11. Docs

test('criterion 11: DEFINITIONS.md defines "cloud name": sent to the cloud, today the spec\'s name, per-user suffix in part 2b', () => {
  const doc = now('docs/DEFINITIONS.md');
  const p = doc.split(/\n\s*\n/).find((b) => /\*\*Cloud name\.?\*\*|^#+\s*Cloud name/im.test(b));
  assert.ok(p, 'DEFINITIONS.md has no "Cloud name" definition (bold term or heading)');
  const t = squash(p);
  assert.match(t, /name sent to the cloud/i, `the definition doesn't say it's the name sent to the cloud:\n${t}`);
  assert.match(t, /same as the spec'?s name/i, `the definition doesn't say it's today the spec's name:\n${t}`);
  assert.match(t, /\btoday\b/i, `the definition doesn't say "today":\n${t}`);
  assert.match(t, /per-user suffix/i, `the definition doesn't mention the per-user suffix:\n${t}`);
  assert.match(t, /part 2b/i, `the definition doesn't name part 2b:\n${t}`);
});

test('criterion 11: TEMPORAL-FEATURES.md lists batchshard-v2-cloud-name among the replay histories', () => {
  const doc = now('docs/TEMPORAL-FEATURES.md');
  const lines = doc.split('\n');
  const i = lines.findIndex((l) => l.startsWith('## 9. Replay tests'));
  assert.ok(i >= 0, 'no "## 9. Replay tests" section');
  let j = i + 1;
  while (j < lines.length && !lines[j].startsWith('## ')) j++;
  const s9 = lines.slice(i, j).join('\n');
  assert.match(s9, /^- `batchshard-v2-cloud-name(\.json)?`/m, 'section 9 has no list item for batchshard-v2-cloud-name');
  assert.match(squash(s9), /batchshard-v2-cloud-name(\.json)?` is a batch shard whose `BatchItem` has the cloud name `x-test`/,
    'the list item doesn\'t describe the history');
});
