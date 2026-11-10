// AP-0028 acceptance, repository half (criteria 1-9, and the "existing suites unchanged" part of 10): the daily
// docs for 2026-11-10 name VMINTENT_API_TOKEN and the batch MCP tools, turning off the nightly inventory check,
// VsphereControllerTest, the missing vSphere and simulator settings and VmIdentityTest, each matching the code;
// the five pages carry 'Last updated 2026-11-10.'; and AP-0028 commits only change those docs.
//
// Files are read as they were at the newest AP-0028 commit, and "must not change" checks look only at AP-0028
// commits, so later requirements can change these files without breaking this suite. The build gates run mvn test;
// this suite only reads files.
//
//   node --test tests/acceptance/ap-0028/repo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const DATE_LINE = 'Last updated 2026-11-10.';
const FIVE = ['README.md', 'docs/TEMPORAL-FEATURES.md', 'docs/VSPHERE.md', 'docs/SCALING.md', 'mcp-server/README.md'];
const ALLOWED = [...FIVE, 'docs/AGENT-REQUIREMENTS.md'].map((p) => `vm-intent/${p}`);
const YML = 'backend/src/main/resources/application.yml';

const git = (args) => execFileSync('git', args,
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

// Oldest first.
const COMMITS = git(['log', '--reverse', '--format=%H', '--grep', '^AP-0028:']).split('\n').filter(Boolean);
// The newest AP-0028 commit that changed a doc (not just the pipeline's acceptance-test commit).
const DOC_COMMITS = COMMITS.filter((sha) => changed(sha).some(([, p]) => FIVE.some((f) => p === `vm-intent/${f}`)));
const LAST = DOC_COMMITS[DOC_COMMITS.length - 1];

function changed(sha) {
  return git(['diff', '--name-status', '--no-renames', `${sha}^`, sha]).split('\n').filter(Boolean)
    .map((l) => l.split('\t'));
}
/** A vm-intent/ file as it was at a commit, or null if it didn't exist. */
function at(sha, rel) {
  try { return git(['show', `${sha}:vm-intent/${rel}`]).replace(/\r\n/g, '\n'); } catch { return null; }
}
function must(rel) {
  assert.ok(LAST, 'no AP-0028 commit changes any of the five docs');
  const t = at(LAST, rel);
  assert.ok(t !== null, `${rel} doesn't exist at ${LAST.slice(0, 8)}`);
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
const flat = (s) => s.replace(/\s+/g, ' ');
/** application.yml's default for ${NAME:default}. */
function ymlDefault(yml, name) {
  const m = yml.match(new RegExp('\\$\\{' + name + ':([^}]*)\\}'));
  assert.ok(m, `${name} not in application.yml`);
  return m[1];
}

test('there is an AP-0028 commit that changes the docs', () => {
  assert.ok(COMMITS.length > 0, 'no AP-0028 commits');
  assert.ok(LAST, 'no AP-0028 commit changes any of the five docs');
});

test('criterion 1: mcp-server/README.md lists VMINTENT_API_TOKEN, matching index.ts', () => {
  const idx = must('mcp-server/src/index.ts');
  assert.match(idx, /API_TOKEN\s*=\s*process\.env\.VMINTENT_API_TOKEN\s*\?\?\s*""/, 'index.ts no longer reads VMINTENT_API_TOKEN with an empty default');
  assert.match(idx, /API_TOKEN \? \{ Authorization: `Bearer \$\{API_TOKEN\}` \} : \{\}/, 'index.ts no longer sends the token as a Bearer header');

  const md = must('mcp-server/README.md');
  const settings = md.slice(md.indexOf('Settings'));
  assert.ok(md.includes('Settings'), 'no settings list');
  const entry = settings.split('\n- ').find((e) => e.startsWith('`VMINTENT_API_TOKEN`'));
  assert.ok(entry, 'the settings list has no `VMINTENT_API_TOKEN` entry');
  const e = flat(entry.split('\n\n')[0]);
  assert.match(e, /Authorization: Bearer/, 'entry does not say it is sent as an Authorization: Bearer header');
  assert.match(e, /API call/i, 'entry does not say it is sent on API calls');
  assert.match(e, /sign-in on/i, 'entry does not say it is for an API with sign-in on');
  assert.match(e, /empty/i, 'entry does not say what empty means');
  assert.match(e, /default/i, 'entry does not say empty is the default');
  assert.match(e, /no token/i, 'entry does not say empty sends no token');
});

test('criterion 2: README MCP section names vm_batch_submit and vm_batch_status, which index.ts registers', () => {
  const idx = must('mcp-server/src/index.ts');
  for (const t of ['vm_batch_submit', 'vm_batch_status']) {
    assert.match(idx, new RegExp('registerTool\\(\\s*"' + t + '"'), `index.ts registers no tool ${t}`);
  }
  const sec = flat(section(must('README.md'), /^## MCP server \(use the app from Claude\)/));
  assert.match(sec, /`vm_batch_submit`/);
  assert.match(sec, /`vm_batch_status`/);
  assert.match(sec, /start a batch of VMs/i, 'does not say the tools can start a batch of VMs');
  assert.match(sec, /follow its progress/i, 'does not say the tools can follow a batch\'s progress');
});

test('criterion 3: TEMPORAL-FEATURES section 6 says VMINTENT_INVENTORY_CHECK=false removes the schedule on next start', () => {
  const yml = must(YML);
  assert.match(yml, /inventory-check:\s*\n\s*enabled: \$\{VMINTENT_INVENTORY_CHECK:true\}/,
    'application.yml vmintent.inventory-check.enabled is not ${VMINTENT_INVENTORY_CHECK:true}');
  const sched = must('backend/src/main/java/com/example/vmintent/config/InventorySchedule.java');
  assert.match(sched, /SCHEDULE_ID = "vm-inventory-check"/);
  assert.match(sched, /if \(!enabled\)[\s\S]{0,200}handle\.delete\(\)/, 'InventorySchedule no longer deletes the schedule when disabled');
  assert.match(sched, /ApplicationReadyEvent/, 'InventorySchedule no longer acts at start-up');

  const sec = flat(section(must('docs/TEMPORAL-FEATURES.md'), /^## 6\. The nightly inventory check/));
  assert.match(sec, /`VMINTENT_INVENTORY_CHECK=false`/);
  assert.match(sec, /default `?true`?/i, 'does not give the default true');
  assert.match(sec, /turn[^.]*off/i, 'does not say it turns the check off');
  assert.match(sec, /`vm-inventory-check`/, 'does not name the vm-inventory-check schedule');
  assert.match(sec, /next time the app starts|when it next starts|next start/i, 'does not say it happens when the app next starts');
  assert.match(sec, /removes the `vm-inventory-check` schedule/i);
});

test('criterion 4: VSPHERE.md test list has a VsphereControllerTest entry; the class exists', () => {
  assert.ok(at(LAST, 'backend/src/test/java/com/example/vmintent/api/VsphereControllerTest.java'),
    'VsphereControllerTest.java does not exist');
  const md = must('docs/VSPHERE.md');
  const items = md.split('\n- ');
  const near = items.findIndex((i) => i.startsWith('`VcenterBackendTest`'));
  assert.ok(near >= 0, 'VcenterBackendTest entry not found');
  assert.ok(items.some((i) => i.startsWith('`VsphereRoutesWorkflowTest`')), 'VsphereRoutesWorkflowTest entry not found');
  const raw = items.find((i) => i.startsWith('`VsphereControllerTest`'));
  assert.ok(raw, 'no `VsphereControllerTest` list entry');
  // Same list: within a few entries of VcenterBackendTest.
  assert.ok(Math.abs(items.indexOf(raw) - near) <= 3, 'VsphereControllerTest entry is not next to the other vSphere tests');
  const e = flat(raw.split('\n\n')[0]);
  assert.match(e, /each vSphere failure type maps to one HTTP status/i);
  assert.match(e, /templates and blueprints give 503/i);
  assert.match(e, /vCenter or VCF Automation isn'?t set up/i);
  assert.match(e, /status response leaves out empty fields/i);
  assert.match(e, /vSphere set up,? an unknown blueprint gives 404/i);
});

test('criterion 5: VSPHERE.md "Turn it on" names the four vSphere variables with application.yml defaults', () => {
  const yml = must(YML);
  assert.match(yml, /route: \$\{VMINTENT_VSPHERE_ROUTE:/);
  assert.equal(ymlDefault(yml, 'VMINTENT_VCENTER_LIBRARY'), 'vm-intent-templates');
  assert.match(yml, /content-library: \$\{VMINTENT_VCENTER_LIBRARY:/);
  assert.equal(ymlDefault(yml, 'VMINTENT_VCFA_AUTH'), 'tenant-oauth');
  assert.match(yml, /auth: \$\{VMINTENT_VCFA_AUTH:tenant-oauth\}.*iaas-login/);
  assert.match(yml, /ca-file: \$\{VMINTENT_VCFA_CA_FILE:/);

  const sec = section(must('docs/VSPHERE.md'), /^## Turn it on/);
  const line = (key) => {
    const l = sec.split('\n').find((x) => new RegExp('^\\s*' + key + ':').test(x) && x.includes('VMINTENT_'));
    assert.ok(l, `no "${key}:" line with a VMINTENT_ variable in "Turn it on"`);
    return l;
  };
  assert.match(line('route'), /VMINTENT_VSPHERE_ROUTE/);
  const lib = line('content-library');
  assert.match(lib, /VMINTENT_VCENTER_LIBRARY/);
  assert.match(lib, /default vm-intent-templates|vm-intent-templates.*default/);
  // automation.auth and automation.ca-file come after the automation: key.
  const auto = sec.slice(sec.indexOf('automation:'));
  assert.ok(sec.includes('automation:'), 'no automation: block');
  const autoLine = (key) => auto.split('\n').find((x) => new RegExp('^\\s*' + key + ':').test(x) && x.includes('VMINTENT_'));
  const auth = autoLine('auth');
  assert.ok(auth, 'no automation auth: line');
  assert.match(auth, /VMINTENT_VCFA_AUTH/);
  assert.match(auth, /tenant-oauth \(default\)|default.*tenant-oauth/);
  assert.match(auth, /iaas-login[^\n]*Aria Automation 8\.x/);
  const ca = autoLine('ca-file');
  assert.ok(ca, 'no automation ca-file: line');
  assert.match(ca, /VMINTENT_VCFA_CA_FILE/);
});

test('criterion 6: SCALING.md "What is still simulated" names the simulator settings with application.yml defaults', () => {
  const yml = must(YML);
  assert.equal(ymlDefault(yml, 'VMINTENT_SIM_BOOT_MIN'), '20');
  assert.equal(ymlDefault(yml, 'VMINTENT_SIM_BOOT_MAX'), '60');
  assert.equal(ymlDefault(yml, 'VMINTENT_SIM_LATENCY_MS'), '250');
  assert.equal(ymlDefault(yml, 'VMINTENT_SIM_THROTTLE'), '0.02');

  const sec = section(must('docs/SCALING.md'), /^## What is still simulated/);
  const row = (name) => {
    const r = sec.split('\n').find((l) => l.startsWith('|') && l.includes('`' + name + '`'));
    assert.ok(r, `no table row naming ${name}`);
    return r;
  };
  const boot = row('VMINTENT_SIM_BOOT_MIN');
  assert.ok(boot.includes('`VMINTENT_SIM_BOOT_MAX`') || row('VMINTENT_SIM_BOOT_MAX'));
  assert.match(boot, /20 ?s/);
  assert.match(row('VMINTENT_SIM_BOOT_MAX'), /60 ?s/);
  assert.match(boot, /boot time/i);
  const lat = row('VMINTENT_SIM_LATENCY_MS');
  assert.match(lat, /\|\s*250\s*\|/);
  assert.match(lat, /delay/i);
  assert.match(lat, /cloud call/i);
  const thr = row('VMINTENT_SIM_THROTTLE');
  assert.match(thr, /\|\s*0\.02\s*\|/);
  assert.match(thr, /share of cloud calls refused as throttled/i);
});

test('criterion 7: TEMPORAL-FEATURES test table has a VmIdentityTest row; the class exists', () => {
  assert.ok(at(LAST, 'backend/src/test/java/com/example/vmintent/spec/VmIdentityTest.java'),
    'VmIdentityTest.java does not exist');
  const md = must('docs/TEMPORAL-FEATURES.md');
  const row = md.split('\n').find((l) => l.startsWith('| `VmIdentityTest`'));
  assert.ok(row, 'no `VmIdentityTest` row in a table');
  // It sits in the same table as the other test rows.
  const lines = md.split('\n');
  const i = lines.indexOf(row);
  assert.ok(lines.slice(Math.max(0, i - 12), i).some((l) => /^\| `\w+Test` \|/.test(l)), 'VmIdentityTest row is not in the test table');
  assert.match(row, /golden values/i);
  assert.match(row, /canonical strings/i);
  assert.match(row, /spec hash/i);
  assert.match(row, /pinned|pins/i);
  assert.match(row, /same for every owner/i);
  assert.match(row, /for now/i);
  assert.match(row, /`?anonymous`? keeps today'?s hash/i);
  assert.match(row, /`vm-`/);
  assert.match(row, /`life-`/);
  assert.match(row, /built from the hash/i);
});

test('criterion 8: the five pages say "Last updated 2026-11-10." straight under the title', () => {
  for (const f of FIVE) {
    const lines = must(f).split('\n');
    assert.match(lines[0], /^# /, `${f} line 1 is not the title`);
    assert.equal(lines[1], '', `${f} line 2 is not blank`);
    assert.equal(lines[2], DATE_LINE, `${f} line 3 is "${lines[2]}"`);
    assert.equal(lines.filter((l) => /^Last updated /.test(l)).length, 1, `${f} has more than one "Last updated" line`);
  }
});

test('criterion 8: no AP-0028 commit changes the "Last updated" line of any other doc', () => {
  for (const sha of COMMITS) {
    for (const [, path] of changed(sha)) {
      if (path.startsWith('vm-intent/tests/acceptance/') || FIVE.some((f) => path === `vm-intent/${f}`)) continue;
      const diff = git(['diff', '--no-renames', `${sha}^`, sha, '--', `:(top)${path}`]);
      const hit = diff.split('\n').find((l) => /^[+-]Last updated \d{4}-\d\d-\d\d/.test(l));
      assert.ok(!hit, `${sha.slice(0, 8)} changes a "Last updated" line in ${path}: ${hit}`);
    }
  }
});

test('criterion 9: AP-0028 commits change only the five docs and AGENT-REQUIREMENTS.md (plus tests/acceptance)', () => {
  for (const sha of COMMITS) {
    const short = sha.slice(0, 8);
    for (const [status, path] of changed(sha)) {
      if (path.startsWith('vm-intent/tests/acceptance/')) continue;
      assert.ok(ALLOWED.includes(path), `${short} changes ${path}`);
      assert.notEqual(status, 'A', `${short} adds ${path}`);
      assert.notEqual(status, 'D', `${short} deletes ${path}`);
    }
  }
});

test('criterion 10: AP-0028 commits leave the existing acceptance suites unchanged', () => {
  for (const sha of COMMITS) {
    for (const [, path] of changed(sha)) {
      if (!path.startsWith('vm-intent/tests/acceptance/')) continue;
      assert.ok(path.startsWith('vm-intent/tests/acceptance/ap-0028/'), `${sha.slice(0, 8)} changes ${path}`);
    }
  }
});
