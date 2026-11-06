// Control the pipeline:
//   npm run ctl -- start            start the loop (runs until stopped)
//   npm run ctl -- once             run one cycle and print what happened
//   npm run ctl -- status           what it's doing, today's spend, recent cycles
//   npm run ctl -- pause [reason]   finish nothing new; the current stage carries on
//   npm run ctl -- resume
//   npm run ctl -- run-now          skip the wait before the next cycle
//   npm run ctl -- stop             stop after the current cycle
//   npm run ctl -- reports          list the cycle reports
//   npm run ctl -- synopsis [days]  summary of the last run (default: cycles since the last 24 hours)
//   npm run ctl -- deploy-live      rebuild and check the live copy from main now (not during a cycle)
//   npm run ctl -- approve [note]   say yes to what the current cycle is waiting on (build or merge);
//                                   before building, the note is passed on to the developer
//   npm run ctl -- skip [reason]    don't build the requirement it's waiting on
//   npm run ctl -- reject [reason]  don't merge the change it's waiting on

import { Client, Connection, WorkflowNotFoundError } from '@temporalio/client';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, PIPELINE_WORKFLOW_ID, TASK_QUEUE } from './config.js';
import { synopsis } from './synopsis.js';
import type { CycleResult } from './types.js';
import { decideSignal, liveDeployWorkflow, pauseSignal, pipelineWorkflow, resumeSignal, runNowSignal, stageQuery, statusQuery, stopSignal } from './workflows.js';

async function client() {
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233' });
  return new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' });
}

