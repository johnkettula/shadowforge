// The pipeline as Temporal workflows.
//
//   pipelineWorkflow  runs cycles one after another, within the daily limits, until stopped.
//                     Signals: pause, resume, stop, runNow. Query: status.
//   cycleWorkflow     one cycle: requirement → (a person approves) → develop → gates → staging →
//                     acceptance tests → independent review → (a person approves) → merge →
//                     live deploy → live check → (revert). Signal: decide. Query: stage.
//                     Every Nth cycle is a redesign review instead.
//
// Workflow code must be deterministic: no I/O here, only decisions. All work is in activities.

import {
  ActivityFailure,
  ApplicationFailure,
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  executeChild,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type { Activities } from './activities.js';
import type { CycleOutcome, CyclePrep, CycleResult, GateResult, PipelineConfig, Requirement, StagingHandle } from './types.js';

// Agents: long and expensive. An agent that fails is not retried (its failure is non-retryable),
// but one cut off by a worker restart or crash (a heartbeat timeout) gets one more try.
const agents = proxyActivities<Activities>({
  startToCloseTimeout: '90 minutes',
  heartbeatTimeout: '10 minutes',
  retry: { maximumAttempts: 2, initialInterval: '10 seconds' },
});
// Builds, deploys, checks: long, and they report failure as data rather than throwing.
const work = proxyActivities<Activities>({
  startToCloseTimeout: '3 hours',
  heartbeatTimeout: '15 minutes',
  retry: { maximumAttempts: 2, initialInterval: '30 seconds' },
});
// Git and files: quick, safe to retry.
const quick = proxyActivities<Activities>({
  startToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 3, initialInterval: '5 seconds' },
});

// ---------------------------------------------------------------------------------------------
// One cycle

/** What a cycle is waiting on, while it waits for a person. */
export interface Waiting {
  gate: 'build' | 'merge';
  since: string;
  /** For the merge gate: where to look at the change (the pushed branch, its diff stat). */
  details?: string;
}
export const stageQuery = defineQuery<{ stage: string; attempt: number; requirement?: Requirement; costUsd: number; log: string[]; waiting?: Waiting }>('stage');

/** A person's answer at an approval gate. A note on "approve" before building is passed to the developer. */
export interface Decision {
  action: 'approve' | 'skip' | 'reject';
  note?: string;
}
export const decideSignal = defineSignal<[Decision]>('decide');

export interface CycleInput {
  cfg: PipelineConfig;
  cycle: number;
  mode: 'feature' | 'redesign';
}

const failed = (gs: GateResult[]) => gs.filter((g) => !g.passed);
const describe = (gs: GateResult[]) => failed(gs).map((g) => `${g.name} failed:\n${g.tail.slice(-3000)}`).join('\n\n');

