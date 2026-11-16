// AP-0041 acceptance, repository half (criteria 1-12): the daily docs pass of 2026-11-14. API.md and DEFINITIONS.md
// stop naming the non-existent GET /api/v2/vms/{specHash}; TEMPORAL-FEATURES' VmIdentityTest, RequestOwnerFlowTest
// and CatalogRunWorkflowTest rows and its replay sentence describe per-user identity; SCALING, VSPHERE and the user
// guide (markdown and HTML) say duplicates are per user; six docs get the new date; nothing else changes.
//
// Files are read as they were at the newest AP-0041 commit that changed them (git show), and "before" means the
// parent of the oldest AP-0041 commit. The "must not change" checks look only at AP-0041 commits, so later
// requirements can change these files freely. Only sources are read, never build outputs.
//
//   node --test tests/acceptance/ap-0041/repo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const NEW_DATE = 'Last updated 2026-11-14.';
const DATED = ['docs/API.md', 'docs/DEFINITIONS.md', 'docs/TEMPORAL-FEATURES.md', 'docs/SCALING.md',
  'docs/VSPHERE.md', 'docs/USER-GUIDE.md'];
const KEPT_DATES = { 'README.md': '2026-11-13', 'docs/AUDIT.md': '2026-11-13', 'docs/ONE-WAY-LINK.md': '2026-11-13',
  'docs/KUBERNETES.md': '2026-11-11', 'docs/SECURITY.md': '2026-11-07' };
const TEST_SRC = 'backend/src/test/java/com/example/vmintent';
const VM_IDENTITY_TEST = `${TEST_SRC}/spec/VmIdentityTest.java`;
const OWNER_FLOW_TEST = `${TEST_SRC}/api/RequestOwnerFlowTest.java`;
const CATALOG_TEST = `${TEST_SRC}/workflow/CatalogRunWorkflowTest.java`;

