// AP-0037 acceptance, repository half (criteria 1-12): the daily docs for 2026-11-13 complete README's code map
// (link/, db/, VmLifecycleWorkflow, InventoryCheckWorkflow), its audit-event list and its test list; AUDIT.md names
// AuditTest; ONE-WAY-LINK.md says how an answer without replyTo is routed, what a CREATE order's spec carries and
// lists its tests; DEFINITIONS.md gets the retire row and its tests; every class name added exists; four pages say
// "Last updated 2026-11-13." on line 3.
//
// Files are read as they were at the newest AP-0037 commit that changed one of the four docs, and "must not
// change" checks look only at AP-0037 commits, so later requirements can change these files without breaking this
// suite. The build gates run mvn test; this suite only reads source files (never build outputs).
//
//   node --test tests/acceptance/ap-0037/repo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const DATE_LINE = 'Last updated 2026-11-13.';
const README = 'README.md';
const AUDIT = 'docs/AUDIT.md';
const LINK = 'docs/ONE-WAY-LINK.md';
const DEFS = 'docs/DEFINITIONS.md';
const DOCS = [README, DEFS, AUDIT, LINK];
const MAIN = 'backend/src/main/java/com/example/vmintent';
const TESTS = 'backend/src/test/java/com/example/vmintent';

