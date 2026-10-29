// Control the pipeline:
//   npm run ctl -- start            start the loop (runs until stopped)
//   npm run ctl -- once             run one cycle and print what happened
//   npm run ctl -- status           what it's doing, today's spend, recent cycles
//   npm run ctl -- pause [reason]   finish nothing new; the current stage carries on
//   npm run ctl -- resume
//   npm run ctl -- run-now          skip the wait before the next cycle
//   npm run ctl -- stop             stop after the current cycle
//   npm run ctl -- reports          list the cycle reports

import { Client, Connection, WorkflowNotFoundError } from '@temporalio/client';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, PIPELINE_WORKFLOW_ID, TASK_QUEUE } from './config.js';
import type { CycleResult } from './types.js';
import { pauseSignal, pipelineWorkflow, resumeSignal, runNowSignal, stageQuery, statusQuery, stopSignal } from './workflows.js';

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
    case 'reports': {
      const ledger = path.join(cfg.home, 'reports', 'ledger.json');
      const rows: CycleResult[] = existsSync(ledger) ? JSON.parse(readFileSync(ledger, 'utf8')) : [];
      for (const r of rows.slice(-30)) console.log(`${r.cycle}\t${r.outcome}\t$${r.costUsd.toFixed(2)}\t${r.requirement?.title ?? r.mode}\t${r.reportPath ?? ''}`);
      if (!rows.length) console.log('no cycles yet');
      break;
    }
    default:
      console.log('commands: start | once | status | pause [reason] | resume | run-now | stop | reports');
  }
  await c.connection.close();
}

await main();
