// AP-0038 acceptance, repository half (criteria 1-10): two signed-in baseline histories are saved
// (intent-v2-signed-in.json, catalog-v3-signed-in.json) with the owner in their start input, the owner reaches
// PrepareVm and a vm- child, active @Test methods record and replay them, ReplayTest guards both names, ReplayTest's
// factory will replay them, the 11 older histories are untouched and backend/src/main is not changed.
//
// Files are read as they were at the newest AP-0038 commit that changed them (git show), and the "must not change"
// checks look only at AP-0038 commits, so later requirements can change these files freely. The build gates run
// mvn test (criterion 8's pass/fail); this suite only reads sources, never build outputs.
//
//   node --test tests/acceptance/ap-0038/repo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const HIST = 'backend/src/test/resources/histories';
const TEST_SRC = 'backend/src/test/java';
const REPLAY = `${TEST_SRC}/com/example/vmintent/workflow/ReplayTest.java`;
const OWNER = 'alice-signed-in';
const OLD_HISTORIES = [
  'intent-v1-completed', 'intent-v1-cancelled', 'intent-v1-open', 'reconcile-v1-completed',
  'catalog-v1-resumed', 'catalog-v1-torn-down', 'catalog-v1-approved', 'catalog-v2-existing-vm',
  'intent-v2-multi-existing', 'lifecycle-v1-renewed', 'batchshard-v1-duplicate',
].map((n) => `${HIST}/${n}.json`);

const git = (args) => execFileSync('git', args,
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
const subject = (sha) => git(['log', '-1', '--format=%s', sha]).trim();

// Oldest first.
const COMMITS = git(['log', '--reverse', '--format=%H', '--grep', '^AP-0038:']).split('\n').filter(Boolean);
const changed = (sha) => git(['diff', '--name-status', '--no-renames', `${sha}^`, sha]).split('\n').filter(Boolean)
  .map((l) => { const [status, path] = l.split('\t'); return { status, path }; });
const CHANGES = new Map(COMMITS.map((sha) => [sha, changed(sha)]));
const touching = (prefix) => COMMITS.filter((sha) => CHANGES.get(sha).some((c) => c.path.startsWith(prefix)));
const SRC_COMMITS = touching('vm-intent/backend/src/');
const LAST = SRC_COMMITS[SRC_COMMITS.length - 1];

function at(sha, rel) {
  try { return git(['show', `${sha}:vm-intent/${rel}`]); } catch { return null; }
}
/** A file as it was at the newest AP-0038 commit that changed it (or, failing that, that changed backend/src). */
function must(rel) {
  assert.ok(LAST, 'no AP-0038 commit changes vm-intent/backend/src/');
  const own = touching(`vm-intent/${rel}`);
  const sha = own.length ? own[own.length - 1] : LAST;
  const t = at(sha, rel);
  assert.ok(t !== null, `${rel} doesn't exist at ${sha.slice(0, 8)}`);
  return t.replace(/\r\n/g, '\n');
}

function history(name) {
  const text = must(`${HIST}/${name}.json`);
  let doc;
  try { doc = JSON.parse(text); } catch (e) { assert.fail(`${name}.json is not valid JSON: ${e.message}`); }
  assert.ok(doc && Array.isArray(doc.events), `${name}.json has no top-level "events" array`);
  return doc.events;
}
const isType = (ev, camel, upper) => ev.eventType === camel || ev.eventType === upper;
const started = (events) => events[0]?.workflowExecutionStartedEventAttributes;
const decode = (payload) => Buffer.from(payload?.data || '', 'base64').toString('utf8');
const payloads = (input) => (input?.payloads || []);

// --------------------------------------------------------------- Java helpers

/** Blanks comments (same length); with `strings`, also blanks string/char literal contents. */
function strip(src, strings) {
  let out = '';
  for (let i = 0; i < src.length;) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { const e = src.indexOf('\n', i); const j = e < 0 ? src.length : e; out += ' '.repeat(j - i); i = j; }
    else if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); const j = e < 0 ? src.length : e + 2; out += src.slice(i, j).replace(/[^\n]/g, ' '); i = j; }
    else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      j = Math.min(j + 1, src.length);
      out += strings ? c + ' '.repeat(Math.max(0, j - i - 2)) + (j - i >= 2 ? src[j - 1] : '') : src.slice(i, j);
      i = j;
    } else { out += c; i++; }
  }
  return out;
}

