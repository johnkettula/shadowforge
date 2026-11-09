// The pipeline's activities: everything that touches git, files, processes or an agent.
// The workflow decides what happens next; these do the work and report back plain data.

import { Context, ApplicationFailure } from '@temporalio/activity';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { defaultConfig, loadConfig } from './config.js';
import type { AgentRunner, AgentOutcome, AgentTask } from './agents/runner.js';
import { checkWrite, type PolicyContext } from './agents/policy.js';
import { developerPrompt, redesignPrompt, requirementsPrompt, reviewerPrompt, testerPrompt } from './agents/prompts.js';
import { DEVELOPER_SCHEMA, REDESIGN_SCHEMA, REQUIREMENT_SCHEMA, REVIEW_SCHEMA, TESTER_SCHEMA } from './agents/schemas.js';
import { fill, fillEnv, git, killListeners, killPostgresIn, killTree, removeDir, run, startService, stopProcessesUsing, waitForUrl } from './exec.js';
import { matchesAny, toPosix } from './glob.js';
import type {
  AgentUsage,
  CommandSpec,
  CyclePrep,
  CycleResult,
  DeploySpec,
  DiffCheck,
  GateResult,
  PipelineConfig,
  Requirement,
  Role,
  StagingHandle,
} from './types.js';

// ---------------------------------------------------------------------------------------------
// Paths

export const dirs = (cfg: PipelineConfig) => ({
  repo: path.join(cfg.home, 'repo'),
  worktrees: path.join(cfg.home, 'worktrees'),
  logs: path.join(cfg.home, 'logs'),
  reports: path.join(cfg.home, 'reports'),
  staging: path.join(cfg.home, 'staging'),
  state: path.join(cfg.home, 'state'),
  ledger: path.join(cfg.home, 'reports', 'ledger.json'),
  backlog: path.join(cfg.home, 'backlog.md'),
});

/** This pipeline's own folder (for its helper scripts). */
export const PIPELINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const pad = (n: number) => String(n).padStart(4, '0');
export const requirementId = (cycle: number) => `AP-${pad(cycle)}`;

function heartbeat(detail?: unknown): void {
  try {
    Context.current().heartbeat(detail);
  } catch {
    /* not inside an activity (unit tests) */
  }
}

