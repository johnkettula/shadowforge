// AP-0046 acceptance, repository half (criteria 1-10): the daily docs pass of 2026-11-18. TEMPORAL-FEATURES says
// callers copy cloudName from VmIdentity.of and lists VmControllerTest's getVm tests; README's code map names
// VmIdentity.of and the cloud name; DEFINITIONS gives blueprint.deploy's ranges; USER-GUIDE (markdown and HTML) and
// API.md give the spec, resize and snapshot limits; five docs get the new date; nothing else changes.
//
// "This requirement's commits" are the non-merge commits whose subject starts with "AP-0046:", leaving out the
// pipeline's own "acceptance tests" and "record the requirement" commits. Files are read with git show as they were
// at the newest such commit that changed them (or, for files it didn't change, the newest such commit), and "before"
// means the parent of the oldest AP-0046 commit, so later requirements can change these files freely. Only sources
// are read, never build outputs; the build gates run the unit tests.
//
//   node --test tests/acceptance/ap-0046/repo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = 'AP-0046';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const NEW_DATE = 'Last updated 2026-11-18.';
const DATED = ['README.md', 'docs/API.md', 'docs/DEFINITIONS.md', 'docs/TEMPORAL-FEATURES.md', 'docs/USER-GUIDE.md'];
const ALLOWED = [...DATED, 'frontend/public/user-guide.html'];
const MAIN = 'backend/src/main/java/com/example/vmintent';
const SPEC_VALIDATOR = `${MAIN}/spec/SpecValidator.java`;
const LIFECYCLE = `${MAIN}/workflow/VmLifecycleWorkflowImpl.java`;
const CATALOG = `${MAIN}/workflow/CatalogRunWorkflowImpl.java`;
const VM_CONTROLLER_TEST = 'backend/src/test/java/com/example/vmintent/api/VmControllerTest.java';

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
/** A file as it was at the newest AP-0046 commit that changed it (or the newest AP-0046 commit). */
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
const has = (text, needle, what) => assert.ok(squash(text).includes(needle), `${what} doesn't say: ${needle}\n--- it says:\n${squash(text)}`);
const hasRe = (text, re, what) => assert.match(squash(text), re, `${what} doesn't match ${re}\n--- it says:\n${squash(text)}`);
/** A "## " (or deeper) section, from its heading to the next heading of the same or a higher level. */
function section(text, heading, level = 2) {
  const lines = text.split('\n');
  const hashes = '#'.repeat(level);
  const i = lines.findIndex((l) => l.startsWith(`${hashes} ${heading}`));
  assert.ok(i >= 0, `no section "${hashes} ${heading}"`);
  let j = i + 1;
  while (j < lines.length && !new RegExp(`^#{1,${level}} `).test(lines[j])) j++;
  return lines.slice(i, j).join('\n');
}
/** The table row whose first cell is `cell` (optionally in backticks). */
function row(text, cell) {
  const r = text.split('\n').find((l) => l.startsWith(`| ${cell} |`) || l.startsWith(`| \`${cell}\` |`));
  assert.ok(r, `no table row for ${cell}`);
  return r;
}
const htmlText = (h) => squash(h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&rsquo;/g, '\''));

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

// ------------------------------------------------------------------ 1. TEMPORAL-FEATURES section 3

test('criterion 1: section 3 no longer says every caller passes null', () => {
  const s = squash(section(now('docs/TEMPORAL-FEATURES.md'), '3. Rollback (saga)'));
  assert.ok(!s.includes('Today every caller passes null, so the cloud name is the same as the name asked for.'),
    'section 3 still says every caller passes null');
  assert.ok(!/every caller passes null/i.test(s), 'section 3 still says every caller passes null');
});