const git = (args) => execFileSync('git', args,
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

function changed(sha) {
  return git(['diff', '--name-status', '--no-renames', `${sha}^`, sha]).split('\n').filter(Boolean)
    .map((l) => l.split('\t'));
}
// Oldest first.
const COMMITS = git(['log', '--reverse', '--format=%H', '--grep', '^AP-0037:']).split('\n').filter(Boolean);
const DOC_COMMITS = COMMITS.filter((sha) => changed(sha).some(([, p]) => DOCS.some((f) => p === `vm-intent/${f}`)));
const FIRST = DOC_COMMITS[0];
const LAST = DOC_COMMITS[DOC_COMMITS.length - 1];

/** A vm-intent/ file as it was at a commit, or null if it didn't exist. */
function at(sha, rel) {
  try { return git(['show', `${sha}:vm-intent/${rel}`]).replace(/\r\n/g, '\n'); } catch { return null; }
}
function must(rel) {
  assert.ok(LAST, 'no AP-0037 commit changes any of the four docs');
  const t = at(LAST, rel);
  assert.ok(t !== null, `${rel} doesn't exist at ${LAST.slice(0, 8)}`);
  return t;
}
/** A file as it was just before the first AP-0037 doc commit. */
function before(rel) {
  assert.ok(FIRST, 'no AP-0037 commit changes any of the four docs');
  const t = at(`${FIRST}^`, rel);
  assert.ok(t !== null, `${rel} doesn't exist before ${FIRST.slice(0, 8)}`);
  return t;
}
/** Every file path under vm-intent/backend/src at the commit (relative to vm-intent/). */
let files;
function backendFiles() {
  if (!files) {
    files = git(['ls-tree', '-r', '--name-only', '--full-tree', LAST, 'vm-intent/backend/src']).split('\n')
      .filter(Boolean).map((p) => p.replace(/^vm-intent\//, ''));
  }
  return files;
}
/** The text from a heading line (matched by regex) up to the next heading of the same or higher level. */
function section(md, headingRe) {
  const lines = md.split('\n');
  const i = lines.findIndex((l) => headingRe.test(l));
  assert.ok(i >= 0, `section ${headingRe} not found`);
  const level = lines[i].match(/^#+/)[0].length;
  let j = i + 1;
  let fence = false;
  while (j < lines.length) {
    if (/^```/.test(lines[j])) fence = !fence;
    if (!fence && /^#+ /.test(lines[j]) && lines[j].match(/^#+/)[0].length <= level) break;
    j++;
  }
  return lines.slice(i, j).join('\n');
}
/** The paragraph (up to a blank line) that starts with a given line prefix. */
function paragraph(md, startsWith) {
  const lines = md.split('\n');
  const i = lines.findIndex((l) => l.startsWith(startsWith));
  assert.ok(i >= 0, `no paragraph starts with ${startsWith}`);
  let j = i;
  while (j < lines.length && lines[j].trim() !== '') j++;
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
/** The lines of README's "How the code is organised" code block. */
function codeBlock(md) {
  const sec = section(md, /^#+ How the code is organised/);
  const m = sec.match(/```[^\n]*\n([\s\S]*?)```/);
  assert.ok(m, 'no code block in How the code is organised');
  return m[1].split('\n');
}
/** Every entry of the code block whose folder is `dir`, each joined with its continuation lines. */
function entries(lines, dir) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!new RegExp(`^\\s+${dir.replace('/', '\\/')}\\s`).test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && /^\s{6,}\S/.test(lines[j]) && !/^\s+[a-z0-9-]+\/\s/.test(lines[j])) j++;
    out.push(flat(lines.slice(i, j).join(' ')));
  }
  return out;
}
/** A test source's method names (JUnit @Test methods, roughly: every `void name(`). */
function methods(rel) {
  return [...must(rel).matchAll(/void ([A-Za-z0-9_]+)\(/g)].map((m) => m[1]);
}
/** Text of a table row or line that names `name` in backticks in a chunk of markdown, as a flat string. */
function rowFor(md, name) {
  const r = rows(md).find((c) => c[0] === `\`${name}\`` || c[0] === name);
  if (r) return { name: r[0], desc: flat(r.slice(1).join(' ')) };
  return null;
}
/** Uppercase event-like words (EVENT or EVENT_NAME) in a text. */
const eventNames = (text) => [...new Set([...text.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*\b/g)].map((m) => m[0])
  .filter((w) => w.length >= 4))];

test('there is an AP-0037 commit that changes the docs', () => {
  assert.ok(COMMITS.length > 0, 'no AP-0037 commits');
  assert.ok(LAST, 'no AP-0037 commit changes any of the four docs');
});

test('criterion 1: README\'s code map has link/ and db/ entries, and keeps every old line', () => {
  const now = codeBlock(must(README));
  const old = codeBlock(before(README));
  for (const l of old) assert.ok(now.includes(l), `code-block line is gone: ${JSON.stringify(l)}`);
  // Old lines stay in the same order.
  const idx = old.filter((l) => l.trim()).map((l) => now.indexOf(l));
  assert.deepEqual([...idx].sort((a, b) => a - b), idx, 'the old code-block lines are no longer in the same order');

  const link = entries(now, 'link/');
  assert.equal(link.length, 1, `expected one link/ entry, found ${link.length}`);
  const e = link[0];
  assert.match(e, /one-way link/i, `link/ entry does not mention the one-way link: ${e}`);
  assert.match(e, /domain 3/, `link/ entry does not mention domain 3: ${e}`);
  assert.match(e, /order[^.]*outbox/i, `link/ entry does not say orders are written to the outbox: ${e}`);
  assert.match(e, /answer[^.]*inbox/i, `link/ entry does not say answers are read from the inbox: ${e}`);
  assert.match(e, /\bReturnLinkListener\b/, `link/ entry does not name ReturnLinkListener: ${e}`);
  assert.match(e, /\bDomain3Simulator\b/, `link/ entry does not name Domain3Simulator: ${e}`);

  const db = entries(now, 'db/');
  assert.equal(db.length, 1, `expected one db/ entry, found ${db.length}`);
  assert.match(db[0], /\bAuditLog\b[^,;]*audit trail/i, `db/ entry does not name AuditLog (the audit trail): ${db[0]}`);
  assert.match(db[0], /\bBatchStore\b/, `db/ entry does not name BatchStore: ${db[0]}`);

  // The folders really hold these classes.
  for (const f of [`${MAIN}/link/ReturnLinkListener.java`, `${MAIN}/link/Domain3Simulator.java`,
    `${MAIN}/db/AuditLog.java`, `${MAIN}/db/BatchStore.java`]) {
    assert.ok(backendFiles().includes(f), `${f} does not exist`);
  }
});

test('criterion 2: a workflow/ entry names VmLifecycleWorkflow and InventoryCheckWorkflow', () => {
  const wf = entries(codeBlock(must(README)), 'workflow/');
  const e = wf.find((x) => /\bVmLifecycleWorkflow\b/.test(x) && /\bInventoryCheckWorkflow\b/.test(x));
  assert.ok(e, `no workflow/ entry names both workflows: ${JSON.stringify(wf)}`);
  assert.match(e, /VmLifecycleWorkflow\s*\(expiry, renewal and day-2 changes\)/, `VmLifecycleWorkflow is not described: ${e}`);
  assert.match(e, /InventoryCheckWorkflow\s*\(the nightly inventory check\)/, `InventoryCheckWorkflow is not described: ${e}`);
  for (const n of ['VmLifecycleWorkflow', 'InventoryCheckWorkflow']) {
    assert.ok(backendFiles().includes(`${MAIN}/workflow/${n}.java`), `${n}.java does not exist`);
  }
});

test('criterion 3: the Audit events bullet keeps today\'s names, adds the new ones, and every name is a Java literal', () => {
  const sec = (md) => section(md, /^## Database \(Postgres\) and audit trail/);
  const now = flat(bullet(sec(must(README)), '- Audit events:'));
  const old = flat(bullet(sec(before(README)), '- Audit events:'));
  const listed = eventNames(now);
  for (const n of eventNames(old)) assert.ok(listed.includes(n), `${n} is no longer listed`);
  for (const n of ['BATCH_STARTED', 'BATCH_COMPLETED', 'LINK_ORDER_SENT', 'LINK_REPLY', 'LINK_REPLY_UNMATCHED',
    'INVENTORY_CHECK', 'MISSING', 'AUDIT_REPLAY', 'LIFECYCLE_NOT_STARTED']) {
    assert.ok(listed.includes(n), `${n} is not listed`);
  }
  assert.match(now, /catalog[- ]run events/i, 'the bullet does not mention catalog-run events');
  for (const n of ['RUN_STARTED', 'STEP_DONE', 'STEP_FAILED', 'RUN_COMPLETED']) assert.ok(listed.includes(n), `${n} is not listed`);

  const literals = new Set(git(['grep', '-h', '-o', '-E', '"[A-Z][A-Z0-9_]*"', LAST, '--',
    ':(top)vm-intent/backend/src/main/java']).split('\n').filter(Boolean)
    .map((l) => l.replace(/^.*?"/, '').replace(/"$/, '')));
  const missing = listed.filter((n) => !literals.has(n));
  assert.deepEqual(missing, [], `listed events that are no string literal under backend/src/main/java: ${missing}`);
});

test('criterion 4: "Run the tests" names GoldenPhrasingTest and four more tests, and points to TEMPORAL-FEATURES.md', () => {
  const md = must(README);
  const p = flat(paragraph(md, 'Run the tests'));
  assert.match(p, /`?GoldenPhrasingTest`?/, 'GoldenPhrasingTest is gone');
  assert.match(p, /`?SpecValidatorTest`?[^,;]*spec limits/, `SpecValidatorTest (the spec limits) missing: ${p}`);
  assert.match(p, /`?PolicyDefaultsTest`?[^,;]*sizes\s+and defaults/, `PolicyDefaultsTest (sizes and defaults) missing: ${p}`);
  assert.match(p, /`?LlmIntentExtractorTest`?[^.]*AI providers[^.]*fallback to the rules[^.]*startup settings check/,
    `LlmIntentExtractorTest (AI providers, fallback, startup check) missing: ${p}`);
  assert.match(p, /`?RequestOwnerTest`?[^.]*owner comes from sign-in, or is 'anonymous'/,
    `RequestOwnerTest (owner from sign-in, or 'anonymous') missing: ${p}`);
  assert.match(p, /workflow tests[^\n]{0,80}\]\(docs\/TEMPORAL-FEATURES\.md\)/,`does not point to docs/TEMPORAL-FEATURES.md for the workflow tests: ${p}`);
  assert.ok(at(LAST, 'docs/TEMPORAL-FEATURES.md') !== null, 'docs/TEMPORAL-FEATURES.md does not exist');

  // The named tests test what the paragraph says.
  assert.ok(methods(`${TESTS}/spec/SpecValidatorTest.java`).some((m) => /Vcpu|Memory|Disk/.test(m)), 'SpecValidatorTest has no limit tests');
  assert.ok(methods(`${TESTS}/intent/PolicyDefaultsTest.java`).some((m) => /SIZES/.test(m)), 'PolicyDefaultsTest has no sizes test');
  const llm = methods(`${TESTS}/intent/LlmIntentExtractorTest.java`);
  for (const m of ['anthropic', 'openAi', 'fallsBackToTheRules', 'startupChecksTheSettings']) assert.ok(llm.includes(m), `LlmIntentExtractorTest has no ${m}`);
  const owner = methods(`${TESTS}/api/RequestOwnerTest.java`);
  for (const m of ['nobodySignedInIsAnonymous', 'aSignedInCallerIsTheOwner']) assert.ok(owner.includes(m), `RequestOwnerTest has no ${m}`);
});

test('criterion 5: AUDIT.md names AuditTest next to ReplayTest, says what it checks; nothing else changed but the date', () => {
  const now = must(AUDIT);
  const old = before(AUDIT);
  const paras = (md) => md.split(/\n\s*\n/).map(flat).filter(Boolean);
  const nowP = paras(now).filter((p) => p !== DATE_LINE);
  const oldP = paras(old);
  const i = nowP.findIndex((p) => /`ReplayTest`/.test(p) && /`?AuditTest`?/.test(p));
  assert.ok(i >= 0, 'no paragraph names both ReplayTest and AuditTest');
  const a = nowP[i];
  assert.match(a, /archive files are written once and their SHA-256 checked/, `archive check missing: ${a}`);
  assert.match(a, /classifications map codes to text and retention/, `classification check missing: ${a}`);
  assert.match(a, /retention \([^)]*built-in[^)]*from a file[^)]*\)/,`built-in and file classifications not both named: ${a}`);
  assert.match(a, /OPA is asked after the built-in rules and both must allow/, `OPA check missing: ${a}`);
  assert.match(a, /replay knows every workflow type/, `replay check missing: ${a}`);

  // Every other paragraph is unchanged, and the ReplayTest paragraph only gained text.
  assert.equal(nowP.length, oldP.length, 'AUDIT.md gained or lost paragraphs besides the date line');
  for (let k = 0; k < oldP.length; k++) {
    if (k === i) assert.ok(nowP[k].includes(oldP[k]), `the ReplayTest paragraph lost text: ${oldP[k]}`);
    else assert.equal(nowP[k], oldP[k], `AUDIT.md paragraph ${k + 1} changed`);
  }
  assert.equal(now.replace(/^Last updated [^\n]*\n\n/m, '').replace(/\s+/g, ''),
    old.replace(/\s+/g, '').replace(oldP[i].replace(/\s+/g, ''), nowP[i].replace(/\s+/g, '')),
    'AUDIT.md changed somewhere other than the date line and the AuditTest sentence');

  const ms = methods(`${TESTS}/audit/AuditTest.java`);
  for (const m of ['archiveFilesAreWrittenOnceAndChecked', 'classificationsMapCodesToTextAndRetention', 'builtInClassificationsLoad',
    'opaIsAskedAfterTheBuiltInRulesAndBothMustAllow', 'replayKnowsEveryWorkflow']) {
    assert.ok(ms.includes(m), `AuditTest has no ${m}`);
  }
});

test('criterion 6: ONE-WAY-LINK.md says how an answer without replyTo is routed, matching ReplyFile.workflowId()', () => {
  const t = flat(must(LINK));
  assert.match(t, /replyTo`? is missing or blank/, 'does not say "replyTo is missing or blank"');
  assert.match(t, /`vm-<specHash>` for a CREATE answer/, 'does not say vm-<specHash> for a CREATE answer');
  assert.match(t, /`life-<specHash>` for any other type/, 'does not say life-<specHash> for any other type');
  assert.match(t, /ReplyFile\.workflowId\(\)/, 'does not name ReplyFile.workflowId()');

  const src = must(`${MAIN}/link/ReplyFile.java`);
  const body = src.slice(src.indexOf('public String workflowId()'));
  assert.ok(src.includes('public String workflowId()'), 'ReplyFile.workflowId() is gone');
  assert.match(body, /if \(replyTo != null && !replyTo\.isBlank\(\)\) return replyTo;/, 'workflowId no longer prefers a non-blank replyTo');
  assert.match(body, /\("CREATE"\.equals\(type\) \? "vm-" : "life-"\) \+ specHash/, 'workflowId no longer picks vm-/life- + specHash by type');
});

test('criterion 7: ONE-WAY-LINK.md says what a CREATE order\'s spec carries and that domain 3 refuses "fail" names', () => {
  const t = flat(must(LINK));
  assert.match(t, /spec`? in a CREATE order carries the VM's cloud-side name/, 'does not say the CREATE spec carries the cloud-side name');
  assert.match(t, /ReconcileRequest\.cloudName[^.]*today[^.]*same as the name asked for/, 'does not name ReconcileRequest.cloudName (today the same as the name asked for)');
  assert.match(t, /VM record and the audit trail keep the name asked for/, 'does not say the VM record and audit trail keep the name asked for');
  assert.match(t, /simulated domain 3 refuses a CREATE whose spec name contains "?fail"?/, 'does not say the simulated domain 3 refuses names containing "fail"');

  assert.match(must(`${MAIN}/workflow/Models.java`), /record ReconcileRequest\([^)]*String cloudName\)/, 'ReconcileRequest has no cloudName');
  assert.match(must(`${MAIN}/link/Domain3Simulator.java`),
    /"CREATE"\.equals\(o\.type\(\)\)[\s\S]{0,120}name\(\)\.contains\("fail"\)/, 'Domain3Simulator no longer refuses CREATE names containing "fail"');
});

test('criterion 8: ONE-WAY-LINK.md has a Tests section describing OneWayLinkTest, LinkFilesTest and ReplyFileTest', () => {
  const sec = section(must(LINK), /^##+ .*Tests?\b/);
  const one = rowFor(sec, 'OneWayLinkTest');
  const files = rowFor(sec, 'LinkFilesTest');
  const reply = rowFor(sec, 'ReplyFileTest');
  assert.ok(one && files && reply, `the Tests section does not describe all three tests: ${sec}`);

  const oneM = methods(`${TESTS}/workflow/OneWayLinkTest.java`);
  for (const m of ['buildsAndChangesAVmThroughDomain3', 'noAnswerInTimeRollsBackByKey', 'aRefusalFromDomain3RollsBack', 'otherCloudsAreStillCalledDirectly']) {
    assert.ok(oneM.includes(m), `OneWayLinkTest has no ${m}`);
  }
  assert.match(one.desc, /built and changed through domain 3/, one.desc);
  assert.match(one.desc, /no answer in time rolls back/, one.desc);
  assert.match(one.desc, /refusal[^;]*rolls back/, one.desc);
  assert.match(one.desc, /other clouds are still called directly/, one.desc);

  const filesM = methods(`${TESTS}/link/LinkFilesTest.java`);
  for (const m of ['anOrderGoesOutAndItsAnswerComesBack', 'aStrayAnswerIsSetAsideAndAudited']) assert.ok(filesM.includes(m), `LinkFilesTest has no ${m}`);
  assert.match(files.desc, /order[^;]*goes out[^;]*answer comes back/, files.desc);
  assert.match(files.desc, /stray answer is set aside[^;]*audited/, files.desc);

  const replyM = methods(`${TESTS}/link/ReplyFileTest.java`);
  assert.ok(replyM.includes('toReply_copiesAllFields'), 'ReplyFileTest has no toReply_copiesAllFields');
  for (const m of ['workflowId_returnsReplyTo_whenSet', 'workflowId_returnsVmHash_whenReplyToNullAndTypeCreate',
    'workflowId_returnsLifeHash_whenReplyToBlankAndTypeResize']) assert.ok(replyM.includes(m), `ReplyFileTest has no ${m}`);
  assert.match(reply.desc, /copying an answer's fields/, reply.desc);
  assert.match(reply.desc, /choosing the waiting workflow/, reply.desc);
  assert.match(reply.desc, /replyTo`? is missing or blank/, reply.desc);
});

test('criterion 9: DEFINITIONS.md\'s API table has the retire row and keeps every old row', () => {
  const now = section(must(DEFS), /^## API\s*$/);
  const old = section(before(DEFS), /^## API\s*$/);
  const nowLines = now.split('\n');
  for (const l of old.split('\n').filter((x) => /^\|/.test(x))) assert.ok(nowLines.includes(l), `row is gone: ${l}`);
  const row = rows(now).find((r) => r[0] === '`POST /api/v2/definitions/{kind}/{name}/{version}/retire`');
  assert.ok(row, 'no row for POST /api/v2/definitions/{kind}/{name}/{version}/retire');
  // The doc already says: "`POST .../retire` stops new runs of a version."
  assert.match(flat(must(DEFS)), /\/retire` stops new runs of a version/, 'the doc\'s existing description of retiring is gone');
  assert.match(row[1], /stops new runs/, `the row is not worded like the existing description: ${row[1]}`);
  assert.match(must(`${MAIN}/api/CatalogController.java`), /@PostMapping\("\/definitions\/\{kind\}\/\{name\}\/\{version\}\/retire"\)/,
    'CatalogController has no POST .../retire');
});

test('criterion 10: DEFINITIONS.md names DefinitionParserTest, CelTest, CatalogRunWorkflowTest and CatalogControllerTest', () => {
  const md = must(DEFS);
  const describe = (name) => {
    const r = rowFor(md, name);
    if (r) return r.desc;
    const line = md.split('\n').find((l) => l.includes(name));
    assert.ok(line, `${name} is not named`);
    return flat(line);
  };
  const parser = describe('DefinitionParserTest');
  assert.match(parser, /built-in examples are valid/, parser);
  assert.match(parser, /every problem[^,]*reported at once/, parser);
  assert.match(parser, /steps may only read earlier steps/, parser);
  assert.match(describe('CelTest'), /CEL engine/);
  assert.ok(describe('CatalogRunWorkflowTest').length > 10, 'CatalogRunWorkflowTest has no description');
  assert.match(describe('CatalogRunWorkflowTest'), /\bruns?\b/);
  const ctl = describe('CatalogControllerTest');
  assert.match(ctl, /classifications'? JSON shape/, ctl);
  assert.match(ctl, /schema/, ctl);

  const pm = methods(`${TESTS}/catalog/DefinitionParserTest.java`);
  for (const m of ['builtInExamplesAreValid', 'reportsEveryProblemAtOnce', 'stepsMayOnlyReadEarlierSteps']) assert.ok(pm.includes(m), `DefinitionParserTest has no ${m}`);
  const cm = methods(`${TESTS}/api/CatalogControllerTest.java`);
  for (const m of ['classificationsKeepTheirJsonShape', 'classificationsSchemaIsNamedWithADefaultCode']) assert.ok(cm.includes(m), `CatalogControllerTest has no ${m}`);
  assert.ok(methods(`${TESTS}/cel/CelTest.java`).length >= 5, 'CelTest has few tests');
  assert.ok(methods(`${TESTS}/workflow/CatalogRunWorkflowTest.java`).includes('runsEveryStepInOrder'), 'CatalogRunWorkflowTest has no runsEveryStepInOrder');
});

test('criterion 11: every class name the change adds to a doc exists under backend/src', () => {
  const names = new Set();
  for (const f of DOCS) {
    const diff = git(['diff', '-U0', `${FIRST}^`, LAST, '--', `:(top)vm-intent/${f}`]);
    for (const l of diff.split('\n')) {
      if (!l.startsWith('+') || l.startsWith('+++')) continue;
      // CamelCase words of two or more parts (ReplyFile, Domain3Simulator, CelTest), as Java class names are.
      for (const m of l.matchAll(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g)) names.add(m[0]);
    }
  }
  assert.ok(names.size >= 15, `found only ${names.size} class names in the added lines: ${[...names]}`);
  const base = new Set(backendFiles().map((p) => p.split('/').pop().replace(/\.java$/, '')));
  const missing = [];
  for (const n of names) {
    if (base.has(n)) continue;
    // A record nested in another file (ReconcileRequest, which criterion 7 asks the doc to name) is accepted when
    // the type is declared in backend/src/main/java.
    const declared = git(['grep', '-l', '-E', `(class|record|interface|enum) ${n}\\b`, LAST, '--',
      ':(top)vm-intent/backend/src/main/java']).trim();
    if (declared) { console.log(`# ${n} is declared in ${declared.split('\n')[0]}, not in a file of its own`); continue; }
    missing.push(n);
  }
  assert.deepEqual(missing, [], `names added to the docs that are no class under backend/src: ${missing}`);
});

test('criterion 12: four pages say "Last updated 2026-11-13." on line 3; no other doc\'s date changes', () => {
  for (const f of DOCS) {
    const lines = must(f).split('\n');
    assert.match(lines[0], /^# /, `${f} does not start with a title`);
    assert.equal(lines[1], '', `${f}: line 2 is not blank`);
    assert.equal(lines[2], DATE_LINE, `${f}: line 3 is "${lines[2]}"`);
    assert.equal(lines.filter((l) => l.startsWith('Last updated ')).length, 1, `${f} has more than one Last updated line`);
  }
  for (const f of [AUDIT, LINK]) {
    assert.ok(!/^Last updated /m.test(before(f)), `${f} already had a Last updated line`);
  }
  for (const f of [README, DEFS]) {
    assert.equal(before(f).split('\n')[2], 'Last updated 2026-11-12.', `${f} did not say 2026-11-12 before`);
  }
  for (const sha of COMMITS) {
    for (const [, p] of changed(sha)) {
      if (!p.endsWith('.md') || DOCS.some((f) => p === `vm-intent/${f}`) || p.startsWith('vm-intent/tests/acceptance/')) continue;
      const diff = git(['diff', '-U0', `${sha}^`, sha, '--', `:(top)${p}`]);
      assert.ok(!/^[+-]Last updated \d{4}-/m.test(diff), `${sha.slice(0, 8)} changes the Last updated line of ${p}`);
    }
  }
});