async function main() {
  const [cmd = 'status', ...rest] = process.argv.slice(2);
  const cfg = loadConfig();
  const c = await client();
  // A dry run gets its own workflow ID, so it can't collide with the real pipeline.
  const workflowId = process.env.AGENT_PIPELINE_ID ?? (cfg.agent.mode === 'scripted' ? `${PIPELINE_WORKFLOW_ID}-dryrun` : PIPELINE_WORKFLOW_ID);
  const handle = c.workflow.getHandle(workflowId);
  switch (cmd) {
    case 'start':
    case 'once': {
      const maxCycles = cmd === 'once' ? 1 : undefined;
      const h = await c.workflow.start(pipelineWorkflow, {
        workflowId,
        taskQueue: TASK_QUEUE,
        args: [{ cfg, maxCycles }],
      });
      console.log(`started ${h.workflowId} (agents: ${cfg.agent.mode}, push: ${cfg.push}, home: ${cfg.home})`);
      if (cmd === 'once') {
        const state = await h.result();
        if (state.paused) console.log(`stopped: ${state.pauseReason}`);
        const last = state.recent.at(-1);
        console.log(last ? `cycle ${last.cycle}: ${last.outcome} ($${last.costUsd.toFixed(2)})\n${last.note}` : 'no cycle ran');
        console.log(`report: ${path.join(cfg.home, 'reports')}`);
      }
      break;
    }
    case 'status': {
      try {
        const s = await handle.query(statusQuery);
        console.log(`${s.status}\ncycles so far: ${s.cycle} · spent today: $${s.totalUsdToday.toFixed(2)} · failures in a row: ${s.consecutiveFailures}`);
        if (s.currentCycleWorkflowId) {
          const st = await c.workflow.getHandle(s.currentCycleWorkflowId).query(stageQuery).catch(() => undefined);
          if (st) {
            console.log(`\nnow: ${st.stage}${st.attempt ? ` (attempt ${st.attempt})` : ''}${st.requirement ? ` · ${st.requirement.id} ${st.requirement.title}` : ''} · $${st.costUsd.toFixed(2)}`);
            st.log.slice(-8).forEach((l) => console.log(`  ${l}`));
            if (st.waiting && st.requirement) {
              const r = st.requirement;
              console.log(`\n*** WAITING FOR YOU: ${st.waiting.gate === 'build' ? 'build this requirement?' : 'merge this change?'} ***`);
              console.log(`${r.id}: ${r.title} (risk ${r.risk})\n\n${r.rationale}\n\nAcceptance criteria:\n${r.acceptanceCriteria.map((a) => `  - ${a}`).join('\n')}`);
              if (st.waiting.details) console.log(`\n${st.waiting.details}`);
              console.log(`\nAnswer with: 5-control approve [note]  |  5-control ${st.waiting.gate === 'build' ? 'skip' : 'reject'} [reason]`);
            }
          }
        }
        if (s.recent.length) {
          console.log('\nrecent cycles:');
          s.recent.slice(-10).forEach((r) => console.log(`  ${r.cycle} ${r.mode} ${r.outcome} $${r.costUsd.toFixed(2)} ${r.note.split('\n')[0].slice(0, 120)}`));
        }
      } catch (e) {
        if (e instanceof WorkflowNotFoundError) console.log('the pipeline is not running (npm run ctl -- start)');
        else throw e;
      }
      break;
    }
    case 'pause':
      await handle.signal(pauseSignal, rest.join(' ') || undefined);
      console.log('paused (the current stage finishes first)');
      break;
    case 'resume':
      await handle.signal(resumeSignal);
      console.log('resumed');
      break;
    case 'run-now':
      await handle.signal(runNowSignal);
      console.log('the next cycle starts now');
      break;
    case 'stop':
      await handle.signal(stopSignal);
      console.log('stopping after the current cycle');
      break;
    case 'approve':
    case 'skip':
    case 'reject': {
      const s = await handle.query(statusQuery);
      if (!s.currentCycleWorkflowId) {
        console.log('no cycle is running, so there is nothing to answer');
        break;
      }
      const cyc = c.workflow.getHandle(s.currentCycleWorkflowId);
      const st = await cyc.query(stageQuery);
      if (!st.waiting) {
        console.log(`cycle ${s.cycle} isn't waiting for an answer (it's at: ${st.stage})`);
        break;
      }
      await cyc.signal(decideSignal, { action: cmd, note: rest.join(' ') || undefined });
      console.log(`${cmd} sent to cycle ${s.cycle} (${st.waiting.gate} gate)`);
      break;
    }
    case 'deploy-live': {
      const s = await handle.query(statusQuery).catch(() => undefined);
      if (s?.currentCycleWorkflowId) {
        console.log(`cycle ${s.cycle} is running; deploy live when it has finished (or pause first)`);
        break;
      }
      const h = await c.workflow.start(liveDeployWorkflow, { workflowId: `${workflowId}-deploy-live-${Date.now()}`, taskQueue: TASK_QUEUE, args: [{ cfg }] });
      console.log(`deploying live from ${cfg.baseBranch} (${h.workflowId}); this takes a few minutes`);
      const r = await h.result();
      console.log(`${r.ok ? 'OK' : 'FAILED'}: ${r.note}\n${r.apiUrl}`);
      break;
    }
    case 'reports': {
      const ledger = path.join(cfg.home, 'reports', 'ledger.json');
      const rows: CycleResult[] = existsSync(ledger) ? JSON.parse(readFileSync(ledger, 'utf8')) : [];
      for (const r of rows.slice(-30)) console.log(`${r.cycle}\t${r.outcome}\t$${r.costUsd.toFixed(2)}\t${r.requirement?.title ?? r.mode}\t${r.reportPath ?? ''}`);
      if (!rows.length) console.log('no cycles yet');
      break;
    }
    case 'synopsis': {
      const ledger = path.join(cfg.home, 'reports', 'ledger.json');
      const rows: CycleResult[] = existsSync(ledger) ? JSON.parse(readFileSync(ledger, 'utf8')) : [];
      const days = Number(rest[0]) > 0 ? Number(rest[0]) : 1;
      console.log(synopsis(rows, new Date(Date.now() - days * 86_400_000).toISOString()));
      break;
    }
    default:
      console.log('commands: start | once | status | synopsis [days] | approve [note] | skip [reason] | reject [reason] | pause [reason] | resume | run-now | stop | deploy-live | reports');
  }
  await c.connection.close();
}

await main();
