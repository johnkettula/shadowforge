// AP-0031 acceptance, repository half (criteria 1-9, and the "existing suites unchanged" part of 10): the daily
// docs for 2026-11-11 describe the Kubernetes overlays' one-way-link settings, the dev HPA ranges and the per-pod
// grace periods; list a catalog run's states and the check.until / approval.wait / step limits; name the external
// Postgres settings in README.md and the workflow-cache and pool settings in SCALING.md, each matching the code;
// the four pages carry 'Last updated 2026-11-11.'; and AP-0031 commits only change those docs.
//
// Files are read as they were at the newest AP-0031 commit, and "must not change" checks look only at AP-0031
// commits, so later requirements can change these files without breaking this suite. The build gates run mvn test;
// this suite only reads files.
//
//   node --test tests/acceptance/ap-0031/repo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const DATE_LINE = 'Last updated 2026-11-11.';
const FOUR = ['README.md', 'docs/SCALING.md', 'docs/KUBERNETES.md', 'docs/DEFINITIONS.md'];
const ALLOWED = [...FOUR, 'docs/AGENT-REQUIREMENTS.md'].map((p) => `vm-intent/${p}`);
const YML = 'backend/src/main/resources/application.yml';
const IMPL = 'backend/src/main/java/com/example/vmintent/workflow/CatalogRunWorkflowImpl.java';
const PARSER = 'backend/src/main/java/com/example/vmintent/catalog/DefinitionParser.java';
const K8S = 'deploy/kubernetes';

