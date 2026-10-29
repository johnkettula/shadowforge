// How the pipeline runs an agent. ClaudeAgentRunner uses the Claude Agent SDK;
// ScriptedAgentRunner does canned work so the whole pipeline can be tested without an API key.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { AgentUsage, PipelineConfig, Role } from '../types.js';
import { checkWrite, decide, toolsFor, type PolicyContext } from './policy.js';
import { ROLE_PROMPTS } from './prompts.js';

export interface AgentTask {
  role: Role;
  /** The worktree root. */
  cwd: string;
  prompt: string;
  /** JSON Schema of the structured result the agent must return. */
  schema: Record<string, unknown>;
  stagingHosts?: string[];
  /** Extra context the scripted runner uses (requirement, feedback, …). */
  meta?: Record<string, unknown>;
}

export interface AgentOutcome {
  output: Record<string, unknown> | undefined;
  text: string;
  usage: AgentUsage;
  /** Tool calls the policy refused, with the reason. */
  denied: string[];
}

export interface AgentRunner {
  run(task: AgentTask, cfg: PipelineConfig, heartbeat: (detail?: unknown) => void): Promise<AgentOutcome>;
}

// ---------------------------------------------------------------------------------------------
// Claude Agent SDK

export class ClaudeAgentRunner implements AgentRunner {
  async run(task: AgentTask, cfg: PipelineConfig, heartbeat: (detail?: unknown) => void): Promise<AgentOutcome> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const ctx: PolicyContext = { cfg, role: task.role, root: task.cwd, stagingHosts: task.stagingHosts };
    const denied: string[] = [];
    const started = Date.now();
    const abort = new AbortController();
    const q = query({
      prompt: task.prompt,
      options: {
        cwd: task.cwd,
        abortController: abort,
        tools: toolsFor(task.role),
        permissionMode: 'default',
        // No user or project settings: the policy below is the whole rulebook.
        settingSources: [],
        persistSession: false,
        maxTurns: cfg.limits.maxAgentTurns,
        maxBudgetUsd: cfg.limits.maxUsdPerAgentRun,
        model: cfg.agent.model || undefined,
        effort: cfg.agent.effort,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: ROLE_PROMPTS[task.role] },
        outputFormat: { type: 'json_schema', schema: task.schema },
        canUseTool: async (toolName, input) => {
          const d = decide(ctx, toolName, input);
          if (d.allow) return { behavior: 'allow', updatedInput: input };
          denied.push(`${toolName}: ${d.reason}`);
          return { behavior: 'deny', message: `Refused by the pipeline's rules: ${d.reason}` };
        },
      },
    });
    let result: Record<string, unknown> | undefined;
    let turns = 0;
    try {
      for await (const msg of q) {
        if (msg.type === 'assistant') turns++;
        heartbeat({ role: task.role, turns, denied: denied.length });
        if (msg.type === 'result') result = msg as unknown as Record<string, unknown>;
      }
    } catch (err) {
      abort.abort();
      throw err;
    }
    const cost = Number(result?.total_cost_usd ?? 0);
    const usage: AgentUsage = { costUsd: cost, turns: Number(result?.num_turns ?? turns), seconds: (Date.now() - started) / 1000 };
    if (!result) throw new Error(`the ${task.role} agent ended without a result`);
    if (result.subtype !== 'success' || result.is_error) {
      // Over budget, out of turns, or an API error: report it as a failed run, with its cost.
      return { output: undefined, text: `${result.subtype}: ${String(result.result ?? (result.errors as string[] | undefined)?.join('; ') ?? '')}`, usage, denied };
    }
    const output = (result.structured_output as Record<string, unknown> | undefined) ?? tryParse(String(result.result ?? ''));
    return { output, text: String(result.result ?? ''), usage, denied };
  }
}

