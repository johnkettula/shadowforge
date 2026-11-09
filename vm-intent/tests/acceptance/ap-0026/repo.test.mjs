// AP-0026 acceptance, repository half (criteria 1-6): the daily docs for 2026-11-09. The MCP server README documents
// VMINTENT_API_TOKEN, the main README's MCP section mentions the batch tools, TEMPORAL-FEATURES section 6 says how to
// turn the nightly inventory check off, VSPHERE.md lists VsphereControllerTest, the four files say 'Last updated
// 2026-11-09.', and no AP-0026 commit touches code, generated or protected files, or adds files outside
// tests/acceptance. Each doc is also checked against the code it describes, so the docs aren't just words.
//
// Files are read as they were at the newest AP-0026 commit (and just before the first one), and "must not change"
// checks look only at AP-0026 commits, so later requirements can change these files without breaking this suite.
// The build gates run mvn test and the older suites; this suite only reads files.
//
//   node --test tests/acceptance/ap-0026/repo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const README = 'README.md';
const MCP = 'mcp-server/README.md';
const TF = 'docs/TEMPORAL-FEATURES.md';
const VS = 'docs/VSPHERE.md';
const DATED = [README, TF, VS, MCP];

const git = (args) => execFileSync('git', args,
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

// Oldest first.
const COMMITS = git(['log', '--reverse', '--format=%H', '--grep', '^AP-0026:']).split('\n').filter(Boolean);
const LAST = COMMITS[COMMITS.length - 1];
const BEFORE = COMMITS.length ? `${COMMITS[0]}^` : null;

/** A vm-intent/ file as it was at a commit, or null if it didn't exist. */
function at(sha, rel) {
  try { return git(['show', `${sha}:vm-intent/${rel}`]).replace(/\r\n/g, '\n'); } catch { return null; }
}
function must(sha, rel) {
  const t = at(sha, rel);
  assert.ok(t !== null, `${rel} doesn't exist at ${sha.slice(0, 8)}`);
  return t;
}
/** The text of a '## ...' section up to the next '## ' heading. */
function section(md, heading) {
  const i = md.indexOf('\n' + heading);
  assert.ok(i >= 0, `section "${heading}" not found`);
  const rest = md.slice(i + 1);
  const j = rest.indexOf('\n## ', 1);
  return j < 0 ? rest : rest.slice(0, j);
}
const flat = (s) => s.replace(/\s+/g, ' ').trim();
/** The '- ' bullets of a block, each joined with its indented continuation lines. */
function bullets(text) {
  const out = [];
  let open = false;
  for (const l of text.split('\n')) {
    if (/^- /.test(l)) { out.push(l.slice(2)); open = true; }
    else if (open && /^\s+\S/.test(l)) out[out.length - 1] += ' ' + l.trim();
    else open = false;
  }
  return out.map(flat);
}
/** The first non-blank line after the '# ' title. */
function lineUnderTitle(md) {
  const lines = md.split('\n');
  const t = lines.findIndex((l) => /^# /.test(l));
  assert.ok(t >= 0, 'no title');
  return lines.slice(t + 1).find((l) => l.trim() !== '');
}

test('there is at least one AP-0026 commit', () => {
  assert.ok(COMMITS.length > 0, "no commit whose subject starts with 'AP-0026:'");
});

test('criterion 1: the MCP README Settings list documents VMINTENT_API_TOKEN', () => {
  const md = must(LAST, MCP);
  const setup = section(md, '## Setup');
  const list = bullets(setup.slice(setup.indexOf('Settings')));
  const tok = list.find((b) => b.startsWith('`VMINTENT_API_TOKEN`'));
  assert.ok(tok, `no VMINTENT_API_TOKEN bullet in the Settings list: ${JSON.stringify(list)}`);
  assert.match(tok, /Entra ID access token/i);
  assert.ok(tok.includes('`Authorization: Bearer <token>`'), `the bullet doesn't show the header: ${tok}`);
  assert.match(tok, /every API call/i);
  assert.match(tok, /sign-in (is )?on/i);
  assert.match(tok, /empty[^.]*default[^.]*no token|default[^.]*empty[^.]*no token/i);
  assert.match(tok, /docs\/SECURITY\.md/);

  // The other two settings are still there with the same defaults as before AP-0026.
  const base = list.find((b) => b.startsWith('`VMINTENT_API_BASE`'));
  const home = list.find((b) => b.startsWith('`VMINTENT_HOME`'));
  assert.ok(base && base.includes('default `http://localhost:8080`'), `VMINTENT_API_BASE bullet: ${base}`);
  assert.ok(home && /default the folder above `mcp-server`/.test(home), `VMINTENT_HOME bullet: ${home}`);
  const old = bullets(section(must(BEFORE, MCP), '## Setup'));
  for (const name of ['VMINTENT_API_BASE', 'VMINTENT_HOME']) {
    const was = old.find((b) => b.startsWith(`\`${name}\``));
    const now = list.find((b) => b.startsWith(`\`${name}\``));
    assert.equal(now, was, `the ${name} bullet changed`);
  }

  // It matches the MCP server's code: read from VMINTENT_API_TOKEN, empty by default, sent as a Bearer header only when set.
  const src = must(LAST, 'mcp-server/src/index.ts');
  assert.match(src, /process\.env\.VMINTENT_API_TOKEN \?\? ""/);
  assert.match(src, /API_TOKEN \? \{ Authorization: `Bearer \$\{API_TOKEN\}` \} : \{\}/);
});

test("criterion 2: README's MCP section mentions starting a batch and following it, and the rest is unchanged", () => {
  const heading = '## MCP server (use the app from Claude)';
  const now = section(must(LAST, README), heading);
  const was = section(must(BEFORE, README), heading);
  const f = flat(now);

  // The sentence describing the tools (up to its full stop) names the batch tools.
  const start = f.indexOf('`mcp-server/` is an MCP server with tools');
  assert.ok(start >= 0, 'the tools sentence is gone');
  const sentence = f.slice(start, f.indexOf('. ', start) + 1);
  assert.match(sentence, /start(ing)? a batch of VMs/i, `no batch start in: ${sentence}`);
  assert.match(sentence, /follow(ing)? its progress/i, `no batch progress in: ${sentence}`);
  assert.ok(sentence.includes('`vm_batch_submit`') && sentence.includes('`vm_batch_status`'),
    `the tool names are missing from: ${sentence}`);
  // The existing tools are still listed.
  for (const w of ['preview requests', 'run workflows', 'inventory', 'audit trail', 'phrasing tests']) {
    assert.ok(sentence.includes(w), `"${w}" dropped from: ${sentence}`);
  }

  // Everything from 'Double-click' on is word-for-word what it was.
  const tail = (s) => flat(s).slice(flat(s).indexOf('Double-click'));
  assert.ok(f.includes('Double-click `4-setup-mcp.cmd`'));
  assert.ok(f.includes('`gitlab-host.txt`'));
  assert.ok(f.includes('See `mcp-server/README.md`.'));
  assert.equal(tail(now), tail(was), 'the rest of the MCP section changed');

  // The two tools exist in the MCP server.
  const src = must(LAST, 'mcp-server/src/index.ts');
  assert.match(src, /"vm_batch_submit"/);
  assert.match(src, /"vm_batch_status"/);
});

test('criterion 3: TEMPORAL-FEATURES section 6 says VMINTENT_INVENTORY_CHECK=false removes the schedule at the next start', () => {
  const sec = flat(section(must(LAST, TF), '## 6. The nightly inventory check'));
  assert.ok(sec.includes('`VMINTENT_INVENTORY_CHECK=false`'), 'section 6 does not name VMINTENT_INVENTORY_CHECK=false');
  const i = sec.indexOf('`VMINTENT_INVENTORY_CHECK=false`');
  const around = sec.slice(Math.max(0, i - 200), i + 300);
  assert.match(around, /turn[^.]*off|off[^.]*turn/i, `doesn't say it turns the check off: ${around}`);
  assert.match(around, /default `?true`?/i, `doesn't give the default true: ${around}`);
  assert.match(around, /next time the app starts|app (next )?starts/i, `doesn't say when: ${around}`);
  assert.match(around, /removes[^.]*`vm-inventory-check` schedule/i, `doesn't say the schedule is removed: ${around}`);
  // The sentence about the timing settings is kept.
  assert.ok(sec.includes('Change the timing with `VMINTENT_INVENTORY_CHECK_CRON` and `_TZ`.'),
    'the VMINTENT_INVENTORY_CHECK_CRON / _TZ sentence is gone');

  // It matches the code: the env var feeds vmintent.inventory-check.enabled (default true), and false deletes the schedule.
  const yml = must(LAST, 'backend/src/main/resources/application.yml');
  assert.match(yml, /enabled: \$\{VMINTENT_INVENTORY_CHECK:true\}/);
  const java = must(LAST, 'backend/src/main/java/com/example/vmintent/config/InventorySchedule.java');
  assert.match(java, /SCHEDULE_ID = "vm-inventory-check"/);
  assert.match(java, /@EventListener\(ApplicationReadyEvent\.class\)/);
  assert.match(java, /if \(!enabled\) \{[\s\S]*?handle\.delete\(\);/);
});

test("criterion 4: VSPHERE.md's 'How it's tested' list has VsphereControllerTest and keeps the others", () => {
  const list = bullets(section(must(LAST, VS), "## How it's tested"));
  const e = list.find((b) => b.startsWith('`VsphereControllerTest`'));
  assert.ok(e, `no VsphereControllerTest entry: ${JSON.stringify(list)}`);
  assert.match(e, /status codes/i);
  assert.match(e, /503[^,;]*vCenter or VCF Automation isn't set up/);
  assert.match(e, /404[^,;]*unknown blueprint/);
  assert.match(e, /502[^,;]*sign-in[^,;]*refuse/);
  assert.match(e, /status response[^.]*leaves out empty fields/i);
  for (const n of ['`VcenterBackendTest`', '`VcfaBackendTest`', '`VsphereRoutesWorkflowTest`']) {
    assert.ok(list.some((b) => b.includes(n)), `${n} entry is gone`);
  }
  // The entries that were there before AP-0026 are word-for-word kept.
  for (const b of bullets(section(must(BEFORE, VS), "## How it's tested"))) {
    assert.ok(list.includes(b), `entry changed or removed: ${b}`);
  }

  // The class exists and tests what the entry says.
  const t = must(LAST, 'backend/src/test/java/com/example/vmintent/api/VsphereControllerTest.java');
  assert.match(t, /class VsphereControllerTest/);
  assert.match(t, /void templatesWithoutVcenterIs503\(/);
  assert.match(t, /void blueprintsWithoutAutomationAre503\(/);
  assert.match(t, /void statusWithoutVsphereLeavesOutEmptyFields\(/);
  assert.match(t, /UnknownBlueprintIs404\(/);
  const c = must(LAST, 'backend/src/main/java/com/example/vmintent/api/VsphereController.java');
  assert.match(c, /"CloudAuth" -> HttpStatus\.BAD_GATEWAY/);
  assert.match(c, /"NotFound" -> HttpStatus\.NOT_FOUND/);
  assert.match(c, /NOT_SET_UP -> HttpStatus\.SERVICE_UNAVAILABLE/);
});

test("criterion 5: the line under the title is 'Last updated 2026-11-09.' in the four files", () => {
  for (const rel of DATED) {
    assert.equal(lineUnderTitle(must(LAST, rel)), 'Last updated 2026-11-09.', `${rel} at ${LAST.slice(0, 8)}`);
  }
  // What it replaced: 2026-11-08 in README.md and TEMPORAL-FEATURES.md, nothing in VSPHERE.md and the MCP README.
  assert.equal(lineUnderTitle(must(BEFORE, README)), 'Last updated 2026-11-08.');
  assert.equal(lineUnderTitle(must(BEFORE, TF)), 'Last updated 2026-11-08.');
  assert.doesNotMatch(must(BEFORE, VS), /^Last updated /m);
  assert.doesNotMatch(must(BEFORE, MCP), /^Last updated /m);
  // Each of the four has exactly one such line.
  for (const rel of DATED) {
    assert.equal((must(LAST, rel).match(/^Last updated /gm) || []).length, 1, `${rel} has more than one 'Last updated' line`);
  }
});

test("criterion 5: no AP-0026 commit adds, removes or changes a 'Last updated' line in any other file", () => {
  const allowed = new Set(DATED.map((r) => `vm-intent/${r}`));
  for (const sha of COMMITS) {
    const diff = git(['diff', '--no-renames', '-U0', `${sha}^`, sha]).replace(/\r\n/g, '\n');
    let file = null;
    for (const l of diff.split('\n')) {
      const m = /^\+\+\+ b\/(.*)$/.exec(l) || /^--- a\/(.*)$/.exec(l);
      if (m) { file = m[1]; continue; }
      if (/^diff --git a\/(\S+)/.test(l)) { file = /^diff --git a\/(\S+)/.exec(l)[1]; continue; }
      if (/^[+-](?![+-]{2} )/.test(l) && /Last updated/.test(l)) {
        assert.ok(allowed.has(file), `${sha.slice(0, 8)} changes a 'Last updated' line in ${file}: ${l}`);
      }
    }
  }
});

test('criterion 6: AP-0026 commits stay out of code, generated, protected and user-guide files and add no new files', () => {
  for (const sha of COMMITS) {
    const short = sha.slice(0, 8);
    const lines = git(['diff', '--name-status', '--no-renames', `${sha}^`, sha]).split('\n').filter(Boolean);
    for (const l of lines) {
      const [status, path] = l.split('\t');
      assert.ok(!/^vm-intent\/(backend|frontend|mcp-server\/src)\//.test(path), `${short} touches ${path}`);
      assert.ok(!/^vm-intent\/docs\/(openapi\.(json|yaml)|USER-GUIDE\.md|SECURITY\.md|AGENT-REQUIREMENTS\.md)$/.test(path),
        `${short} touches ${path}`);
      assert.ok(path !== 'docs/AGENT-REQUIREMENTS.md', `${short} touches ${path}`);
      // The pipeline's protected paths (agent-pipeline/src/config.ts).
      assert.ok(!/^(agent-pipeline\/|\.github\/|\.gitlab-ci\.yml$)/.test(path), `${short} touches ${path}`);
      assert.ok(!/^vm-intent\/(deploy\/(azure|pki)\/|deploy\/catalog\/gitlab-ci|[^/]+\.(cmd|ps1)$)/.test(path),
        `${short} touches ${path}`);
      if (status === 'A') {
        assert.ok(path.startsWith('vm-intent/tests/acceptance/'), `${short} adds ${path} outside tests/acceptance`);
      }
    }
  }
});