function readLedger(cfg: PipelineConfig): CycleResult[] {
  try {
    return JSON.parse(readFileSync(dirs(cfg).ledger, 'utf8'));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------
// Repository

/** The pipeline's own clone, on the base branch and up to date with the remote. */
function ensureRepo(cfg: PipelineConfig): string {
  const d = dirs(cfg);
  if (!existsSync(path.join(d.repo, '.git'))) {
    mkdirSync(cfg.home, { recursive: true });
    git(cfg.home, ['clone', '--branch', cfg.baseBranch, cfg.repoUrl, d.repo]);
  }
  git(d.repo, ['config', 'user.name', cfg.git.authorName]);
  git(d.repo, ['config', 'user.email', cfg.git.authorEmail]);
  git(d.repo, ['fetch', 'origin', cfg.baseBranch], true);
  git(d.repo, ['checkout', cfg.baseBranch]);
  // Local merges that were never pushed (push: false) are kept; otherwise follow the remote.
  const ff = git(d.repo, ['merge', '--ff-only', `origin/${cfg.baseBranch}`], true);
  void ff;
  return d.repo;
}

function backlogText(cfg: PipelineConfig): string {
  const parts: string[] = [];
  const b = dirs(cfg).backlog;
  if (existsSync(b)) parts.push(readFileSync(b, 'utf8').trim());
  return parts.join('\n\n') || '(empty)';
}

export const DAILY_DOCS_PREFIX = 'Daily docs';

/**
 * The day's documentation update is due when docs are on and no cycle today (UTC) has picked it yet,
 * whatever its outcome: a failed one isn't retried the same day.
 */
export function dailyDocsDue(cfg: PipelineConfig, ledger: CycleResult[], now = new Date()): boolean {
  if (cfg.dailyDocs === false) return false;
  const today = now.toISOString().slice(0, 10);
  return !ledger.some((r) => r.startedAt?.slice(0, 10) === today && r.requirement?.title?.startsWith(DAILY_DOCS_PREFIX));
}

export const dailyDocsTask = (today: string) => `THIS CYCLE IS TODAY'S DOCUMENTATION UPDATE (asked for by John: "we should update documentation daily"
and "really check those docs for changes").
Pick exactly one requirement whose title starts with "${DAILY_DOCS_PREFIX} ${today}:". It brings the documentation in
line with the code as it is on ${'main'} now, and changes no code: README.md, docs/*.md (API, USER-GUIDE and the
generated frontend/public/user-guide.html if USER-GUIDE.md changes, TEMPORAL-FEATURES, DEFINITIONS, SECURITY,
VSPHERE, AZURE and the rest) and agent-pipeline-facing docs inside vm-intent.
Check thoroughly, not only the latest merges: read every one of those docs in full and check each concrete claim
(endpoints, settings and their defaults, states, file and class names, commands, counts, which clouds are real or
simulated) against the code. Also look at what was merged since the last daily docs update (git log,
${'docs/AGENT-REQUIREMENTS.md'}). Find every place the docs are now wrong, missing or out of date, and list each fix
as an acceptance criterion a tester can check by reading the files. Leave out anything already correct.
Dates: every doc this change edits must have a "Last updated ${today}." line near its top (just under the title),
added if it is missing and replaced if it shows an older date; make that an acceptance criterion naming each file.
Don't change the date of a doc you don't otherwise edit. Risk low. Don't touch backend/, frontend/src/, tests/
except docs-only files, or the OpenAPI snapshots. If nothing is out of date, say so and pick no requirement.`;

function contextFor(cfg: PipelineConfig, repo: string, mode: 'feature' | 'redesign' = 'feature'): string {
  const all = readLedger(cfg);
  const ledger = all.slice(-15);
  const lines = ledger.map(
    (r) => `- cycle ${r.cycle} (${r.mode}) ${r.requirement ? `${r.requirement.id} "${r.requirement.title}"` : ''}: ${r.outcome}${r.note ? ` — ${r.note.slice(0, 300)}` : ''}`,
  );
  const live = path.join(dirs(cfg).state, 'last-live-check.txt');
  const reqDoc = path.join(repo, cfg.requirementsDoc);
  const docsDue = mode === 'feature' && dailyDocsDue(cfg, all);
  return [
    ...(docsDue ? [dailyDocsTask(new Date().toISOString().slice(0, 10))] : []),
    `Recent pipeline cycles (newest last):\n${lines.join('\n') || '(none yet)'}`,
    `Backlog (from people and from redesign reviews):\n${backlogText(cfg)}`,
    `Last check of the live deployment:\n${existsSync(live) ? readFileSync(live, 'utf8').slice(-3000) : '(none yet)'}`,
    `Requirements the pipeline has built so far are listed in ${cfg.requirementsDoc}${existsSync(reqDoc) ? '' : ' (not created yet)'}.`,
  ].join('\n\n');
}

export async function prepareCycle(cfg: PipelineConfig, cycle: number, mode: 'feature' | 'redesign'): Promise<CyclePrep> {
  const d = dirs(cfg);
  const repo = ensureRepo(cfg);
  const branch = `agent/cycle-${pad(cycle)}`;
  // Leftovers from a cycle that was stopped hard (a worker restart, a crash): their databases first.
  killPostgresIn(d.staging);
  let worktree = path.join(d.worktrees, `cycle-${pad(cycle)}`);
  if (existsSync(worktree)) {
    git(repo, ['worktree', 'remove', '--force', worktree], true);
    if (!removeDir(worktree)) {
      // Something still holds it open: use a fresh folder rather than fail the cycle.
      worktree = `${worktree}-${Date.now().toString(36)}`;
    }
  }
  git(repo, ['worktree', 'prune']);
  mkdirSync(d.worktrees, { recursive: true });
  git(repo, ['worktree', 'add', '-B', branch, worktree, cfg.baseBranch]);
  const baseSha = git(worktree, ['rev-parse', 'HEAD']);
  return { cycle, mode, branch, worktree, baseSha, context: contextFor(cfg, repo, mode), portOffset: 10 * (cycle % 10) };
}

/** Best effort: a folder that can't be removed now is removed at the start of a later cycle. */
export async function cleanupCycle(cfg: PipelineConfig, prep: CyclePrep): Promise<{ left: string[] }> {
  const repo = dirs(cfg).repo;
  const stateDir = path.join(dirs(cfg).staging, `cycle-${pad(prep.cycle)}`);
  killPostgresIn(stateDir);
  await freeStateDir(stateDir);
  git(repo, ['worktree', 'remove', '--force', prep.worktree], true);
  const left: string[] = [];
  if (!removeDir(prep.worktree)) left.push(prep.worktree);
  git(repo, ['worktree', 'prune'], true);
  if (!removeDir(stateDir)) left.push(stateDir);
  // A branch pushed for review (publishBranch) is removed from the remote once the cycle is over.
  if (cfg.push && git(repo, ['ls-remote', '--heads', 'origin', prep.branch], true)) {
    git(repo, ['push', '-q', 'origin', '--delete', prep.branch], true);
  }
  return { left };
}

function diffFiles(cwd: string, from: string, to = 'HEAD', generated: string[] = []): { files: string[]; added: number; removed: number } {
  const out = git(cwd, ['diff', '--numstat', `${from}..${to}`]);
  let added = 0;
  let removed = 0;
  const files: string[] = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [a, r, f] = line.split('\t');
    const file = toPosix(f.includes(' => ') ? f.replace(/\{?([^{]*) => ([^}]*)\}?/, '$2') : f);
    files.push(file);
    if (matchesAny(file, generated)) continue;
    added += Number(a) || 0;
    removed += Number(r) || 0;
  }
  return { files, added, removed };
}

/**
 * Commits what an agent changed, then checks the commit against that role's rules and the
 * size limits. A commit that breaks a rule is undone, so the bad change never reaches a build.
 */
export async function commitAndCheck(cfg: PipelineConfig, prep: CyclePrep, role: Role, message: string): Promise<DiffCheck> {
  const wt = prep.worktree;
  git(wt, ['add', '-A']);
  const staged = git(wt, ['diff', '--cached', '--name-only']);
  if (!staged) {
    const sha = git(wt, ['rev-parse', 'HEAD']);
    const all = diffFiles(wt, prep.baseSha);
    return { sha, files: [], added: all.added, removed: all.removed, violations: [] };
  }
  git(wt, ['-c', `user.name=${cfg.git.authorName}`, '-c', `user.email=${cfg.git.authorEmail}`, 'commit', '-q', '--no-verify', '-m', message]);
  const sha = git(wt, ['rev-parse', 'HEAD']);
  const mine = diffFiles(wt, `${sha}~1`, sha);
  const ctx: PolicyContext = { cfg, role, root: wt };
  const violations: string[] = [];
  for (const f of mine.files) {
    const d = checkWrite(ctx, path.join(wt, f));
    if (!d.allow) violations.push(d.reason);
  }
  for (const line of git(wt, ['diff', '--name-status', `${sha}~1`, sha]).split('\n').filter(Boolean)) {
    const [status, file] = line.split('\t');
    if (status !== 'A' && matchesAny(file, cfg.appendOnly)) violations.push(`${file} may only be added to, never changed or deleted (status ${status})`);
  }
  // A pipeline started before `generated` existed carries a config without it: use the default then.
  // Acceptance tests count toward neither limit: they're the tester's, not part of the change, and
  // counting them threw away a passing tester's tests (lines in cycle 9, files in cycle 21).
  const notCounted = [...(cfg.generated ?? defaultConfig().generated ?? []), `${cfg.acceptanceDir}/**`];
  const total = diffFiles(wt, prep.baseSha, 'HEAD', notCounted);
  const countedFiles = total.files.filter((f) => !matchesAny(f, [`${cfg.acceptanceDir}/**`]));
  if (countedFiles.length > cfg.limits.maxChangedFiles)
    violations.push(`the change touches ${countedFiles.length} files (not counting acceptance tests); the limit is ${cfg.limits.maxChangedFiles}. Make it smaller.`);
  if (total.added + total.removed > cfg.limits.maxChangedLines)
    violations.push(`the change is ${total.added + total.removed} lines (not counting generated files or acceptance tests); the limit is ${cfg.limits.maxChangedLines}. Make it smaller.`);
  if (violations.length) {
    git(wt, ['reset', '-q', '--hard', `${sha}~1`]);
    return { sha: git(wt, ['rev-parse', 'HEAD']), files: mine.files, added: total.added, removed: total.removed, violations };
  }
  return { sha, files: mine.files, added: total.added, removed: total.removed, violations };
}

export async function diffStat(cfg: PipelineConfig, prep: CyclePrep): Promise<string> {
  return git(prep.worktree, ['diff', '--stat', `${prep.baseSha}..HEAD`]) || '(no changes)';
}

// ---------------------------------------------------------------------------------------------
// Commands, gates, deploys and checks

function vars(cfg: PipelineConfig, prep: CyclePrep | undefined, extra: Record<string, string> = {}): Record<string, string> {
  const root = prep?.worktree ?? dirs(cfg).repo;
  const base = prep ? cfg.stagingPortBase + prep.portOffset : cfg.livePortBase;
  const v: Record<string, string> = {
    ...cfg.vars,
    home: cfg.home,
    pipelineDir: PIPELINE_DIR,
    python: process.platform === 'win32' ? 'python' : 'python3',
    root,
    project: path.join(root, cfg.projectDir),
    cycle: String(prep?.cycle ?? 0),
    stateDir: prep ? path.join(dirs(cfg).staging, `cycle-${pad(prep.cycle)}`) : path.join(dirs(cfg).state, 'live'),
    composeProject: prep ? `vmintent-ap${prep.cycle % 10}` : 'vmintent-live',
    'port.api': String(base),
    'port.temporal': String(base + 1),
    'port.temporalUi': String(base + 2),
    'port.db': String(base + 3),
    'port.web': String(base + 4),
    'port.health': String(base + 5),
    ...extra,
  };
  return v;
}

async function runSpec(cfg: PipelineConfig, spec: CommandSpec, v: Record<string, string>, logFile: string): Promise<GateResult> {
  const cwd = spec.cwd ? path.resolve(v.project, fill(spec.cwd, v)) : v.project;
  mkdirSync(cwd, { recursive: true });
  const r = await run(fill(spec.cmd, v), {
    cwd,
    env: fillEnv(spec.env, v),
    timeoutMs: (spec.timeoutMinutes ?? 20) * 60_000,
    logFile,
    onOutput: () => heartbeat({ running: spec.name }),
  });
  return { name: spec.name, passed: r.code === 0 && !r.timedOut, seconds: Math.round(r.seconds), tail: r.tail.slice(-6000) };
}

/** The build gates (compile, unit tests, replay tests, web build). Stops at the first failure. */
export async function runGates(cfg: PipelineConfig, prep: CyclePrep, attempt: number): Promise<GateResult[]> {
  const v = vars(cfg, prep);
  const changed = diffFiles(prep.worktree, prep.baseSha).files;
  const out: GateResult[] = [];
  for (const g of cfg.gates) {
    if (g.onlyIfChanged && !changed.some((f) => matchesAny(f, g.onlyIfChanged!))) {
      out.push({ name: g.name, passed: true, skipped: true, seconds: 0, tail: '' });
      continue;
    }
    const r = await runSpec(cfg, g, v, path.join(dirs(cfg).logs, `cycle-${pad(prep.cycle)}`, `attempt-${attempt}-gates.log`));
    out.push(r);
    if (!r.passed) break;
  }
  return out;
}

/** The ports a deploy uses (they're its own: staging per cycle, live fixed). */
const deployPorts = (v: Record<string, string>) =>
  ['port.api', 'port.temporal', 'port.temporalUi', 'port.db', 'port.web', 'port.health'].map((k) => Number(v[k])).filter((n) => n > 0);

async function startDeploy(cfg: PipelineConfig, spec: DeploySpec, v: Record<string, string>, logDir: string): Promise<{ ok: boolean; handle: StagingHandle; tail: string }> {
  const handle: StagingHandle = { apiUrl: fill(spec.apiUrl, v), pids: [], stopCommands: spec.stop ?? [], vars: v, logDir };
  mkdirSync(logDir, { recursive: true });
  mkdirSync(v.stateDir, { recursive: true });
  // Anything left on this deploy's ports from an earlier run would hold files open or take the port.
  if (spec.mode === 'processes' && killListeners(deployPorts(v)).length) await new Promise((r) => setTimeout(r, 2000));
  for (const b of spec.build ?? []) {
    const r = await runSpec(cfg, b, v, path.join(logDir, 'build.log'));
    if (!r.passed) return { ok: false, handle, tail: `${b.name} failed:\n${r.tail}` };
  }
  if (spec.mode === 'commands') {
    for (const s of spec.start ?? []) {
      const r = await runSpec(cfg, s, v, path.join(logDir, 'start.log'));
      if (!r.passed) return { ok: false, handle, tail: `${s.name} failed:\n${r.tail}` };
    }
  } else if (spec.mode === 'processes') {
    for (const s of spec.services ?? []) {
      const logFile = path.join(logDir, `${s.name}.log`);
      const cwd = s.cwd ? path.resolve(v.project, fill(s.cwd, v)) : v.project;
      mkdirSync(cwd, { recursive: true });
      handle.pids.push(startService(fill(s.cmd, v), { cwd, env: fillEnv(s.env, v), logFile }));
      if (s.readyUrl) {
        const ok = await waitForUrl(fill(s.readyUrl, v), (s.readyTimeoutSeconds ?? 120) * 1000, () => heartbeat({ waiting: s.name }));
        if (!ok) return { ok: false, handle, tail: `${s.name} did not start in time. Its log ends:\n${tailOf(logFile)}` };
      }
    }
  }
  if (spec.healthUrl) {
    const ok = await waitForUrl(fill(spec.healthUrl, v), (spec.healthTimeoutSeconds ?? 180) * 1000, () => heartbeat({ waiting: 'health' }));
    if (!ok) return { ok: false, handle, tail: `the stack did not become healthy at ${fill(spec.healthUrl, v)}.\n${logTails(logDir)}` };
  }
  return { ok: true, handle, tail: '' };
}

function tailOf(file: string, lines = 60): string {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

function logTails(dir: string): string {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => `--- ${f}\n${tailOf(path.join(dir, f), 40)}`)
      .join('\n');
  } catch {
    return '';
  }
}