/** Every method in a Java source: its annotations, name and body (comments removed, strings kept). */
function methods(src) {
  const keep = strip(src, false), bare = strip(src, true);
  const re = /((?:@[\w.]+(?:\([^)]*\))?\s+)*)(?:(?:public|protected|private|static|final|synchronized)\s+)*(?:<[^>]*>\s*)?[\w.<>\[\], ?]+\s+(\w+)\s*\([^)]*\)\s*(?:throws\s+[\w.,\s]+)?\{/g;
  const out = [];
  let m;
  while ((m = re.exec(bare))) {
    const open = m.index + m[0].length - 1;
    let depth = 0, end = bare.length;
    for (let k = open; k < bare.length; k++) {
      if (bare[k] === '{') depth++;
      else if (bare[k] === '}' && --depth === 0) { end = k; break; }
    }
    if (['if', 'for', 'while', 'switch', 'catch', 'synchronized', 'return', 'new'].includes(m[2])) continue;
    out.push({ annotations: m[1] || '', name: m[2], body: keep.slice(open + 1, end) });
  }
  return out;
}

/** Test sources as they were at the last AP-0038 commit that changed backend/src. */
let sources;
function testSources() {
  assert.ok(LAST, 'no AP-0038 commit changes vm-intent/backend/src/');
  if (sources) return sources;
  const files = git(['ls-tree', '--full-tree', '-r', '--name-only', LAST, `vm-intent/${TEST_SRC}`]).split('\n')
    .filter((p) => p.endsWith('.java'));
  return (sources = files.map((p) => ({ path: p, src: git(['show', `${LAST}:${p}`]).replace(/\r\n/g, '\n') })));
}

function recorderMethods(name) {
  const quoted = new RegExp(`HistoryRecorder\\s*\\.\\s*record\\s*\\([^;]*"${name}"`, 's');
  const found = [];
  for (const { path, src } of testSources()) {
    for (const m of methods(src)) if (quoted.test(m.body)) found.push({ ...m, path });
  }
  return found;
}

// --------------------------------------------------------------- criteria

test('AP-0038 has commits that change backend/src', () => {
  assert.ok(COMMITS.length > 0, 'no commit subject starts with AP-0038:');
  assert.ok(LAST, `no AP-0038 commit changes vm-intent/backend/src/ (${COMMITS.map(subject).join(' | ')})`);
});

for (const name of ['intent-v2-signed-in', 'catalog-v3-signed-in']) {
  test(`criterion 1: ${name}.json is valid JSON with >1 events, the first WorkflowExecutionStarted`, () => {
    const events = history(name);
    assert.ok(events.length > 1, `${name}.json has ${events.length} events`);
    assert.ok(isType(events[0], 'WorkflowExecutionStarted', 'EVENT_TYPE_WORKFLOW_EXECUTION_STARTED'),
      `first event of ${name}.json is ${events[0]?.eventType}`);
    assert.ok(started(events), `${name}.json's first event has no workflowExecutionStartedEventAttributes`);
  });
}

test('criterion 2: the workflow types match intent-v2-multi-existing.json and catalog-v2-existing-vm.json', () => {
  const intentType = started(history('intent-v2-signed-in'))?.workflowType?.name;
  const catalogType = started(history('catalog-v3-signed-in'))?.workflowType?.name;
  assert.equal(intentType, 'IntentWorkflow');
  const refIntent = JSON.parse(at(LAST, `${HIST}/intent-v2-multi-existing.json`)).events[0]
    .workflowExecutionStartedEventAttributes.workflowType.name;
  const refCatalog = JSON.parse(at(LAST, `${HIST}/catalog-v2-existing-vm.json`)).events[0]
    .workflowExecutionStartedEventAttributes.workflowType.name;
  assert.equal(intentType, refIntent, 'intent-v2-signed-in type differs from intent-v2-multi-existing');
  assert.equal(catalogType, refCatalog, 'catalog-v3-signed-in type differs from catalog-v2-existing-vm');
  assert.match(catalogType, /Catalog/i);
});

