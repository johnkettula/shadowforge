// End-to-end: real Temporal server (temporal CLI, TEMPORAL_CLI or on PATH), real git, real
// processes; scripted agents instead of Claude. Each scenario gets its own fixture repo.
//
// The fixture project ("app"): server.mjs serves value.txt at /api/value; check.mjs is the
// build gate (fails if value.txt says "bad"); smoke.mjs is the check (fails if /api/value
// answers 500). The live server answers 500 when value.txt says "breaks-live".

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, Connection } from '@temporalio/client';
import { bundleWorkflowCode, NativeConnection, Worker, type WorkflowBundleWithSourceMap } from '@temporalio/worker';
import { createActivities } from '../src/activities.js';
import { ScriptedAgentRunner, defaultScript, type ScriptStep } from '../src/agents/runner.js';
import { defaultConfig } from '../src/config.js';
import type { PipelineConfig, Role } from '../src/types.js';
import { decideSignal, liveDeployWorkflow, pipelineWorkflow, resumeSignal, stageQuery, statusQuery, stopSignal, type PipelineState } from '../src/workflows.js';

const TEMPORAL = process.env.TEMPORAL_CLI ?? 'temporal';
const PORT = 17233 + Math.floor(Math.random() * 500);
let server: ChildProcess;
let connection: NativeConnection;
let client: Client;
let bundle: WorkflowBundleWithSourceMap;
const tmp = mkdtempSync(path.join(os.tmpdir(), 'ap-test-'));

const sh = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

before(async () => {
  server = spawn(TEMPORAL, ['server', 'start-dev', '--headless', '--port', String(PORT), '--http-port', String(PORT + 1000), '--metrics-port', String(PORT + 2000), '--log-level', 'error'], {
    stdio: 'ignore',
  });
  for (let i = 0; i < 240; i++) {
    try {
      connection = await NativeConnection.connect({ address: `127.0.0.1:${PORT}` });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const c = await Connection.connect({ address: `127.0.0.1:${PORT}` });
  client = new Client({ connection: c });
  bundle = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL('../src/workflows.ts', import.meta.url)), logger: { log() {}, info() {}, warn() {}, error() {}, debug() {}, trace() {} } as never });
});

after(async () => {
  await connection?.close();
  server?.kill('SIGTERM');
  rmSync(tmp, { recursive: true, force: true });
});

