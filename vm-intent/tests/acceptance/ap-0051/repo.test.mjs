// AP-0051 acceptance, repository half (criteria 1-12): the daily docs pass of 2026-11-25. The Help page's Missing
// bullet matches USER-GUIDE.md after AP-0052; the user guide (Markdown and Help page) gets Troubleshooting rows for
// the inventory check's 'Not marked missing' and 'listed again' notes; TEMPORAL-FEATURES' section-12 table gets the
// AP-0052 test rows; the dates move to 2026-11-25 and nothing else changes.
//
// The ID AP-0051 was used before, for the daily docs pass of 2026-11-20. So "this requirement's kept commits" are the
// non-merge commits whose subject starts with "AP-0051: Daily docs 2026-11-25" (the pipeline's own "acceptance tests"
// and "record the requirement" commits never do). Files are read with git show at the newest kept commit, and
// "before" means the parent of the oldest kept commit, so later requirements can change these files freely. Only
// sources are read, never build outputs; the build gates run the unit tests.
//
//   node --test tests/acceptance/ap-0051/repo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = 'AP-0051';
const PREFIX = `${ID}: Daily docs 2026-11-25`;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const GUIDE = 'docs/USER-GUIDE.md';
const HELP = 'frontend/public/user-guide.html';
const TF = 'docs/TEMPORAL-FEATURES.md';
const TESTS = 'backend/src/test/java/com/example/vmintent';
const TEST_FILES = {
  InventoryCheckTest: `${TESTS}/workflow/InventoryCheckTest.java`,
  InventoryRulesTest: `${TESTS}/workflow/InventoryRulesTest.java`,
  InventoryActivitiesImplTest: `${TESTS}/db/InventoryActivitiesImplTest.java`,
};