async function stopDeploy(cfg: PipelineConfig, handle: StagingHandle): Promise<void> {
  for (const s of handle.stopCommands) await runSpec(cfg, s, handle.vars, path.join(handle.logDir, 'stop.log'));
  for (const pid of [...handle.pids].reverse()) killTree(pid);
  await new Promise((r) => setTimeout(r, 1500));
  // Whatever outlived its recorded parent is still on the deploy's ports: stop that too.
  if (handle.pids.length && killListeners(deployPorts(handle.vars)).length) await new Promise((r) => setTimeout(r, 1500));
  // The backend's embedded Postgres runs on its own: stop it too.
  if (handle.vars.stateDir && killPostgresIn(handle.vars.stateDir).length) await new Promise((r) => setTimeout(r, 1500));
  // Then make sure nothing is still using the deploy's folder (a backend or Postgres that lost its
  // parent), and wait until it has really exited before anything starts there again.
  if (handle.vars.stateDir) await freeStateDir(handle.vars.stateDir, handle.logDir);
}

/** Stops whatever still uses a deploy's state folder and waits for it; notes stragglers in the log. */
async function freeStateDir(stateDir: string, logDir?: string): Promise<void> {
  const left = await stopProcessesUsing(stateDir);
  if (left.length && logDir) {
    mkdirSync(logDir, { recursive: true });
    appendFileSync(path.join(logDir, 'stop.log'), `${new Date().toISOString()} still running in ${stateDir} after waiting: pids ${left.join(', ')}\n`);
  }
}