export async function cycleWorkflow({ cfg, cycle, mode }: CycleInput): Promise<CycleResult> {
  const startedAt = new Date().toISOString();
  let stage = 'preparing';
  let attempt = 0;
  let costUsd = 0;
  let requirement: Requirement | undefined;
  const log: string[] = [];
  let waiting: Waiting | undefined;
  let decision: Decision | undefined;
  setHandler(stageQuery, () => ({ stage, attempt, requirement, costUsd, log, waiting }));
  // Only an answer given while the cycle is actually waiting counts.
  setHandler(decideSignal, (d: Decision) => {
    if (waiting && !decision) decision = d;
  });
  const note = (s: string) => log.push(`${new Date().toISOString().slice(11, 19)} ${s}`);
  const spend = (usd: number) => {
    costUsd += usd;
    if (costUsd > cfg.limits.maxUsdPerCycle) throw ApplicationFailure.nonRetryable(`cycle spent $${costUsd.toFixed(2)}, over its $${cfg.limits.maxUsdPerCycle} limit`, 'OverBudget');
  };

  /** Stops until a person decides. No answer in time counts as skip (build) or reject (merge). */
  async function askPerson(gate: Waiting['gate'], details?: string): Promise<Decision> {
    waiting = { gate, since: new Date().toISOString(), details };
    decision = undefined;
    stage = gate === 'build' ? 'waiting for your OK to build' : 'waiting for your OK to merge';
    note(stage);
    const days = cfg.approval?.waitDays ?? 7;
    const answered = await condition(() => decision !== undefined, days * 86_400_000);
    const d: Decision = answered && decision ? decision : { action: gate === 'build' ? 'skip' : 'reject', note: `no answer within ${days} days` };
    waiting = undefined;
    note(`person: ${d.action}${d.note ? `: ${d.note.slice(0, 300)}` : ''}`);
    return d;
  }

  const prep: CyclePrep = await quick.prepareCycle(cfg, cycle, mode);
  let outcome: CycleOutcome = 'error';
  let summary = '';
  let mergeSha: string | undefined;
  let revertSha: string | undefined;
  try {
    if (mode === 'redesign') {
      stage = 'redesign review';
      const r = await agents.redesignAgent(cfg, prep);
      spend(r.usage.costUsd);
      note(`redesign: ${r.summary}`);
      const c = await quick.commitAndCheck(cfg, prep, 'redesign', `Design review (cycle ${cycle})`);
      if (c.violations.length) {
        outcome = 'abandoned';
        summary = `the design review broke the rules: ${c.violations.join('; ')}`;
      } else if (!c.files.length) {
        outcome = 'no-work';
        summary = 'the redesign agent wrote nothing';
      } else {
        stage = 'merging';
        const m = await quick.mergeToMain(cfg, prep, `Design review ${cycle}: ${r.summary.split('\n')[0].slice(0, 80)}`);
        outcome = m.ok ? 'redesigned' : 'abandoned';
        mergeSha = m.sha;
        summary = `${r.proposals.length} proposal(s) added to the backlog. ${m.note}`;
        r.proposals.forEach((p) => note(`proposal: ${p.title} (${p.risk})`));
      }
      return await finish();
    }

    // 1. Requirement
    stage = 'choosing a requirement';
    const req = await agents.requirementsAgent(cfg, prep);
    spend(req.usage.costUsd);
    if (!req.requirement) {
      outcome = 'no-work';
      summary = `nothing to do: ${req.reason}`;
      return await finish();
    }
    requirement = req.requirement;
    note(`requirement ${requirement.id}: ${requirement.title} (risk ${requirement.risk})`);
    if (requirement.risk === 'high') {
      outcome = 'parked';
      summary = 'high risk: parked for a person to decide (not built)';
      return await finish();
    }
    if (cfg.approval?.beforeBuild) {
      const d = await askPerson('build');
      if (d.action !== 'approve') {
        outcome = 'skipped';
        summary = `not built: a person said ${d.action}${d.note ? ` (${d.note})` : ''}`;
        return await finish();
      }
      if (d.note) requirement = { ...requirement, rationale: `${requirement.rationale}\n\nNote from the person who approved it: ${d.note}` };
    }

    // 2. Develop → gates → staging → acceptance tests → review, until it passes or attempts run out.
    let feedback: string[] = [];
    let approved = false;
    let lastGates: GateResult[] = [];
    while (!approved && attempt < cfg.limits.maxDevAttempts) {
      attempt++;
      stage = 'developing';
      const dev = await agents.developerAgent(cfg, prep, requirement, feedback);
      spend(dev.usage.costUsd);
      note(`attempt ${attempt}: developer: ${dev.summary.split('\n')[0].slice(0, 200)}`);
      feedback = [];
      const c = await quick.commitAndCheck(cfg, prep, 'developer', `${requirement.id}: ${requirement.title} (attempt ${attempt})`);
      if (c.violations.length) {
        feedback.push(`Your change was undone because it broke the pipeline's rules:\n- ${c.violations.join('\n- ')}`);
        note(`attempt ${attempt}: rules broken: ${c.violations.join('; ')}`);
        continue;
      }
      if (c.added + c.removed === 0) {
        feedback.push('You made no changes. Build the requirement.');
        note(`attempt ${attempt}: no changes`);
        continue;
      }

      stage = 'build gates';
      const gates = await work.runGates(cfg, prep, attempt);
      if (failed(gates).length) {
        feedback.push(describe(gates));
        note(`attempt ${attempt}: gates failed: ${failed(gates).map((g) => g.name).join(', ')}`);
        continue;
      }

      stage = 'deploying to staging';
      const dep = await work.deployStaging(cfg, prep, attempt);
      if (!dep.ok || !dep.handle) {
        feedback.push(`The staging deploy failed:\n${dep.tail.slice(-4000)}`);
        note(`attempt ${attempt}: staging deploy failed`);
        continue;
      }
      const handle: StagingHandle = dep.handle;
      let checks: GateResult[] = [];
      try {
        stage = 'writing acceptance tests';
        const t = await agents.testerAgent(cfg, prep, requirement, handle.apiUrl);
        spend(t.usage.costUsd);
        note(`attempt ${attempt}: tester: ${t.passed ? 'passed' : 'failed'}: ${t.summary.split('\n')[0].slice(0, 200)}`);
        const tc = await quick.commitAndCheck(cfg, prep, 'tester', `${requirement.id}: acceptance tests (attempt ${attempt})`);
        if (tc.violations.length) note(`attempt ${attempt}: tester broke the rules (undone): ${tc.violations.join('; ')}`);
        stage = 'running checks on staging';
        checks = await work.runChecks(cfg, prep, handle.apiUrl, `attempt-${attempt}-staging`);
        if (!t.passed && t.failures.length) checks.push({ name: 'tester verdict', passed: false, seconds: 0, tail: t.failures.join('\n') });
      } finally {
        stage = 'stopping staging';
        await work.stopStaging(cfg, handle);
      }
      if (failed(checks).length) {
        feedback.push(`Checks against the staging server failed:\n${describe(checks)}`);
        note(`attempt ${attempt}: staging checks failed: ${failed(checks).map((g) => g.name).join(', ')}`);
        continue;
      }
      lastGates = [...gates, ...checks];

      stage = 'independent review';
      const rv = await agents.reviewerAgent(cfg, prep, requirement, lastGates);
      spend(rv.usage.costUsd);
      if (!rv.approve) {
        feedback.push(`The reviewer did not approve:\n${rv.summary}\nBlocking issues:\n- ${rv.blockingIssues.join('\n- ')}`);
        note(`attempt ${attempt}: review: changes requested: ${rv.blockingIssues.join('; ').slice(0, 300)}`);
        continue;
      }
      note(`attempt ${attempt}: review: approved: ${rv.summary.split('\n')[0].slice(0, 200)}`);
      approved = true;
    }
    if (!approved) {
      outcome = 'abandoned';
      summary = `not approved after ${attempt} attempt(s). Last feedback:\n${feedback.join('\n').slice(0, 1500)}`;
      return await finish();
    }

    // 3. A person approves the merge, if asked to; then merge, deploy live, check live, revert if live breaks.
    if (cfg.approval?.beforeMerge) {
      stage = 'publishing the branch for review';
      const pub = await quick.publishBranch(cfg, prep);
      note(pub.note.split('\n')[0]);
      const d = await askPerson('merge', pub.note);
      if (d.action !== 'approve') {
        outcome = 'rejected';
        summary = `built and checked, but not merged: a person said ${d.action}${d.note ? ` (${d.note})` : ''}`;
        return await finish();
      }
    }
    stage = 'merging';
    await quick.recordRequirement(cfg, prep, requirement, attempt, log.filter((l) => l.includes('developer:') || l.includes('review:')).slice(-2).join('\n'));
    const m = await quick.mergeToMain(cfg, prep, `${requirement.id}: ${requirement.title}`);
    if (!m.ok || !m.sha) {
      outcome = 'abandoned';
      summary = m.note;
      return await finish();
    }
    mergeSha = m.sha;
    note(m.note);
    if (cfg.live.mode === 'none') {
      outcome = 'merged';
      summary = `${m.note}. No live deployment configured.`;
      return await finish();
    }
    stage = 'deploying live';
    const live = await work.deployLive(cfg);
    let liveChecks: GateResult[] = [];
    if (live.ok) {
      stage = 'checking live';
      liveChecks = await work.runChecks(cfg, undefined, live.apiUrl, `after-${requirement.id}`);
    }
    if (!live.ok || failed(liveChecks).length) {
      const why = live.ok ? describe(liveChecks) : `live deploy failed: ${live.tail}`;
      stage = 'reverting';
      note(`live broke after the merge: ${why.slice(0, 300)}`);
      const rv = await quick.revertMerge(cfg, mergeSha, why);
      revertSha = rv.sha;
      note(rv.note);
      stage = 'redeploying live';
      const again = await work.deployLive(cfg);
      if (again.ok) await work.runChecks(cfg, undefined, again.apiUrl, `after-revert-${requirement.id}`);
      outcome = 'reverted';
      summary = `merged, but the live deployment failed its checks, so it was reverted (${rv.note}). ${again.ok ? 'Live is back on the previous version.' : 'Live did NOT come back up: look at it.'}\n${why.slice(0, 1500)}`;
      return await finish();
    }
    outcome = 'merged';
    summary = `${m.note}; live deployment updated and checked (${liveChecks.length} checks passed).`;
    return await finish();
  } catch (err) {
    const cause = err instanceof ActivityFailure ? err.cause ?? err : err;
    const msg = (cause as Error).message ?? String(cause);
    outcome = /OverBudget|over its/.test(msg) ? 'over-budget' : 'error';
    summary = msg;
    return await finish();
  } finally {
    await quick.cleanupCycle(cfg, prep);
  }

  async function finish(): Promise<CycleResult> {
    stage = `done: ${outcome}`;
    const result: CycleResult = {
      cycle,
      mode,
      outcome,
      requirement,
      attempts: attempt,
      costUsd,
      mergeSha,
      revertSha,
      note: summary,
      startedAt,
      endedAt: new Date().toISOString(),
    };
    result.reportPath = await quick.writeReport(cfg, result, log);
    return result;
  }
}

