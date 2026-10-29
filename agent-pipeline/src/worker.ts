// The pipeline's Temporal worker: runs the workflows and activities.
//   npm run worker        (TEMPORAL_ADDRESS, default 127.0.0.1:7233)

import { NativeConnection, Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import { createActivities } from './activities.js';
import { ClaudeAgentRunner, ScriptedAgentRunner, type AgentRunner } from './agents/runner.js';
import { TASK_QUEUE } from './config.js';

export async function startWorker(opts: { runner?: AgentRunner; address?: string; taskQueue?: string } = {}) {
  // The run's config says which agents to use, so a dry run (scripted) needs no worker restart.
  const claude = new ClaudeAgentRunner();
  const choice = opts.runner ?? ((c: { agent: { mode: string } }) => (c.agent.mode === 'scripted' ? new ScriptedAgentRunner() : claude));
  if (!opts.runner && !process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.warn('No ANTHROPIC_API_KEY is set: only dry runs (scripted agents) will work. See README.');
  }
  const connection = await NativeConnection.connect({ address: opts.address ?? process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233' });
  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: opts.taskQueue ?? TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL('./workflows.ts', import.meta.url)),
    activities: createActivities(choice),
    // One cycle at a time: stages share the machine (builds, staging ports).
    maxConcurrentActivityTaskExecutions: 4,
  });
  return { worker, connection };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { worker } = await startWorker();
  console.log(`agent pipeline worker running on task queue ${TASK_QUEUE}`);
  await worker.run();
}