test('criterion 3: the start input decodes to a request whose owner is alice-signed-in', () => {
  const intent = payloads(started(history('intent-v2-signed-in'))?.input).map(decode);
  assert.ok(intent.length >= 1, 'intent-v2-signed-in has no start input payloads');
  const req = JSON.parse(intent[0]);
  assert.equal(req.owner, OWNER, `IntentRequest: ${intent[0]}`);
  assert.ok(typeof req.text === 'string', `the first payload looks like an IntentRequest: ${intent[0]}`);

  const catalog = payloads(started(history('catalog-v3-signed-in'))?.input).map(decode);
  assert.ok(catalog.length >= 1, 'catalog-v3-signed-in has no start input payloads');
  const run = catalog.map((d) => { try { return JSON.parse(d); } catch { return null; } })
    .find((o) => o && o.owner === OWNER);
  assert.ok(run, `no catalog start payload has owner ${OWNER}: ${catalog.join(' | ').slice(0, 600)}`);
});

test('criterion 4: a PrepareVm ActivityTaskScheduled input in catalog-v3-signed-in contains alice-signed-in', () => {
  const scheduled = history('catalog-v3-signed-in')
    .filter((e) => isType(e, 'ActivityTaskScheduled', 'EVENT_TYPE_ACTIVITY_TASK_SCHEDULED'))
    .map((e) => e.activityTaskScheduledEventAttributes)
    .filter((a) => /^prepareVm$/i.test(a?.activityType?.name || ''));
  assert.ok(scheduled.length >= 1, 'no PrepareVm activity is scheduled in catalog-v3-signed-in');
  assert.ok(scheduled.some((a) => payloads(a.input).some((p) => decode(p).includes(OWNER))),
    `no PrepareVm input contains ${OWNER}`);
});

test('criterion 5: intent-v2-signed-in starts a child workflow whose ID starts with vm-', () => {
  const kids = history('intent-v2-signed-in')
    .filter((e) => isType(e, 'StartChildWorkflowExecutionInitiated', 'EVENT_TYPE_START_CHILD_WORKFLOW_EXECUTION_INITIATED'))
    .map((e) => e.startChildWorkflowExecutionInitiatedEventAttributes?.workflowId || '');
  assert.ok(kids.some((id) => id.startsWith('vm-')), `child workflow IDs: ${JSON.stringify(kids)}`);
});