const git = (args) => execFileSync('git', args,
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

// Oldest first; subjects are checked here, because --grep also matches body lines.
const isPipeline = (s) => /^AP-\d+: (acceptance tests|record the requirement)\b/.test(s);
const COMMITS = git(['log', '--no-merges', '--reverse', '--format=%H %s', '--grep', `^${ID}:`]).split('\n')
  .filter(Boolean).map((l) => ({ sha: l.slice(0, 40), subject: l.slice(41) }))
  .filter((c) => c.subject.startsWith(PREFIX) && !isPipeline(c.subject)).map((c) => c.sha);
const NEWEST = COMMITS[COMMITS.length - 1];
const BEFORE = COMMITS.length ? git(['rev-parse', `${COMMITS[0]}^`]).trim() : null;

function at(sha, rel) {
  try { return git(['show', `${sha}:vm-intent/${rel}`]).replace(/\r\n/g, '\n'); } catch { return null; }
}
function now(rel) {
  assert.ok(NEWEST, `no commit subject starts with "${PREFIX}"`);
  const t = at(NEWEST, rel);
  assert.ok(t !== null, `${rel} doesn't exist at ${NEWEST.slice(0, 8)}`);
  return t;
}
function before(rel) {
  assert.ok(BEFORE, `no commit subject starts with "${PREFIX}"`);
  const t = at(BEFORE, rel);
  assert.ok(t !== null, `${rel} doesn't exist before ${ID}`);
  return t;
}
const squash = (s) => s.replace(/\s+/g, ' ').trim();
/** Markdown to plain text: no backticks, bold or italics markers. */
const mdPlain = (s) => squash(s.replace(/`/g, '').replace(/\*\*/g, '').replace(/\*/g, ''));
/** HTML to plain text: tags removed, the usual entities decoded. */
const htmlPlain = (s) => squash(s.replace(/<[^>]+>/g, '')
  .replace(/&rsquo;|&#8217;|&#39;|&apos;/g, '\'').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&'));
const has = (text, needle, what) => assert.ok(squash(text).includes(squash(needle)),
  `${what} doesn't say: ${needle}\n--- it says:\n${squash(text)}`);
const hasRe = (text, re, what) => assert.match(text, re, `${what} doesn't match ${re}\n--- it says:\n${text}`);

/** The lines of a Markdown section, from its "## " heading to the next "## " heading. */
function section(text, heading) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.trim() === heading);
  assert.ok(i >= 0, `no heading "${heading}"`);
  let j = i + 1;
  while (j < lines.length && !/^## /.test(lines[j])) j++;
  return lines.slice(i, j);
}
/** Body rows of the Markdown table in the given section lines (header and separator left out). */
function tableRows(lines) {
  const rows = lines.filter((l) => l.startsWith('|'));
  return rows.filter((l, k) => !/^\|[\s:|-]+\|?$/.test(l) && !(k === 0 && rows[1] && /^\|[\s:|-]+\|?$/.test(rows[1])));
}
/** A Markdown table row split into its two cells. */
function cells(rowLine) {
  const m = rowLine.match(/^\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*$/);
  assert.ok(m, `not a two-cell row: ${rowLine}`);
  return [m[1], m[2]];
}
/** The table row whose first cell is `cell` (optionally in backticks). */
function row(text, cell) {
  const r = text.split('\n').find((l) => l.startsWith(`| ${cell} |`) || l.startsWith(`| \`${cell}\` |`));
  assert.ok(r, `no table row for ${cell}`);
  return r;
}
const troubleRows = (md) => tableRows(section(md, '## Troubleshooting'));
const findTrouble = (md, needle) => {
  const r = troubleRows(md).filter((l) => mdPlain(cells(l)[0]).includes(needle));
  assert.equal(r.length, 1, `Troubleshooting rows whose first cell says "${needle}": ${r.length}`);
  return r[0];
};
/** The Help page's Troubleshooting table rows, as [plain cell 1, plain cell 2]. */
function helpTroubleRows(html) {
  const i = html.search(/<h2 id=['"]troubleshooting['"]/);
  assert.ok(i >= 0, 'the Help page has no Troubleshooting heading');
  const rest = html.slice(i);
  const end = rest.search(/<\/table>/);
  assert.ok(end >= 0, 'the Help page\'s Troubleshooting section has no table');
  return [...rest.slice(0, end).matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
    .map((m) => [...m[1].matchAll(/<td>([\s\S]*?)<\/td>/g)].map((c) => htmlPlain(c[1])))
    .filter((c) => c.length);
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
/** Problems with `name` as an active test in the class at `rel` (empty if it's an active @Test method). */
function activeTestProblems(rel, name) {
  const raw = at(NEWEST, rel);
  if (raw === null) return [`${rel} doesn't exist`];
  const src = noComments(raw);
  const i = src.search(new RegExp(`void\\s+${name}\\s*\\(`));
  if (i < 0) return [`${rel} has no method ${name}`];
  // The modifiers and annotations between the previous member (or the class's opening brace) and the method.
  const start = Math.max(src.lastIndexOf(';', i), src.lastIndexOf('}', i), src.lastIndexOf('{', i));
  const head = src.slice(start + 1, i);
  const problems = [];
  if (!/@(org\.junit\.jupiter\.api\.)?Test\b/.test(head)) problems.push(`${name} is not annotated @Test`);
  if (/@(org\.junit\.jupiter\.api\.)?Disabled\b/.test(head)) problems.push(`${name} is @Disabled`);
  const classHead = src.slice(0, src.search(/\bclass\s+\w+/));
  if (/@(org\.junit\.jupiter\.api\.)?Disabled\b/.test(classHead)) problems.push(`the class in ${rel} is @Disabled`);
  return problems;
}

test(`there is a "${PREFIX}" commit (other than the pipeline's own)`, () => {
  assert.ok(COMMITS.length > 0, `no non-merge commit subject starts with "${PREFIX}"`);
});

// ------------------------------------------------------------------ 1. Help page Missing bullet

const helpMissingItem = (html) => {
  const items = [...html.matchAll(/<li>\s*<strong>Missing:<\/strong>([\s\S]*?)<\/li>/g)];
  assert.equal(items.length, 1, `the Help page has ${items.length} <li><strong>Missing:</strong> items`);
  return items[0][0];
};
const guideMissingLine = (md) => {
  const l = md.split('\n').filter((x) => x.startsWith('- **Missing:**'));
  assert.equal(l.length, 1, `${GUIDE} has ${l.length} "- **Missing:**" bullets`);
  return l[0];
};

test('criterion 1: the Help page\'s Missing item has the same wording as the guide\'s "- **Missing:**" bullet', () => {
  const html = htmlPlain(helpMissingItem(now(HELP)));
  const md = mdPlain(guideMissingLine(now(GUIDE)).slice(2));
  assert.equal(html, md, 'the Help page Missing item and the USER-GUIDE.md Missing bullet differ');
});

test('criterion 1: the Help page\'s Missing item gives the hold-back rule, the note text and the listed-again report', () => {
  const t = htmlPlain(helpMissingItem(now(HELP)));
  has(t, 'more than half (and more than 2)', 'the Missing item');
  has(t, 'Not marked missing: the listing left out N of M running VMs; check the provider\'s route settings', 'the Missing item');
  has(t, 'listed again:', 'the Missing item');
  hasRe(t, /listed again:[^.]*\bnot changed\b/, 'the Missing item');
  hasRe(t, /an administrator decides what to do with it/, 'the Missing item');
  // The note text the page quotes is the one the code writes.
  const rules = noComments(at(NEWEST, 'backend/src/main/java/com/example/vmintent/workflow/InventoryRules.java') ?? '');
  hasRe(rules, /"Not marked missing: the listing left out "\s*\+\s*missing\s*\+\s*" of "\s*\+\s*running\s*\+\s*" running VMs; check the provider's route settings"/,
    'InventoryRules.heldBackNote');
});

test('criterion 1: the old Missing item that ended right after "It\'s marked MISSING." is gone', () => {
  const html = now(HELP);
  assert.doesNotMatch(html, /It's marked MISSING\.\s*<\/li>/, 'an item still ends right after "It\'s marked MISSING."');
  assert.ok(!htmlPlain(helpMissingItem(html)).endsWith('It\'s marked MISSING.'));
});

// ------------------------------------------------------------------ 2. 'Not marked missing' row

test('criterion 2: USER-GUIDE.md has a Troubleshooting row for an Inventory check note saying "Not marked missing"', () => {
  const [a, b] = cells(findTrouble(now(GUIDE), 'Not marked missing')).map(mdPlain);
  hasRe(a, /Inventory check card's note says Not marked missing/, 'the row\'s first cell');
  hasRe(b, /listing left out more than half \(and more than 2\) of that provider's running VMs/, 'the row');
  hasRe(b, /none of them was marked MISSING/, 'the row');
  hasRe(b, /their lifecycles go on/, 'the row');
  hasRe(b, /administrator checks that provider's route settings \(for vSphere, see docs\/VSPHERE\.md\),? then presses Run now/, 'the row');
});

// ------------------------------------------------------------------ 3. 'listed again' row

test('criterion 3: USER-GUIDE.md has a Troubleshooting row for a note saying "listed again"', () => {
  const [a, b] = cells(findTrouble(now(GUIDE), 'listed again')).map(mdPlain);
  hasRe(a, /note says listed again/, 'the row\'s first cell');
  hasRe(b, /A VM that was marked MISSING is in its cloud's listing again/, 'the row');
  hasRe(b, /the note gives its spec hash/, 'the row');
  hasRe(b, /vm-intent changes nothing on its own/, 'the row');
  hasRe(b, /an administrator decides what to do with it/, 'the row');
});

// ------------------------------------------------------------------ 4. Old rows kept, Help page rows

test('criterion 4: every Troubleshooting row USER-GUIDE.md had before is still there with the same text', () => {
  const cur = new Set(troubleRows(now(GUIDE)).map(squash));
  const old = troubleRows(before(GUIDE)).map(squash);
  assert.ok(old.length > 0, 'no Troubleshooting rows before (test assumption)');
  assert.deepEqual(old.filter((r) => !cur.has(r)), [], 'rows that are gone or changed');
  assert.equal(cur.size, old.length + 2, 'the table should have exactly the two new rows added');
});

test('criterion 4: the Help page\'s Troubleshooting table has both new rows as <tr>s with the Markdown\'s wording', () => {
  const md = now(GUIDE);
  const help = helpTroubleRows(now(HELP));
  for (const needle of ['Not marked missing', 'listed again']) {
    const want = cells(findTrouble(md, needle)).map(mdPlain);
    const got = help.filter((c) => c[0].includes(needle));
    assert.equal(got.length, 1, `Help page Troubleshooting <tr>s for "${needle}": ${got.length}`);
    assert.deepEqual(got[0], want, `the Help page's "${needle}" row differs from the Markdown`);
  }
});

// ------------------------------------------------------------------ 5. Unchanged text

test('criterion 5: USER-GUIDE.md\'s "- **Missing:**" bullet line is unchanged', () => {
  assert.equal(guideMissingLine(now(GUIDE)), guideMissingLine(before(GUIDE)));
});

test('criterion 5: TEMPORAL-FEATURES.md\'s section-6 "**Missing:**" bullet paragraph is unchanged', () => {
  const bullet = (t) => {
    const lines = section(t, t.split('\n').find((l) => /^## 6\. /.test(l)) ?? '## 6.');
    const i = lines.findIndex((l) => l.startsWith('- **Missing:**'));
    assert.ok(i >= 0, 'section 6 has no "- **Missing:**" bullet');
    let j = i + 1;
    while (j < lines.length && /^\s+\S/.test(lines[j])) j++;
    return lines.slice(i, j).join('\n');
  };
  assert.equal(bullet(now(TF)), bullet(before(TF)));
});

test('criterion 5: README.md as a whole is unchanged', () => {
  assert.equal(now('README.md'), before('README.md'));
});

// ------------------------------------------------------------------ 6-9. Section-12 rows

const S12 = '## 12. Time-skipping tests';
const s12rows = (t) => tableRows(section(t, S12));
const s12row = (t, cell) => {
  const r = s12rows(t).find((l) => l.startsWith(`| \`${cell}\` |`) || l.startsWith(`| ${cell} |`));
  assert.ok(r, `section 12 has no row for ${cell}`);
  return r;
};
const namedMethods = (r) => [...cells(r)[1].matchAll(/`([a-z][A-Za-z0-9]{12,})`/g)].map((m) => m[1]);

test('criterion 6: the InventoryCheckTest row still mentions missing VMs and orphans and adds the 3-of-4 hold-back', () => {
  const r = s12row(now(TF), 'InventoryCheckTest');
  const b = mdPlain(cells(r)[1]);
  hasRe(b, /^Missing VMs and orphans/, 'the InventoryCheckTest row');
  hasRe(b, /3 of a provider's 4 VMs vanish/, 'the InventoryCheckTest row');
  hasRe(b, /none is marked missing/, 'the InventoryCheckTest row');
  hasRe(b, /the note says so/, 'the InventoryCheckTest row');
  hasRe(b, /lifecycles are not ended MISSING/, 'the InventoryCheckTest row');
  assert.ok(namedMethods(r).includes('doesNotMarkMostOfAProvidersVmsMissing'), 'the row does not name doesNotMarkMostOfAProvidersVmsMissing');
  assert.deepEqual(activeTestProblems(TEST_FILES.InventoryCheckTest, 'doesNotMarkMostOfAProvidersVmsMissing'), []);
});

test('criterion 6: doesNotMarkMostOfAProvidersVmsMissing checks what the row says (3 of 4, note, not MISSING)', () => {
  const src = noComments(at(NEWEST, TEST_FILES.InventoryCheckTest) ?? '');
  const i = src.search(/void\s+doesNotMarkMostOfAProvidersVmsMissing\s*\(/);
  const body = src.slice(i, src.indexOf('\n    }', i));
  hasRe(body, /"Not marked missing"/, 'the test');
  hasRe(body, /"3 of 4"/, 'the test');
  hasRe(body, /assertNotEquals\(\s*"MISSING"/, 'the test');
});

test('criterion 7: the section-12 table has an InventoryRulesTest row with the rule and the note', () => {
  const b = mdPlain(cells(s12row(now(TF), 'InventoryRulesTest'))[1]);
  hasRe(b, /holds back marking only when more than 2 and more than half of the running VMs are left out/, 'the InventoryRulesTest row');
  hasRe(b, /up to 2, or up to half, are still marked/, 'the InventoryRulesTest row');
  hasRe(b, /the note says how many of how many were left out/, 'the InventoryRulesTest row');
});

test('criterion 8: the section-12 table has an InventoryActivitiesImplTest row for the real compare', () => {
  const b = mdPlain(cells(s12row(now(TF), 'InventoryActivitiesImplTest'))[1]);
  hasRe(b, /real compare holds back when a listing leaves out most VMs/, 'the InventoryActivitiesImplTest row');
  hasRe(b, /marks a few missing VMs MISSING/, 'the InventoryActivitiesImplTest row');
  hasRe(b, /reports a MISSING VM that is listed again in the note/, 'the InventoryActivitiesImplTest row');
});

test('criterion 9: the classes the new rows name exist, and every method they name is an active @Test there', () => {
  const tf = now(TF);
  const problems = [];
  for (const cls of ['InventoryRulesTest', 'InventoryActivitiesImplTest', 'InventoryCheckTest']) {
    if (at(NEWEST, TEST_FILES[cls]) === null) { problems.push(`${TEST_FILES[cls]} doesn't exist`); continue; }
    for (const m of namedMethods(s12row(tf, cls))) problems.push(...activeTestProblems(TEST_FILES[cls], m));
  }
  assert.deepEqual(problems, []);
  // The rows name the tests behind their claims.
  assert.ok(namedMethods(s12row(tf, 'InventoryRulesTest')).length > 0, 'the InventoryRulesTest row names no test method');
  assert.ok(namedMethods(s12row(tf, 'InventoryActivitiesImplTest')).length > 0, 'the InventoryActivitiesImplTest row names no test method');
});

// ------------------------------------------------------------------ 10. Rest of section 12 unchanged

test('criterion 10: the section-12 heading and every other row of its table are unchanged', () => {
  const ours = /^\| `?(InventoryCheckTest|InventoryRulesTest|InventoryActivitiesImplTest)`? \|/;
  assert.ok(now(TF).split('\n').includes(S12), `no "${S12}" heading now`);
  assert.ok(before(TF).split('\n').includes(S12), `no "${S12}" heading before`);
  const cur = s12rows(now(TF)).filter((l) => !ours.test(l));
  const old = s12rows(before(TF)).filter((l) => !ours.test(l));
  for (const c of ['VmControllerTest', 'ReplayTest', 'RequestOwnerFlowTest', 'VmIdentityTest']) {
    assert.ok(old.some((l) => l.startsWith(`| \`${c}\` |`)), `no ${c} row before (test assumption)`);
  }
  assert.deepEqual(cur, old);
});

// ------------------------------------------------------------------ 11. Dates

test('criterion 11: USER-GUIDE.md and TEMPORAL-FEATURES.md have the title, a blank line and "Last updated 2026-11-25." on line 3', () => {
  for (const [rel, old] of [[GUIDE, 'Last updated 2026-11-18.'], [TF, 'Last updated 2026-11-20.']]) {
    const lines = now(rel).split('\n');
    assert.ok(lines[0].startsWith('# '), `${rel} line 1 is not the title`);
    assert.equal(lines[1], '', `${rel} line 2 is not blank`);
    assert.equal(lines[2], 'Last updated 2026-11-25.', `${rel} line 3`);
    assert.equal(before(rel).split('\n')[2], old, `${rel} line 3 before ${ID}`);
  }
});

test('criterion 11: the Help page\'s <p class="updated"> line reads "Last updated 2026-11-25."', () => {
  const p = [...now(HELP).matchAll(/<p class="updated">([\s\S]*?)<\/p>/g)];
  assert.equal(p.length, 1, `<p class="updated"> lines: ${p.length}`);
  assert.equal(htmlPlain(p[0][1]), 'Last updated 2026-11-25.');
});

// ------------------------------------------------------------------ 12. Other dates unchanged

test('criterion 12: the other docs\' "Last updated" lines are the same as before the first kept commit', () => {
  const files = ['README.md', 'docs/API.md', 'docs/DEFINITIONS.md', 'docs/AUDIT.md', 'docs/SCALING.md', 'docs/VSPHERE.md',
    'docs/AZURE.md', 'docs/KUBERNETES.md', 'docs/ONE-WAY-LINK.md', 'docs/SECURITY.md', 'mcp-server/README.md'];
  const dateLine = (t) => (t ?? '').split('\n').find((l) => /Last updated/i.test(l)) ?? null;
  const changed = [];
  for (const rel of files) {
    const a = dateLine(at(BEFORE, rel)); const b = dateLine(at(NEWEST, rel));
    if (a !== b) changed.push(`${rel}: ${a} -> ${b}`);
  }
  assert.deepEqual(changed, []);
});
