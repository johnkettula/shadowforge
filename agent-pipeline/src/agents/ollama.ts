// Runs an agent on a local open model through Ollama (http://127.0.0.1:11434), and routes each
// stage to it or to Claude by the run's config (agent.local). John chose this hybrid on 2026-11-07
// after a benchmark on basement: qwen3.5:4b passed a real requirements step and a real code change.
//
// The local agent gets the same tools as a Claude agent (Read, Glob, Grep, Bash, Edit, Write), and
// every call goes through the same policy (decide) before it runs, so the guardrails don't change.
// It hands back its structured result by calling a `submit` tool. If the local model gives nothing
// usable (no valid result, a broken tool loop, too slow), the stage is done again by Claude, after
// any half-made edits are undone, so a weak local answer costs time, never a failed cycle.

import { spawn } from 'node:child_process';
import http from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { matchesAny, toPosix } from '../glob.js';
import type { PipelineConfig, Role } from '../types.js';
import { decide, toolsFor, type PolicyContext } from './policy.js';
import { ROLE_PROMPTS } from './prompts.js';
import type { AgentOutcome, AgentRunner, AgentTask } from './runner.js';

export interface LocalAgentConfig {
  /** Ollama's address. */
  url?: string;
  /** The model, e.g. qwen3.5:4b. */
  model: string;
  /** Roles that run on the local model (each falls back to Claude when the local answer is unusable). */
  roles: Role[];
  /** Also run the developer locally on the daily docs cycle (its requirement title starts with the prefix). */
  dailyDocsDeveloper?: boolean;
  /** Context window in tokens (more uses more memory). */
  numCtx?: number;
  /** Give up and fall back to Claude after this long. */
  maxMinutes?: number;
  /** Most model calls in one run. */
  maxTurns?: number;
  /**
   * Most tokens the model may write in one reply (Ollama's num_predict). Without a cap, a reply that
   * runs on can occupy Ollama for an hour and every other request waits behind it (2026-11-08 morning).
   */
  maxOutputTokens?: number;
}

export const DAILY_DOCS_TITLE_PREFIX = 'Daily docs';

/** Does this stage run on the local model? */
export function routesLocal(task: AgentTask, local: LocalAgentConfig | undefined): boolean {
  if (!local?.model) return false;
  if (local.roles?.includes(task.role)) return true;
  const title = String(task.meta?.requirementTitle ?? '');
  return task.role === 'developer' && !!local.dailyDocsDeveloper && title.startsWith(DAILY_DOCS_TITLE_PREFIX);
}

/** Is a result good enough to use, for this role? (The schema's required keys, with the right basic types.) */
export function usableOutput(role: Role, schema: Record<string, unknown>, out: Record<string, unknown> | undefined): string | undefined {
  if (!out || typeof out !== 'object') return 'no result';
  for (const k of (schema.required as string[] | undefined) ?? []) if (!(k in out)) return `the result has no "${k}"`;
  if (role === 'requirements' && out.found === true) {
    const r = out.requirement as Record<string, unknown> | undefined;
    if (!r || typeof r.title !== 'string' || !r.title.trim() || !Array.isArray(r.acceptanceCriteria) || !r.acceptanceCriteria.length) return 'the requirement is incomplete';
  }
  if (role === 'reviewer' && typeof out.approve !== 'boolean') return '"approve" is not true or false';
  if (role === 'requirements' && typeof out.found !== 'boolean') return '"found" is not true or false';
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// The tools, as the local model sees them

const TOOL_DEFS: Record<string, { description: string; parameters: Record<string, unknown> }> = {
  Read: { description: 'Read a file (path relative to the repository root). Long files: pass offset/limit (lines).', parameters: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['file_path'] } },
  Glob: { description: 'List files matching a glob pattern such as "vm-intent/docs/*.md" (relative to the repository root).', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
  Grep: { description: 'Search file contents for a regular expression; returns file:line: text matches.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
  Bash: { description: 'Run one allowed shell command in the repository root (for example git diff, git log, mvn -q test).', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  Edit: { description: 'Replace one exact piece of text in a file. old_string must appear exactly once.', parameters: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['file_path', 'old_string', 'new_string'] } },
  Write: { description: 'Write the whole content of a file (creates or replaces it).', parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } },
};

const SKIP_DIRS = new Set(['.git', 'node_modules', 'target', 'dist', 'build', '.gradle', '.idea']);
const MAX_TOOL_RESULT = 12_000;

function walk(root: string, start: string, limit = 5000): string[] {
  const out: string[] = [];
  const stack = [start];
  while (stack.length && out.length < limit) {
    const dir = stack.pop()!;
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e)) continue;
      const p = path.join(dir, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) stack.push(p);
      else out.push(toPosix(path.relative(root, p)));
    }
  }
  return out.sort();
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    let out = '';
    const add = (b: Buffer) => { if (out.length < 200_000) out += b.toString(); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const t = setTimeout(() => { child.kill(); out += `\n(stopped after ${timeoutMs / 1000} s)`; }, timeoutMs);
    child.on('close', (code) => { clearTimeout(t); resolve(`${out}\n(exit code ${code})`); });
    child.on('error', (e) => { clearTimeout(t); resolve(`error: ${e.message}`); });
  });
}

