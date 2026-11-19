// AP-0048 acceptance, repository half (criteria 1-7): the daily docs pass of 2026-11-19. README's code map names
// spec/VmNames as the one VM-name rule and its test paragraph names VmNamesTest; DEFINITIONS' vm.create row and
// 'Cloud name' paragraph and API.md's VM-names bullet give the name rule and a catalog run's generated name
// (<definition>-<6 hex>); three docs get the new date; nothing else changes.
//
// "This requirement's kept commits" are the non-merge commits whose subject starts with "AP-0048:", leaving out the
// pipeline's own "acceptance tests" and "record the requirement" commits. Files are read with git show as they were
// at the newest kept commit that changed them (or, for files it didn't change, the newest kept commit), and "before"
// means the parent of the oldest AP-0048 commit, so later requirements can change these files freely. Only sources
// are read, never build outputs; the build gates run the unit tests.
//
//   node --test tests/acceptance/ap-0048/repo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = 'AP-0048';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const NEW_DATE = 'Last updated 2026-11-19.';
const DATED = ['README.md', 'docs/API.md', 'docs/DEFINITIONS.md'];
const UNDATED = ['docs/USER-GUIDE.md', 'docs/TEMPORAL-FEATURES.md', 'docs/SCALING.md', 'docs/VSPHERE.md', 'docs/AUDIT.md',
  'docs/ONE-WAY-LINK.md', 'docs/KUBERNETES.md', 'docs/AZURE.md', 'docs/SECURITY.md'];
const MAIN = 'backend/src/main/java/com/example/vmintent';
const TESTS = 'backend/src/test/java/com/example/vmintent';
const CATALOG = `${MAIN}/catalog/CatalogActivitiesImpl.java`;
const UNIT_TESTS = [`${TESTS}/spec/SpecValidatorTest.java`, `${TESTS}/spec/VmNamesTest.java`];

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
const CHANGED_FILES = [...new Set(COMMITS.flatMap((sha) => CHANGES.get(sha)))];

function at(sha, rel) {
  try { return git(['show', `${sha}:vm-intent/${rel}`]).replace(/\r\n/g, '\n'); } catch { return null; }
}
/** A file as it was at the newest kept AP-0048 commit that changed it (or the newest kept AP-0048 commit). */
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
const has = (text, needle, what) => assert.ok(squash(text).includes(needle), `${what} doesn't say: ${needle}\n--- it says:\n${squash(text)}`);
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
    else if (src.startsWith('/*', i)) { const j = src.indexOf('*/', i + 2); i = j + 2; out += ' '; }
    else { out += c; i++; }
  }
  return out;
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

test('criterion 1: the spec/ entry names VmNames as the one VM-name rule, with the rule, used by SpecValidator and the English extractor', () => {
  const e = specEntry(now('README.md'));
  hasRe(e, /\b(spec\/)?VmNames\b/, 'the spec/ entry');
  const tail = e.slice(e.search(/\bVmNames\b/));
  hasRe(tail, /one VM-name rule/i, 'the VmNames part of the spec/ entry');
  hasRe(tail, /lower-?case letters, digits,? and hyphens/i, 'the VmNames part of the spec/ entry');
  hasRe(tail, /2 to 41 characters/, 'the VmNames part of the spec/ entry');
  hasRe(tail, /\bSpecValidator\b/, 'the VmNames part of the spec/ entry');
  hasRe(tail, /English extractor|RuleBasedIntentExtractor/, 'the VmNames part of the spec/ entry');
});

test('criterion 1: the spec/ entry still says everything it said before (VmIdentity, the spec hash, VmIdentity.of and cloudName)', () => {
  const e = specEntry(now('README.md'));
  has(e, 'VmIdentity', 'the spec/ entry');
  has(e, 'the one place that computes a VM\'s spec hash', 'the spec/ entry');
  hasRe(e, /VmIdentity\.of\b[^;]*\bcloudName\b/, 'the spec/ entry');
  // Word for word: the old entry, bar trailing punctuation, is still part of the new one.
  const old = specEntry(before('README.md')).replace(/[.;,]$/, '');
  has(e, old, 'the spec/ entry');
});

// ------------------------------------------------------------------ 2. README test paragraph

