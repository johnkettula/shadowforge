// AP-0034 acceptance, repository half (criteria 1-11): the daily docs for 2026-11-12 describe the same-spec rule
// for reusing a cloud VM (build key, InvalidSpec "choose another name") in DEFINITIONS.md, API.md, USER-GUIDE.md
// (and its HTML copy) and README.md; say the inventory-check schedule is written again from its settings at each
// start (USER-GUIDE.md, TEMPORAL-FEATURES.md); name the pinned replay histories by prefix; move five 'Last updated'
// lines to 2026-11-12; each statement matches the code; and AP-0034 commits only change docs.
//
// Files are read as they were at the newest AP-0034 commit that changed a doc, and "must not change" checks look
// only at AP-0034 commits, so later requirements can change these files without breaking this suite. The build
// gates run mvn test; this suite only reads files (never build outputs).
//
//   node --test tests/acceptance/ap-0034/repo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const DATE_LINE = 'Last updated 2026-11-12.';
const DATED = ['README.md', 'docs/API.md', 'docs/DEFINITIONS.md', 'docs/USER-GUIDE.md', 'docs/TEMPORAL-FEATURES.md'];
const HTML = 'frontend/public/user-guide.html';
const DOCS = [...DATED, HTML];
const JAVA = 'backend/src/main/java/com/example/vmintent';
const IDENTITY = `${JAVA}/spec/VmIdentity.java`;
const VCENTER = `${JAVA}/provider/vsphere/VcenterBackend.java`;
const VCFA = `${JAVA}/provider/vsphere/VcfaBackend.java`;
const AZURE = `${JAVA}/provider/azure/AzureArmBackend.java`;
const SCHEDULE = `${JAVA}/config/InventorySchedule.java`;
const RECONCILE = `${JAVA}/workflow/VmReconcileWorkflowImpl.java`;
const REPLAY = 'backend/src/test/java/com/example/vmintent/workflow/ReplayTest.java';
const YML = 'backend/src/main/resources/application.yml';
const ANOTHER = 'was built by vm-intent for another request; choose another name';

