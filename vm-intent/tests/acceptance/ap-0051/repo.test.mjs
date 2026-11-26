// AP-0051 acceptance, repository half (criteria 1-8): the daily docs pass of 2026-11-20. README's spec/ entry,
// TEMPORAL-FEATURES' cloud-name paragraph and its VmIdentityTest / RequestOwnerFlowTest rows, and DEFINITIONS'
// 'Cloud name' paragraph describe AP-0049's signed-in <name>-<8 hex> cloud name; the three docs get the new date;
// every class and test method the change names exists; nothing else changes.
//
// "This requirement's kept commits" are the non-merge commits whose subject starts with "AP-0051:", leaving out the
// pipeline's own "acceptance tests" and "record the requirement" commits. Files are read with git show as they were
// at the newest kept commit that changed them (or, for files it didn't change, the newest kept commit), and "before"
// means the parent of the oldest AP-0051 commit, so later requirements can change these files freely. Only sources
// are read, never build outputs; the build gates run the unit tests.
//
//   node --test tests/acceptance/ap-0051/repo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = 'AP-0051';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const NEW_DATE = 'Last updated 2026-11-20.';
const DATED = { 'README.md': 'Last updated 2026-11-19.', 'docs/TEMPORAL-FEATURES.md': 'Last updated 2026-11-18.',
  'docs/DEFINITIONS.md': 'Last updated 2026-11-19.' };
const TESTS = 'backend/src/test/java/com/example/vmintent';
const VMID_TEST = `${TESTS}/spec/VmIdentityTest.java`;
const OWNER_TEST = `${TESTS}/api/RequestOwnerFlowTest.java`;

const git = (args) => execFileSync('git', args,
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

// Oldest first; subjects are checked here, because --grep also matches body lines.
const ALL = git(['log', '--no-merges', '--reverse', '--format=%H %s', '--grep', `^${ID}:`]).split('\n').filter(Boolean)
  .map((l) => ({ sha: l.slice(0, 40), subject: l.slice(41) })).filter((c) => c.subject.startsWith(`${ID}:`));
const isPipeline = (c) => /^AP-\d+: (acceptance tests|record the requirement)\b/.test(c.subject);
const COMMITS = ALL.filter((c) => !isPipeline(c)).map((c) => c.sha);
const NEWEST = COMMITS[COMMITS.length - 1];
const BEFORE = ALL.length ? git(['rev-parse', `${ALL[0].sha}^`]).trim() : null;
const changed = (sha) => git(['diff', '--name-only', '--no-renames', `${sha}^`, sha]).split('\n').filter(Boolean);
const CHANGES = new Map(COMMITS.map((sha) => [sha, changed(sha)]));
const touching = (rel) => COMMITS.filter((sha) => CHANGES.get(sha).includes(`vm-intent/${rel}`));

function at(sha, rel) {
  try { return git(['show', `${sha}:vm-intent/${rel}`]).replace(/\r\n/g, '\n'); } catch { return null; }
}
/** A file as it was at the newest kept AP-0051 commit that changed it (or the newest kept AP-0051 commit). */
function now(rel) {
  assert.ok(NEWEST, `no ${ID} commit`);
  const own = touching(rel);
  const sha = own.length ? own[own.length - 1] : NEWEST;
  const t = at(sha, rel);
  assert.ok(t !== null, `${rel} doesn't exist at ${sha.slice(0, 8)}`);
  return t;
}
function before(rel) {
  assert.ok(BEFORE, `no ${ID} commit`);
  const t = at(BEFORE, rel);
  assert.ok(t !== null, `${rel} doesn't exist before ${ID}`);
  return t;
}
const squash = (s) => s.replace(/\s+/g, ' ').trim();
const plain = (s) => squash(s.replace(/`/g, '').replace(/\*\*/g, ''));
const has = (text, needle, what) => assert.ok(squash(text).includes(squash(needle)),
  `${what} doesn't say: ${needle}\n--- it says:\n${squash(text)}`);
const hasNot = (text, needle, what) => assert.ok(!squash(text).includes(squash(needle)),
  `${what} still says: ${needle}\n--- it says:\n${squash(text)}`);
const hasRe = (text, re, what) => assert.match(text, re, `${what} doesn't match ${re}\n--- it says:\n${text}`);
/** The table row whose first cell is `cell` (optionally in backticks). */
function row(text, cell) {
  const r = text.split('\n').find((l) => l.startsWith(`| ${cell} |`) || l.startsWith(`| \`${cell}\` |`));
  assert.ok(r, `no table row for ${cell}`);
  return r;
}
/** The blank-line-separated paragraph containing `needle`. */
function paragraph(text, needle) {
  const p = text.split(/\n\s*\n/).find((x) => x.includes(needle));
  assert.ok(p, `no paragraph containing ${needle}`);
  return p;
}
/** Java source with // and /* comments removed (string literals kept). */
function noComments(src) {
  let out = '';
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1); i = j + 1;
    } else if (src.startsWith('//', i)) { const j = src.indexOf('\n', i); i = j < 0 ? src.length : j; }
    else if (src.startsWith('/*', i)) { const j = src.indexOf('*/', i + 2); i = j < 0 ? src.length : j + 2; out += ' '; }
    else { out += c; i++; }
  }
  return out;
}
/** The body of the method `name` in Java source (from its signature to the matching close brace). */
function methodBody(src, name) {
  const i = src.search(new RegExp(`void\\s+${name}\\s*\\(`));
  if (i < 0) return null;
  const open = src.indexOf('{', i);
  let depth = 0; let j = open;
  for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}' && --depth === 0) break; }
  return src.slice(open, j + 1);
}