function tryParse(text: string): Record<string, unknown> | undefined {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return undefined;
  try {
    return JSON.parse(m[0]);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Scripted

/** What a scripted step can do: edit files (through the same policy as a real agent) and answer. */
export interface ScriptTools {
  root: string;
  read(rel: string): string;
  exists(rel: string): boolean;
  /** Writes a file if the role's policy allows it; returns the refusal reason otherwise. */
  write(rel: string, content: string): string | undefined;
  /** Writes regardless of the policy (to test that the diff check catches what the hook missed). */
  writeUnchecked(rel: string, content: string): void;
}

export type ScriptStep = (task: AgentTask, tools: ScriptTools) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;

export class ScriptedAgentRunner implements AgentRunner {
  /** Each role's steps are used in order; the last one repeats. */
  constructor(private readonly script: Partial<Record<Role, ScriptStep[]>> = defaultScript(), private readonly costPerRun = 0.01) {}

  private calls: Partial<Record<Role, number>> = {};

  async run(task: AgentTask, cfg: PipelineConfig, heartbeat: (detail?: unknown) => void): Promise<AgentOutcome> {
    heartbeat({ role: task.role, scripted: true });
    const steps = this.script[task.role];
    if (!steps?.length) throw new Error(`no scripted step for ${task.role}`);
    const n = this.calls[task.role] ?? 0;
    this.calls[task.role] = n + 1;
    const step = steps[Math.min(n, steps.length - 1)];
    const denied: string[] = [];
    const ctx: PolicyContext = { cfg, role: task.role, root: task.cwd, stagingHosts: task.stagingHosts };
    const tools: ScriptTools = {
      root: task.cwd,
      read: (rel) => readFileSync(path.join(task.cwd, rel), 'utf8'),
      exists: (rel) => existsSync(path.join(task.cwd, rel)),
      write: (rel, content) => {
        const d = checkWrite(ctx, path.join(task.cwd, rel));
        if (!d.allow) {
          denied.push(`Write: ${d.reason}`);
          return d.reason;
        }
        mkdirSync(path.dirname(path.join(task.cwd, rel)), { recursive: true });
        writeFileSync(path.join(task.cwd, rel), content);
        return undefined;
      },
      writeUnchecked: (rel, content) => {
        mkdirSync(path.dirname(path.join(task.cwd, rel)), { recursive: true });
        writeFileSync(path.join(task.cwd, rel), content);
      },
    };
    const output = await step(task, tools);
    return { output, text: JSON.stringify(output ?? null), usage: { costUsd: this.costPerRun, turns: 1, seconds: 0 }, denied };
  }
}

/**
 * The dry-run script: a harmless, real change (a line in the pipeline's own notes file) that goes
 * through every stage, so the pipeline can be tried end to end before an API key is set.
 */
export function defaultScript(): Partial<Record<Role, ScriptStep[]>> {
  return {
    requirements: [
      (task) => ({
        found: true,
        reason: 'dry run',
        requirement: {
          title: 'Record a dry-run note in the docs',
          rationale: 'Dry run of the agent pipeline (scripted agents, no AI).',
          acceptanceCriteria: ['docs/agent-pipeline-dry-runs.md has a line for this cycle', 'The API still answers GET /api/v2/requests'],
          risk: 'low',
          areas: [`${String(task.meta?.projectDir ?? 'vm-intent')}/docs/agent-pipeline-dry-runs.md`],
        },
      }),
    ],
    developer: [
      (task, t) => {
        const rel = `${String(task.meta?.projectDir ?? 'vm-intent')}/docs/agent-pipeline-dry-runs.md`;
        const before = t.exists(rel) ? t.read(rel) : '# Agent pipeline dry runs\n\nOne line per scripted cycle.\n\n';
        const err = t.write(rel, `${before}- ${String(task.meta?.requirementId)}: dry-run cycle\n`);
        return { summary: err ? `could not write: ${err}` : 'added a line', filesChanged: [rel], testsAdded: [], openQuestions: [] };
      },
    ],
    tester: [
      (task, t) => {
        const dir = String(task.meta?.testDir);
        t.write(
          `${dir}/requests-endpoint.test.mjs`,
          `// Written by the scripted tester for ${String(task.meta?.requirementId)}.
const api = process.env.VMINTENT_API;
const res = await fetch(api + '/api/v2/requests');
if (res.status !== 200) { console.error('GET /api/v2/requests returned', res.status); process.exit(1); }
console.log('ok');
`,
        );
        return { passed: true, summary: 'scripted test written', testFiles: [`${dir}/requests-endpoint.test.mjs`], failures: [] };
      },
    ],
    reviewer: [() => ({ approve: true, summary: 'scripted approval', blockingIssues: [], suggestions: [] })],
    redesign: [
      (task, t) => {
        const doc = String(task.meta?.docPath);
        t.write(doc, `# Design review (dry run)\n\nScripted redesign stage: no proposals.\n`);
        return { docPath: doc, summary: 'dry run', proposals: [] };
      },
    ],
  };
}