// ---------------------------------------------------------------------------------------------
// The loop

export const pauseSignal = defineSignal<[string?]>('pause');
export const resumeSignal = defineSignal('resume');
export const stopSignal = defineSignal('stop');
export const runNowSignal = defineSignal('runNow');
export const updateConfigSignal = defineSignal<[Partial<PipelineConfig>]>('updateConfig');

export interface PipelineState {
  cycle: number;
  paused: boolean;
  pauseReason?: string;
  consecutiveFailures: number;
  spendByDay: Record<string, number>;
  cyclesByDay: Record<string, number>;
  recent: Pick<CycleResult, 'cycle' | 'mode' | 'outcome' | 'costUsd' | 'note'>[];
}

export interface PipelineStatus extends PipelineState {
  status: string;
  currentCycleWorkflowId?: string;
  totalUsdToday: number;
}

export const statusQuery = defineQuery<PipelineStatus>('status');

const FAILURES: CycleOutcome[] = ['abandoned', 'reverted', 'error', 'over-budget'];

export async function pipelineWorkflow(input: { cfg: PipelineConfig; state?: PipelineState; maxCycles?: number; skipPreflight?: boolean }): Promise<PipelineState> {
  let cfg = input.cfg;
  const state: PipelineState = input.state ?? { cycle: 0, paused: false, consecutiveFailures: 0, spendByDay: {}, cyclesByDay: {}, recent: [] };
  let stopping = false;
  let runNow = false;
  let status = 'starting';
  let current: string | undefined;
  let cyclesThisRun = 0;
  const today = () => new Date().toISOString().slice(0, 10);
  // On a fresh start, and on a resume after a failed preflight, check the setup before any agent runs.
  let needPreflight = !input.state && !input.skipPreflight;

  setHandler(pauseSignal, (reason?: string) => {
    state.paused = true;
    state.pauseReason = reason ?? 'paused by a person';
  });
  setHandler(resumeSignal, () => {
    if (state.pauseReason?.startsWith('preflight')) needPreflight = true;
    state.paused = false;
    state.pauseReason = undefined;
    state.consecutiveFailures = 0;
  });
  setHandler(stopSignal, () => {
    stopping = true;
  });
  setHandler(runNowSignal, () => {
    runNow = true;
  });
  setHandler(updateConfigSignal, (patch) => {
    cfg = { ...cfg, ...patch, limits: { ...cfg.limits, ...(patch.limits ?? {}) } };
  });
  setHandler(statusQuery, () => ({ ...state, status, currentCycleWorkflowId: current, totalUsdToday: state.spendByDay[today()] ?? 0 }));

  while (!stopping) {
    if (needPreflight && !state.paused) {
      status = 'preflight: building, deploying and checking the base branch before any agent runs';
      const pf = await work.preflight(cfg);
      if (!pf.ok) {
        state.paused = true;
        state.pauseReason = `preflight failed (fix the setup, then resume):\n${pf.problems.join('\n\n')}`;
        if (input.maxCycles !== undefined) break; // a one-off run ends here instead of waiting
        continue;
      }
      needPreflight = false;
    }
    if (state.paused) {
      status = `paused: ${state.pauseReason}`;
      await condition(() => !state.paused || stopping);
      continue;
    }
    const day = today();
    if ((state.cyclesByDay[day] ?? 0) >= cfg.limits.maxCyclesPerDay || (state.spendByDay[day] ?? 0) >= cfg.limits.maxUsdPerDay) {
      status = `daily limit reached (${state.cyclesByDay[day] ?? 0} cycles, $${(state.spendByDay[day] ?? 0).toFixed(2)}); waiting for tomorrow`;
      const msToMidnight = Date.parse(`${day}T00:00:00Z`) + 86_400_000 - Date.now() + 60_000;
      await condition(() => stopping || state.paused || today() !== day, msToMidnight);
      continue;
    }
    if (input.maxCycles !== undefined && cyclesThisRun >= input.maxCycles) break;

    state.cycle++;
    cyclesThisRun++;
    const mode = cfg.limits.redesignEvery > 0 && state.cycle % cfg.limits.redesignEvery === 0 ? 'redesign' : 'feature';
    current = `${workflowInfo().workflowId}-cycle-${state.cycle}`;
    status = `running cycle ${state.cycle} (${mode})`;
    let result: CycleResult;
    try {
      result = await executeChild(cycleWorkflow, { workflowId: current, args: [{ cfg, cycle: state.cycle, mode }] });
    } catch (err) {
      result = {
        cycle: state.cycle,
        mode,
        outcome: 'error',
        attempts: 0,
        costUsd: 0,
        note: (err as Error).message,
        startedAt: '',
        endedAt: new Date().toISOString(),
      };
    }
    current = undefined;
    state.cyclesByDay = { [day]: (state.cyclesByDay[day] ?? 0) + 1 };
    state.spendByDay = { [day]: (state.spendByDay[day] ?? 0) + result.costUsd };
    state.recent = [
      ...state.recent,
      { cycle: result.cycle, mode: result.mode, outcome: result.outcome, costUsd: result.costUsd, note: `${result.requirement ? `${result.requirement.id} ${result.requirement.title}: ` : ''}${result.note.slice(0, 300)}` },
    ].slice(-20);

    if (FAILURES.includes(result.outcome)) state.consecutiveFailures++;
    else if (result.outcome !== 'no-work') state.consecutiveFailures = 0;
    if (state.consecutiveFailures >= cfg.limits.consecutiveFailuresToPause) {
      state.paused = true;
      state.pauseReason = `${state.consecutiveFailures} failed cycles in a row; look at the reports, then resume`;
      continue;
    }
    if (result.outcome === 'reverted') {
      // A revert means live broke: stop and let a person look, whatever the counter says.
      state.paused = true;
      state.pauseReason = `cycle ${result.cycle} broke the live deployment and was reverted; look at the report, then resume`;
      continue;
    }
    if (workflowInfo().historyLength > 2000 || cyclesThisRun >= 25) {
      await continueAsNew<typeof pipelineWorkflow>({ cfg, state, maxCycles: input.maxCycles === undefined ? undefined : input.maxCycles - cyclesThisRun });
    }
    const wait = result.outcome === 'no-work' ? Math.max(cfg.limits.minutesBetweenCycles, 60) : cfg.limits.minutesBetweenCycles;
    status = `waiting ${wait} min before the next cycle`;
    runNow = false;
    await condition(() => stopping || runNow || state.paused, wait * 60_000);
  }
  status = 'stopped';
  return state;
}

// ---------------------------------------------------------------------------------------------
// A one-off live deploy, outside a cycle (after a person fixed main by hand, or live is down).

export interface LiveDeployResult {
  ok: boolean;
  apiUrl: string;
  checks: { name: string; passed: boolean }[];
  note: string;
}

export async function liveDeployWorkflow(input: { cfg?: PipelineConfig } = {}): Promise<LiveDeployResult> {
  const cfg = input.cfg ?? (await quick.currentConfig());
  const live = await work.deployLive(cfg);
  if (!live.ok) return { ok: false, apiUrl: live.apiUrl, checks: [], note: `live deploy failed:\n${live.tail.slice(-3000)}` };
  const checks = await work.runChecks(cfg, undefined, live.apiUrl, 'manual-deploy');
  const bad = failed(checks);
  return {
    ok: bad.length === 0,
    apiUrl: live.apiUrl,
    checks: checks.map((c) => ({ name: c.name, passed: c.passed })),
    note: bad.length ? `live is up, but checks failed:\n${describe(checks).slice(0, 3000)}` : `live deployed and checked (${checks.length} checks passed)`,
  };
}