test(`there is an ${ID} commit (other than the pipeline's own)`, () => {
  assert.ok(COMMITS.length > 0, `no non-pipeline commit subject starts with ${ID}:`);
});

// ------------------------------------------------------------------ 1. README code map, spec/ entry

function specEntry(readme) {
  const lines = readme.split('\n');
  const i = lines.findIndex((l) => /^\s+spec\/\s/.test(l));
  assert.ok(i >= 0, 'README has no spec/ entry in the code map');
  let j = i + 1;
  while (j < lines.length && /^\s{6,}\S/.test(lines[j]) && !/^\s+\w+\/\s/.test(lines[j])) j++;
  return squash(lines.slice(i, j).join(' '));
}

test('criterion 1: the spec/ entry no longer says the cloud name "today is the spec\'s name"', () => {
  const e = specEntry(now('README.md'));
  hasNot(e, 'today is the spec\'s name', 'the spec/ entry');
  assert.doesNotMatch(e, /cloudName\)[^;]*\btoday\b/, 'the cloud-name clause still says "today"');
});

test('criterion 1: the spec/ entry still says VmIdentity.of gives the spec hash together with the cloud name (cloudName)', () => {
  has(specEntry(now('README.md')), 'VmIdentity.of gives the spec hash together with the VM\'s cloud name (cloudName)', 'the spec/ entry');
});

test('criterion 1: the spec/ entry says the cloud name is the spec\'s name, except a signed-in user\'s named VM gets "-" plus the first 8 hex of its spec hash', () => {
  const e = specEntry(now('README.md'));
  const clause = e.slice(e.indexOf('(cloudName)'));
  hasRe(clause, /^\(cloudName\),? which is the spec's name, except (that )?a signed-in user's named VM gets "-" plus the first 8 hex characters of its spec hash/,
    'the cloud-name clause of the spec/ entry');
  // The rest of the entry is still there.
  for (const t of ['the one place that computes a VM\'s spec hash', 'vm-/life- workflow IDs', 'build key',
    'same spec hash only', 'VmNames: the one VM-name rule']) has(e, t, 'the spec/ entry');
});

// ------------------------------------------------------------------ 2. TEMPORAL-FEATURES cloud-name paragraph

const RECORDED = '**The cloud-side name is a recorded value.**';

test('criterion 2: the recorded-value paragraph no longer says the cloud name is "today" the spec\'s name', () => {
  const p = paragraph(now('docs/TEMPORAL-FEATURES.md'), RECORDED);
  assert.ok(p.trimStart().startsWith(RECORDED), 'the paragraph does not start with the heading');
  assert.doesNotMatch(squash(p), /\btoday\b/i, `the paragraph still says "today":\n${squash(p)}`);
});