export async function deployStaging(cfg: PipelineConfig, prep: CyclePrep, attempt: number): Promise<{ ok: boolean; handle?: StagingHandle; tail: string }> {
  if (cfg.staging.mode === 'none') return { ok: true, handle: { apiUrl: fill(cfg.staging.apiUrl, vars(cfg, prep)), pids: [], stopCommands: [], vars: {}, logDir: '' }, tail: '' };
  const v = vars(cfg, prep);
  killPostgresIn(v.stateDir);
  await freeStateDir(v.stateDir);
  removeDir(v.stateDir);
  const r = await startDeploy(cfg, cfg.staging, v, path.join(dirs(cfg).logs, `cycle-${pad(prep.cycle)}`, `attempt-${attempt}-staging`));
  if (!r.ok) await stopDeploy(cfg, r.handle);
  return r.ok ? r : { ok: false, tail: r.tail };
}

export async function stopStaging(cfg: PipelineConfig, handle: StagingHandle): Promise<void> {
  await stopDeploy(cfg, handle);
}

function acceptanceTests(root: string, dir: string): string[] {
  const base = path.join(root, dir);
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of existsSync(d) ? readdirSync(d) : []) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.test\.(mjs|js|cjs)$|^test_.*\.py$|_test\.py$/.test(name)) out.push(p);
    }
  };
  walk(base);
  return out.sort();
}