const git = (args) => execFileSync('git', args,
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

// Oldest first.
const COMMITS = git(['log', '--reverse', '--format=%H', '--grep', '^AP-0031:']).split('\n').filter(Boolean);
// The AP-0031 commits that changed a doc (not just the pipeline's acceptance-test commit).
const DOC_COMMITS = COMMITS.filter((sha) => changed(sha).some(([, p]) => FOUR.some((f) => p === `vm-intent/${f}`)));
const FIRST = DOC_COMMITS[0];
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
  assert.ok(LAST, 'no AP-0031 commit changes any of the four docs');
  const t = at(LAST, rel);
  assert.ok(t !== null, `${rel} doesn't exist at ${LAST.slice(0, 8)}`);
  return t;
}
/** A file as it was just before the first AP-0031 doc commit. */
function before(rel) {
  assert.ok(FIRST, 'no AP-0031 commit changes any of the four docs');
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
const flat = (s) => s.replace(/\s+/g, ' ');
/** application.yml's default for ${NAME:default}. */
function ymlDefault(yml, name) {
  const m = yml.match(new RegExp('\\$\\{' + name + ':([^}]*)\\}'));
  assert.ok(m, `${name} not in application.yml`);
  return m[1];
}
/** Table rows (as arrays of trimmed cells) in a chunk of markdown. */
function rows(md) {
  return md.split('\n').filter((l) => /^\s*\|/.test(l) && !/^\s*\|[\s:|-]+\|\s*$/.test(l))
    .map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
}
/** The numbers of a key in one YAML document of a multi-document file, by metadata name. */
function hpa(yaml, name) {
  const doc = yaml.split(/^---$/m).find((d) => new RegExp(`^metadata:\\n\\s+name: ${name}\\s*$`, 'm').test(d));
  assert.ok(doc, `HPA ${name} not found in autoscaling.yaml`);
  const n = (k) => Number(doc.match(new RegExp(`^\\s+${k}: (\\d+)`, 'm'))[1]);
  return { min: n('minReplicas'), max: n('maxReplicas') };
}

test('there is an AP-0031 commit that changes the docs', () => {
  assert.ok(COMMITS.length > 0, 'no AP-0031 commits');
  assert.ok(LAST, 'no AP-0031 commit changes any of the four docs');
});

test('criterion 1: KUBERNETES.md gives the overlays\' one-way-link settings, matching the overlays', () => {
  const dev = must(`${K8S}/overlays/dev/kustomization.yaml`);
  const prod = must(`${K8S}/overlays/prod/kustomization.yaml`);
  assert.match(dev, /^\s+- VMINTENT_LINK_PROVIDERS=gcp\s*$/m, 'dev overlay no longer sets VMINTENT_LINK_PROVIDERS=gcp');
  assert.match(dev, /^\s+- VMINTENT_LINK_SIMULATE=true\s*$/m, 'dev overlay no longer sets VMINTENT_LINK_SIMULATE=true');
  assert.match(prod, /^\s+- VMINTENT_LINK_PROVIDERS=\*\s*$/m, 'prod overlay no longer sets VMINTENT_LINK_PROVIDERS=*');
  assert.doesNotMatch(prod, /VMINTENT_LINK_SIMULATE=true/, 'prod overlay simulates domain 3');

  const md = must('docs/KUBERNETES.md');
  assert.match(md, /\]\((\.\/)?ONE-WAY-LINK\.md(#[^)]*)?\)/, 'KUBERNETES.md does not link to ONE-WAY-LINK.md');
  const lines = md.split('\n');
  const devLine = lines.find((l) => l.includes('VMINTENT_LINK_PROVIDERS=gcp'));
  assert.ok(devLine, 'KUBERNETES.md does not give VMINTENT_LINK_PROVIDERS=gcp');
  assert.match(devLine, /\bdev\b/, 'the VMINTENT_LINK_PROVIDERS=gcp text does not say it is the dev overlay');
  assert.match(devLine, /VMINTENT_LINK_SIMULATE=true/, 'the dev overlay text does not give VMINTENT_LINK_SIMULATE=true');
  assert.match(devLine, /Google Cloud/, 'the dev overlay text does not say Google Cloud goes over the link');
  assert.match(devLine, /simulated domain 3/i, 'the dev overlay text does not say domain 3 is simulated');
  const prodLine = lines.find((l) => l.includes('VMINTENT_LINK_PROVIDERS=*'));
  assert.ok(prodLine, 'KUBERNETES.md does not give VMINTENT_LINK_PROVIDERS=*');
  assert.match(prodLine, /\bprod\b/, 'the VMINTENT_LINK_PROVIDERS=* text does not say it is the prod overlay');
  assert.match(prodLine, /every cloud/i, 'the prod overlay text does not say every cloud goes over the link');
  assert.match(prodLine, /inventory check skips every cloud/i, 'the prod overlay text does not say the nightly inventory check skips every cloud');
  assert.match(prodLine, /nightly/i, 'the prod overlay text does not say it is the nightly inventory check');
  assert.ok(must('docs/ONE-WAY-LINK.md').length > 0, 'docs/ONE-WAY-LINK.md does not exist');
});

test('criterion 2: KUBERNETES.md gives the base, dev and prod HPA ranges, matching the manifests', () => {
  const auto = must(`${K8S}/base/autoscaling.yaml`);
  assert.deepEqual(hpa(auto, 'vm-intent-worker-workflows'), { min: 2, max: 10 });
  assert.deepEqual(hpa(auto, 'vm-intent-worker-clouds'), { min: 2, max: 8 });

  const dev = must(`${K8S}/overlays/dev/kustomization.yaml`);
  // dev patches every HorizontalPodAutoscaler (no name in the target) to 1-3.
  const devPatch = dev.match(/- target:\n\s+kind: HorizontalPodAutoscaler\n\s+patch: \|-\n([\s\S]*?)(?=\n\S|\n\s+- target:|$)/);
  assert.ok(devPatch, 'dev overlay has no patch for every HorizontalPodAutoscaler');
  assert.match(devPatch[1], /path: \/spec\/minReplicas\n\s+value: 1\b/, 'dev overlay does not set minReplicas 1');
  assert.match(devPatch[1], /path: \/spec\/maxReplicas\n\s+value: 3\b/, 'dev overlay does not set maxReplicas 3');

  const prod = must(`${K8S}/overlays/prod/kustomization.yaml`);
  assert.match(prod, /kind: HorizontalPodAutoscaler\n\s+name: vm-intent-worker-workflows\n\s+patch: \|-\n\s+- op: replace\n\s+path: \/spec\/maxReplicas\n\s+value: 20\b/,
    'prod overlay no longer raises worker-workflows\' maxReplicas to 20');

  const md = must('docs/KUBERNETES.md');
  const table = rows(section(md, /^## The pods/));
  const wf = table.find((r) => r[0].includes('vm-intent-worker-workflows'));
  const cl = table.find((r) => r[0].includes('vm-intent-worker-clouds'));
  assert.ok(wf && cl, 'the pods table has no worker-workflows or worker-clouds row');
  const wfScale = wf[wf.length - 1];
  const clScale = cl[cl.length - 1];
  assert.match(wfScale, /HPA/, wfScale);
  assert.match(wfScale, /\b2-10\b/, `worker-workflows base range 2-10 is gone: ${wfScale}`);
  assert.match(wfScale, /prod 2-20/, `worker-workflows prod range 2-20 is gone: ${wfScale}`);
  assert.match(wfScale, /dev 1-3/, `worker-workflows dev range 1-3 is not given: ${wfScale}`);
  assert.match(clScale, /HPA/, clScale);
  assert.match(clScale, /\b2-8\b/, `worker-clouds base range 2-8 is gone: ${clScale}`);
  assert.match(clScale, /dev 1-3/, `worker-clouds dev range 1-3 is not given: ${clScale}`);
});

test('criterion 3: KUBERNETES.md gives each pod kind\'s grace period, matching the manifests', () => {
  const grace = (f) => {
    const m = must(`${K8S}/base/${f}`).match(/^\s+terminationGracePeriodSeconds: (\d+)\s*$/m);
    assert.ok(m, `${f} has no terminationGracePeriodSeconds`);
    return Number(m[1]);
  };
  assert.equal(grace('worker-workflows.yaml'), 60);
  assert.equal(grace('worker-clouds.yaml'), 60);
  assert.equal(grace('api.yaml'), 30);

  const md = flat(must('docs/KUBERNETES.md'));
  const i = md.indexOf('terminationGracePeriodSeconds');
  assert.ok(i >= 0, 'KUBERNETES.md does not name terminationGracePeriodSeconds');
  const near = md.slice(i, i + 300);
  assert.match(near, /60 for (the )?worker pods/i, `does not say worker pods get 60: ${near}`);
  assert.match(near, /30 for (the )?API pod/i, `does not say the API pod gets 30: ${near}`);
});

const RUN_STATES = ['STARTING', 'RUNNING', 'AWAITING_APPROVAL', 'AWAITING_RECOVERY', 'COMPLETED', 'TEARING_DOWN',
  'TORN_DOWN', 'TEARDOWN_INCOMPLETE'];

test('criterion 4: DEFINITIONS.md lists a run\'s states with meanings, each a state string in CatalogRunWorkflowImpl', () => {
  const impl = must(IMPL);
  // The run's state strings: those passed to setState(...) or the initial value of the state field.
  const codeStates = new Set();
  for (const m of impl.matchAll(/setState\(\s*"([A-Z_]+)"/g)) codeStates.add(m[1]);
  for (const m of impl.matchAll(/\bstate\s*=\s*"([A-Z_]+)"/g)) codeStates.add(m[1]);
  for (const m of impl.matchAll(/setState\([^;]*?\?\s*"([A-Z_]+)"\s*:\s*"([A-Z_]+)"/g)) { codeStates.add(m[1]); codeStates.add(m[2]); }
  for (const s of RUN_STATES) assert.ok(codeStates.has(s), `${s} is not a run state string in CatalogRunWorkflowImpl`);

  const md = must('docs/DEFINITIONS.md');
  const lines = md.split('\n');
  const h = lines.findIndex((l) => /^#+ .*\bstates?\b/i.test(l));
  assert.ok(h >= 0, 'DEFINITIONS.md has no section about a run\'s states');
  const sec = section(md, new RegExp('^' + lines[h].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
  const listed = new Map();
  for (const r of rows(sec)) {
    const m = r[0].match(/^`?([A-Z][A-Z_]+)`?$/);
    if (m) listed.set(m[1], r.slice(1).join(' ').trim());
  }
  for (const m of sec.matchAll(/^\s*[-*] \*{0,2}`([A-Z][A-Z_]+)`\*{0,2}[:\s-]+(.+)$/gm)) listed.set(m[1], m[2].trim());
  assert.deepEqual([...listed.keys()].sort(), [...RUN_STATES].sort(), 'the states listed are not exactly the run\'s states');
  for (const [s, meaning] of listed) {
    assert.ok(meaning.replace(/[`*_|\s]/g, '').length >= 5, `${s} has no meaning`);
    assert.ok(codeStates.has(s), `${s} is listed but is not a state string in CatalogRunWorkflowImpl`);
  }
});

test('criterion 5: DEFINITIONS.md gives the check.until, approval.wait and step limits, matching the code', () => {
  const impl = must(IMPL);
  const parser = must(PARSER);
  assert.match(impl, /int every = clamp\(with\.get\("everySeconds"\), 5, 3600, 30\);\s*\n\s*int minutes = clamp\(with\.get\("timeoutMinutes"\), 1, 1440, 30\);/,
    'check.until is no longer everySeconds 5-3600 (30), timeoutMinutes 1-1440 (30) in CatalogRunWorkflowImpl');
  assert.match(impl, /clamp\(with\.get\("timeoutHours"\), 1, 72, 24\)/, 'approval.wait is no longer timeoutHours 1-72 (24)');
  assert.match(impl, /Nobody answered the approval within/, 'an unanswered approval no longer fails the step');
  assert.match(parser, /intIn\(s\.get\("timeoutMinutes"\), where \+ "\.timeoutMinutes", 1, 1440, 30, p\)/,
    'a step\'s timeoutMinutes is no longer 1-1440 (30) in DefinitionParser');

  const md = must('docs/DEFINITIONS.md');
  const actions = rows(md);
  const cu = actions.find((r) => r[0] === '`check.until`');
  const aw = actions.find((r) => r[0] === '`approval.wait`');
  assert.ok(cu, 'no check.until row');
  assert.ok(aw, 'no approval.wait row');
  const cuText = cu.join(' | ');
  assert.match(cuText, /`everySeconds` \(5-3600, default 30\)/, `check.until everySeconds: ${cuText}`);
  assert.match(cuText, /`timeoutMinutes` \(1-1440, default 30\)/, `check.until timeoutMinutes: ${cuText}`);
  const awText = aw.join(' | ');
  assert.match(awText, /`timeoutHours` \(1-72, default 24\)/, `approval.wait timeoutHours: ${awText}`);

  const text = flat(md);
  assert.match(text, /nobody answers an `?approval\.wait`?[^.]*`?timeoutHours`?,? or (the approval|it) is rejected,? the step fails and the run stops in \**`?AWAITING_RECOVERY`?\**,? like any failed step/i,
    'DEFINITIONS.md does not say an unanswered or rejected approval fails the step and stops the run in AWAITING_RECOVERY like any failed step');
  assert.match(text, /timeoutMinutes: \d+ # longest one try may take \(1-1440, default 30\)/,
    'the example does not give a step\'s timeoutMinutes as 1-1440 (default 30)');
});

test('criterion 6: README.md\'s Postgres section names the external Postgres variables with application.yml\'s defaults', () => {
  const yml = must(YML);
  assert.equal(ymlDefault(yml, 'VMINTENT_DB_EMBEDDED'), 'true');
  assert.equal(ymlDefault(yml, 'VMINTENT_DB_URL'), 'jdbc:postgresql://localhost:5432/vmintent');
  assert.equal(ymlDefault(yml, 'VMINTENT_DB_USER'), 'vmintent');
  assert.equal(ymlDefault(yml, 'VMINTENT_DB_PASSWORD'), '');
  assert.equal(ymlDefault(yml, 'VMINTENT_DB_POOL'), '30');
  assert.match(yml, /maximum-pool-size: \$\{VMINTENT_DB_POOL:30\}/, 'VMINTENT_DB_POOL is not the connection pool size');

  const sec = section(must('README.md'), /^#+ Database \(Postgres\) and audit trail\s*$/);
  const entry = (name) => {
    const r = rows(sec).find((c) => c[0] === '`' + name + '`');
    if (r) return r.join(' | ');
    const line = sec.split('\n').find((l) => l.includes('`' + name + '`'));
    assert.ok(line, `${name} is not named in the Postgres section`);
    return line;
  };
  const emb = entry('VMINTENT_DB_EMBEDDED');
  assert.match(emb, /`?true`?/, emb);
  assert.match(emb, /`?false`? uses the server/i, `does not say false uses the external server: ${emb}`);
  assert.match(entry('VMINTENT_DB_URL'), /`?jdbc:postgresql:\/\/localhost:5432\/vmintent`?/);
  assert.match(entry('VMINTENT_DB_USER'), /\|\s*`vmintent`\s*\||default `?vmintent`?/);
  entry('VMINTENT_DB_PASSWORD');
  const pool = entry('VMINTENT_DB_POOL');
  assert.match(pool, /\b30\b/, pool);
  assert.match(pool, /connection pool size/i, pool);
});

test('criterion 7: SCALING.md names the workflow-cache settings and VMINTENT_DB_POOL, and keeps everything it said', () => {
  const yml = must(YML);
  assert.match(yml, /workflow-cache:\n\s+max-instances: \$\{VMINTENT_WORKFLOW_CACHE:4000\}\n\s+max-threads: \$\{VMINTENT_WORKFLOW_THREADS:4000\}/,
    'application.yml no longer sets spring.temporal.workflow-cache from VMINTENT_WORKFLOW_CACHE / _THREADS (4000)');

  const md = must('docs/SCALING.md');
  const cacheLine = md.split('\n').find((l) => l.includes('VMINTENT_WORKFLOW_CACHE'));
  assert.ok(cacheLine, 'SCALING.md does not name VMINTENT_WORKFLOW_CACHE');
  assert.match(cacheLine, /VMINTENT_WORKFLOW_THREADS/, cacheLine);
  assert.match(cacheLine, /4000/, cacheLine);
  assert.match(cacheLine, /cached/, cacheLine);
  assert.match(cacheLine, /spring\.temporal\.workflow-cache/, cacheLine);

  const pg = rows(md).find((r) => r[0] === 'Postgres');
  assert.ok(pg, 'the sizing guide has no Postgres row');
  const pgText = pg.join(' | ');
  assert.match(pgText, /`VMINTENT_DB_POOL`/, pgText);
  assert.match(pgText, /default 30/, pgText);
  assert.match(pgText, /connection pool/, pgText);
  assert.match(pgText, /max_connections` 400\+/, 'the Postgres row lost what it said before');

  // Every line SCALING.md had before is still there, apart from the date line; a rewritten line keeps its
  // old text (without the closing '.' or table bar) and only adds to it.
  const old = before('docs/SCALING.md');
  const now = md.split('\n');
  for (const line of old.split('\n')) {
    if (!line.trim() || line.startsWith('Last updated ')) continue;
    if (now.includes(line)) continue;
    const core = line.replace(/\s*\|\s*$/, '').replace(/\.\s*$/, '');
    assert.ok(now.some((l) => l.includes(core)), `SCALING.md lost this line: ${line}`);
  }
  const sims = (t) => [...new Set(t.match(/VMINTENT_SIM_[A-Z0-9_]+/g) || [])].sort();
  const oldSim = section(old, /^## What is still simulated/);
  const newSim = section(md, /^## What is still simulated/);
  assert.ok(sims(oldSim).length > 0, 'the old "What is still simulated" section has no VMINTENT_SIM_* settings');
  for (const s of sims(oldSim)) assert.ok(sims(newSim).includes(s), `${s} is gone from "What is still simulated"`);
});

test('criterion 8: the four pages say "Last updated 2026-11-11." straight under the title; no other doc\'s date changes', () => {
  for (const f of FOUR) {
    const lines = must(f).split('\n');
    assert.match(lines[0], /^# /, `${f} does not start with a title`);
    assert.equal(lines[1], '', `${f}: the line after the title is not blank`);
    assert.equal(lines[2], DATE_LINE, `${f}: the line under the title is "${lines[2]}"`);
  }
  for (const f of ['docs/KUBERNETES.md', 'docs/DEFINITIONS.md']) {
    assert.ok(!/^Last updated /m.test(before(f)), `${f} already had a Last updated line`);
  }
  for (const f of ['README.md', 'docs/SCALING.md']) {
    const old = before(f).split('\n')[2];
    assert.match(old, /^Last updated \d{4}-\d{2}-\d{2}\.$/, `${f} had no older date line`);
    assert.notEqual(old, DATE_LINE);
    assert.equal(must(f).split('\n').filter((l) => l.startsWith('Last updated ')).length, 1, `${f} has more than one Last updated line`);
  }
  for (const sha of COMMITS) {
    for (const [, p] of changed(sha)) {
      if (!p.endsWith('.md') || FOUR.some((f) => p === `vm-intent/${f}`) || p.startsWith('vm-intent/tests/acceptance/')) continue;
      const diff = git(['diff', '-U0', `${sha}^`, sha, '--', p]);
      assert.ok(!/^[+-]Last updated /m.test(diff), `${sha.slice(0, 8)} changes the Last updated line of ${p}`);
    }
  }
});

test('criterion 9: AP-0031 commits change only the four docs and AGENT-REQUIREMENTS.md outside tests/acceptance', () => {
  assert.ok(COMMITS.length > 0, 'no AP-0031 commits');
  for (const sha of COMMITS) {
    for (const [status, p] of changed(sha)) {
      if (p.startsWith('vm-intent/tests/acceptance/')) continue;
      assert.ok(ALLOWED.includes(p), `${sha.slice(0, 8)} changes ${p}`);
      assert.notEqual(status, 'A', `${sha.slice(0, 8)} adds ${p}`);
    }
  }
});

test('criterion 10: AP-0031 commits leave the existing acceptance suites unchanged', () => {
  for (const sha of COMMITS) {
    for (const [, p] of changed(sha)) {
      if (!p.startsWith('vm-intent/tests/acceptance/')) continue;
      assert.ok(p.startsWith('vm-intent/tests/acceptance/ap-0031/'), `${sha.slice(0, 8)} changes ${p}`);
    }
  }
});