test('criterion 2: it still says every caller copies the cloud name VmIdentity.of gave the Interpretation, BatchItem or PreparedVm', () => {
  const p = plain(paragraph(now('docs/TEMPORAL-FEATURES.md'), RECORDED));
  has(p, 'Every caller copies the cloud name that VmIdentity.of gave the Interpretation, BatchItem or PreparedVm', 'the paragraph');
});

test('criterion 2: it says a signed-in user\'s named VM gets <name>-<first 8 hex of the spec hash>, otherwise the spec\'s name (or the generated vm- name)', () => {
  const p = plain(paragraph(now('docs/TEMPORAL-FEATURES.md'), RECORDED));
  hasRe(p, /signed-in user's named VM[^.]*<name>-<first 8 hex characters of the spec hash>/, 'the paragraph');
  hasRe(p, /otherwise it is the spec's name \(or the generated vm- name\)/, 'the paragraph');
});

test('criterion 2: it still says histories recorded before that change carry a null cloudName, treated as spec.name', () => {
  const p = plain(paragraph(now('docs/TEMPORAL-FEATURES.md'), RECORDED));
  has(p, 'histories recorded before that change carry a null cloudName, which the build treats as spec.name', 'the paragraph');
  // The rest of the paragraph (everything before "Every caller") is word for word as it was.
  const head = (t) => squash(t).split('Every caller')[0];
  assert.equal(head(paragraph(now('docs/TEMPORAL-FEATURES.md'), RECORDED)),
    head(paragraph(before('docs/TEMPORAL-FEATURES.md'), RECORDED)), 'the start of the paragraph changed');
});

// ------------------------------------------------------------------ 3. VmIdentityTest row

const OLD_VMID_CLOUD = 'and a cloud name (the spec\'s name, or the generated one);';

test('criterion 3: the VmIdentityTest row no longer describes the cloud name only as "the spec\'s name, or the generated one"', () => {
  const r = row(now('docs/TEMPORAL-FEATURES.md'), 'VmIdentityTest');
  hasNot(r, OLD_VMID_CLOUD, 'the VmIdentityTest row');
});

test('criterion 3: the VmIdentityTest row describes the signed-in cloud name and its properties', () => {
  const r = plain(row(now('docs/TEMPORAL-FEATURES.md'), 'VmIdentityTest'));
  hasRe(r, /signed-in owner's named spec gets <name>-<first 8 hex characters of its hash>/, 'the VmIdentityTest row');
  hasRe(r, /for example web-01-55214b87/, 'the VmIdentityTest row');
  hasRe(r, /without changing the hash/, 'the VmIdentityTest row');
  hasRe(r, /generated vm-<hash8> name gets no second suffix/, 'the VmIdentityTest row');
  hasRe(r, /same owner and spec always give the same cloud name/, 'the VmIdentityTest row');
  hasRe(r, /two signed-in owners get different cloud names for the same named spec/, 'the VmIdentityTest row');
  hasRe(r, /41-character name gives a 50-character cloud name that is still a valid name/, 'the VmIdentityTest row');
});

test('criterion 3: every other claim of the VmIdentityTest row is still there word for word', () => {
  const old = squash(row(before('docs/TEMPORAL-FEATURES.md'), 'VmIdentityTest'));
  const cur = squash(row(now('docs/TEMPORAL-FEATURES.md'), 'VmIdentityTest'));
  const i = old.indexOf(OLD_VMID_CLOUD);
  assert.ok(i >= 0, 'the old row did not have the cloud-name clause (test assumption)');
  const prefix = old.slice(0, i) + 'and a cloud name';
  const suffix = old.slice(i + OLD_VMID_CLOUD.length).trim();
  has(cur, prefix, 'the VmIdentityTest row');
  has(cur, suffix, 'the VmIdentityTest row');
  for (const t of ['Golden values', '`vm-` and `life-` workflow IDs', '`buildKey`', '`hashOfBuildKey`', '`VmIdentity.sameBuild`']) {
    has(cur, t, 'the VmIdentityTest row');
  }
});

// ------------------------------------------------------------------ 4. RequestOwnerFlowTest row

const OLD_OWNER_CLOUD = 'the cloud name recorded for a single request, a multi-VM request, a batch and the legacy endpoint is the spec\'s name, and is what the build gets';

test('criterion 4: the RequestOwnerFlowTest row says the spec\'s-name cloud name holds with sign-in off', () => {
  const r = plain(row(now('docs/TEMPORAL-FEATURES.md'), 'RequestOwnerFlowTest'));
  hasRe(r, /with sign-in off,? the cloud name recorded for a single request, a multi-VM request, a batch and the legacy endpoint is the spec's name,? and is what the build gets/,
    'the RequestOwnerFlowTest row');
  // No unqualified "the cloud name recorded ... is the spec's name" left.
  const unqualified = r.split(/;\s*/).filter((c) => c.includes('the cloud name recorded') && !/sign-in off/.test(c));
  assert.deepEqual(unqualified, [], 'a clause still says only that the recorded cloud name is the spec\'s name');
});

test('criterion 4: the RequestOwnerFlowTest row describes the signed-in build and the signed-in batch', () => {
  const r = plain(row(now('docs/TEMPORAL-FEATURES.md'), 'RequestOwnerFlowTest'));
  hasRe(r, /signed-in build sends the cloud <name>-<8 hex> while the VM record and (the )?audit trail keep the asked-for name/, 'the RequestOwnerFlowTest row');
  hasRe(r, /signed-in batch records <name>-<8 hex> as a named item's cloud name and vm-<hash8> \(no second suffix\) for an unnamed item/, 'the RequestOwnerFlowTest row');
});

test('criterion 4: every other claim of the RequestOwnerFlowTest row is still there word for word', () => {
  const old = squash(row(before('docs/TEMPORAL-FEATURES.md'), 'RequestOwnerFlowTest'));
  const cur = squash(row(now('docs/TEMPORAL-FEATURES.md'), 'RequestOwnerFlowTest'));
  const i = old.indexOf(OLD_OWNER_CLOUD);
  assert.ok(i >= 0, 'the old row did not have the cloud-name clause (test assumption)');
  has(cur, old.slice(0, i).trim(), 'the RequestOwnerFlowTest row');
  has(cur, OLD_OWNER_CLOUD, 'the RequestOwnerFlowTest row');
});

// ------------------------------------------------------------------ 5. DEFINITIONS 'Cloud name' paragraph

const CLOUD = '**Cloud name.**';

test('criterion 5: the Cloud name paragraph says a signed-in catalog run\'s unnamed VM gets <definition>-<6 hex>-<first 8 hex of its spec hash>', () => {
  const p = plain(paragraph(now('docs/DEFINITIONS.md'), CLOUD));
  hasRe(p, /signed-in run's VM with no name input gets the per-user suffix too/, 'the Cloud name paragraph');
  hasRe(p, /<definition>-<6 hex characters>-<the first 8 hex characters of its spec hash>/, 'the Cloud name paragraph');
  hasRe(p, /With sign-in off its cloud name stays <definition>-<6 hex characters>/, 'the Cloud name paragraph');
});

test('criterion 5: the Cloud name paragraph keeps its other claims', () => {
  const p = plain(paragraph(now('docs/DEFINITIONS.md'), CLOUD));
  hasRe(p, /generated vm-<hash8> name is already unique per user, so it gets no suffix/, 'the Cloud name paragraph');
  for (const t of ['web-01-55214b87', 'at most 41 characters', 'cloud name is at most 50', 'VmIdentity.of',
    'ReconcileRequest.cloudName', 'POST /api/v2/interpret']) has(p, t, 'the Cloud name paragraph');
  // Every sentence of the old paragraph is still there word for word.
  const old = squash(paragraph(before('docs/DEFINITIONS.md'), CLOUD));
  const cur = squash(paragraph(now('docs/DEFINITIONS.md'), CLOUD));
  const sentences = old.split(/(?<=\.)\s+(?=[A-Z`*])/).filter((s) => s.length > 3);
  const missing = sentences.filter((s) => !cur.includes(s));
  assert.deepEqual(missing, [], 'sentences of the old Cloud name paragraph that are gone');
});

test('criterion 5: the catalog run really names an unnamed VM before VmIdentity.of runs (so the doc\'s claim holds)', () => {
  const src = noComments(at(NEWEST, 'backend/src/main/java/com/example/vmintent/catalog/CatalogActivitiesImpl.java') ?? '');
  assert.ok(src, 'CatalogActivitiesImpl.java is missing');
  const gen = src.search(/run\.get\("definition"\)\s*\+\s*"-"\s*\+\s*sha\(/);
  const of = src.search(/VmIdentity\.of\(\s*spec\s*,\s*owner\s*\)/);
  assert.ok(gen >= 0, 'CatalogActivitiesImpl no longer builds <definition>-<sha...>');
  assert.ok(of > gen, 'VmIdentity.of(spec, owner) is not called after the name is generated');
});

// ------------------------------------------------------------------ 6. Names exist

test('criterion 6: the named examples exist under backend/src', () => {
  const vmid = noComments(at(NEWEST, VMID_TEST) ?? '');
  const owner = noComments(at(NEWEST, OWNER_TEST) ?? '');
  assert.ok(vmid, `${VMID_TEST} is missing`);
  assert.ok(owner, `${OWNER_TEST} is missing`);
  assert.ok(methodBody(vmid, 'twoSignedInOwnersGetDifferentCloudNamesForTheSameNamedSpec'), 'VmIdentityTest.twoSignedInOwnersGetDifferentCloudNamesForTheSameNamedSpec');
  assert.ok(methodBody(owner, 'aSignedInBatchRecordsTheNamePlus8HexOfItsHashAsTheCloudName'), 'RequestOwnerFlowTest.aSignedInBatchRecordsTheNamePlus8HexOfItsHashAsTheCloudName');
  assert.ok(at(NEWEST, 'backend/src/main/java/com/example/vmintent/catalog/CatalogActivitiesImpl.java'), 'CatalogActivitiesImpl.java');
  // The doc's example value is what the unit test pins.
  assert.match(methodBody(vmid, 'ofGivesASignedInOwnersNamedSpecTheNamePlus8HexOfItsHash') ?? '', /"web-01-55214b87"/);
});

test('criterion 6: every class and test-method name added to a doc by this change exists under backend/src', () => {
  const files = git(['ls-tree', '-r', '--name-only', NEWEST, '--', 'backend/src']).split('\n').filter(Boolean);
  const classFiles = new Map(files.filter((f) => f.endsWith('.java')).map((f) => [f.split('/').pop().replace('.java', ''), f]));
  const allSrc = () => git(['grep', '-h', '-E', '(class|record|interface|enum) [A-Z]', NEWEST, '--', 'backend/src']);
  let declared;
  const classExists = (c) => classFiles.has(c) || (declared ??= allSrc()).match(new RegExp(`\\b(class|record|interface|enum) ${c}\\b`));
  // Lines this requirement's kept commits add to a doc.
  const added = COMMITS.flatMap((sha) => git(['diff', '--no-renames', `${sha}^`, sha, '--', 'README.md', 'docs'])
    .split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')));
  const tokens = new Set(added.flatMap((l) => [...l.matchAll(/`([^`]+)`/g)].map((m) => m[1]))
    .concat(added.flatMap((l) => [...l.matchAll(/\b([A-Z][a-z]+(?:[A-Z][a-z0-9]*)+)\b/g)].map((m) => m[1]))));
  const problems = [];
  for (const raw of tokens) {
    const t = raw.replace(/\.java$/, '').replace(/^.*\//, '').replace(/\(.*\)$/, '');
    if (/^[A-Z][A-Za-z0-9]+$/.test(t) && /[a-z][A-Z]/.test(t)) {
      if (!classExists(t)) problems.push(`class ${t}`);
    } else if (/^[a-z][A-Za-z0-9]{24,}$/.test(t)) {
      const hit = git(['grep', '-l', '-E', `void ${t}\\s*\\(`, NEWEST, '--', 'backend/src/test']).trim();
      if (!hit) problems.push(`test method ${t}`);
    } else if (/^[A-Z][A-Za-z0-9]+\.[a-z][A-Za-z0-9]*$/.test(t)) {
      const [c, m] = t.split('.');
      const f = classFiles.get(c);
      if (!f) { problems.push(`class ${c} (of ${t})`); continue; }
      if (!new RegExp(`\\b${m}\\b`).test(at(NEWEST, f) ?? '')) problems.push(t);
    }
  }
  assert.deepEqual(problems, [], 'names added to the docs that are not in backend/src');
  // The test methods each row names are in that row's class.
  const vmid = at(NEWEST, VMID_TEST); const owner = at(NEWEST, OWNER_TEST);
  const tf = now('docs/TEMPORAL-FEATURES.md');
  for (const [cell, src] of [['VmIdentityTest', vmid], ['RequestOwnerFlowTest', owner]]) {
    for (const m of row(tf, cell).matchAll(/`([a-z][A-Za-z0-9]{24,})`/g)) {
      assert.ok(methodBody(noComments(src), m[1]), `${cell}.${m[1]} does not exist`);
    }
  }
});

// ------------------------------------------------------------------ 7. Dates

test('criterion 7: README.md, TEMPORAL-FEATURES.md and DEFINITIONS.md have the title, a blank line and "Last updated 2026-11-20." on line 3', () => {
  for (const [rel, old] of Object.entries(DATED)) {
    const lines = now(rel).split('\n');
    assert.ok(lines[0].startsWith('# '), `${rel} line 1 is not the title`);
    assert.equal(lines[1], '', `${rel} line 2 is not blank`);
    assert.equal(lines[2], NEW_DATE, `${rel} line 3`);
    assert.equal(before(rel).split('\n')[2], old, `${rel} line 3 before ${ID}`);
  }
});

test('criterion 7: no kept AP-0051 commit changes the "Last updated" line of any other file', () => {
  const dated = new Set(Object.keys(DATED).map((p) => `vm-intent/${p}`));
  const bad = [];
  for (const sha of COMMITS) {
    for (const p of CHANGES.get(sha).filter((f) => !dated.has(f))) {
      const d = git(['diff', '--no-renames', `${sha}^`, sha, '--', `:(top)${p}`]).split('\n')
        .filter((l) => /^[+-](?![+-])/.test(l) && /Last updated/i.test(l));
      if (d.length) bad.push(`${sha.slice(0, 8)} ${p}: ${d.join(' / ')}`);
    }
  }
  assert.deepEqual(bad, []);
  // And every other doc's line 3 is the same across the AP-0051 commits.
  const docs = git(['ls-tree', '-r', '--name-only', BEFORE, '--', 'docs', 'README.md']).split('\n')
    .filter((f) => /\.md$/.test(f)).map((f) => f.replace(/^vm-intent\//, '')).filter((f) => !(f in DATED));
  for (const rel of docs) {
    const line3 = (t) => (t ?? '').split('\n')[2];
    assert.equal(line3(at(NEWEST, rel)), line3(at(BEFORE, rel)), `${rel} line 3 changed`);
  }
});

// ------------------------------------------------------------------ 8. Scope

test('criterion 8: no kept AP-0051 commit touches backend/, frontend/src/, tests/ (bar tests/acceptance), the OpenAPI files, SECURITY.md or the user guide', () => {
  const forbidden = (p) => ['vm-intent/backend/', 'vm-intent/frontend/src/'].some((d) => p.startsWith(d))
    || (p.startsWith('vm-intent/tests/') && !p.startsWith('vm-intent/tests/acceptance/'))
    || ['vm-intent/docs/openapi.json', 'vm-intent/docs/openapi.yaml', 'vm-intent/docs/SECURITY.md',
      'vm-intent/docs/USER-GUIDE.md', 'vm-intent/frontend/public/user-guide.html'].includes(p);
  const bad = COMMITS.flatMap((sha) => CHANGES.get(sha).filter(forbidden).map((p) => `${sha.slice(0, 8)} ${p}`));
  assert.deepEqual(bad, []);
});