/** The checks against a running stack: the configured ones, then every acceptance test. */
export async function runChecks(cfg: PipelineConfig, prep: CyclePrep | undefined, apiUrl: string, label: string): Promise<GateResult[]> {
  const v = vars(cfg, prep, { apiUrl });
  const logFile = path.join(dirs(cfg).logs, prep ? `cycle-${pad(prep.cycle)}` : 'live', `${label}-checks.log`);
  const out: GateResult[] = [];
  for (const c of cfg.checks) out.push(await runSpec(cfg, c, v, logFile));
  for (const file of acceptanceTests(v.root, cfg.acceptanceDir)) {
    const rel = toPosix(path.relative(v.root, file));
    const cmd = file.endsWith('.py') ? `${v.python} "${file}"` : `node "${file}"`;
    out.push(await runSpec(cfg, { name: `acceptance: ${rel}`, cmd, cwd: v.root, env: { VMINTENT_API: apiUrl }, timeoutMinutes: 10 }, v, logFile));
  }
  if (!prep) {
    mkdirSync(dirs(cfg).state, { recursive: true });
    writeFileSync(
      path.join(dirs(cfg).state, 'last-live-check.txt'),
      `${new Date().toISOString()}\n${out.map((g) => `${g.name}: ${g.passed ? 'passed' : `FAILED\n${g.tail.slice(-1500)}`}`).join('\n')}\n`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Agents

/** Which runner does an agent stage: a fixed one (tests), or by the run's agent.mode. */
export type RunnerChoice = AgentRunner | ((cfg: PipelineConfig) => AgentRunner);

export function createAgentActivities(choice: RunnerChoice) {
  const pick = (cfg: PipelineConfig) => (typeof choice === 'function' ? choice(cfg) : choice);
  async function runAgent(cfg: PipelineConfig, task: AgentTask): Promise<AgentOutcome> {
    try {
      return await pick(cfg).run(task, cfg, heartbeat);
    } catch (err) {
      // An agent that crashes is a failed stage, not a reason to re-run it (and pay again).
      throw ApplicationFailure.nonRetryable(`${task.role} agent failed: ${(err as Error).message}`, 'AgentFailed');
    }
  }

  return {
    async requirementsAgent(cfg: PipelineConfig, prep: CyclePrep): Promise<{ requirement?: Requirement; reason: string; usage: AgentUsage; denied: string[] }> {
      const o = await runAgent(cfg, {
        role: 'requirements',
        cwd: prep.worktree,
        prompt: requirementsPrompt(cfg, prep.context),
        schema: REQUIREMENT_SCHEMA,
        meta: { projectDir: cfg.projectDir },
      });
      const out = o.output as { found?: boolean; reason?: string; requirement?: Omit<Requirement, 'id'> } | undefined;
      if (!out?.found || !out.requirement) return { reason: out?.reason ?? o.text.slice(0, 500), usage: o.usage, denied: o.denied };
      const r = out.requirement;
      const requirement: Requirement = {
        id: requirementId(prep.cycle),
        title: String(r.title).slice(0, 200),
        rationale: String(r.rationale),
        acceptanceCriteria: (r.acceptanceCriteria ?? []).map(String).slice(0, 12),
        risk: r.risk === 'low' || r.risk === 'medium' ? r.risk : 'high',
        areas: (r.areas ?? []).map(String),
      };
      return { requirement, reason: out.reason ?? '', usage: o.usage, denied: o.denied };
    },

    async developerAgent(cfg: PipelineConfig, prep: CyclePrep, req: Requirement, feedback: string[]): Promise<{ summary: string; usage: AgentUsage; denied: string[] }> {
      const o = await runAgent(cfg, {
        role: 'developer',
        cwd: prep.worktree,
        prompt: developerPrompt(cfg, req, feedback),
        schema: DEVELOPER_SCHEMA,
        meta: { projectDir: cfg.projectDir, requirementId: req.id, requirementTitle: req.title, feedback },
      });
      return { summary: String((o.output as { summary?: string } | undefined)?.summary ?? o.text).slice(0, 2000), usage: o.usage, denied: o.denied };
    },

    async testerAgent(cfg: PipelineConfig, prep: CyclePrep, req: Requirement, apiUrl: string): Promise<{ passed: boolean; summary: string; failures: string[]; usage: AgentUsage; denied: string[] }> {
      const host = new URL(apiUrl).hostname;
      const o = await runAgent(cfg, {
        role: 'tester',
        cwd: prep.worktree,
        prompt: testerPrompt(cfg, req, apiUrl),
        schema: TESTER_SCHEMA,
        stagingHosts: [host, 'localhost', '127.0.0.1'],
        meta: { requirementId: req.id, testDir: `${cfg.acceptanceDir}/${req.id.toLowerCase()}`, apiUrl },
      });
      const out = o.output as { passed?: boolean; summary?: string; failures?: string[] } | undefined;
      return { passed: Boolean(out?.passed), summary: String(out?.summary ?? o.text).slice(0, 2000), failures: (out?.failures ?? []).map(String), usage: o.usage, denied: o.denied };
    },

    async reviewerAgent(cfg: PipelineConfig, prep: CyclePrep, req: Requirement, gates: GateResult[]): Promise<{ approve: boolean; summary: string; blockingIssues: string[]; usage: AgentUsage; denied: string[] }> {
      const stat = git(prep.worktree, ['diff', '--stat', `${prep.baseSha}..HEAD`]);
      const o = await runAgent(cfg, {
        role: 'reviewer',
        cwd: prep.worktree,
        prompt: reviewerPrompt(cfg, req, stat, gates).replace(`${cfg.baseBranch}...HEAD`, `${prep.baseSha}..HEAD`),
        schema: REVIEW_SCHEMA,
        meta: { requirementId: req.id },
      });
      const out = o.output as { approve?: boolean; summary?: string; blockingIssues?: string[] } | undefined;
      return {
        approve: out?.approve === true && (out.blockingIssues ?? []).length === 0,
        summary: String(out?.summary ?? o.text).slice(0, 2000),
        blockingIssues: (out?.blockingIssues ?? (out ? [] : ['the reviewer gave no verdict'])).map(String),
        usage: o.usage,
        denied: o.denied,
      };
    },

    async redesignAgent(cfg: PipelineConfig, prep: CyclePrep): Promise<{ docPath: string; summary: string; proposals: { title: string; rationale: string; risk: string }[]; usage: AgentUsage; denied: string[] }> {
      const docPath = `${cfg.projectDir}/docs/redesign/review-${pad(prep.cycle)}.md`;
      const o = await runAgent(cfg, {
        role: 'redesign',
        cwd: prep.worktree,
        prompt: redesignPrompt(cfg, prep.context, docPath),
        schema: REDESIGN_SCHEMA,
        meta: { docPath },
      });
      const out = o.output as { summary?: string; proposals?: { title: string; rationale: string; risk: string }[] } | undefined;
      const proposals = (out?.proposals ?? []).slice(0, 3).map((p) => ({ title: String(p.title), rationale: String(p.rationale), risk: String(p.risk) }));
      if (proposals.length) {
        mkdirSync(cfg.home, { recursive: true });
        const b = dirs(cfg).backlog;
        if (!existsSync(b)) writeFileSync(b, '# Backlog\n\nPeople can add items here too. The requirements agent reads this file every cycle.\n\n');
        appendFileSync(b, proposals.map((p) => `- [redesign ${pad(prep.cycle)}] ${p.title} (risk ${p.risk}): ${p.rationale}\n`).join(''));
      }
      return { docPath, summary: String(out?.summary ?? o.text).slice(0, 2000), proposals, usage: o.usage, denied: o.denied };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Recording, merging, live deploy, revert

export async function recordRequirement(cfg: PipelineConfig, prep: CyclePrep, req: Requirement, attempts: number, summary: string): Promise<void> {
  const file = path.join(prep.worktree, cfg.requirementsDoc);
  mkdirSync(path.dirname(file), { recursive: true });
  if (!existsSync(file)) {
    writeFileSync(
      file,
      '# Requirements built by the agent pipeline\n\nEach entry was chosen, built, tested, reviewed and merged by the agent pipeline (agent-pipeline/). Newest last.\n',
    );
  }
  appendFileSync(
    file,
    `\n## ${req.id}: ${req.title}\n\n${req.rationale}\n\nAcceptance criteria:\n${req.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}\n\nRisk: ${req.risk}. Attempts: ${attempts}. Built: ${new Date().toISOString().slice(0, 10)}.\n\n${summary.trim()}\n`,
  );
  git(prep.worktree, ['add', '-A']);
  git(prep.worktree, ['-c', `user.name=${cfg.git.authorName}`, '-c', `user.email=${cfg.git.authorEmail}`, 'commit', '-q', '--no-verify', '-m', `${req.id}: record the requirement`]);
}

function tryPush(cfg: PipelineConfig, repo: string): string | undefined {
  if (!cfg.push) return undefined;
  const r = git(repo, ['push', 'origin', `${cfg.baseBranch}:${cfg.baseBranch}`], true);
  const ahead = git(repo, ['rev-list', '--count', `origin/${cfg.baseBranch}..${cfg.baseBranch}`], true);
  git(repo, ['fetch', 'origin', cfg.baseBranch], true);
  const stillAhead = git(repo, ['rev-list', '--count', `origin/${cfg.baseBranch}..${cfg.baseBranch}`], true);
  return stillAhead === '0' ? undefined : `push failed (${ahead} commits not on the remote): ${r}`;
}

/** A web link to compare a branch with the base branch, for GitHub and GitLab remotes. */
function compareUrl(cfg: PipelineConfig, branch: string): string | undefined {
  const m = cfg.repoUrl.match(/^(?:https:\/\/|git@)(github\.com|gitlab\.com)[/:](.+?)(?:\.git)?$/);
  if (!m) return undefined;
  return m[1] === 'github.com'
    ? `https://github.com/${m[2]}/compare/${cfg.baseBranch}...${branch}`
    : `https://gitlab.com/${m[2]}/-/compare/${cfg.baseBranch}...${branch}`;
}

/**
 * Pushes the cycle's branch (not the base branch) so a person can look at the change before
 * approving the merge. The branch is deleted from the remote again when the cycle ends.
 */
export async function publishBranch(cfg: PipelineConfig, prep: CyclePrep): Promise<{ pushed: boolean; note: string }> {
  const repo = ensureRepo(cfg);
  const stat = git(repo, ['diff', '--stat', `${prep.baseSha}..${prep.branch}`], true) || '(no changes)';
  if (!cfg.push) return { pushed: false, note: `branch ${prep.branch} (not pushed; push is off)\n${stat}` };
  const r = spawnSync('git', ['push', '-q', '--force', 'origin', `${prep.branch}:refs/heads/${prep.branch}`], { cwd: repo, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return { pushed: false, note: `could not push ${prep.branch} for review: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}\n${stat}` };
  const url = compareUrl(cfg, prep.branch);
  return { pushed: true, note: `pushed ${prep.branch} for review${url ? `: ${url}` : ''}\n${stat}` };
}

export async function mergeToMain(cfg: PipelineConfig, prep: CyclePrep, title: string): Promise<{ ok: boolean; sha?: string; note: string }> {
  const repo = ensureRepo(cfg);
  const before = git(repo, ['rev-parse', 'HEAD']);
  const r = git(repo, ['merge', '--no-ff', '-q', prep.branch, '-m', `${title}\n\nBuilt, tested and reviewed by the agent pipeline (cycle ${prep.cycle}).`], true);
  if (git(repo, ['rev-parse', 'HEAD']) === before) {
    git(repo, ['merge', '--abort'], true);
    return { ok: false, note: `merge conflict with ${cfg.baseBranch}: ${r.slice(0, 500)}` };
  }
  const sha = git(repo, ['rev-parse', 'HEAD']);
  const pushErr = tryPush(cfg, repo);
  if (pushErr) {
    git(repo, ['reset', '-q', '--hard', before]);
    return { ok: false, note: pushErr };
  }
  return { ok: true, sha, note: cfg.push ? `merged and pushed ${sha.slice(0, 10)}` : `merged ${sha.slice(0, 10)} (not pushed)` };
}

export async function revertMerge(cfg: PipelineConfig, mergeSha: string, why: string): Promise<{ ok: boolean; sha?: string; note: string }> {
  const repo = ensureRepo(cfg);
  const r = git(repo, ['revert', '-m', '1', '--no-edit', mergeSha], true);
  const sha = git(repo, ['rev-parse', 'HEAD']);
  if (sha === mergeSha || !git(repo, ['log', '-1', '--format=%s']).startsWith('Revert')) {
    git(repo, ['revert', '--abort'], true);
    return { ok: false, note: `could not revert ${mergeSha.slice(0, 10)}: ${r.slice(0, 300)}` };
  }
  git(repo, ['commit', '--amend', '-q', '-m', `${git(repo, ['log', '-1', '--format=%B'])}\n\nAutomatic revert by the agent pipeline: ${why.slice(0, 500)}`]);
  const revertSha = git(repo, ['rev-parse', 'HEAD']);
  const pushErr = tryPush(cfg, repo);
  return { ok: !pushErr, sha: revertSha, note: pushErr ?? `reverted with ${revertSha.slice(0, 10)}` };
}

/** Rebuilds and restarts the live deployment from the pipeline's clone of the base branch. */
export async function deployLive(cfg: PipelineConfig): Promise<{ ok: boolean; apiUrl: string; tail: string }> {
  ensureRepo(cfg);
  const v = vars(cfg, undefined);
  if (cfg.live.mode === 'none') return { ok: true, apiUrl: fill(cfg.live.apiUrl, v), tail: '' };
  const stateFile = path.join(dirs(cfg).state, 'live.json');
  if (existsSync(stateFile)) {
    const old = JSON.parse(readFileSync(stateFile, 'utf8')) as StagingHandle;
    await stopDeploy(cfg, old);
  }
  const logDir = path.join(dirs(cfg).logs, 'live');
  // Belt and braces: nothing from an earlier live run (recorded or not) may still hold its folder.
  if (v.stateDir) await freeStateDir(v.stateDir, logDir);
  let r = await startDeploy(cfg, cfg.live, v, logDir);
  if (!r.ok) {
    // One more try before the caller reverts a merge: a start that failed because the machine was
    // busy or an old process was slow to let go usually works the second time.
    await stopDeploy(cfg, r.handle);
    await new Promise((res) => setTimeout(res, 15_000));
    const second = await startDeploy(cfg, cfg.live, v, logDir);
    if (!second.ok) second.tail = `first try:\n${r.tail}\n\nsecond try:\n${second.tail}`;
    r = second;
  }
  mkdirSync(dirs(cfg).state, { recursive: true });
  writeFileSync(stateFile, JSON.stringify(r.handle));
  return { ok: r.ok, apiUrl: r.handle.apiUrl, tail: r.tail };
}

export async function writeReport(cfg: PipelineConfig, result: CycleResult, details: string[]): Promise<string> {
  const d = dirs(cfg);
  mkdirSync(d.reports, { recursive: true });
  const file = path.join(d.reports, `cycle-${pad(result.cycle)}.md`);
  const req = result.requirement;
  writeFileSync(
    file,
    `# Cycle ${result.cycle} (${result.mode}): ${result.outcome}\n\n` +
      `${result.startedAt} → ${result.endedAt} · ${result.attempts} attempt(s) · $${result.costUsd.toFixed(2)}\n\n` +
      (req ? `## ${req.id}: ${req.title}\n\n${req.rationale}\n\nRisk: ${req.risk}\n\n${req.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}\n\n` : '') +
      `## What happened\n\n${result.note}\n\n${details.map((x) => `- ${x.replace(/\n/g, '\n  ')}`).join('\n')}\n`,
  );
  const ledger = readLedger(cfg);
  ledger.push({ ...result, reportPath: file });
  writeFileSync(d.ledger, JSON.stringify(ledger, null, 2));
  return file;
}

/**
 * Before any agent runs: can the pipeline clone, build, deploy and check the base branch as it is?
 * If not, the problem is the setup, not an agent's change, and no money should be spent.
 */
export async function preflight(cfg: PipelineConfig): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  if (cfg.agent.mode === 'claude' && !process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN)
    problems.push('No ANTHROPIC_API_KEY is set for the worker, so the agents cannot run. Set it (see README), restart the worker, then resume.');
  let prep: CyclePrep;
  try {
    prep = await prepareCycle(cfg, 0, 'feature');
  } catch (e) {
    return { ok: false, problems: [...problems, `cannot get the repository: ${(e as Error).message}`] };
  }
  try {
    const dep = await deployStaging(cfg, prep, 0);
    if (!dep.ok || !dep.handle) {
      problems.push(`the base branch does not deploy to staging, before any change:\n${dep.tail.slice(-3000)}`);
    } else {
      try {
        const checks = await runChecks(cfg, prep, dep.handle.apiUrl, 'preflight');
        for (const g of checks.filter((c) => !c.passed)) problems.push(`check "${g.name}" fails on the base branch, before any change:\n${g.tail.slice(-2000)}`);
      } finally {
        await stopDeploy(cfg, dep.handle);
      }
    }
  } finally {
    await cleanupCycle(cfg, prep);
  }
  return { ok: problems.length === 0, problems };
}

/** The config the worker would start a pipeline with (pipeline.config.json in its folder). */
export async function currentConfig(): Promise<PipelineConfig> {
  return loadConfig();
}

export const plainActivities = {
  currentConfig,
  preflight,
  prepareCycle,
  cleanupCycle,
  commitAndCheck,
  diffStat,
  runGates,
  deployStaging,
  stopStaging,
  runChecks,
  recordRequirement,
  publishBranch,
  mergeToMain,
  revertMerge,
  deployLive,
  writeReport,
};

export function createActivities(choice: RunnerChoice) {
  return { ...plainActivities, ...createAgentActivities(choice) };
}

export type Activities = ReturnType<typeof createActivities>;
