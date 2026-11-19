// AP-0049 acceptance, repository half: a signed-in user's named VM gets the cloud name <name>-<first 8 hex of its
// spec hash>, from VmIdentity.of only. These checks read the sources and docs as the newest AP-0049 commit (other
// than the pipeline's own "acceptance tests" / "record the requirement" commits) left them, so later requirements
// can change these files without breaking this suite. The build gates run the unit tests; here we check that the
// tests the criteria ask for exist, are active and assert the right things.
//
//   node --test tests/acceptance/ap-0049/repo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = 'AP-0049';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const PIPELINE = /^AP-\d+: (acceptance tests|record the requirement)\b/;

const git = (args) => execFileSync('git', args,
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

/** Every AP-0049 commit, newest first: { sha, subject }. */
function commits() {
  return git(['log', '--no-merges', '--format=%H %s', '--grep', `^${ID}:`])
    .split('\n').filter(Boolean).map((l) => ({ sha: l.slice(0, 40), subject: l.slice(41) }))
    .filter((c) => c.subject.startsWith(`${ID}:`));
}

let codeSha;
/** The newest AP-0049 commit made by the developer (not the pipeline's bookkeeping). */
function codeCommit() {
  if (!codeSha) {
    const code = commits().filter((c) => !PIPELINE.test(c.subject));
    assert.ok(code.length > 0, `no ${ID} code commit found`);
    codeSha = code[0].sha;
  }
  return codeSha;
}

/** A file under vm-intent/ as the newest AP-0049 code commit left it. */
function at(path) {
  return git(['show', `${codeCommit()}:vm-intent/${path}`]).replace(/\r\n/g, '\n');
}

/** Files under a vm-intent/ directory at the newest AP-0049 code commit. */
function filesAt(dir) {
  const files = git(['ls-tree', '-r', '--full-tree', '--name-only', codeCommit(), '--', `vm-intent/${dir}`])
    .split('\n').filter(Boolean).map((p) => p.replace(/^vm-intent\//, ''));
  assert.ok(files.length > 0, `no files under vm-intent/${dir} at ${codeCommit().slice(0, 8)}`);
  return files;
}

/** The active (@Test, not @Disabled) test methods of a Java test class: [{ name, body }]. */
function activeTests(src) {
  if (/@Disabled[\s\S]*?\bclass\s/.test(src.slice(0, src.search(/\bclass\s/) + 6))) return [];
  const out = [];
  const re = /@Test\b/g;
  const starts = [];
  let m;
  while ((m = re.exec(src))) starts.push(m.index);
  starts.forEach((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : src.length;
    const chunk = src.slice(s, end);
    const sig = chunk.match(/^@Test\b([\s\S]*?)\bvoid\s+(\w+)\s*\(/);
    if (!sig) return;
    // Annotations right before @Test (back to the previous statement or block end) and between @Test and void.
    const before = src.slice(Math.max(0, s - 300), s);
    const lead = before.slice(Math.max(before.lastIndexOf('}'), before.lastIndexOf(';')) + 1);
    if (/@Disabled\b/.test(lead) || /@Disabled\b/.test(sig[1])) return;
    out.push({ name: sig[2], body: chunk });
  });
  return out;
}

const TEST_JAVA = 'backend/src/test/java/com/example/vmintent/';
const MAIN_JAVA = 'backend/src/main/java/com/example/vmintent/';

// ------------------------------------------------------------------ 1. VmIdentity.of

test('criterion 1: VmIdentity.of adds "-" + the first 8 characters of the hash for a signed-in owner\'s named spec only', () => {
  const src = at(MAIN_JAVA + 'spec/VmIdentity.java');
  const i = src.search(/public static Id of\s*\(/);
  assert.ok(i >= 0, 'VmIdentity has no public static Id of(...)');
  const body = src.slice(i, src.indexOf('\n    }', i));
  assert.match(body, /"-"\s*\+\s*hash\.substring\(0,\s*8\)/, `of() doesn't append "-" + hash.substring(0, 8):\n${body}`);
  assert.match(body, /isAnonymous\(owner\)|"anonymous"/, 'of() doesn\'t look at whether the owner is signed in');
  assert.match(body, /isBlank\(\)|isEmpty\(\)|== null|!= null/, 'of() doesn\'t check that the spec has a name');
  assert.match(body, /withGeneratedName\(spec, hash\)/, 'of() no longer takes the generated vm- name from SpecCanonicalizer');
  // The hash itself is unchanged: of() still gets it from hash(spec, owner).
  assert.match(body, /String hash = hash\(spec, owner\)/, 'of() doesn\'t take the hash from hash(spec, owner)');
});

// ------------------------------------------------------------------ 2. VmIdentityTest

test('criterion 2: VmIdentityTest has active tests for each case of the cloud-name rule', () => {
  const tests = activeTests(at(TEST_JAVA + 'spec/VmIdentityTest.java'));
  assert.ok(tests.length > 0, 'VmIdentityTest has no active tests');
  const find = (what, pred) => {
    const hit = tests.find((t) => pred(t.body));
    assert.ok(hit, `no active VmIdentityTest method checks that ${what} (methods: ${tests.map((t) => t.name).join(', ')})`);
  };
  const SIGNED = /VmIdentity\.of\([^;]*,\s*"(?!anonymous")[a-z][\w.-]*"\)/;

  find('null and "anonymous" owners keep cloudName == spec.name()', (b) =>
    /VmIdentity\.of\([^;]*,\s*null\)/.test(b) && /VmIdentity\.of\([^;]*,\s*"anonymous"\)/.test(b)
    && /assertEquals\(\s*"web-01",\s*\w+\.cloudName\(\)/.test(b));
  find('a signed-in owner\'s named spec gets name + "-" + hash.substring(0, 8)', (b) =>
    SIGNED.test(b) && /assertEquals\(\s*"[a-z0-9-]+-"\s*\+\s*[\w.()]*hash\(\)?[\w.()]*\.substring\(0,\s*8\),\s*\w+\.cloudName\(\)/.test(b));
  find('a signed-in owner\'s unnamed spec gets "vm-" + 8 hex characters and no second suffix', (b) =>
    SIGNED.test(b) && /"vm-"\s*\+\s*\w+\.hash\(\)\.substring\(0,\s*8\)/.test(b)
    && /assertEquals\(\s*"vm-"\s*\+[^;]*,\s*\w+\.cloudName\(\)/.test(b) && /UNNAMED|withName\(null\)/.test(b));
  find('the same owner and spec give the same cloudName every time', (b) =>
    /assertEquals\(\s*VmIdentity\.of\(([^;]*)\),\s*VmIdentity\.of\(\1\)/.test(b)
    || /assertEquals\(\s*VmIdentity\.of\([^;]*\)\.cloudName\(\),\s*VmIdentity\.of\([^;]*\)\.cloudName\(\)/.test(b));
  find('two different signed-in owners with the same named spec get different cloud names', (b) =>
    /assertNotEquals\(/.test(b) && /cloudName\(\)/.test(b)
    && (b.match(/VmIdentity\.of\(\s*NAMED[^;]*,\s*"(?!anonymous")[a-z]\w*"\)/g) || []).length >= 2);
  find('a 41-character name gives a 50-character cloud name matching [a-z0-9][a-z0-9-]*', (b) =>
    /assertEquals\(\s*41,/.test(b) && /assertEquals\(\s*50,\s*\w+\.cloudName\(\)\.length\(\)\)/.test(b)
    && /\[a-z0-9\]\[a-z0-9-\]\*/.test(b));
});

// ------------------------------------------------------------------ 3. workflow-level test

test('criterion 3: an active workflow-level test checks that the provider gets web-01-<hash8> while the record and audit keep web-01', () => {
  const files = filesAt(TEST_JAVA).filter((p) => p.endsWith('.java'));
  const hits = [];
  for (const f of files) {
    const src = at(f);
    if (!src.includes('web-01-')) continue;
    for (const t of activeTests(src)) {
      const b = t.body;
      if (/"web-01-"\s*\+\s*\w+\.substring\(0,\s*8\)/.test(b)
        && /signIn\(|signedIn|"alice"|"bob"/.test(b)
        && /cloud\.\w+\(|provider|nameOf|created/i.test(b)
        && /saved\w*\(|record/i.test(b) && /"web-01"/.test(b)
        && /events\(\)|audit/i.test(b)) hits.push(`${f}#${t.name}`);
    }
  }
  assert.ok(hits.length > 0, 'no active test checks the provider\'s create name web-01-<hash8> against a saved record and audit trail keeping web-01');
});

// ------------------------------------------------------------------ 4. batches and catalog runs

test('criterion 4: batches and catalog runs take cloudName from VmIdentity.of, with no suffix code of their own', () => {
  for (const f of ['api/BatchController.java', 'workflow/WorkflowActivitiesImpl.java', 'catalog/CatalogActivitiesImpl.java']) {
    const src = at(MAIN_JAVA + f);
    assert.match(src, /VmIdentity\.of\(/, `${f} doesn't call VmIdentity.of`);
    assert.match(src, /\bid\.cloudName\(\)|VmIdentity\.of\([^;]*\)\.cloudName\(\)/, `${f} doesn't take the cloud name from VmIdentity.of`);
  }
  const suffix = /"-"\s*\+\s*[\w.()]*\.substring\(0,\s*8\)/;
  const others = filesAt(MAIN_JAVA).filter((p) => p.endsWith('.java') && !p.endsWith('/spec/VmIdentity.java'))
    .filter((p) => suffix.test(at(p)));
  assert.deepEqual(others, [], 'main sources other than VmIdentity append "-" + 8 characters of a hash');
});

test('criterion 4: an active unit test checks the BatchItem.cloudName the batch path records for a signed-in owner', () => {
  const files = filesAt(TEST_JAVA).filter((p) => p.endsWith('.java'));
  const hits = [];
  for (const f of files) {
    const src = at(f);
    if (!src.includes('BatchItem')) continue;
    for (const t of activeTests(src)) {
      const b = t.body;
      if (/signIn\(|"alice"|"bob"/.test(b) && /BatchItem/.test(b)
        && /"[a-z0-9-]*-"\s*\+\s*\w+\.specHash\(\)\.substring\(0,\s*8\)[^;]*\w+\.cloudName\(\)|\w+\.cloudName\(\)[^;]*"[a-z0-9-]*-"\s*\+\s*\w+\.specHash\(\)\.substring\(0,\s*8\)|\w+\.cloudName\(\)\.endsWith\(\s*"-"\s*\+\s*\w+\.specHash\(\)\.substring\(0,\s*8\)\)/.test(b))
        hits.push(`${f}#${t.name}`);
    }
  }
  assert.ok(hits.length > 0, 'no active test compares a signed-in BatchItem.cloudName with name + "-" + specHash().substring(0, 8)');
});

// ------------------------------------------------------------------ 5. replay histories

test('criterion 5: ReplayTest replays the histories folder and no AP-0049 commit modifies or deletes a history file', () => {
  const replay = filesAt(TEST_JAVA).find((p) => p.endsWith('/ReplayTest.java'));
  assert.ok(replay, 'there is no ReplayTest.java');
  assert.match(at(replay), /histories/, 'ReplayTest doesn\'t read the histories folder');
  assert.ok(filesAt('backend/src/test/resources/histories').some((p) => p.endsWith('.json')), 'no history files');
  const touched = [];
  for (const c of commits()) {
    const out = git(['diff-tree', '--no-commit-id', '-r', '--name-status', '-M', c.sha, '--',
      ':(top)vm-intent/backend/src/test/resources/histories/']);
    for (const line of out.split('\n').filter(Boolean)) if (!line.startsWith('A')) touched.push(`${c.sha.slice(0, 8)} ${line}`);
  }
  assert.deepEqual(touched, [], 'AP-0049 commits that change or delete an existing history file');
});

// ------------------------------------------------------------------ 6. OpenAPI description

test('criterion 6: docs/openapi.json describes Interpretation.cloudName with the new rule', () => {
  const doc = JSON.parse(at('docs/openapi.json'));
  const d = doc?.components?.schemas?.Interpretation?.properties?.cloudName?.description;
  assert.equal(typeof d, 'string', 'Interpretation.cloudName has no description');
  assert.ok(d.includes('name in its cloud'), d);
  assert.ok(d.includes('same as spec.name'), d);
  assert.match(d, /signed-in/i, d);
  assert.match(d, /['"`]-['"`] plus the first 8 characters of specHash/, d);
  assert.doesNotMatch(d, /Today the same as spec\.name\./, d);
});

// ------------------------------------------------------------------ 8. docs

/** The paragraph or bullet of a markdown text that contains this anchor. */
function block(text, anchor, from = 0) {
  const i = text.indexOf(anchor, from);
  if (i < 0) return undefined;
  const startCandidates = [text.lastIndexOf('\n\n', i), text.lastIndexOf('\n- ', i)];
  const start = Math.max(...startCandidates) + 1;
  const ends = [text.indexOf('\n\n', i), text.indexOf('\n- ', i)].filter((e) => e >= 0);
  const end = ends.length ? Math.min(...ends) : text.length;
  return text.slice(start, end);
}

function checkRule(where, b) {
  assert.ok(b, `${where}: not found`);
  const flat = b.replace(/\s+/g, ' ');
  assert.match(flat, /signed-in user's named VM/i, `${where} doesn't say what a signed-in user's named VM is called:\n${b}`);
  assert.match(flat, /<name>-<[^>]*8 hex characters[^>]*spec ?hash>|<name>-<[^>]*specHash>/i,
    `${where} doesn't give the <name>-<8 hex characters of its spec hash> form:\n${b}`);
  assert.match(flat, /(name|you) asked for/i, `${where} doesn't say the API/web app show the name asked for:\n${b}`);
  assert.match(flat, /sign-in off/i, `${where} doesn't say what happens with sign-in off:\n${b}`);
  assert.match(flat, /vm-<hash8>|generated/i, `${where} doesn't cover a generated vm-<hash8> name:\n${b}`);
  assert.doesNotMatch(flat, /until[^.]*per-user suffix/i, `${where} still has an "until ... per-user suffix" caveat:\n${b}`);
  assert.doesNotMatch(flat, /today the same as/i, `${where} still says the cloud name is today the same as the name:\n${b}`);
}

test('criterion 8: API.md\'s duplicates paragraph states the new rule', () => {
  checkRule('API.md duplicates paragraph', block(at('docs/API.md'), 'Another signed-in user\'s same spec is not a duplicate'));
});

test('criterion 8: DEFINITIONS.md\'s "Cloud name" paragraph states the new rule', () => {
  checkRule('DEFINITIONS.md Cloud name', block(at('docs/DEFINITIONS.md'), '**Cloud name.**'));
});

test('criterion 8: USER-GUIDE.md\'s "Duplicates are per user" states the new rule', () => {
  checkRule('USER-GUIDE.md Duplicates are per user', block(at('docs/USER-GUIDE.md'), '**Duplicates are per user.**'));
});

test('criterion 8: VSPHERE.md\'s vCenter and VCF Automation adoption bullets state the new rule', () => {
  const md = at('docs/VSPHERE.md');
  const anchor = 'spec hash also covers';
  const bullets = [];
  for (let i = md.indexOf(anchor); i >= 0; i = md.indexOf(anchor, i + 1)) bullets.push(block(md, anchor, i));
  assert.ok(bullets.length >= 2, `VSPHERE.md has ${bullets.length} adoption bullets mentioning the per-user spec hash, expected 2`);
  bullets.forEach((b, n) => checkRule(`VSPHERE.md adoption bullet ${n + 1}`, b));
  assert.doesNotMatch(md.replace(/\s+/g, ' '), /until the cloud-side name gets a per-user suffix/i);
});

test('criterion 8: ONE-WAY-LINK.md no longer says ReconcileRequest.cloudName is today the name asked for', () => {
  const md = at('docs/ONE-WAY-LINK.md');
  checkRule('ONE-WAY-LINK.md ReconcileRequest.cloudName', block(md, 'ReconcileRequest.cloudName'));
});