test('criterion 1: section 3 says every caller copies the cloud name VmIdentity.of gave, and that only old histories carry null', () => {
  const s = squash(section(now('docs/TEMPORAL-FEATURES.md'), '3. Rollback (saga)'));
  has(s, 'VmIdentity.of', 'section 3');
  hasRe(s, /\bcop(y|ies)\b/, 'section 3');
  const sentence = s.split(/(?<=\.)\s+(?=[A-Z])/).find((x) => x.includes('VmIdentity.of'));
  assert.ok(sentence, 'no sentence names VmIdentity.of');
  const ctx = s.slice(s.indexOf(sentence), s.indexOf(sentence) + sentence.length + 400);
  hasRe(ctx, /[Ee]very caller cop(y|ies)/, 'the VmIdentity.of sentence');
  for (const t of ['Interpretation', 'BatchItem', 'PreparedVm']) has(ctx, t, 'the VmIdentity.of sentence');
  hasRe(ctx, /spec'?s name/, 'the VmIdentity.of sentence');
  hasRe(ctx, /generated `?vm-/, 'the VmIdentity.of sentence');
  hasRe(ctx, /[Oo]nly histories recorded before/, 'section 3');
  hasRe(ctx, /null `?cloudName`?/, 'section 3');
  hasRe(ctx, /treats as `?spec\.name`?/, 'section 3');
});

// ------------------------------------------------------------------ 2. TEMPORAL-FEATURES section 12, VmControllerTest

test('criterion 2: the VmControllerTest row keeps the day-2 cases and adds getVm with 200, 400 and 404', () => {
  const r = squash(row(section(now('docs/TEMPORAL-FEATURES.md'), '12. Time-skipping tests'), 'VmControllerTest'));
  for (const t of ['Day-2 changes', '404 for a spec hash that matches no VM', '409 for a VM that exists but can\'t be changed',
    '400 for a malformed hash']) has(r, t, 'the VmControllerTest row');
  assert.ok(r.includes('GET /api/v2/vms/{specHash}') || r.includes('getVm'), 'the row names neither GET /api/v2/vms/{specHash} nor getVm');
  hasRe(r, /200 and the record for a known VM in any state/, 'the VmControllerTest row');
  const tail = r.slice(r.search(/getVm|GET \/api\/v2\/vms\/\{specHash\}/));
  has(tail, '400 for a malformed hash', 'the getVm part of the row');
  hasRe(tail, /404 for an unknown/, 'the getVm part of the row');
});

test('criterion 2: the old VmControllerTest row text is kept word for word', () => {
  const old = squash(row(section(before('docs/TEMPORAL-FEATURES.md'), '12. Time-skipping tests'), 'VmControllerTest'))
    .replace(/^\| `?VmControllerTest`? \|\s*/, '').replace(/\s*\|$/, '').replace(/\.$/, '');
  const r = squash(row(section(now('docs/TEMPORAL-FEATURES.md'), '12. Time-skipping tests'), 'VmControllerTest'));
  has(r, old, 'the VmControllerTest row');
});

test('criterion 2: VmControllerTest has active @Test methods for getVm 200 (any state), 400 and 404', () => {
  const src = noComments(at(NEWEST, VM_CONTROLLER_TEST) ?? '');
  assert.ok(src, `${VM_CONTROLLER_TEST} is missing`);
  const header = src.split(/\bclass\s+VmControllerTest\b/)[0];
  assert.ok(!/@Disabled\b/.test(header), 'VmControllerTest is @Disabled');
  const methods = [];
  for (const m of src.matchAll(/((?:@\w+(?:\([^)]*\))?\s*)+)void\s+(\w+)\s*\([^)]*\)[^{]*\{/g)) {
    // Body: from the brace to its match.
    let depth = 0; let i = m.index + m[0].length - 1; const start = i;
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
    methods.push({ ann: m[1], name: m[2], body: src.slice(start, i + 1) });
  }
  const active = methods.filter((m) => /@Test\b/.test(m.ann) && !/@Disabled\b/.test(m.ann));
  const getVm = active.filter((m) => /controller\.vm\(/.test(m.body));
  const ok = getVm.find((m) => /RUNNING/.test(m.body) && /DELETED/.test(m.body) && /specHash\(\)/.test(m.body));
  assert.ok(ok, `no active @Test calls controller.vm and checks a record in RUNNING and DELETED state (getVm tests: ${getVm.map((m) => m.name).join(', ')})`);
  assert.ok(getVm.find((m) => /BAD_REQUEST/.test(m.body)), 'no active @Test checks getVm answers 400 (BAD_REQUEST)');
  assert.ok(getVm.find((m) => /NOT_FOUND/.test(m.body)), 'no active @Test checks getVm answers 404 (NOT_FOUND)');
});

// ------------------------------------------------------------------ 3. README code map

function specEntry(readme) {
  const lines = readme.split('\n');
  const i = lines.findIndex((l) => /^\s+spec\/\s/.test(l));
  assert.ok(i >= 0, 'README has no spec/ entry in the code map');
  let j = i + 1;
  while (j < lines.length && /^\s{6,}\S/.test(lines[j]) && !/^\s+\w+\/\s/.test(lines[j])) j++;
  return squash(lines.slice(i, j).join(' '));
}

test('criterion 3: README code map spec/ entry still says VmIdentity is the one place that computes the spec hash', () => {
  has(specEntry(now('README.md')), 'VmIdentity: the one place that computes a VM\'s spec hash', 'the spec/ entry');
});

test('criterion 3: the spec/ entry names VmIdentity.of, the spec hash with the cloud name (cloudName), today the spec\'s name', () => {
  const e = specEntry(now('README.md'));
  has(e, 'VmIdentity.of', 'the spec/ entry');
  hasRe(e, /VmIdentity\.of gives the spec hash together with the VM's cloud name \(cloudName\)/, 'the spec/ entry');
  hasRe(e, /today is the spec's name/, 'the spec/ entry');
});

// ------------------------------------------------------------------ 4. DEFINITIONS blueprint.deploy

test('criterion 4: DEFINITIONS blueprint.deploy row gives timeoutMinutes 5-1440 default 90 and everySeconds 10-600 default 30', () => {
  const r = squash(row(now('docs/DEFINITIONS.md'), 'blueprint.deploy'));
  hasRe(r, /`timeoutMinutes` \(5-1440, default 90\)/, 'the blueprint.deploy row');
  hasRe(r, /`everySeconds` \(10-600, default 30\)/, 'the blueprint.deploy row');
});

test('criterion 4: those ranges match CatalogRunWorkflowImpl\'s clamp calls and VSPHERE.md\'s example', () => {
  const src = noComments(at(NEWEST, CATALOG) ?? '');
  const i = src.search(/int\s+\w+\s*=\s*clamp\(with\.get\("everySeconds"\),\s*10,/);
  assert.ok(i >= 0, 'no blueprint.deploy everySeconds clamp in CatalogRunWorkflowImpl');
  const block = src.slice(i, i + 400);
  assert.match(block, /clamp\(with\.get\("everySeconds"\),\s*10,\s*600,\s*30\)/);
  assert.match(block, /clamp\(with\.get\("timeoutMinutes"\),\s*5,\s*1440,\s*90\)/);
  // The clamp block belongs to the blueprint deploy method.
  const method = src.slice(src.lastIndexOf('private', i), i);
  assert.match(method, /[Bb]lueprint/, 'the 10-600 / 5-1440 clamp is not in the blueprint method');
  const vs = now('docs/VSPHERE.md');
  assert.match(vs, /timeoutMinutes: 90\s+#.*5-1440, default 90/);
  assert.match(vs, /everySeconds: 30\s+#.*10-600/);
});

// ------------------------------------------------------------------ 5. USER-GUIDE limits

const LIMITS = [
  [/vCPU[^|]*\|\s*1-64\b/, 'vCPU 1-64'],
  [/Memory[^|]*\|\s*1-512 GiB/, 'memory 1-512 GiB'],
  [/Disk[^|]*\|\s*10-4096 GiB, and at least 64 GiB for Windows/, 'disk 10-4096 GiB, at least 64 for Windows'],
  [/Lifetime[^|]*\|\s*at most 365 days/, 'lifetime at most 365 days'],
  [/regions[^|]*\|\s*us-east, us-west, us-central,? (and )?eu-west/, 'cloud regions'],
  [/datacenters[^|]*\|\s*dc1,? (and )?dc2/, 'vSphere datacenters'],
  [/Operating systems[^|]*\|\s*ubuntu, rhel, windows, debian,? (and )?rocky/, 'operating systems'],
];

test('criterion 5: USER-GUIDE "What to say" gives every spec limit and says a request outside them is refused with the reason', () => {
  const s = squash(section(now('docs/USER-GUIDE.md'), 'What to say', 3));
  for (const [re, what] of LIMITS) assert.match(s, re, `"What to say" doesn't give ${what}`);
  hasRe(s, /outside (them|these limits) is refused,? with the reason/, '"What to say"');
});

test('criterion 5: the limits match SpecValidator.java', () => {
  const src = noComments(at(NEWEST, SPEC_VALIDATOR) ?? '');
  assert.match(src, /s\.vcpu\(\) < 1 \|\| s\.vcpu\(\) > 64/);
  assert.match(src, /s\.memoryGiB\(\) < 1 \|\| s\.memoryGiB\(\) > 512/);
  assert.match(src, /s\.diskGiB\(\) < 10 \|\| s\.diskGiB\(\) > 4096/);
  assert.match(src, /"windows"\.equals\(s\.os\(\)\) && s\.diskGiB\(\) < 64/);
  assert.match(src, /s\.ttlDays\(\) > 365/);
  const set = (name) => {
    const m = src.match(new RegExp(`${name}\\s*=\\s*Set\\.of\\(([^)]*)\\)`));
    assert.ok(m, `no ${name} in SpecValidator`);
    return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
  };
  assert.deepEqual(set('CLOUD_REGIONS'), ['eu-west', 'us-central', 'us-east', 'us-west']);
  assert.deepEqual(set('DATACENTERS'), ['dc1', 'dc2']);
  assert.deepEqual(set('OS'), ['debian', 'rhel', 'rocky', 'ubuntu', 'windows']);
});

// ------------------------------------------------------------------ 6. USER-GUIDE day-2 table

test('criterion 6: the Resize row says vCPU 1-64 and memory 1-512 GiB', () => {
  const r = squash(row(section(now('docs/USER-GUIDE.md'), 'Looking after a VM'), 'Resize'));
  hasRe(r, /vCPU \(?1-64\)?/, 'the Resize row');
  hasRe(r, /memory \(?1-512 GiB\)?/, 'the Resize row');
});

test('criterion 6: the Take snapshot row gives the label rule, 40 characters and at most 20 snapshots', () => {
  const r = squash(row(section(now('docs/USER-GUIDE.md'), 'Looking after a VM'), 'Take snapshot'));
  hasRe(r, /lowercase letters, digits and dashes, up to 40 characters/, 'the Take snapshot row');
  hasRe(r, /A VM keeps at most 20 snapshots/, 'the Take snapshot row');
});

test('criteria 6-7: the numbers match VmLifecycleWorkflowImpl', () => {
  const src = noComments(at(NEWEST, LIFECYCLE) ?? '');
  assert.match(src, /MAX_SNAPSHOTS\s*=\s*20;/);
  assert.match(src, /MAX_VCPU\s*=\s*64;/);
  assert.match(src, /MAX_MEMORY_GIB\s*=\s*512;/);
  assert.match(src, /newVcpu < 1 \|\| newVcpu > MAX_VCPU/);
  assert.match(src, /newMemoryGiB < 1 \|\| newMemoryGiB > MAX_MEMORY_GIB/);
  // Label: a lowercase letter or digit, then up to 39 more of lowercase, digit or dash = up to 40 characters.
  assert.match(src, /label\.matches\("\[a-z0-9\]\[a-z0-9-\]\{0,39\}"\)/);
});

// ------------------------------------------------------------------ 7. API.md

function opsTable(api) {
  const lines = api.split('\n');
  const i = lines.findIndex((l) => l.startsWith('| Operation ID |'));
  assert.ok(i >= 0, 'API.md has no Operations table');
  let j = i + 2;
  while (j < lines.length && lines[j].startsWith('|')) j++;
  return lines.slice(i + 2, j);
}

test('criterion 7: API.md resizeVm row adds 1-64 vCPU and 1-512 GiB', () => {
  const r = squash(row(now('docs/API.md'), 'resizeVm'));
  has(r, '`{"vcpu": 4, "memoryGiB": 16}`', 'the resizeVm row');
  hasRe(r, /vCPU 1-64/, 'the resizeVm row');
  hasRe(r, /memory 1-512 GiB/i, 'the resizeVm row');
});

test('criterion 7: API.md snapshotVm row adds the label rule and 20 snapshots per VM', () => {
  const r = squash(row(now('docs/API.md'), 'snapshotVm'));
  has(r, '`{"label": "before-upgrade"}`', 'the snapshotVm row');
  hasRe(r, /lowercase letters, digits and dashes, up to 40 characters/, 'the snapshotVm row');
  hasRe(r, /20 snapshots per VM/, 'the snapshotVm row');
});

test('criterion 7: the Operations table has 43 rows, every operation count says 43, and the "61 checks" sentence is unchanged', () => {
  const api = now('docs/API.md');
  assert.equal(opsTable(api).length, 43, 'Operations table rows');
  const counts = [...api.matchAll(/\b(\d+) operations\b/g)].map((m) => m[1]);
  assert.ok(counts.length > 0, 'API.md gives no operation count');
  for (const c of counts) assert.equal(c, '43', `an operation count says ${c}`);
  const sentence = (t) => { const m = squash(t).match(/It runs 61 checks:[^.]*\./); assert.ok(m, 'no "It runs 61 checks" sentence'); return m[0]; };
  assert.equal(sentence(api), sentence(before('docs/API.md')));
});

test('criterion 7: no other Operations row changed', () => {
  const a = opsTable(before('docs/API.md'));
  const b = opsTable(now('docs/API.md'));
  const diffs = b.filter((l, i) => l !== a[i] && !/^\| `(resizeVm|snapshotVm)` \|/.test(l));
  assert.deepEqual(diffs, []);
});

// ------------------------------------------------------------------ 8. user-guide.html

test('criterion 8: user-guide.html has the limits, the 40-character and 20-snapshot text and the new date', () => {
  const html = now('frontend/public/user-guide.html');
  assert.match(html, /<p class="updated">Last updated 2026-11-18\.<\/p>/);
  const t = htmlText(html);
  for (const s of ['1-64', '1-512 GiB', '10-4096 GiB, and at least 64 GiB for Windows', 'at most 365 days',
    'us-east, us-west, us-central, eu-west', 'dc1, dc2', 'ubuntu, rhel, windows, debian, rocky',
    'A request outside them is refused, with the reason',
    'Change vCPU (1-64) and memory (1-512 GiB)',
    'lowercase letters, digits and dashes, up to 40 characters', 'A VM keeps at most 20 snapshots']) {
    assert.ok(t.includes(s), `user-guide.html doesn't say: ${s}`);
  }
});

test('criterion 8: user-guide.html carries the same limits table and day-2 rows as USER-GUIDE.md', () => {
  const md = now('docs/USER-GUIDE.md');
  const t = htmlText(now('frontend/public/user-guide.html'));
  const plain = (s) => squash(s.replace(/\*\*/g, '').replace(/`/g, '').replace(/\*/g, ''));
  const what = section(md, 'What to say', 3);
  const limitsPara = what.split(/\n\s*\n/).find((p) => p.includes('Limits.'));
  assert.ok(limitsPara, 'USER-GUIDE.md has no "Limits." paragraph');
  const lines = limitsPara.split('\n');
  const tableStart = what.indexOf(limitsPara) + limitsPara.length;
  const rows = what.slice(tableStart).split('\n').filter((l) => /^\| /.test(l) && !/^\| (---|Detail)/.test(l));
  for (const l of [lines.join(' '), ...rows.flatMap((r) => r.split('|').slice(1, -1))]) {
    const p = plain(l);
    if (p) assert.ok(t.includes(p), `user-guide.html lacks: ${p}`);
  }
  const day2 = section(md, 'Looking after a VM');
  for (const c of ['Resize', 'Take snapshot']) {
    const cellText = plain(row(day2, c).split('|')[2]);
    assert.ok(t.includes(cellText), `user-guide.html lacks the ${c} text: ${cellText}`);
  }
});

// ------------------------------------------------------------------ 9. Dates

test('criterion 9: line 3 of the five docs is "Last updated 2026-11-18." under the title and a blank line', () => {
  for (const rel of DATED) {
    const lines = now(rel).split('\n');
    assert.ok(lines[0].startsWith('# '), `${rel} line 1 is not the title`);
    assert.equal(lines[1], '', `${rel} line 2 is not blank`);
    assert.equal(lines[2], NEW_DATE, `${rel} line 3`);
  }
});

test('criterion 9: no other doc the AP-0046 commits change has its "Last updated" line changed', () => {
  const others = CHANGED_FILES.filter((p) => /\.(md|html)$/.test(p))
    .map((p) => p.replace(/^vm-intent\//, '')).filter((p) => !DATED.includes(p) && p !== 'frontend/public/user-guide.html');
  for (const rel of others) {
    const pick = (t) => (t ?? '').split('\n').filter((l) => /Last updated/.test(l)).join('\n');
    assert.equal(pick(now(rel)), pick(at(BEFORE, rel)), `${rel}'s "Last updated" line changed`);
  }
});

// ------------------------------------------------------------------ 10. Scope

test('criterion 10: the AP-0046 commits change only README.md, the five docs and user-guide.html', () => {
  const allowed = new Set(ALLOWED.map((p) => `vm-intent/${p}`));
  const extra = CHANGED_FILES.filter((p) => !allowed.has(p));
  assert.deepEqual(extra, [], 'files outside the allowed list');
});

test('criterion 10: no AP-0046 commit touches backend, frontend/src, tests (bar acceptance), OpenAPI files, AZURE.md or SECURITY.md', () => {
  const forbidden = (p) => p.startsWith('vm-intent/backend/') || p.startsWith('vm-intent/frontend/src/')
    || (p.startsWith('vm-intent/tests/') && !p.startsWith('vm-intent/tests/acceptance/'))
    || ['vm-intent/docs/openapi.json', 'vm-intent/docs/openapi.yaml', 'vm-intent/docs/AZURE.md',
      'vm-intent/docs/SECURITY.md'].includes(p);
  const bad = COMMITS.flatMap((sha) => CHANGES.get(sha).filter(forbidden).map((p) => `${sha.slice(0, 8)} ${p}`));
  assert.deepEqual(bad, []);
});