const git = (args) => execFileSync('git', args,
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

function changed(sha) {
  return git(['diff', '--name-status', '--no-renames', `${sha}^`, sha]).split('\n').filter(Boolean)
    .map((l) => l.split('\t'));
}
const subject = (sha) => git(['log', '-1', '--format=%s', sha]).trim();
// Oldest first.
const COMMITS = git(['log', '--reverse', '--format=%H', '--grep', '^AP-0034:']).split('\n').filter(Boolean);
// Leaving out the pipeline's own acceptance-test and record-the-requirement commits.
const WORK = COMMITS.filter((sha) => !/^AP-0034: (acceptance tests|record the requirement)\b/.test(subject(sha)));
const DOC_COMMITS = COMMITS.filter((sha) => changed(sha).some(([, p]) => DOCS.some((f) => p === `vm-intent/${f}`)));
const FIRST = DOC_COMMITS[0];
const LAST = DOC_COMMITS[DOC_COMMITS.length - 1];

/** A vm-intent/ file as it was at a commit, or null if it didn't exist. */
function at(sha, rel) {
  try { return git(['show', `${sha}:vm-intent/${rel}`]).replace(/\r\n/g, '\n'); } catch { return null; }
}
function must(rel) {
  assert.ok(LAST, 'no AP-0034 commit changes any of the docs');
  const t = at(LAST, rel);
  assert.ok(t !== null, `${rel} doesn't exist at ${LAST.slice(0, 8)}`);
  return t;
}
/** A file as it was just before the first AP-0034 doc commit. */
function before(rel) {
  assert.ok(FIRST, 'no AP-0034 commit changes any of the docs');
  const t = at(`${FIRST}^`, rel);
  assert.ok(t !== null, `${rel} doesn't exist before ${FIRST.slice(0, 8)}`);
  return t;
}
/** The text from a heading line (matched by regex) up to the next heading of the same or higher level. */
function section(md, headingRe) {
  const lines = md.split('\n');
  const i = lines.findIndex((l) => headingRe.test(l));
  assert.ok(i >= 0, `section ${headingRe} not found`);
  const level = lines[i].match(/^#+/)[0].length;
  let j = i + 1;
  while (j < lines.length && !(/^#+ /.test(lines[j]) && lines[j].match(/^#+/)[0].length <= level)) j++;
  return lines.slice(i, j).join('\n');
}
/** The paragraph (up to a blank line) that starts with a given line prefix, plus the paragraph after it. */
function paragraph(md, startsWith, withNext = false) {
  const lines = md.split('\n');
  const i = lines.findIndex((l) => l.startsWith(startsWith));
  assert.ok(i >= 0, `no paragraph starts with ${startsWith}`);
  let j = i;
  while (j < lines.length && lines[j].trim() !== '') j++;
  if (withNext) {
    while (j < lines.length && lines[j].trim() === '') j++;
    while (j < lines.length && lines[j].trim() !== '') j++;
  }
  return lines.slice(i, j).join('\n');
}
/** A top-level "- " bullet that starts with a given text, with its continuation lines. */
function bullet(md, startsWith) {
  const lines = md.split('\n');
  const i = lines.findIndex((l) => l.startsWith(startsWith));
  assert.ok(i >= 0, `no bullet starts with ${startsWith}`);
  let j = i + 1;
  while (j < lines.length && /^\s+\S/.test(lines[j])) j++;
  return lines.slice(i, j).join('\n');
}
const flat = (s) => s.replace(/\s+/g, ' ').trim();
/** Table rows (as arrays of trimmed cells) in a chunk of markdown. */
function rows(md) {
  return md.split('\n').filter((l) => /^\s*\|/.test(l) && !/^\s*\|[\s:|-]+\|\s*$/.test(l))
    .map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
}
/** Markdown inline text as the help-page builder renders it. */
function inline(md) {
  return md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}
/** Strings listed in a Java `static final List<String> NAME = List.of(...)`. */
function javaList(src, name) {
  const m = src.match(new RegExp(`List<String> ${name} = List\\.of\\(([\\s\\S]*?)\\);`));
  assert.ok(m, `${name} not found`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

test('there is an AP-0034 commit that changes the docs', () => {
  assert.ok(COMMITS.length > 0, 'no AP-0034 commits');
  assert.ok(LAST, 'no AP-0034 commit changes any of the docs');
});

test('criterion 1: DEFINITIONS.md\'s spec-hash paragraph describes the build key and the same-spec reuse rule', () => {
  const md = must('docs/DEFINITIONS.md');
  const p = flat(paragraph(md, '**A VM\'s identity (spec hash).**', true));
  const own = flat(paragraph(md, '**A VM\'s identity (spec hash).**'));
  // Whatever was in the paragraph before is still there.
  const old = flat(paragraph(before('docs/DEFINITIONS.md'), '**A VM\'s identity (spec hash).**'));
  assert.ok(own.startsWith(old.replace(/\.$/, '')), 'the spec-hash paragraph lost what it said before');

  assert.match(p, /build key/, 'no "build key"');
  assert.match(p, /InvalidSpec/, 'no "InvalidSpec"');
  assert.match(p, /choose another name/, 'no "choose another name"');
  assert.match(p, /each build (also )?gets a build key/i, `does not say each build gets a build key: ${p}`);
  assert.match(p, /the spec hash, or the hash \+ `?-`? \+ the first 8 characters of the build's run ID/,
    'does not say the key is the hash, or hash + "-" + the first 8 characters of the run ID');
  assert.match(p, /`?VmIdentity\.buildKey`?/, 'does not name VmIdentity.buildKey');
  assert.match(p, /real cloud route/i, 'does not say this is on a real cloud route');
  assert.match(p, /existing VM with the requested name is reused only when its recorded build key has the same spec hash/,
    'does not say an existing same-named VM is reused only when its recorded build key has the same spec hash');
  assert.match(p, /`?VmIdentity\.sameBuild`?/, 'does not name VmIdentity.sameBuild');
  assert.match(p, /`?hashOfBuildKey`?/, 'does not name hashOfBuildKey');
  assert.match(p, /Otherwise[^.]*fails with the non-retryable `?InvalidSpec`? reason/, 'does not say otherwise the build fails with the non-retryable InvalidSpec reason');
  assert.ok(p.includes(ANOTHER), `does not quote "${ANOTHER}"`);
  assert.match(p, /nothing is built or removed/, 'does not say nothing is built or removed');
  assert.match(p, /simulated clouds[^.]*don't check names/i, 'does not say the simulated clouds don\'t check names');
});

test('criterion 2: API.md\'s Idempotency bullet adds the same-name rule for the real vSphere routes', () => {
  const b = flat(bullet(must('docs/API.md'), '- **Idempotency.**'));
  const old = flat(bullet(before('docs/API.md'), '- **Idempotency.**'));
  assert.ok(b.startsWith(old), 'the Idempotency bullet lost what it said before');
  assert.match(b, /real vSphere routes \(vCenter 9 and VCF Automation 9\)/, 'does not name the real vSphere routes (vCenter 9 and VCF Automation 9)');
  assert.match(b, /different hash/, 'does not say a spec with a different hash');
  assert.match(b, /name already taken in the cloud by a VM vm-intent built for another spec is not reused/,
    'does not say a name taken by a VM vm-intent built for another spec is not reused');
  assert.match(b, /fails with[^.]*`InvalidSpec`/, 'does not say the build fails with InvalidSpec');
  assert.ok(b.includes(ANOTHER), `does not quote "${ANOTHER}"`);
  assert.match(b, /VCF Automation[^.]*any same-named deployment[^.]*(no vm-intent key|vm-intent didn't build)/,
    'does not say a same-named VCF Automation deployment vm-intent didn\'t build is refused');
  assert.match(b, /that vm-intent didn't build; choose another name/, 'does not quote the "didn\'t build" message');
  assert.match(b, /simulated clouds \(the default\) don't check names/, 'does not say the simulated clouds (the default) don\'t check names');
});

test('criterion 3: USER-GUIDE.md\'s Troubleshooting table has the "choose another name" row and keeps every old row', () => {
  const now = section(must('docs/USER-GUIDE.md'), /^## Troubleshooting\s*$/);
  const old = section(before('docs/USER-GUIDE.md'), /^## Troubleshooting\s*$/);
  const nowLines = now.split('\n');
  for (const l of old.split('\n').filter((x) => /^\|/.test(x))) assert.ok(nowLines.includes(l), `row is gone: ${l}`);
  const row = rows(now).find((r) => r[0].includes(ANOTHER));
  assert.ok(row, 'no Troubleshooting row for the "choose another name" failure');
  assert.match(row[0], /FAILED/, row[0]);
  const fix = row[1];
  assert.match(fix, /only when vSphere is connected to a real vCenter or VCF Automation/, fix);
  assert.match(fix, /a different VM already has that name there/, fix);
  assert.match(fix, /Pick another name/, fix);
  assert.equal(rows(now).length, rows(old).length + 1, 'the table should have exactly one new row');
});

test('criterion 4: USER-GUIDE.md\'s inventory-check section gives the settings and says a start rewrites the schedule', () => {
  const now = section(must('docs/USER-GUIDE.md'), /^## The nightly inventory check\s*$/);
  const t = flat(now);
  assert.doesNotMatch(t, /To change the time or pause it, use the Temporal UI/, 'still says to change the time in the Temporal UI');
  assert.doesNotMatch(t, /change the time[^.]*Schedules/i, 'still says the time is changed on the Schedules page');
  assert.match(t, /Every night at 02:00 UTC/, '"Every night at 02:00 UTC" is gone');
  assert.match(t, /Press \*\*Run now\*\* to check straight away/, 'the Run now text is gone');
  assert.match(t, /administrator sets the time with `VMINTENT_INVENTORY_CHECK_CRON` \(default 02:00\) and `VMINTENT_INVENTORY_CHECK_TZ` \(default UTC\)/,
    'does not say an administrator sets the time with VMINTENT_INVENTORY_CHECK_CRON (02:00) and _TZ (UTC)');
  assert.match(t, /writes the schedule again from these settings every time it starts/, 'does not say the schedule is written again at each start');
  assert.match(t, /change made in the Temporal UI lasts only until the next restart/, 'does not say a Temporal UI change lasts only until the next restart');
  assert.match(t, /`VMINTENT_INVENTORY_CHECK=false` turns the nightly check off/, 'does not say VMINTENT_INVENTORY_CHECK=false turns it off');
  // The rest of the section is unchanged: every old line is still there apart from the reworded paragraph.
  const oldSec = section(before('docs/USER-GUIDE.md'), /^## The nightly inventory check\s*$/);
  const nowLines = now.split('\n');
  for (const l of oldSec.split('\n')) {
    if (!l.trim() || l.startsWith('Press **Run now**')) continue;
    assert.ok(nowLines.includes(l), `inventory-check line is gone: ${l}`);
  }
});

test('criterion 5: user-guide.html carries both USER-GUIDE.md changes and its date, and nothing else changed', () => {
  const md = must('docs/USER-GUIDE.md');
  const html = must(HTML);
  const oldHtml = before(HTML);
  assert.ok(html.includes('<p class="updated">Last updated 2026-11-12.</p>'), 'the updated line is not 2026-11-12');

  const para = section(md, /^## The nightly inventory check\s*$/).split('\n').find((l) => l.startsWith('Press **Run now**'));
  const newP = `<p>${inline(para)}</p>`;
  assert.ok(html.includes(newP), `the inventory-check paragraph doesn't match USER-GUIDE.md; expected ${newP}`);
  assert.ok(!html.includes('To change the time or pause it, use the Temporal UI'), 'the old Temporal UI sentence is still there');

  const row = rows(section(md, /^## Troubleshooting\s*$/)).find((r) => r[0].includes(ANOTHER));
  assert.ok(row, 'no new Troubleshooting row in USER-GUIDE.md');
  const newRow = `<tr>\n<td>${inline(row[0])}</td>\n<td>${inline(row[1])}</td>\n</tr>\n`;
  assert.ok(html.includes(newRow), `the new Troubleshooting row isn't in the HTML table; expected ${newRow}`);
  const table = html.slice(html.indexOf("<h2 id='troubleshooting'>"));
  assert.ok(table.includes(newRow), 'the new row is not in the Troubleshooting table');

  // Undo the three expected changes; what is left must be the old page exactly (diagram included).
  const oldUpdated = oldHtml.match(/<p class="updated">Last updated [^<]*<\/p>/)[0];
  const oldP = oldHtml.split('\n').find((l) => l.startsWith('<p>Press <strong>Run now</strong>'));
  assert.ok(oldP, 'old page had no Run now paragraph');
  const undone = html.replace('<p class="updated">Last updated 2026-11-12.</p>', oldUpdated)
    .replace(newP, oldP).replace(newRow, '');
  assert.equal(undone, oldHtml, 'user-guide.html changed somewhere other than the date, the paragraph and the new row');
  assert.ok(/<svg[\s\S]*<\/svg>/.test(html), 'the request-states diagram is gone');
});

test('criterion 6: README.md\'s VmIdentity line mentions the build key and same-spec reuse; nothing else in the block changed', () => {
  const block = (md) => {
    const sec = section(md, /^#+ How the code is organised/);
    const m = sec.match(/```\n([\s\S]*?)```/);
    assert.ok(m, 'no code block in How the code is organised');
    return m[1].split('\n');
  };
  /** The block split into the spec/ entry (spec/ line and its continuation lines) and the rest. */
  const split = (lines) => {
    const i = lines.findIndex((l) => /^\s+spec\/\s/.test(l));
    assert.ok(i >= 0, 'no spec/ line');
    let j = i + 1;
    while (j < lines.length && /^\s{6,}\S/.test(lines[j]) && !/^\s+[a-z]+\/\s/.test(lines[j])) j++;
    return { entry: lines.slice(i, j), rest: [...lines.slice(0, i), ...lines.slice(j)] };
  };
  const now = split(block(must('README.md')));
  const old = split(block(before('README.md')));
  assert.deepEqual(now.rest, old.rest, 'other lines of the code block changed');
  assert.equal(now.entry[0], old.entry[0], 'the spec/ line itself changed');
  const e = flat(now.entry.join(' '));
  assert.match(e, /VmIdentity: the one place that computes a VM's spec hash and its vm-\/life- workflow IDs/, 'the old VmIdentity text is gone');
  assert.match(e, /builds a VM's build key/, 'does not say VmIdentity builds a VM\'s build key');
  assert.match(e, /real clouds use (it )?to decide whether to reuse an existing VM with the same name \(same spec hash only\)/,
    'does not say the real clouds use it to decide whether to reuse a same-named VM (same spec hash only)');
});

test('criterion 7: TEMPORAL-FEATURES.md section 6 says the schedule is written again from the settings at each start', () => {
  const s = flat(section(must('docs/TEMPORAL-FEATURES.md'), /^## 6\. The nightly inventory check/));
  assert.match(s, /writes the `vm-inventory-check` schedule again from these settings every time it starts/,
    'does not say the app writes the vm-inventory-check schedule again at each start');
  assert.match(s, /VMINTENT_INVENTORY_CHECK_CRON` and `_TZ`\. The app writes/, 'does not tie it to VMINTENT_INVENTORY_CHECK_CRON / _TZ');
  assert.match(s, /timing changed in the Temporal UI lasts only until the next start/, 'does not say a Temporal UI change lasts until the next start');
  // What section 6 said before is still there.
  for (const phrase of ['Pause it or run it now', 'POST /api/v2/inventory-checks', 'VMINTENT_INVENTORY_CHECK=false']) {
    assert.ok(s.includes(phrase), `section 6 lost "${phrase}"`);
  }
});

test('criterion 8: TEMPORAL-FEATURES.md section 9 and the ReplayTest row name the pinned histories by prefix, matching ReplayTest', () => {
  const replay = must(REPLAY);
  const pinned = javaList(replay, 'VERSION_1');
  const recorded = javaList(replay, 'RECORDED');
  const prefixes = ['intent-v1-', 'reconcile-v1-', 'catalog-v1-'];
  assert.equal(pinned.length, 7, `ReplayTest pins ${pinned.length} histories, not seven`);
  assert.equal(recorded.length, 4, `ReplayTest lists ${recorded.length} recorded histories, not four`);
  for (const n of pinned) assert.ok(prefixes.some((p) => n.startsWith(p)), `${n} has none of the documented prefixes`);
  for (const p of prefixes) assert.ok(pinned.some((n) => n.startsWith(p)), `no pinned history starts with ${p}`);

  const md = must('docs/TEMPORAL-FEATURES.md');
  const sec = section(md, /^## 9\. Replay tests/);
  const s = flat(sec);
  assert.ok(!s.includes('`*-v1-*`'), 'section 9 still says `*-v1-*`');
  const namesAll = (text, names) => names.every((n) => text.includes(n));
  const byPrefix = (text) => prefixes.every((p) => text.includes(`${p}*`));
  assert.match(s, /seven pinned histories/, 'section 9 does not say "seven pinned histories"');
  assert.ok(byPrefix(s) || namesAll(s, pinned), 'section 9 does not name the pinned histories by prefix or list them');
  assert.match(s, /four recorded ones/, 'section 9 does not mention the four recorded ones');

  const row = rows(md).find((r) => r[0] === '`ReplayTest`');
  assert.ok(row, 'no ReplayTest row');
  const r = row.join(' | ');
  assert.ok(!r.includes('*-v1-*'), 'the ReplayTest row still says *-v1-*');
  assert.ok(byPrefix(r) || namesAll(r, pinned), `the ReplayTest row doesn't name the pinned histories: ${r}`);
  assert.match(r, /\bseven\b/, r);
  assert.match(r, /four recorded/, r);
  const listedRecorded = [...r.matchAll(/`([a-z]+-v\d-[a-z-]+)`/g)].map((m) => m[1]);
  if (listedRecorded.length) assert.deepEqual(listedRecorded.sort(), [...recorded].sort(), 'the recorded histories the row lists differ from ReplayTest.RECORDED');

  // The bullets in section 9 are unchanged.
  const bullets = (t) => t.split('\n').filter((l) => /^- /.test(l) || /^\s{2}\S/.test(l));
  assert.deepEqual(bullets(sec), bullets(section(before('docs/TEMPORAL-FEATURES.md'), /^## 9\. Replay tests/)),
    'the bullets in section 9 changed');
});

test('criterion 9: five pages say "Last updated 2026-11-12." on line 3; no other doc\'s date changes', () => {
  for (const f of DATED) {
    const lines = must(f).split('\n');
    assert.match(lines[0], /^# /, `${f} does not start with a title`);
    assert.equal(lines[2], DATE_LINE, `${f}: line 3 is "${lines[2]}"`);
    assert.equal(lines.filter((l) => l.startsWith('Last updated ')).length, 1, `${f} has more than one Last updated line`);
  }
  const kept = { 'docs/VSPHERE.md': '2026-11-10', 'docs/KUBERNETES.md': '2026-11-11', 'docs/SCALING.md': '2026-11-11', 'docs/SECURITY.md': '2026-11-07' };
  for (const [f, d] of Object.entries(kept)) {
    assert.equal(must(f).split('\n')[2], `Last updated ${d}.`, `${f} no longer says ${d}`);
  }
  for (const sha of COMMITS) {
    for (const [, p] of changed(sha)) {
      if (!p.endsWith('.md') || DATED.some((f) => p === `vm-intent/${f}`) || p.startsWith('vm-intent/tests/acceptance/')) continue;
      const diff = git(['diff', '-U0', `${sha}^`, sha, '--', p]);
      assert.ok(!/^[+-]Last updated \d{4}-/m.test(diff), `${sha.slice(0, 8)} changes the Last updated line of ${p}`);
    }
  }
});

test('criterion 10: the code has what the docs now say', () => {
  const id = must(IDENTITY);
  assert.match(id, /public static String buildKey\(String hash, String runIdPrefix\)/, 'VmIdentity.buildKey is missing');
  assert.match(id, /hash \+ "-" \+ runIdPrefix/, 'buildKey is no longer hash + "-" + prefix');
  assert.match(id, /public static String hashOfBuildKey\(String key\)/, 'VmIdentity.hashOfBuildKey is missing');
  assert.match(id, /public static boolean sameBuild\(String recordedKey, String newKey\)/, 'VmIdentity.sameBuild is missing');
  assert.match(id, /hashOfBuildKey\(recordedKey\)[\s\S]*equals\(hashOfBuildKey\(newKey\)\)/, 'sameBuild no longer compares hashOfBuildKey of both keys');
  assert.match(must(RECONCILE), /VmIdentity\.buildKey\(request\.specHash\(\),\s*[^;]*getRunId\(\)\.substring\(0, 8\)/,
    'the build key is no longer the hash + the first 8 characters of the run ID');

  for (const f of [VCENTER, VCFA, AZURE]) {
    const src = must(f);
    assert.ok(src.includes(ANOTHER), `${f} lacks "${ANOTHER}"`);
    assert.match(src, /VmIdentity\.sameBuild\(/, `${f} doesn't use VmIdentity.sameBuild`);
  }
  for (const f of [VCENTER, VCFA]) {
    const src = must(f);
    assert.match(src, /public String createVm\(VmSpec spec, String idempotencyKey\)/, `${f} has no createVm`);
    assert.match(src, /choose another name", "InvalidSpec"\)/, `${f}'s refusal is not InvalidSpec`);
    assert.match(src, /newNonRetryableFailure/, `${f}'s refusal is not non-retryable`);
  }
  assert.match(must(VCFA), /that vm-intent didn't build; choose another name/, 'VcfaBackend lacks "that vm-intent didn\'t build"');
  assert.match(must(VCFA), /if \(recorded == null\) \{\s*throw/, 'VcfaBackend no longer refuses a deployment with no vm-intent key');
  for (const f of [`${JAVA}/provider/SimCloud.java`, `${JAVA}/provider/SimulatedProvider.java`]) {
    const src = must(f);
    assert.ok(!/choose another name|sameBuild/.test(src), `${f} checks names, but the docs say the simulated clouds don't`);
  }

  const sched = must(SCHEDULE);
  assert.match(sched, /SCHEDULE_ID = "vm-inventory-check"/, 'the schedule ID is not vm-inventory-check');
  assert.match(sched, /@EventListener\(ApplicationReadyEvent\.class\)\s*public void setUp\(\)/, 'setUp no longer runs at each start');
  const setUp = sched.slice(sched.indexOf('public void setUp()'));
  assert.match(setUp, /catch \(ScheduleAlreadyRunningException[^)]*\) \{\s*handle\.update\(/, 'setUp no longer updates an existing schedule');
  assert.match(setUp, /if \(!enabled\) \{\s*try \{\s*handle\.delete\(\)/, 'setUp no longer removes the schedule when disabled');

  const yml = must(YML);
  assert.match(yml, /enabled: \$\{VMINTENT_INVENTORY_CHECK:true\}/, 'application.yml does not read VMINTENT_INVENTORY_CHECK');
  assert.match(yml, /cron: "\$\{VMINTENT_INVENTORY_CHECK_CRON:0 2 \* \* \*\}"/, 'VMINTENT_INVENTORY_CHECK_CRON default is not 02:00');
  assert.match(yml, /time-zone: \$\{VMINTENT_INVENTORY_CHECK_TZ:UTC\}/, 'VMINTENT_INVENTORY_CHECK_TZ default is not UTC');
});

test('criterion 11: AP-0034 commits change no code, tests, OpenAPI snapshot or protected file', () => {
  assert.ok(WORK.length > 0, 'no AP-0034 work commits');
  const forbidden = [
    /^vm-intent\/backend\//,
    /^vm-intent\/frontend\/src\//,
    /^vm-intent\/docs\/openapi\.(json|yaml)$/,
    /^vm-intent\/docs\/SECURITY\.md$/,
    // Protected paths (agent-pipeline/src/config.ts protectedPaths).
    /^agent-pipeline\//, /^\.github\//, /^\.gitlab-ci\.yml$/, /^vm-intent\/deploy\/azure\//, /^vm-intent\/deploy\/pki\//,
    /^vm-intent\/deploy\/catalog\/gitlab-ci/, /^vm-intent\/[^/]+\.(cmd|ps1)$/,
  ];
  for (const sha of WORK) {
    for (const [, p] of changed(sha)) {
      assert.ok(!forbidden.some((re) => re.test(p)), `${sha.slice(0, 8)} changes ${p}`);
      if (p.startsWith('vm-intent/tests/')) assert.ok(p.startsWith('vm-intent/tests/acceptance/'), `${sha.slice(0, 8)} changes ${p}`);
    }
  }
});