for (const name of ['intent-v2-signed-in', 'catalog-v3-signed-in']) {
  test(`criterion 6: an active @Test method records ${name}, uses alice-signed-in and replays`, () => {
    const found = recorderMethods(name);
    assert.ok(found.length >= 1, `no test method calls HistoryRecorder.record(..., "${name}")`);
    const good = found.filter((m) => /@Test\b/.test(m.annotations) && !/@Disabled\b/.test(m.annotations)
      && m.body.includes(OWNER) && /WorkflowReplayer\s*\.\s*replayWorkflowExecution\s*\(/.test(m.body));
    assert.ok(good.length >= 1, `methods recording ${name}: ${found.map((m) => `${m.path}#${m.name} [${m.annotations.trim()}]`).join(', ')}`
      + ' - none is @Test, not @Disabled, mentions alice-signed-in and calls WorkflowReplayer.replayWorkflowExecution');
    // The class itself must not be @Disabled either.
    for (const m of good) {
      const src = testSources().find((s) => s.path === m.path).src;
      const head = strip(src, true).slice(0, strip(src, true).search(/\bclass\s+\w+/));
      assert.doesNotMatch(head, /@Disabled\b/, `${m.path} is @Disabled`);
    }
  });
}

test('criterion 7: ReplayTest checks both signed-in names with assertAllThere in a @Test method', () => {
  const src = must(REPLAY);
  const ms = methods(src);
  const lists = [...strip(src, false).matchAll(/(\w+)\s*=\s*List\.of\(([^;]*)\)\s*;/g)]
    .filter((m) => m[2].includes('"intent-v2-signed-in"') && m[2].includes('"catalog-v3-signed-in"'))
    .map((m) => m[1]);
  const direct = ms.filter((m) => /@Test\b/.test(m.annotations) && !/@Disabled\b/.test(m.annotations)
    && /assertAllThere\s*\(/.test(m.body)
    && (lists.some((l) => new RegExp(`assertAllThere\\s*\\(\\s*${l}\\s*\\)`).test(m.body))
      || (m.body.includes('"intent-v2-signed-in"') && m.body.includes('"catalog-v3-signed-in"'))));
  assert.ok(direct.length >= 1, `lists naming both: ${JSON.stringify(lists)}; no active @Test passes them to assertAllThere`);
  const helper = ms.find((m) => m.name === 'assertAllThere');
  assert.ok(helper, 'ReplayTest has no assertAllThere');
  assert.match(helper.body, /Files\s*\.\s*exists[\s\S]*fail\s*\(/, 'assertAllThere does not fail on a missing file');
});

test('criterion 8 (static half): ReplayTest replays every .json in histories and maps intent-/catalog- prefixes', () => {
  const src = must(REPLAY);
  const factory = methods(src).find((m) => m.name === 'everySavedHistoryReplays');
  assert.ok(factory && /@TestFactory\b/.test(factory.annotations) && !/@Disabled\b/.test(factory.annotations),
    'ReplayTest has no active @TestFactory everySavedHistoryReplays');
  assert.match(factory.body, /Files\s*\.\s*list\s*\(\s*HistoryRecorder\s*\.\s*DIR\s*\)/);
  assert.match(factory.body, /endsWith\s*\(\s*"\.json"\s*\)/);
  assert.match(factory.body, /dynamicTest\s*\(\s*file\s*\.\s*getFileName\s*\(\s*\)\s*\.\s*toString\s*\(\s*\)/,
    'dynamic tests are named after the file');
  assert.match(factory.body, /WorkflowReplayer\s*\.\s*replayWorkflowExecution\s*\(/);
  assert.match(src, /"intent-"\s*,\s*IntentWorkflowImpl\.class/);
  assert.match(src, /"catalog-"\s*,\s*CatalogRunWorkflowImpl\.class/);
  const tree = git(['ls-tree', '--full-tree', '--name-only', LAST, `vm-intent/${HIST}/`]);
  for (const f of ['intent-v2-signed-in.json', 'catalog-v3-signed-in.json']) assert.ok(tree.includes(f), `${f} not in ${HIST}`);
});

test('criterion 9: no AP-0038 commit modifies or deletes one of the 11 older histories', () => {
  const first = COMMITS[0];
  assert.ok(first, 'no AP-0038 commits');
  const before = git(['ls-tree', '--full-tree', '--name-only', `${first}^`, `vm-intent/${HIST}/`]).split('\n').filter(Boolean);
  for (const rel of OLD_HISTORIES) assert.ok(before.includes(`vm-intent/${rel}`), `${rel} did not exist before AP-0038`);
  for (const sha of COMMITS) {
    const bad = CHANGES.get(sha).filter((c) => before.includes(c.path));
    assert.deepEqual(bad, [], `${sha.slice(0, 8)} ${subject(sha)} changes older histories`);
  }
  const last = COMMITS[COMMITS.length - 1];
  for (const rel of OLD_HISTORIES) {
    const was = git(['rev-parse', `${first}^:vm-intent/${rel}`]).trim();
    const now = git(['rev-parse', `${last}:vm-intent/${rel}`]).trim();
    assert.equal(now, was, `${rel} differs after AP-0038`);
  }
});

test('criterion 10: no AP-0038 commit changes anything under backend/src/main', () => {
  for (const sha of COMMITS) {
    const bad = CHANGES.get(sha).filter((c) => c.path.startsWith('vm-intent/backend/src/main/'));
    assert.deepEqual(bad, [], `${sha.slice(0, 8)} ${subject(sha)} changes main code`);
  }
});