function clip(s: string): string {
  return s.length > MAX_TOOL_RESULT ? `${s.slice(0, MAX_TOOL_RESULT)}\n… (${s.length - MAX_TOOL_RESULT} more characters; use offset/limit or a narrower search)` : s;
}

/** Runs one tool call (already allowed by the policy). Paths are relative to the worktree root. */
export async function runTool(name: string, input: Record<string, unknown>, root: string): Promise<string> {
  const abs = (p: unknown) => path.resolve(root, String(p ?? ''));
  try {
    switch (name) {
      case 'Read': {
        const f = abs(input.file_path);
        if (!existsSync(f)) return 'error: no such file';
        const lines = readFileSync(f, 'utf8').split('\n');
        const from = Math.max(0, Number(input.offset ?? 1) - 1);
        const n = Number(input.limit ?? 400);
        const part = lines.slice(from, from + n).map((l, i) => `${from + i + 1}\t${l}`).join('\n');
        return clip(part + (from + n < lines.length ? `\n… (${lines.length} lines in all; pass offset to read on)` : ''));
      }
      case 'Glob': {
        const base = input.path ? abs(input.path) : root;
        const pat = String(input.pattern ?? '**/*');
        const files = walk(root, base).filter((f) => matchesAny(f, [pat]) || matchesAny(toPosix(path.relative(base, path.join(root, f))), [pat]));
        return clip(files.slice(0, 300).join('\n') || '(no files)');
      }
      case 'Grep': {
        const base = input.path ? abs(input.path) : root;
        const re = new RegExp(String(input.pattern ?? ''), 'i');
        const hits: string[] = [];
        const files = existsSync(base) && statSync(base).isFile() ? [toPosix(path.relative(root, base))] : walk(root, base);
        for (const f of files) {
          if (hits.length >= 100) break;
          let text = '';
          try { const st = statSync(path.join(root, f)); if (st.size > 1_000_000) continue; text = readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
          text.split('\n').forEach((l, i) => { if (hits.length < 100 && re.test(l)) hits.push(`${f}:${i + 1}: ${l.trim().slice(0, 200)}`); });
        }
        return clip(hits.join('\n') || '(no matches)');
      }
      case 'Bash':
        return clip(await runShell(String(input.command ?? ''), root, 15 * 60_000));
      case 'Edit': {
        const f = abs(input.file_path);
        if (!existsSync(f)) return 'error: no such file';
        const text = readFileSync(f, 'utf8');
        const old = String(input.old_string ?? '');
        const count = old ? text.split(old).length - 1 : 0;
        if (count !== 1) return `error: old_string appears ${count} times; it must appear exactly once`;
        writeFileSync(f, text.replace(old, String(input.new_string ?? '')));
        return 'ok';
      }
      case 'Write': {
        const f = abs(input.file_path);
        mkdirSync(path.dirname(f), { recursive: true });
        writeFileSync(f, String(input.content ?? ''));
        return 'ok';
      }
      default:
        return `error: unknown tool ${name}`;
    }
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

// ---------------------------------------------------------------------------------------------
// The local runner

interface ChatMessage { role: string; content: string; tool_calls?: { function: { name: string; arguments: unknown } }[]; tool_name?: string }

/**
 * POSTs JSON and streams the reply, with no time limit of its own (the caller's AbortSignal decides).
 * Node's built-in fetch gives up after 5 minutes without response headers, and on basement's CPU
 * Ollama can spend longer than that reading a long prompt before it sends anything (cycle 22).
 */
function postStream(url: string, body: string, signal: AbortSignal): Promise<{ status: number; body: AsyncIterable<Uint8Array>; text: () => Promise<string> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, signal }, (res) => {
      resolve({
        status: res.statusCode ?? 0,
        body: res,
        text: async () => { let t = ''; for await (const c of res) t += c.toString(); return t; },
      });
    });
    req.setTimeout(0);
    req.on('error', reject);
    req.end(body);
  });
}