/** A bare "remote" with the fixture project on main, and a config pointing at it. */
function fixture(name: string, patch: Partial<PipelineConfig> = {}): PipelineConfig {
  const dir = path.join(tmp, name);
  const seed = path.join(dir, 'seed');
  const remote = path.join(dir, 'remote.git');
  mkdirSync(path.join(seed, 'app', 'db'), { recursive: true });
  writeFileSync(path.join(seed, 'app', 'value.txt'), 'one\n');
  writeFileSync(path.join(seed, 'app', 'db', 'V1__init.sql'), 'create table t (id int);\n');
  writeFileSync(path.join(seed, 'app', 'locked.txt'), 'people only\n');
  writeFileSync(
    path.join(seed, 'app', 'server.mjs'),
    `import http from 'node:http'; import { readFileSync } from 'node:fs';
http.createServer((req, res) => {
  const v = readFileSync(new URL('./value.txt', import.meta.url), 'utf8').trim();
  if (req.url === '/health') { res.end('ok'); return; }
  if (process.env.LIVE === '1' && v === 'breaks-live') { res.statusCode = 500; res.end('broken'); return; }
  res.end(JSON.stringify({ value: v }));
}).listen(Number(process.env.PORT), '127.0.0.1');
`,
  );
  writeFileSync(path.join(seed, 'app', 'check.mjs'), `import { readFileSync } from 'node:fs';\nif (readFileSync('value.txt','utf8').includes('bad')) { console.error('value.txt is bad'); process.exit(1); }\nconsole.log('gate ok');\n`);
  writeFileSync(path.join(seed, 'app', 'smoke.mjs'), `const r = await fetch(process.argv[2] + '/api/value');\nif (r.status !== 200) { console.error('smoke: status', r.status); process.exit(1); }\nconsole.log('smoke ok', await r.text());\n`);
  sh(seed, 'init', '-q', '-b', 'main');
  sh(seed, 'add', '-A');
  sh(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed');
  spawnSync('git', ['clone', '-q', '--bare', seed, remote]);

  const base = defaultConfig();
  const svc = (live: boolean) => ({
    name: 'server',
    cmd: 'node server.mjs',
    env: { PORT: '{port.api}', LIVE: live ? '1' : '0' },
    readyUrl: 'http://127.0.0.1:{port.api}/health',
    readyTimeoutSeconds: 20,
  });
  const portBase = 21000 + Math.floor(Math.random() * 300) * 20;
  return {
    ...base,
    home: path.join(dir, 'home'),
    repoUrl: remote,
    projectDir: 'app',
    push: true,
    agent: { mode: 'scripted' },
    protectedPaths: ['app/locked.txt'],
    appendOnly: ['app/db/**'],
    writableBy: { developer: ['app/**'], tester: ['app/acceptance/**'], redesign: ['app/docs/redesign/**'] },
    acceptanceDir: 'app/acceptance',
    requirementsDoc: 'app/docs/AGENT-REQUIREMENTS.md',
    gates: [{ name: 'gate', cmd: 'node check.mjs', timeoutMinutes: 1 }],
    checks: [{ name: 'smoke', cmd: 'node smoke.mjs {apiUrl}', timeoutMinutes: 1 }],
    staging: { mode: 'processes', services: [svc(false)], apiUrl: 'http://127.0.0.1:{port.api}', healthUrl: 'http://127.0.0.1:{port.api}/health', healthTimeoutSeconds: 20 },
    live: { mode: 'processes', services: [svc(true)], apiUrl: 'http://127.0.0.1:{port.api}', healthUrl: 'http://127.0.0.1:{port.api}/health', healthTimeoutSeconds: 20 },
    stagingPortBase: portBase,
    livePortBase: portBase + 150,
    limits: { ...base.limits, maxCyclesPerDay: 6, maxUsdPerDay: 25, maxDevAttempts: 3, minutesBetweenCycles: 0, redesignEvery: 0, consecutiveFailuresToPause: 3 },
    approval: { beforeBuild: false, beforeMerge: false },
    ...patch,
  };
}

/** Scripted steps: requirement with a given title/risk, developer writes value.txt (or other files). */
const requirementStep = (title: string, risk = 'low'): ScriptStep => () => ({
  found: true,
  reason: 'test',
  requirement: { title, rationale: 'because', acceptanceCriteria: ['/api/value answers'], risk, areas: ['app/value.txt'] },
});
const writeValue = (v: string): ScriptStep => (_t, tools) => {
  tools.write('app/value.txt', `${v}\n`);
  return { summary: `value=${v}`, filesChanged: ['app/value.txt'], testsAdded: [] };
};

function script(over: Partial<Record<Role, ScriptStep[]>>) {
  const d = defaultScript();
  return { ...d, requirements: [requirementStep('change the value')], developer: [writeValue('two')], ...over };
}

async function runPipeline(cfg: PipelineConfig, steps: Partial<Record<Role, ScriptStep[]>>, opts: { maxCycles?: number; cost?: number; during?: (wfId: string) => Promise<void> } = {}) {
  const taskQueue = `tq-${path.basename(path.dirname(cfg.home))}`;
  const worker = await Worker.create({
    connection,
    taskQueue,
    workflowBundle: bundle,
    activities: createActivities(new ScriptedAgentRunner(steps, opts.cost ?? 0.01)),
  });
  const wfId = `pipeline-${taskQueue}`;
  const result = await worker.runUntil(async () => {
    const h = await client.workflow.start(pipelineWorkflow, { taskQueue, workflowId: wfId, args: [{ cfg, maxCycles: opts.maxCycles ?? 1 }] });
    if (opts.during) await opts.during(wfId);
    return (await h.result()) as PipelineState;
  });
  // The live stack (if any) is left running by design; stop it so tests don't leak processes.
  const live = path.join(cfg.home, 'state', 'live.json');
  if (existsSync(live)) for (const pid of JSON.parse(readFileSync(live, 'utf8')).pids as number[]) try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
  return result;
}

const remoteLog = (cfg: PipelineConfig) => sh(cfg.repoUrl, 'log', '--format=%s', 'main');
const remoteFile = (cfg: PipelineConfig, f: string) => spawnSync('git', ['show', `main:${f}`], { cwd: cfg.repoUrl, encoding: 'utf8' }).stdout;
const ledger = (cfg: PipelineConfig) => JSON.parse(readFileSync(path.join(cfg.home, 'reports', 'ledger.json'), 'utf8'));

test('happy path: requirement → build → staging → tests → review → merge → push → live', async () => {
  const cfg = fixture('happy');
  const s = await runPipeline(cfg, script({}));
  assert.equal(s.recent[0].outcome, 'merged', s.recent[0].note);
  assert.equal(remoteFile(cfg, 'app/value.txt').trim(), 'two');
  assert.match(remoteFile(cfg, 'app/docs/AGENT-REQUIREMENTS.md'), /AP-0001: change the value/);
  assert.match(remoteFile(cfg, 'app/acceptance/ap-0001/requests-endpoint.test.mjs'), /scripted tester/);
  assert.match(remoteLog(cfg), /^AP-0001: change the value/);
  const report = readFileSync(ledger(cfg)[0].reportPath, 'utf8');
  assert.match(report, /review: approved/);
  assert.match(readFileSync(path.join(cfg.home, 'state', 'last-live-check.txt'), 'utf8'), /smoke: passed/);
  assert.equal(existsSync(path.join(cfg.home, 'worktrees', 'cycle-0001')), false, 'worktree cleaned up');
});

test('a failing gate goes back to the developer with the error, and the fix is merged', async () => {
  const cfg = fixture('gate');
  let sawFeedback = '';
  const s = await runPipeline(
    cfg,
    script({
      developer: [
        writeValue('bad'),
        (task, tools) => {
          sawFeedback = String((task.meta?.feedback as string[]).join('\n'));
          tools.write('app/value.txt', 'good\n');
          return { summary: 'fixed', filesChanged: [], testsAdded: [] };
        },
      ],
    }),
  );
  assert.equal(s.recent[0].outcome, 'merged', s.recent[0].note);
  assert.match(sawFeedback, /value.txt is bad/);
  assert.equal(ledger(cfg)[0].attempts, 2);
  assert.equal(remoteFile(cfg, 'app/value.txt').trim(), 'good');
});

test('protected files and changed migrations are undone and reported back', async () => {
  const cfg = fixture('rules');
  const feedback: string[] = [];
  const s = await runPipeline(
    cfg,
    script({
      developer: [
        (_t, tools) => {
          tools.writeUnchecked('app/locked.txt', 'hacked\n');
          tools.write('app/value.txt', 'x\n');
          return { summary: 'touched locked', filesChanged: [], testsAdded: [] };
        },
        (task, tools) => {
          feedback.push(...(task.meta?.feedback as string[]));
          tools.writeUnchecked('app/db/V1__init.sql', 'drop table t;\n');
          return { summary: 'edited a migration', filesChanged: [], testsAdded: [] };
        },
        (task, tools) => {
          feedback.push(...(task.meta?.feedback as string[]));
          tools.write('app/db/V2__more.sql', 'alter table t add column x int;\n');
          tools.write('app/value.txt', 'three\n');
          return { summary: 'new migration', filesChanged: [], testsAdded: [] };
        },
      ],
    }),
  );
  assert.equal(s.recent[0].outcome, 'merged', s.recent[0].note);
  assert.match(feedback.join('\n'), /locked.txt is protected/);
  assert.match(feedback.join('\n'), /V1__init.sql may only be added to/);
  assert.equal(remoteFile(cfg, 'app/locked.txt'), 'people only\n');
  assert.equal(remoteFile(cfg, 'app/db/V1__init.sql'), 'create table t (id int);\n');
  assert.match(remoteFile(cfg, 'app/db/V2__more.sql'), /alter table/);
});

test('a reviewer who never approves: abandoned, nothing merged', async () => {
  const cfg = fixture('review');
  const s = await runPipeline(cfg, script({ reviewer: [() => ({ approve: false, summary: 'no', blockingIssues: ['missing unit test'], suggestions: [] })] }));
  assert.equal(s.recent[0].outcome, 'abandoned');
  assert.equal(ledger(cfg)[0].attempts, 3);
  assert.match(s.recent[0].note, /missing unit test/);
  assert.equal(remoteLog(cfg), 'seed');
});

test('high-risk requirements are parked, not built', async () => {
  const cfg = fixture('risk');
  const s = await runPipeline(cfg, script({ requirements: [requirementStep('rewrite sign-in', 'high')] }));
  assert.equal(s.recent[0].outcome, 'parked');
  assert.equal(remoteLog(cfg), 'seed');
});

test('a merge that breaks live is reverted automatically and the pipeline pauses', { timeout: 120_000 }, async () => {
  const cfg = fixture('revert');
  const s = await runPipeline(cfg, script({ developer: [writeValue('breaks-live')] }), {
    maxCycles: 2,
    during: async (wfId) => {
      const h = client.workflow.getHandle(wfId);
      for (let i = 0; i < 200 && !(await h.query(statusQuery)).paused; i++) await new Promise((r) => setTimeout(r, 500));
      await h.signal(stopSignal);
    },
  });
  assert.equal(s.recent.length, 1, 'paused after the revert, so no second cycle');
  assert.equal(s.recent[0].outcome, 'reverted', s.recent[0].note);
  assert.equal(s.paused, true);
  assert.match(s.pauseReason ?? '', /broke the live deployment/);
  assert.equal(remoteFile(cfg, 'app/value.txt').trim(), 'one', 'remote is back to the old value');
  assert.match(remoteLog(cfg).split('\n')[0], /^Revert "AP-0001/);
  assert.match(readFileSync(path.join(cfg.home, 'state', 'last-live-check.txt'), 'utf8'), /smoke: passed/, 'live re-checked after the revert');
});

test('three failed cycles in a row pause the pipeline; resume carries on; stop ends it', { timeout: 180_000 }, async () => {
  const cfg = fixture('breaker', {});
  cfg.limits.maxDevAttempts = 1;
  const s = await runPipeline(cfg, script({ developer: [writeValue('bad')] }), {
    maxCycles: 4,
    during: async (wfId) => {
      const h = client.workflow.getHandle(wfId);
      for (let i = 0; i < 120; i++) {
        const st = await h.query(statusQuery);
        if (st.paused) {
          assert.equal(st.cycle, 3);
          assert.match(st.status, /3 failed cycles in a row/);
          await h.signal(resumeSignal);
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      for (let i = 0; i < 120; i++) {
        if ((await h.query(statusQuery)).cycle >= 4) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      await h.signal(stopSignal);
    },
  });
  assert.equal(s.cycle, 4);
  assert.deepEqual(s.recent.map((r) => r.outcome), ['abandoned', 'abandoned', 'abandoned', 'abandoned']);
});

test('a cycle that spends more than its limit stops as over-budget', async () => {
  const cfg = fixture('budget');
  cfg.limits.maxUsdPerCycle = 1;
  const s = await runPipeline(cfg, script({}), { cost: 0.6 });
  assert.equal(s.recent[0].outcome, 'over-budget', s.recent[0].note);
  assert.equal(remoteLog(cfg), 'seed');
});

test('a setup that cannot deploy the base branch pauses at preflight, before any agent runs', async () => {
  const cfg = fixture('preflight');
  cfg.staging = { ...cfg.staging, services: [{ name: 'server', cmd: 'node missing-server.mjs', readyUrl: 'http://127.0.0.1:{port.api}/health', readyTimeoutSeconds: 5 }] };
  let agentCalls = 0;
  const s = await runPipeline(
    cfg,
    script({ requirements: [() => { agentCalls++; return { found: false, reason: 'x' }; }] }),
  );
  // A one-off run (maxCycles) ends at a failed preflight; a long-running one would wait, paused.
  assert.equal(s.paused, true);
  assert.match(s.pauseReason ?? '', /^preflight failed[\s\S]*server did not start/);
  assert.equal(s.cycle, 0);
  assert.equal(agentCalls, 0);
});

test('redesign cycle: review doc merged, proposals on the backlog', async () => {
  const cfg = fixture('redesign');
  cfg.limits.redesignEvery = 1;
  const s = await runPipeline(
    cfg,
    script({
      redesign: [
        (task, tools) => {
          tools.write(String(task.meta?.docPath), '# Review\n\nThe server reads value.txt on every request.\n');
          tools.write('app/value.txt', 'sneaky\n'); // not allowed for the redesign role
          return { docPath: task.meta?.docPath, summary: 'cache the value', proposals: [{ title: 'Cache value.txt', rationale: 'read once', risk: 'low' }] };
        },
      ],
    }),
  );
  assert.equal(s.recent[0].outcome, 'redesigned', s.recent[0].note);
  assert.match(remoteFile(cfg, 'app/docs/redesign/review-0001.md'), /reads value.txt/);
  assert.equal(remoteFile(cfg, 'app/value.txt').trim(), 'one');
  assert.match(readFileSync(path.join(cfg.home, 'backlog.md'), 'utf8'), /Cache value.txt/);
});

/** Waits until cycle n of the pipeline is waiting at the given gate, and returns what it shows. */
async function waitForGate(wfId: string, n: number, gate: 'build' | 'merge') {
  const h = client.workflow.getHandle(`${wfId}-cycle-${n}`);
  for (let i = 0; i < 300; i++) {
    const st = await h.query(stageQuery).catch(() => undefined);
    if (st?.waiting?.gate === gate) return { h, st };
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`cycle ${n} never reached the ${gate} gate`);
}

test('approval gates: a person approves the build (with a note) and the merge; the branch is shown, then removed', { timeout: 120_000 }, async () => {
  const cfg = fixture('approve', { approval: { beforeBuild: true, beforeMerge: true } });
  let devPrompt = '';
  const s = await runPipeline(
    cfg,
    script({
      developer: [
        (task, tools) => {
          devPrompt = task.prompt;
          tools.write('app/value.txt', 'two\n');
          return { summary: 'value=two', filesChanged: ['app/value.txt'], testsAdded: [] };
        },
      ],
    }),
    {
      during: async (wfId) => {
        const b = await waitForGate(wfId, 1, 'build');
        assert.equal(b.st.stage, 'waiting for your OK to build');
        assert.equal(b.st.requirement?.title, 'change the value');
        assert.equal(devPrompt, '', 'nothing is built before the OK');
        await b.h.signal(decideSignal, { action: 'approve', note: 'keep the trailing newline' });
        const m = await waitForGate(wfId, 1, 'merge');
        assert.match(m.st.waiting?.details ?? '', /pushed agent\/cycle-0001 for review/);
        assert.match(sh(cfg.repoUrl, 'branch', '--list', 'agent/cycle-0001'), /agent\/cycle-0001/, 'branch pushed for review');
        assert.doesNotMatch(remoteLog(cfg), /AP-0001/, 'not merged before the OK');
        await m.h.signal(decideSignal, { action: 'approve' });
      },
    },
  );
  assert.equal(s.recent[0].outcome, 'merged', s.recent[0].note);
  assert.match(devPrompt, /Note from the person who approved it: keep the trailing newline/);
  assert.equal(remoteFile(cfg, 'app/value.txt').trim(), 'two');
  assert.equal(sh(cfg.repoUrl, 'branch', '--list', 'agent/cycle-0001').trim(), '', 'review branch removed afterwards');
});

test('approval gates: "skip" builds nothing; "reject" merges nothing', { timeout: 120_000 }, async () => {
  const cfg = fixture('decline', { approval: { beforeBuild: true, beforeMerge: true } });
  let built = 0;
  const s = await runPipeline(
    cfg,
    script({
      developer: [
        (_t, tools) => {
          built++;
          tools.write('app/value.txt', 'two\n');
          return { summary: 'value=two', filesChanged: ['app/value.txt'], testsAdded: [] };
        },
      ],
    }),
    {
      maxCycles: 2,
      during: async (wfId) => {
        const b1 = await waitForGate(wfId, 1, 'build');
        await b1.h.signal(decideSignal, { action: 'skip', note: 'not now' });
        const b2 = await waitForGate(wfId, 2, 'build');
        await b2.h.signal(decideSignal, { action: 'approve' });
        const m2 = await waitForGate(wfId, 2, 'merge');
        await m2.h.signal(decideSignal, { action: 'reject', note: 'wrong value' });
      },
    },
  );
  assert.deepEqual(s.recent.map((r) => r.outcome), ['skipped', 'rejected']);
  assert.match(s.recent[0].note, /skip \(not now\)/);
  assert.match(s.recent[1].note, /reject \(wrong value\)/);
  assert.equal(built, 1, 'the skipped requirement was never built');
  assert.equal(s.consecutiveFailures, 0, 'a person saying no is not a failure');
  assert.equal(remoteFile(cfg, 'app/value.txt').trim(), 'one', 'nothing merged');
  assert.equal(sh(cfg.repoUrl, 'branch', '--list', 'agent/*').trim(), '', 'no review branches left behind');
});

test('acceptance tests don\'t count toward the line limit: a passing tester\'s tests are kept', async () => {
  // The developer's change is 2 lines; the scripted tester's test file is longer than the limit.
  const cfg = fixture('testsize');
  cfg.limits.maxChangedLines = 4;
  const s = await runPipeline(cfg, script({}));
  assert.equal(s.recent[0].outcome, 'merged', s.recent[0].note);
  assert.match(remoteFile(cfg, 'app/acceptance/ap-0001/requests-endpoint.test.mjs'), /scripted tester/, 'the tests were kept');
  assert.doesNotMatch(readFileSync(ledger(cfg)[0].reportPath, 'utf8'), /tester broke the rules/);
});

test('deploy-live: a leftover process on the live port is stopped, and live is rebuilt and checked', { timeout: 120_000 }, async () => {
  const cfg = fixture('deploylive');
  // An orphan from an earlier live run, which the pipeline has no record of, holding the live API port.
  const orphan = spawn(process.execPath, ['-e', `require('http').createServer((q,r)=>{r.statusCode=500;r.end()}).listen(${cfg.livePortBase}, '127.0.0.1')`], { detached: true, stdio: 'ignore' });
  orphan.unref();
  await new Promise((r) => setTimeout(r, 800));
  const taskQueue = 'tq-deploylive';
  const worker = await Worker.create({ connection, taskQueue, workflowBundle: bundle, activities: createActivities(new ScriptedAgentRunner(script({}))) });
  const r = await worker.runUntil(client.workflow.execute(liveDeployWorkflow, { taskQueue, workflowId: 'deploy-live-test', args: [{ cfg }] }));
  const live = path.join(cfg.home, 'state', 'live.json');
  if (existsSync(live)) for (const pid of JSON.parse(readFileSync(live, 'utf8')).pids as number[]) try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
  let orphanAlive = true;
  try { process.kill(orphan.pid!, 0); } catch { orphanAlive = false; }
  if (orphanAlive) process.kill(orphan.pid!, 'SIGKILL');
  assert.equal(orphanAlive, false, 'the orphan on the live port was stopped');
  assert.equal(r.ok, true, r.note);
  assert.deepEqual(r.checks.map((c) => c.name), ['smoke']);
});