const git = (args) => execFileSync('git', args,
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

// Oldest first.
const COMMITS = git(['log', '--reverse', '--format=%H', '--grep', '^AP-0041:']).split('\n').filter(Boolean);
const FIRST = COMMITS[0];
const BEFORE = FIRST ? git(['rev-parse', `${FIRST}^`]).trim() : null;
const changed = (sha) => git(['diff', '--name-only', '--no-renames', `${sha}^`, sha]).split('\n').filter(Boolean);
const CHANGES = new Map(COMMITS.map((sha) => [sha, changed(sha)]));
const touching = (prefix) => COMMITS.filter((sha) => CHANGES.get(sha).some((p) => p.startsWith(prefix)));
const DOC_COMMITS = touching('vm-intent/docs/');
const LAST = DOC_COMMITS[DOC_COMMITS.length - 1];

function at(sha, rel) {
  try { return git(['show', `${sha}:vm-intent/${rel}`]).replace(/\r\n/g, '\n'); } catch { return null; }
}
/** A file as it was at the newest AP-0041 commit that changed it (or, failing that, the newest that changed docs). */
function now(rel) {
  assert.ok(LAST, 'no AP-0041 commit changes vm-intent/docs/');
  const own = touching(`vm-intent/${rel}`);
  const sha = own.length ? own[own.length - 1] : LAST;
  const t = at(sha, rel);
  assert.ok(t !== null, `${rel} doesn't exist at ${sha.slice(0, 8)}`);
  return t;
}
function before(rel) {
  assert.ok(BEFORE, 'no AP-0041 commit');
  const t = at(BEFORE, rel);
  assert.ok(t !== null, `${rel} doesn't exist before AP-0041`);
  return t;
}
const squash = (s) => s.replace(/\s+/g, ' ').trim();
const has = (text, needle, what) => assert.ok(squash(text).includes(needle), `${what} doesn't say: ${needle}\n--- it says:\n${squash(text)}`);
const lacks = (text, needle, what) => assert.ok(!squash(text).includes(needle), `${what} still says: ${needle}`);

/** The markdown bullet (a line starting "- " plus its indented continuation lines) whose first line contains `start`. */
function bullet(text, start) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => /^\s*- /.test(l) && l.includes(start));
  assert.ok(i >= 0, `no bullet starting with "${start}"`);
  let j = i + 1;
  while (j < lines.length && lines[j].trim() !== '' && !/^\s*- /.test(lines[j]) && /^\s/.test(lines[j])) j++;
  return lines.slice(i, j).join('\n');
}
/** The blank-line-separated paragraph containing `needle`. */
function paragraph(text, needle) {
  const p = text.split(/\n\s*\n/).find((b) => squash(b).includes(needle));
  assert.ok(p, `no paragraph containing "${needle}"`);
  return p;
}
/** The table row whose first cell starts with `cell`. */
function row(text, cell) {
  const r = text.split('\n').find((l) => l.startsWith(`| ${cell} |`));
  assert.ok(r, `no table row for ${cell}`);
  return r;
}
/** A "## " section, from its heading to the next "## " heading. */
function section(text, heading) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.startsWith(`## ${heading}`));
  assert.ok(i >= 0, `no section "## ${heading}"`);
  let j = i + 1;
  while (j < lines.length && !lines[j].startsWith('## ')) j++;
  return lines.slice(i, j).join('\n');
}
/** Text with the first sentence that starts with `start` and ends with `end` cut out (whitespace squashed). */
function without(text, start, end) {
  const s = squash(text);
  const i = s.indexOf(start);
  assert.ok(i >= 0, `no sentence starting "${start}" in:\n${s}`);
  const j = s.indexOf(end, i);
  assert.ok(j >= 0, `the sentence starting "${start}" doesn't end with "${end}"`);
  return squash(s.slice(0, i) + s.slice(j + end.length));
}
/** @Test method names in a Java test source. */
function testMethods(src) {
  return [...src.matchAll(/@Test\b[\s\S]{0,300}?\bvoid\s+(\w+)\s*\(/g)].map((m) => m[1]);
}
function assertTestMethods(rel, names) {
  const methods = testMethods(now(rel));
  for (const n of names) assert.ok(methods.includes(n), `${rel} has no @Test method ${n} (has: ${methods.join(', ')})`);
}

test('there is an AP-0041 commit that changes docs', () => {
  assert.ok(COMMITS.length > 0, 'no commit subject starts with AP-0041:');
  assert.ok(LAST, 'no AP-0041 commit changes vm-intent/docs/');
});

// ------------------------------------------------------------------ 1. API.md Idempotency

const IDEMPOTENCY = '- **Idempotency.**';
const API_OLD_SENTENCE = ['VMs that already exist keep their', 'work as before.'];

test('criterion 1: API.md Idempotency no longer names GET /api/v2/vms/{specHash}, names the day-2 calls, lifecycle and VM list', () => {
  const b = bullet(now('docs/API.md'), IDEMPOTENCY);
  assert.ok(!/\/api\/v2\/vms\/\{specHash\}(?!\/)/.test(b), `still names /api/v2/vms/{specHash} with no sub-path:\n${b}`);
  has(b, 'VMs that already exist keep their `specHash`', 'the Idempotency convention');
  has(b, 'the day-2 calls', 'the Idempotency convention');
  has(b, '`GET /api/v2/vms/{specHash}/lifecycle`', 'the Idempotency convention');
  has(b, 'the VM list `GET /api/v2/vms`', 'the Idempotency convention');
  has(b, 'work as before', 'the Idempotency convention');
});

test('criterion 1: the rest of the Idempotency paragraph is unchanged (per-user rule, sign-in off, InvalidSpec, simulated clouds)', () => {
  const b = bullet(now('docs/API.md'), IDEMPOTENCY);
  for (const s of ['with sign-in off, the SHA-256 of its canonical spec', 'also covers the user ID taken from sign-in',
    'A duplicate is the same spec from the same user, or from anyone when sign-in is off',
    'Another signed-in user\'s same spec is not a duplicate', 'non-retryable reason `InvalidSpec`',
    'while the simulated clouds build both']) has(b, s, 'the Idempotency convention');
  assert.equal(without(b, ...API_OLD_SENTENCE), without(bullet(before('docs/API.md'), IDEMPOTENCY), ...API_OLD_SENTENCE),
    'the Idempotency convention changed outside the "VMs that already exist keep their specHash ..." sentence');
});

// ------------------------------------------------------------------ 2. DEFINITIONS.md identity paragraph

const DEF_SENTENCE = ['Existing VMs keep their hash:', 'by its stored hash.'];

test('criterion 2: DEFINITIONS.md\'s spec-hash paragraph no longer names GET /api/v2/vms/{hash}; lists day-2, lifecycle, inventory check, VM list', () => {
  const p = paragraph(now('docs/DEFINITIONS.md'), 'Existing VMs keep their hash');
  assert.ok(!p.includes('/api/v2/vms/{hash}'), `still names /api/v2/vms/{hash}:\n${p}`);
  has(p, 'day-2 calls, the lifecycle, the inventory check and the VM list all look a VM up by its stored hash',
    'the spec-hash paragraph');
});

test('criterion 2: the rest of that DEFINITIONS.md paragraph is unchanged', () => {
  const p = paragraph(now('docs/DEFINITIONS.md'), 'Existing VMs keep their hash');
  const old = paragraph(before('docs/DEFINITIONS.md'), 'Existing VMs keep their hash');
  assert.equal(without(p, ...DEF_SENTENCE), without(old, ...DEF_SENTENCE),
    'the paragraph changed outside the "Existing VMs keep their hash ..." sentence');
});

// ------------------------------------------------------------------ 3. No bare /api/v2/vms/{hash}; Operations match openapi.json

test('criterion 3: no README or doc names /api/v2/vms/{hash} or /{specHash} without a day-2 sub-path', () => {
  const files = ['README.md', 'mcp-server/README.md', ...git(['ls-tree', '--full-tree', '--name-only', LAST, 'vm-intent/docs/'])
    .split('\n').filter((p) => /^vm-intent\/docs\/[^/]+\.md$/.test(p) && !p.endsWith('/AGENT-REQUIREMENTS.md'))
    .map((p) => p.slice('vm-intent/'.length))];
  assert.ok(files.length > 10, `too few docs found: ${files.join(', ')}`);
  const bad = [];
  for (const rel of files) {
    const t = at(LAST, rel);
    if (t === null) continue;
    for (const m of t.matchAll(/\/api\/v2\/vms\/\{(?:hash|specHash)\}(\/[A-Za-z]+)?/g)) {
      if (!/^\/(lifecycle|renew|resize|power|snapshot|decommission)$/.test(m[1] || '')) {
        const line = t.slice(0, m.index).split('\n').length;
        bad.push(`${rel}:${line}: ${m[0]}`);
      }
    }
  }
  assert.deepEqual(bad, [], 'bare VM paths remain');
});

test('criterion 3: every METHOD /api/v2/... in API.md\'s Operations table is in docs/openapi.json', () => {
  const ops = section(now('docs/API.md'), 'Operations');
  const spec = JSON.parse(now('docs/openapi.json'));
  const found = [...ops.matchAll(/`(GET|POST|PUT|PATCH|DELETE) (\/api\/v2\/[^`\s]*)`/g)];
  assert.ok(found.length >= 20, `only ${found.length} operations found in the Operations table`);
  const missing = found.filter(([, m, p]) => !(spec.paths[p] && spec.paths[p][m.toLowerCase()])).map(([, m, p]) => `${m} ${p}`);
  assert.deepEqual(missing, [], 'operations named in API.md but not in openapi.json');
  assert.ok(!(spec.paths['/api/v2/vms/{specHash}'] || {}).get, 'openapi.json unexpectedly has GET /api/v2/vms/{specHash}');
});

// ------------------------------------------------------------------ 4-6. TEMPORAL-FEATURES

test('criterion 4: the VmIdentityTest row describes per-user hashes, workflow IDs, build keys and sameBuild', () => {
  const r = row(now('docs/TEMPORAL-FEATURES.md'), '`VmIdentityTest`');
  lacks(r, 'for every owner', 'the VmIdentityTest row');
  for (const s of ['no owner (null or `anonymous`) keeps today\'s pinned canonical strings and hash',
    'two signed-in users get different hashes for the same spec, neither equal to the anonymous hash',
    'a signed-in user\'s hash is stable', 'changes with the spec',
    'no anonymous spec hashes the same input as a signed-in user',
    '`vm-` and `life-` workflow IDs', '`buildKey`', '`hashOfBuildKey`', 'sameBuild', 'true only for the same spec hash',
  ]) has(r, s, 'the VmIdentityTest row');
});

test('criterion 4: each VmIdentityTest behaviour matches a test method', () => {
  assertTestMethods(VM_IDENTITY_TEST, ['theCanonicalStringsAreUnchanged', 'anonymousOwnersGetTodaysHash',
    'twoSignedInUsersGetDifferentHashesForTheSameSpec', 'aSignedInUsersHashIsStableAndFollowsTheSpec',
    'noAnonymousSpecHashesTheSameInputAsASignedInUser', 'workflowIdsAreBuiltFromTheHash',
    'theBuildKeyIsTheHashOrTheHashAndTheRunIdPrefix', 'twoBuildsAreTheSameOnlyWithTheSameHash']);
  assert.match(now(VM_IDENTITY_TEST), /VmIdentity\.sameBuild\s*\(/, 'VmIdentityTest never calls VmIdentity.sameBuild');
});

const cell = (r) => r.replace(/^\|[^|]*\|\s*/, '').replace(/\s*\|\s*$/, '');

test('criterion 5: the RequestOwnerFlowTest row keeps its text and adds the three per-user behaviours', () => {
  const r = row(now('docs/TEMPORAL-FEATURES.md'), '`RequestOwnerFlowTest`');
  const old = cell(row(before('docs/TEMPORAL-FEATURES.md'), '`RequestOwnerFlowTest`'));
  assert.ok(cell(r).startsWith(old), `the row no longer starts with its old text:\n${old}\n--- now:\n${cell(r)}`);
  for (const s of ['a second signed-in user\'s identical request, or identical batch item, builds its own VM',
    'the first user\'s repeat is DUPLICATE', 'a `userId` or `requestedBy` in the body does not change the hash',
  ]) has(r, s, 'the RequestOwnerFlowTest row');
  assertTestMethods(OWNER_FLOW_TEST, ['aSecondUsersSameRequestBuildsItsOwnVmAndTheFirstUsersRepeatIsADuplicate',
    'aSecondUsersSameBatchItemBuildsItsOwnVmAndTheFirstUsersRepeatIsADuplicate',
    'aUserIdOrRequestedByInTheBodyDoesNotChangeTheHash']);
});

test('criterion 5: the CatalogRunWorkflowTest row keeps its text and adds that the owner changes the prepared hash', () => {
  const r = row(now('docs/TEMPORAL-FEATURES.md'), '`CatalogRunWorkflowTest`');
  const old = cell(row(before('docs/TEMPORAL-FEATURES.md'), '`CatalogRunWorkflowTest`'));
  assert.ok(cell(r).startsWith(old.replace(/\)$/, '')), `the row no longer keeps its old text:\n${old}\n--- now:\n${cell(r)}`);
  has(r, 'the run\'s owner changes the prepared spec hash so each user gets their own VM', 'the CatalogRunWorkflowTest row');
  assertTestMethods(CATALOG_TEST, ['theOwnerChangesThePreparedHashSoEachUserGetsTheirOwnVm']);
});

const REPLAY_START = 'These four were recorded before per-user identity';
const REPLAY_END = 'as before.';

test('criterion 6: the replay sentence is in the past tense and says no-owner requests keep their hash and vm- IDs', () => {
  const s9 = section(now('docs/TEMPORAL-FEATURES.md'), '9. Replay tests');
  has(s9, 'These four were recorded before per-user identity changed the spec hash of signed-in users',
    'section 9');
  has(s9, 'Requests with no owner keep the same hash and `vm-` child IDs', 'section 9');
  lacks(now('docs/TEMPORAL-FEATURES.md'), 'before per-user identity changes the spec hash', 'TEMPORAL-FEATURES.md');
});

test('criterion 6: the rest of section 9 (history list, prefixes, signed-in descriptions) is unchanged', () => {
  const s9 = section(now('docs/TEMPORAL-FEATURES.md'), '9. Replay tests');
  const old = section(before('docs/TEMPORAL-FEATURES.md'), '9. Replay tests');
  // The old paragraph ended "... still replay."; the new one adds "Requests with no owner ... as before."
  assert.equal(without(s9, REPLAY_START, REPLAY_END), without(old, REPLAY_START, 'still replay.'),
    'section 9 changed outside the "These four were recorded ..." paragraph');
});

// ------------------------------------------------------------------ 7. SCALING.md

test('criterion 7: SCALING\'s vm- workflow row qualifies "can\'t be built twice" per user and points at DEFINITIONS.md', () => {
  const r = row(now('docs/SCALING.md'), '**One workflow per VM, ID = `vm-` + spec hash**');
  for (const s of ['The same spec from the same user (from anyone, with sign-in off) can\'t be built twice at once',
    'a repeat counts as a duplicate', 'Another signed-in user\'s same spec has its own hash and its own `vm-` workflow',
    'DEFINITIONS.md']) has(r, s, 'the SCALING row');
  lacks(r, 'The same spec can\'t be built twice', 'the SCALING row');
});

// ------------------------------------------------------------------ 8. VSPHERE.md

const VS_ADDED = ['A signed-in user\'s spec hash also covers their user ID', 'per-user suffix.'];

test('criterion 8: VSPHERE.md says another signed-in user\'s same-named VM/deployment has a different hash and is refused', () => {
  const doc = now('docs/VSPHERE.md');
  const bullets = [bullet(doc, '**Adopts a VM only when it was built for the same spec.**'), bullet(doc, '**Idempotent**')];
  const withRule = bullets.filter((b) => squash(b).includes(VS_ADDED[0]));
  assert.ok(withRule.length >= 1, 'neither the adoption bullet nor the Idempotent bullet carries the per-user rule');
  for (const b of withRule) {
    for (const s of ['also covers their user ID ([DEFINITIONS.md](DEFINITIONS.md))', 'another signed-in user built',
      'even from an identical spec, has a different hash', 'non-retryable `InvalidSpec`', 'nothing deployed or removed',
      'until the cloud-side name gets a per-user suffix']) has(b, s, 'the VSPHERE.md bullet');
  }
});

test('criterion 8: the existing adoption rules in those bullets are otherwise unchanged', () => {
  for (const start of ['**Adopts a VM only when it was built for the same spec.**', '**Idempotent**']) {
    const b = bullet(now('docs/VSPHERE.md'), start);
    const old = bullet(before('docs/VSPHERE.md'), start);
    const rest = squash(b).includes(VS_ADDED[0]) ? without(b, ...VS_ADDED) : squash(b);
    assert.equal(rest, squash(old), `the ${start} bullet changed outside the added per-user sentence`);
  }
});

// ------------------------------------------------------------------ 9. USER-GUIDE.md and user-guide.html

const DUP_TEXT = 'An identical VM already exists: one of your own when sign-in is on (another user\'s identical request '
  + 'doesn\'t count), or anyone\'s with sign-in off. Change something, such as the name, to build another.';

test('criterion 9: USER-GUIDE.md\'s DUPLICATE troubleshooting row says duplicates are per user when signed in', () => {
  const r = row(now('docs/USER-GUIDE.md'), 'The request says DUPLICATE');
  assert.equal(cell(r), DUP_TEXT);
});

const htmlDecode = (s) => s.replace(/&#39;|&#x27;|&apos;/g, '\'').replace(/&quot;/g, '"').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&amp;/g, '&');

test('criterion 9: user-guide.html has the same DUPLICATE wording and "Last updated 2026-11-14."', () => {
  const html = now('frontend/public/user-guide.html');
  const m = html.match(/<td>The request says DUPLICATE<\/td>\s*<td>([\s\S]*?)<\/td>/);
  assert.ok(m, 'no DUPLICATE row in the HTML troubleshooting table');
  assert.equal(squash(htmlDecode(m[1].replace(/<[^>]+>/g, ''))), DUP_TEXT);
  assert.match(html, /<p class="updated">Last updated 2026-11-14\.<\/p>/);
});

test('criterion 9: nothing else in user-guide.html changes (including the request-states diagram)', () => {
  const a = before('frontend/public/user-guide.html').split('\n');
  const b = now('frontend/public/user-guide.html').split('\n');
  assert.equal(b.length, a.length, 'the HTML page gained or lost lines');
  const diffs = a.map((l, i) => (l === b[i] ? null : i)).filter((i) => i !== null);
  for (const i of diffs) {
    assert.ok(/<p class="updated">Last updated/.test(b[i]) || /^<td>An identical VM already exists/.test(b[i]),
      `line ${i + 1} changed unexpectedly:\n- ${a[i]}\n+ ${b[i]}`);
  }
  assert.ok(diffs.length <= 2, `${diffs.length} lines changed`);
});

// ------------------------------------------------------------------ 10. Dates

test('criterion 10: line 3 of the six docs is "Last updated 2026-11-14." and replaces an older date', () => {
  for (const rel of DATED) {
    const lines = now(rel).split('\n');
    assert.ok(lines[0].startsWith('# '), `${rel} line 1 is not the title`);
    assert.equal(lines[1], '', `${rel} line 2 is not blank`);
    assert.equal(lines[2], NEW_DATE, `${rel} line 3`);
    const old = before(rel).split('\n')[2];
    assert.match(old, /^Last updated \d{4}-\d{2}-\d{2}\.$/, `${rel} had no date line before`);
    assert.notEqual(old, NEW_DATE, `${rel} already had the new date before AP-0041`);
  }
});

test('criterion 10: no AP-0041 commit changes the "Last updated" line of any other doc', () => {
  const allowed = new Set([...DATED, 'frontend/public/user-guide.html'].map((r) => `vm-intent/${r}`));
  const bad = [];
  for (const sha of COMMITS) {
    const diff = git(['diff', '--no-renames', '-U0', `${sha}^`, sha]);
    let file = null;
    for (const line of diff.split('\n')) {
      if (line.startsWith('+++ ')) file = line.slice(4).replace(/^b\//, '');
      // Only a doc's date line counts: it starts with "Last updated". Other lines that mention the text (the requirement log, quotes) don't.
      else if (/^[+-]Last updated/.test(line) && file && /\.(md|html)$/.test(file)
        && !file.startsWith('vm-intent/tests/') && !allowed.has(file)) bad.push(`${sha.slice(0, 8)} ${file}: ${line}`);
    }
  }
  assert.deepEqual(bad, [], 'other docs had their "Last updated" line changed');
  for (const [rel, date] of Object.entries(KEPT_DATES)) {
    const t = at(LAST, rel);
    assert.ok(t !== null, `${rel} missing`);
    assert.equal(t.split('\n')[2], `Last updated ${date}.`, `${rel} line 3`);
  }
});

// ------------------------------------------------------------------ 11. Forbidden paths

test('criterion 11: no AP-0041 commit changes backend, frontend/src, OpenAPI files, SECURITY.md, AZURE.md or non-acceptance tests', () => {
  const forbidden = (p) => p.startsWith('vm-intent/backend/') || p.startsWith('vm-intent/frontend/src/')
    || ['vm-intent/docs/openapi.json', 'vm-intent/docs/openapi.yaml', 'vm-intent/docs/SECURITY.md',
      'vm-intent/docs/AZURE.md'].includes(p)
    || (p.startsWith('vm-intent/tests/') && !p.startsWith('vm-intent/tests/acceptance/'));
  const bad = COMMITS.flatMap((sha) => CHANGES.get(sha).filter(forbidden).map((p) => `${sha.slice(0, 8)} ${p}`));
  assert.deepEqual(bad, []);
});

// ------------------------------------------------------------------ 12. Names added exist

test('criterion 12: every Java class, test class or Class.method name added to a doc exists under backend/src', () => {
  const names = new Set();
  for (const sha of COMMITS) {
    const diff = git(['diff', '--no-renames', '-U0', `${sha}^`, sha, '--', ':(top)vm-intent/docs/', ':(top)vm-intent/README.md',
      ':(top)vm-intent/frontend/public/']);
    for (const line of diff.split('\n')) {
      if (!line.startsWith('+') || line.startsWith('+++')) continue;
      for (const m of line.matchAll(/`([A-Z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)?)`/g)) {
        if (/[a-z]/.test(m[1]) && /^[A-Z][a-z]+[A-Z]/.test(m[1])) names.add(m[1]);
      }
      for (const m of line.matchAll(/\b([A-Z][A-Za-z0-9]+Test)\b/g)) names.add(m[1]);
    }
  }
  for (const n of ['VmIdentityTest', 'RequestOwnerFlowTest', 'CatalogRunWorkflowTest']) names.add(n);
  names.add('VmIdentity.sameBuild');
  const grep = (pattern) => {
    try { return git(['grep', '--full-name', '-l', '-E', pattern, LAST, '--', ':(top)vm-intent/backend/src/']).split('\n').filter(Boolean); }
    catch { return []; }
  };
  const missing = [];
  for (const n of names) {
    const [cls, method] = n.split('.');
    const files = grep(`(class|interface|record|enum)[[:space:]]+${cls}\\b`);
    if (method) {
      if (!files.some((f) => new RegExp(`\\b${method}\\s*\\(`).test(git(['show', f])))) missing.push(n);
    } else if (cls.endsWith('Test') ? files.length === 0 : files.length === 0 && grep(`\\b${cls}\\b`).length === 0) {
      missing.push(n);
    }
  }
  assert.deepEqual(missing, [], `names added to docs but not found under backend/src (checked: ${[...names].join(', ')})`);
});