export class OllamaAgentRunner implements AgentRunner {
  /** fetchImpl is for tests; by default the runner uses postStream (no 5-minute limit). */
  constructor(private readonly fetchImpl?: typeof fetch) {}

  async run(task: AgentTask, cfg: PipelineConfig, heartbeat: (detail?: unknown) => void): Promise<AgentOutcome> {
    const local = cfg.agent.local!;
    const url = (local.url ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
    const started = Date.now();
    const deadline = started + (local.maxMinutes ?? 20) * 60_000;
    const maxTurns = local.maxTurns ?? 40;
    const ctx: PolicyContext = { cfg, role: task.role, root: task.cwd, stagingHosts: task.stagingHosts };
    const allowed = toolsFor(task.role).filter((t) => TOOL_DEFS[t]);
    const tools = [
      ...allowed.map((t) => ({ type: 'function', function: { name: t, ...TOOL_DEFS[t] } })),
      { type: 'function', function: { name: 'submit', description: 'Hand in your final result (call this once, at the end).', parameters: task.schema } },
    ];
    const system = `${ROLE_PROMPTS[task.role]}

You work in the repository at the current directory; give paths relative to it (the project is under ${cfg.projectDir}/).
Use the tools to look at the code before deciding. When you are done, call the submit tool once with your result.`;
    const messages: ChatMessage[] = [{ role: 'system', content: system }, { role: 'user', content: task.prompt }];
    const denied: string[] = [];
    let turns = 0;
    let output: Record<string, unknown> | undefined;
    let text = '';

    while (turns < maxTurns && Date.now() < deadline && !output) {
      turns++;
      trim(messages, (local.numCtx ?? 16384) * 2.5);
      const msg = await this.chat(url, local, messages, tools, deadline, () => heartbeat({ role: task.role, turns, local: local.model }));
      messages.push(msg);
      text = msg.content || text;
      const calls = msg.tool_calls ?? [];
      if (!calls.length) {
        // No tool call: maybe it answered with the JSON directly.
        output = parseJson(msg.content);
        if (!output) messages.push({ role: 'user', content: 'Call the submit tool with your result now.' });
        if (!output && turns >= 2 && !msg.content.trim()) break;
        continue;
      }
      for (const c of calls) {
        const name = c.function?.name;
        let args = c.function?.arguments as Record<string, unknown> | string | undefined;
        if (typeof args === 'string') args = parseJson(args) ?? {};
        const input = (args ?? {}) as Record<string, unknown>;
        if (name === 'submit') { output = input; break; }
        const d = decide(ctx, name, input);
        let result: string;
        if (!d.allow) { denied.push(`${name}: ${d.reason}`); result = `Refused by the pipeline's rules: ${d.reason}`; }
        else result = await runTool(name, input, task.cwd);
        messages.push({ role: 'tool', content: result, tool_name: name });
        heartbeat({ role: task.role, turns, local: local.model, tool: name });
      }
    }
    const seconds = (Date.now() - started) / 1000;
    const why = output ? undefined : Date.now() >= deadline ? `ran out of time (${local.maxMinutes ?? 20} min)` : turns >= maxTurns ? `ran out of turns (${maxTurns})` : 'stopped without a result';
    return { output, text: why ? `local model ${local.model}: ${why}` : text, usage: { costUsd: 0, turns, seconds }, denied };
  }

  /** One model call, streamed so a slow CPU never hits an HTTP timeout, with heartbeats while it runs. */
  private async chat(url: string, local: LocalAgentConfig, messages: ChatMessage[], tools: unknown[], deadline: number, beat: () => void): Promise<ChatMessage> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), Math.max(1000, deadline - Date.now()));
    const tick = setInterval(beat, 30_000);
    try {
      const payload = JSON.stringify({ model: local.model, messages, tools, stream: true, think: false, options: { num_ctx: local.numCtx ?? 16384, temperature: 0.2, num_predict: local.maxOutputTokens ?? 4096 } });
      const r = this.fetchImpl
        ? await this.fetchImpl(`${url}/api/chat`, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json' }, body: payload }).then((x) => ({ status: x.status, body: x.body as unknown as AsyncIterable<Uint8Array>, text: () => x.text() }))
        : await postStream(`${url}/api/chat`, payload, ctl.signal);
      if (r.status !== 200 || !r.body) throw new Error(`Ollama answered ${r.status}: ${(await r.text()).slice(0, 300)}`);
      let content = '';
      const toolCalls: ChatMessage['tool_calls'] = [];
      let buf = '';
      const dec = new TextDecoder();
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const j = JSON.parse(line) as { message?: ChatMessage; error?: string };
          if (j.error) throw new Error(`Ollama: ${j.error}`);
          if (j.message?.content) content += j.message.content;
          if (j.message?.tool_calls) toolCalls.push(...j.message.tool_calls);
        }
      }
      return { role: 'assistant', content, tool_calls: toolCalls.length ? toolCalls : undefined };
    } finally {
      clearTimeout(t);
      clearInterval(tick);
    }
  }
}