test('criterion 2: the "Run the tests" paragraph says SpecValidatorTest checks the VM-name rule and names VmNamesTest', () => {
  const p = plain(paragraph(now('README.md'), 'Run the tests'));
  const s = p.slice(p.indexOf('SpecValidatorTest'));
  assert.ok(p.includes('SpecValidatorTest'), `the paragraph no longer names SpecValidatorTest:\n${p}`);
  // The SpecValidatorTest clause (up to the next test class) mentions the VM-name rule.
  const clause = s.slice(0, s.slice(1).search(/\b[A-Z]\w+Test\b/) + 1 || undefined);
  hasRe(clause, /spec limits/, 'the SpecValidatorTest clause');
  hasRe(clause, /VM-name rule|VM name rule/i, 'the SpecValidatorTest clause');
  hasRe(p, /\bVmNamesTest\b/, 'the "Run the tests" paragraph');
  // The rest of what the paragraph said before is still there.
  for (const t of ['GoldenPhrasingTest', 'PolicyDefaultsTest', 'LlmIntentExtractorTest', 'RequestOwnerTest', 'TEMPORAL-FEATURES']) {
    has(p, t, 'the "Run the tests" paragraph');
  }
});

test('criterion 2: SpecValidatorTest and VmNamesTest exist under spec/ with active @Test methods', () => {
  for (const rel of UNIT_TESTS) {
    const raw = at(NEWEST, rel);
    assert.ok(raw, `${rel} doesn't exist at ${NEWEST.slice(0, 8)}`);
    const src = noComments(raw);
    assert.match(src, /package com\.example\.vmintent\.spec;/, `${rel} isn't in package spec`);
    const cls = rel.split('/').pop().replace('.java', '');
    const [header] = src.split(new RegExp(`\\bclass\\s+${cls}\\b`));
    assert.ok(!/@Disabled\b/.test(header), `${cls} is @Disabled`);
    const active = [...src.matchAll(/((?:@\w+(?:\([^)]*\))?\s*)+)(?:public\s+|protected\s+)?void\s+\w+\s*\(/g)]
      .filter((m) => /@Test\b/.test(m[1]) && !/@Disabled\b/.test(m[1]));
    assert.ok(active.length > 0, `${cls} has no active @Test method`);
  }
  // VmNamesTest really exercises VmNames, and SpecValidatorTest checks names through SpecValidator.
  assert.match(noComments(at(NEWEST, UNIT_TESTS[1])), /VmNames\.\w+\(/);
  assert.match(noComments(at(NEWEST, UNIT_TESTS[0])), /SpecValidator\.problems\(/);
});

// ------------------------------------------------------------------ 3. DEFINITIONS vm.create row

const settingsCell = (r) => r.split('|')[2];

test('criterion 3: the vm.create row still lists the same inputs as before', () => {
  const inputs = (r) => [...settingsCell(r).matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]);
  const old = new Set(inputs(row(before('docs/DEFINITIONS.md'), 'vm.create')));
  const cur = settingsCell(row(now('docs/DEFINITIONS.md'), 'vm.create'));
  const missing = [...old].filter((i) => !cur.includes(`\`${i}\``));
  assert.deepEqual(missing, [], 'inputs no longer listed');
  // And the old settings list is still there as written.
  has(cur, squash(settingsCell(row(before('docs/DEFINITIONS.md'), 'vm.create'))), 'the vm.create settings cell');
  // The other cells are unchanged.
  const others = (r) => r.split('|').slice(3).map(squash);
  assert.deepEqual(others(row(now('docs/DEFINITIONS.md'), 'vm.create')), others(row(before('docs/DEFINITIONS.md'), 'vm.create')));
});

test('criterion 3: the vm.create row says the name is lower-cased, then must meet the VM-name rule', () => {
  const c = plain(settingsCell(row(now('docs/DEFINITIONS.md'), 'vm.create')));
  hasRe(c, /lower-?cased/i, 'the vm.create row');
  hasRe(c, /lower-?cased[^|]*(then )?must (then )?meet the VM-name rule/i, 'the vm.create row');
  hasRe(c, /lower-?case letters, digits,? and hyphens/i, 'the vm.create row');
  hasRe(c, /2 to 41 characters/, 'the vm.create row');
  hasRe(c, /not starting with a hyphen/, 'the vm.create row');
});

test('criterion 3: the vm.create row says a step with no name gets the definition name plus "-" and 6 hex characters from the run ID', () => {
  const c = plain(settingsCell(row(now('docs/DEFINITIONS.md'), 'vm.create')));
  hasRe(c, /(with )?no name[^|]*named after the definition/i, 'the vm.create row');
  hasRe(c, /definition plus - and 6 hex characters/i, 'the vm.create row');
  hasRe(c, /6 hex characters derived from the run ID/i, 'the vm.create row');
  hasRe(c, /<definition>-<6 hex/, 'the vm.create row');
});

test('criterion 3: CatalogActivitiesImpl lower-cases the name, validates it with SpecValidator.problems and builds <definition>-<sha(run id)[0..6]>', () => {
  const src = noComments(at(NEWEST, CATALOG) ?? '');
  assert.ok(src, `${CATALOG} is missing`);
  assert.match(src, /name\s*=\s*run\.get\("definition"\)\s*\+\s*"-"\s*\+\s*sha\(String\.valueOf\(run\.get\("id"\)\)\)\.substring\(0,\s*6\)/);
  assert.match(src, /new VmSpec\(\s*name\.toLowerCase\(\)/);
  assert.match(src, /SpecValidator\.problems\(\s*spec\s*\)/);
  // sha is a hex digest, so the 6 characters are hex.
  const sha = src.slice(src.search(/static\s+String\s+sha\s*\(/));
  assert.match(sha.slice(0, 600), /SHA-256|HexFormat|%02x|toHexString/i, 'sha(...) does not look like a hex digest');
});

// ------------------------------------------------------------------ 4. DEFINITIONS 'Cloud name' paragraph

const CLOUD = '**Cloud name.**';

/** Splits a paragraph at the parenthesis about the generated name: [before, inside, after]. */
function splitParen(p) {
  const i = p.indexOf('(the generated');
  assert.ok(i >= 0, 'no parenthesis');
  let depth = 0; let j = i;
  for (; j < p.length; j++) { if (p[j] === '(') depth++; else if (p[j] === ')' && --depth === 0) break; }
  return [p.slice(0, i), p.slice(i + 1, j), p.slice(j + 1)];
}

test('criterion 4: the Cloud name parenthesis keeps the generated vm- + 8 hex text and adds the catalog run\'s <definition>-<6 hex characters>', () => {
  const p = squash(paragraph(now('docs/DEFINITIONS.md'), CLOUD));
  const [, inside] = splitParen(p);
  has(inside, 'the generated `vm-` + 8 hex characters when none was asked for', 'the Cloud name parenthesis');
  const q = plain(inside);
  hasRe(q, /catalog run's VM with no name input/i, 'the Cloud name parenthesis');
  hasRe(q, /<definition>-<6 hex characters>/, 'the Cloud name parenthesis');
  hasRe(q, /instead of vm- \+ 8 hex characters/, 'the Cloud name parenthesis');
});

test('criterion 4: the rest of the Cloud name paragraph is unchanged', () => {
  const old = squash(paragraph(before('docs/DEFINITIONS.md'), CLOUD));
  const cur = squash(paragraph(now('docs/DEFINITIONS.md'), CLOUD));
  const [oBefore, , oAfter] = splitParen(old);
  const [cBefore, , cAfter] = splitParen(cur);
  assert.equal(squash(cBefore), squash(oBefore), 'the text before the parenthesis changed');
  assert.equal(squash(cAfter), squash(oAfter), 'the text after the parenthesis changed');
  for (const t of ['VmIdentity.of', 'ReconcileRequest.cloudName', 'POST /api/v2/interpret', 'part 2b']) has(cur, t, 'the Cloud name paragraph');
});

// ------------------------------------------------------------------ 5. API.md VM-names bullet

function nameBullet(api) {
  const i = api.indexOf('2 to 41');
  assert.ok(i >= 0, 'API.md doesn\'t say 2 to 41');
  const start = api.lastIndexOf('\n- ', i); const end = api.indexOf('\n- ', i);
  return api.slice(start + 1, end < 0 ? undefined : end);
}

test('criterion 5: the VM-names bullet says a catalog run\'s vm.create step with no name gets <definition>-<6 hex> rather than vm- + 8 hex', () => {
  const b = plain(nameBullet(now('docs/API.md')));
  hasRe(b, /catalog run[^.]*vm\.create step with no name/i, 'the VM-names bullet');
  hasRe(b, /<definition>-/, 'the VM-names bullet');
  hasRe(b, /<definition>-[^.]*6 hex characters/, 'the VM-names bullet');
  hasRe(b, /vm- plus the first 8 hex characters of the specHash/, 'the VM-names bullet');
  hasRe(b, /except in a catalog run|rather than|instead/, 'the VM-names bullet');
});

test('criterion 5: the VM-names bullet keeps every phrase it had before', () => {
  const b = nameBullet(now('docs/API.md'));
  const p = plain(b);
  for (const t of ['lower-case letters, digits and hyphens', '2 to 41 characters', 'not starting with a hyphen', 'rejected',
    'never lower-cased', 'POST /api/v1/vms', 'question', 'A missing or blank name is allowed: a missing one is generated',
    'Catalog runs lower-case their name input first']) has(p, t, 'the VM-names bullet');
  hasRe(p, /batch item goes into rejected/, 'the VM-names bullet');
  hasRe(p, /POST \/api\/v1\/vms returns 400/, 'the VM-names bullet');
  // Sentences of the old bullet that don't touch the generated name are still there word for word.
  const old = squash(nameBullet(before('docs/API.md')));
  const sentences = old.replace(/^- /, '').split(/(?<=\.)\s+(?=[A-Z])/)
    .filter((s) => !/generated as `vm-`|Catalog runs lower-case|then apply the same rule|already exist are not/.test(s));
  for (const s of sentences) has(b, s, 'the VM-names bullet');
});

function opsTable(api) {
  const lines = api.split('\n');
  const i = lines.findIndex((l) => l.startsWith('| Operation ID |'));
  assert.ok(i >= 0, 'API.md has no Operations table');
  let j = i + 2;
  while (j < lines.length && lines[j].startsWith('|')) j++;
  return lines.slice(i + 2, j);
}

test('criterion 5: the Operations table and every operation and check count in API.md are unchanged', () => {
  const a = before('docs/API.md'); const b = now('docs/API.md');
  assert.deepEqual(opsTable(b), opsTable(a), 'the Operations table changed');
  const counts = (t) => [...squash(t).matchAll(/\b(\d+) (operations|checks)\b/g)].map((m) => m[0]);
  assert.ok(counts(a).length > 0, 'API.md gives no operation or check counts');
  assert.deepEqual(counts(b), counts(a));
});

// ------------------------------------------------------------------ 6. Dates

test('criterion 6: README.md, API.md and DEFINITIONS.md have the title, a blank line and "Last updated 2026-11-19." on line 3', () => {
  for (const rel of DATED) {
    const lines = now(rel).split('\n');
    assert.ok(lines[0].startsWith('# '), `${rel} line 1 is not the title`);
    assert.equal(lines[1], '', `${rel} line 2 is not blank`);
    assert.equal(lines[2], NEW_DATE, `${rel} line 3`);
    assert.equal(before(rel).split('\n')[2], 'Last updated 2026-11-18.', `${rel} line 3 before ${ID}`);
  }
});

test('criterion 6: the nine other docs keep their line 3 across the AP-0048 commits', () => {
  for (const rel of UNDATED) {
    const line3 = (t) => (t ?? '').split('\n')[2];
    assert.equal(line3(at(NEWEST, rel)), line3(at(BEFORE, rel)), `${rel} line 3 changed`);
  }
});

// ------------------------------------------------------------------ 7. Scope

test('criterion 7: the kept AP-0048 commits change only README.md, docs/API.md and docs/DEFINITIONS.md', () => {
  const allowed = new Set(DATED.map((p) => `vm-intent/${p}`));
  assert.deepEqual(CHANGED_FILES.filter((p) => !allowed.has(p)), [], 'files outside the allowed list');
});

test('criterion 7: no kept AP-0048 commit touches backend/, frontend/, tests/, the OpenAPI files, AZURE.md or SECURITY.md', () => {
  const forbidden = (p) => ['vm-intent/backend/', 'vm-intent/frontend/', 'vm-intent/tests/'].some((d) => p.startsWith(d))
    || ['vm-intent/docs/openapi.json', 'vm-intent/docs/openapi.yaml', 'vm-intent/docs/AZURE.md', 'vm-intent/docs/SECURITY.md'].includes(p);
  const bad = COMMITS.flatMap((sha) => CHANGES.get(sha).filter(forbidden).map((p) => `${sha.slice(0, 8)} ${p}`));
  assert.deepEqual(bad, []);
});