/**
 * Keeps the conversation within roughly the context window. It does nothing until the conversation
 * passes maxChars, then cuts older tool results in one go, down to about half of that. Cutting rarely
 * matters on a CPU: Ollama reuses what it has already read as long as the start of the conversation
 * is unchanged, and an edit to an early message makes it read everything again (cycle 22 slowed to
 * minutes per call because the old version trimmed a little on every call).
 */
export function trim(messages: ChatMessage[], maxChars: number): boolean {
  const size = () => messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
  if (size() <= maxChars) return false;
  const target = maxChars / 2;
  for (let i = 2; i < messages.length - 4 && size() > target; i++) {
    if (messages[i].role === 'tool' && messages[i].content.length > 200) messages[i].content = '(older tool result removed to save space)';
  }
  return true;
}

function parseJson(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return undefined;
  try { const v = JSON.parse(m[0]); return v && typeof v === 'object' ? v : undefined; } catch { return undefined; }
}

// ---------------------------------------------------------------------------------------------
// Routing: local where configured, Claude otherwise and as the fallback

export class RoutingAgentRunner implements AgentRunner {
  constructor(private readonly claude: AgentRunner, private readonly localRunner: AgentRunner = new OllamaAgentRunner(), private readonly resetWorktree: (cwd: string) => Promise<void> = gitReset) {}

  async run(task: AgentTask, cfg: PipelineConfig, heartbeat: (detail?: unknown) => void): Promise<AgentOutcome> {
    if (!routesLocal(task, cfg.agent.local)) return this.claude.run(task, cfg, heartbeat);
    const model = cfg.agent.local!.model;
    let problem: string | undefined;
    let localOutcome: AgentOutcome | undefined;
    try {
      localOutcome = await this.localRunner.run(task, cfg, heartbeat);
      problem = usableOutput(task.role, task.schema, localOutcome.output) && `${usableOutput(task.role, task.schema, localOutcome.output)} (${localOutcome.text.slice(0, 200)})`;
    } catch (e) {
      problem = (e as Error).message;
    }
    if (problem) console.warn(`[local ${model}] ${task.role}: no usable result (${problem}); Claude does this stage`);
    if (!problem && localOutcome) return { ...localOutcome, text: `[local ${model}] ${localOutcome.text}`.slice(0, 4000) };
    // Unusable: undo anything it half-did, then let Claude do the stage.
    if (task.role === 'developer' || task.role === 'tester' || task.role === 'redesign') await this.resetWorktree(task.cwd);
    const c = await this.claude.run(task, cfg, heartbeat);
    return {
      ...c,
      text: `[local ${model} gave no usable result: ${problem}; done by Claude] ${c.text}`.slice(0, 4000),
      usage: { ...c.usage, seconds: c.usage.seconds + (localOutcome?.usage.seconds ?? 0), turns: c.usage.turns + (localOutcome?.usage.turns ?? 0) },
      denied: [...(localOutcome?.denied ?? []), ...c.denied],
    };
  }
}

async function gitReset(cwd: string): Promise<void> {
  await runShell('git reset -q --hard HEAD && git clean -q -fd', cwd, 60_000);
}
