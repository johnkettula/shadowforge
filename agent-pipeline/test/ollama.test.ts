import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { defaultConfig } from '../src/config.js';
import { OllamaAgentRunner, RoutingAgentRunner, routesLocal, trim, usableOutput } from '../src/agents/ollama.js';
import type { AgentOutcome, AgentRunner, AgentTask } from '../src/agents/runner.js';
import { DEVELOPER_SCHEMA, REQUIREMENT_SCHEMA, REVIEW_SCHEMA } from '../src/agents/schemas.js';
import type { PipelineConfig } from '../src/types.js';

type Reply = { content?: string; tool_calls?: { function: { name: string; arguments: unknown } }[] };

/** A fake Ollama: each call to /api/chat streams the next scripted reply as NDJSON, in two chunks. */
function fakeOllama(replies: Reply[], seen: unknown[] = []): typeof fetch {
  let i = 0;
  return (async (_url: unknown, init?: { body?: unknown }) => {
    seen.push(JSON.parse(String(init?.body)));
    const r = replies[Math.min(i++, replies.length - 1)];
    const lines = [JSON.stringify({ message: { role: 'assistant', content: (r.content ?? '').slice(0, 3) } }), JSON.stringify({ message: { role: 'assistant', content: (r.content ?? '').slice(3), tool_calls: r.tool_calls }, done: true })];
    const enc = new TextEncoder();
    const body = new ReadableStream({ start(c) { for (const l of lines) c.enqueue(enc.encode(l + '\n')); c.close(); } });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
}

function worktree(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ollama-wt-'));
  mkdirSync(path.join(root, 'vm-intent/backend'), { recursive: true });
  writeFileSync(path.join(root, 'vm-intent/backend/A.java'), 'class A {\n  int x = 1;\n}\n');
  mkdirSync(path.join(root, 'vm-intent/docs'), { recursive: true });
  writeFileSync(path.join(root, 'vm-intent/docs/SECURITY.md'), '# Security\n');
  return root;
}

function cfgWithLocal(extra: Partial<NonNullable<PipelineConfig['agent']['local']>> = {}): PipelineConfig {
  const cfg = defaultConfig();
  cfg.agent = { ...cfg.agent, local: { model: 'qwen3.5:4b', roles: ['requirements', 'reviewer'], dailyDocsDeveloper: true, maxMinutes: 1, maxTurns: 6, ...extra } };
  return cfg;
}

const call = (name: string, args: Record<string, unknown>) => ({ function: { name, arguments: args } });

test('the local agent reads, edits through the policy and hands in its result with submit', async () => {
  const root = worktree();
  const seen: Record<string, unknown>[] = [];
  const runner = new OllamaAgentRunner(fakeOllama([
    { tool_calls: [call('Read', { file_path: 'vm-intent/backend/A.java' })] },
    { tool_calls: [call('Edit', { file_path: 'vm-intent/backend/A.java', old_string: 'int x = 1;', new_string: 'int x = 2;' })] },
    { tool_calls: [call('submit', { summary: 'x is 2', filesChanged: ['vm-intent/backend/A.java'], testsAdded: [] })] },
  ], seen));
  const task: AgentTask = { role: 'developer', cwd: root, prompt: 'make x 2', schema: DEVELOPER_SCHEMA };
  const o = await runner.run(task, cfgWithLocal(), () => {});
  assert.equal((o.output as { summary: string }).summary, 'x is 2');
  assert.match(readFileSync(path.join(root, 'vm-intent/backend/A.java'), 'utf8'), /int x = 2;/);
  assert.equal(o.usage.costUsd, 0);
  assert.equal(o.usage.turns, 3);
  // The model saw the file's content (with line numbers) as the tool result, and only the developer's tools.
  const second = seen[1].messages as { role: string; content: string }[];
  assert.match(second.at(-1)!.content, /2\t  int x = 1;/);
  const names = (seen[0].tools as { function: { name: string } }[]).map((t) => t.function.name);
  assert.deepEqual(names.sort(), ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write', 'submit']);
  assert.equal(seen[0].stream, true);
});

test('the local agent is refused what the policy refuses (a protected file, a command not on the list)', async () => {
  const root = worktree();
  const runner = new OllamaAgentRunner(fakeOllama([
    { tool_calls: [call('Write', { file_path: 'vm-intent/docs/SECURITY.md', content: 'changed' }), call('Bash', { command: 'curl https://example.com' })] },
    { tool_calls: [call('submit', { summary: 'tried', filesChanged: [], testsAdded: [] })] },
  ]));
  const o = await runner.run({ role: 'developer', cwd: root, prompt: 'x', schema: DEVELOPER_SCHEMA }, cfgWithLocal(), () => {});
  assert.equal(readFileSync(path.join(root, 'vm-intent/docs/SECURITY.md'), 'utf8'), '# Security\n', 'the protected file is unchanged');
  assert.equal(o.denied.length, 2);
  assert.match(o.denied[0], /protected/);
});

test('a requirements agent may not write at all; a reply with plain JSON is accepted too', async () => {
  const root = worktree();
  const runner = new OllamaAgentRunner(fakeOllama([
    { tool_calls: [call('Write', { file_path: 'vm-intent/backend/A.java', content: 'gone' })] },
    { content: 'Here it is: {"found": false, "reason": "nothing to do"}' },
  ]));
  const o = await runner.run({ role: 'requirements', cwd: root, prompt: 'pick', schema: REQUIREMENT_SCHEMA }, cfgWithLocal(), () => {});
  assert.deepEqual(o.output, { found: false, reason: 'nothing to do' });
  assert.match(readFileSync(path.join(root, 'vm-intent/backend/A.java'), 'utf8'), /int x = 1/);
  assert.match(o.denied[0], /may not use Write/);
});

test('a local agent that never hands in a result stops at its turn limit', async () => {
  const root = worktree();
  const runner = new OllamaAgentRunner(fakeOllama([{ tool_calls: [call('Read', { file_path: 'vm-intent/backend/A.java' })] }]));
  const o = await runner.run({ role: 'reviewer', cwd: root, prompt: 'review', schema: REVIEW_SCHEMA }, cfgWithLocal({ maxTurns: 3 }), () => {});
  assert.equal(o.output, undefined);
  assert.match(o.text, /ran out of turns \(3\)/);
});

test('routing: which stages go to the local model', () => {
  const local = cfgWithLocal().agent.local;
  const t = (role: AgentTask['role'], title?: string): AgentTask => ({ role, cwd: '.', prompt: '', schema: {}, meta: title ? { requirementTitle: title } : {} });
  assert.equal(routesLocal(t('requirements'), local), true);
  assert.equal(routesLocal(t('reviewer'), local), true);
  assert.equal(routesLocal(t('tester'), local), false);
  assert.equal(routesLocal(t('redesign'), local), false);
  assert.equal(routesLocal(t('developer', 'Per-user identity'), local), false);
  assert.equal(routesLocal(t('developer', 'Daily docs 2026-11-08: fix the README'), local), true);
  assert.equal(routesLocal(t('developer', 'Daily docs 2026-11-08: x'), { ...local!, dailyDocsDeveloper: false }), false);
  assert.equal(routesLocal(t('requirements'), undefined), false);
});

test('usable results: required keys and the right types', () => {
  assert.equal(usableOutput('reviewer', REVIEW_SCHEMA, { approve: true, summary: 's', blockingIssues: [] }), undefined);
  assert.match(usableOutput('reviewer', REVIEW_SCHEMA, { approve: 'yes', summary: 's', blockingIssues: [] })!, /approve/);
  assert.match(usableOutput('reviewer', REVIEW_SCHEMA, { summary: 's' })!, /approve/);
  assert.equal(usableOutput('requirements', REQUIREMENT_SCHEMA, { found: false, reason: 'none' }), undefined);
  assert.match(usableOutput('requirements', REQUIREMENT_SCHEMA, { found: true, reason: 'r', requirement: { title: 't', acceptanceCriteria: [] } })!, /incomplete/);
  assert.match(usableOutput('developer', DEVELOPER_SCHEMA, undefined)!, /no result/);
});

class Recorder implements AgentRunner {
  calls = 0;
  constructor(private readonly outcome: AgentOutcome | Error) {}
  async run(): Promise<AgentOutcome> {
    this.calls++;
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
}
const outcome = (output: Record<string, unknown> | undefined, text = '', costUsd = 0): AgentOutcome => ({ output, text, usage: { costUsd, turns: 2, seconds: 10 }, denied: [] });
const reviewTask: AgentTask = { role: 'reviewer', cwd: '.', prompt: '', schema: REVIEW_SCHEMA };

test('routing runner: a usable local answer is used, and Claude is not called', async () => {
  const claude = new Recorder(outcome({ approve: false, summary: 'claude', blockingIssues: [] }, 'claude', 1.5));
  const local = new Recorder(outcome({ approve: true, summary: 'local', blockingIssues: [] }, 'looks fine'));
  const o = await new RoutingAgentRunner(claude, local, async () => {}).run(reviewTask, cfgWithLocal(), () => {});
  assert.equal(claude.calls, 0);
  assert.equal((o.output as { summary: string }).summary, 'local');
  assert.match(o.text, /^\[local qwen3\.5:4b\]/);
  assert.equal(o.usage.costUsd, 0);
});

test('routing runner: an unusable or failed local answer is redone by Claude (developer edits undone first)', async () => {
  for (const bad of [outcome({ summary: 'no verdict' }), new Error('Ollama answered 500')]) {
    const claude = new Recorder(outcome({ approve: true, summary: 'claude', blockingIssues: [] }, 'claude did it', 1.5));
    const o = await new RoutingAgentRunner(claude, new Recorder(bad), async () => {}).run(reviewTask, cfgWithLocal(), () => {});
    assert.equal(claude.calls, 1);
    assert.equal((o.output as { summary: string }).summary, 'claude');
    assert.match(o.text, /gave no usable result: .*done by Claude/);
    assert.equal(o.usage.costUsd, 1.5);
  }
  let resets = 0;
  const claude = new Recorder(outcome({ summary: 's', filesChanged: [], testsAdded: [] }));
  const dev: AgentTask = { role: 'developer', cwd: '.', prompt: '', schema: DEVELOPER_SCHEMA, meta: { requirementTitle: 'Daily docs 2026-11-08: x' } };
  await new RoutingAgentRunner(claude, new Recorder(outcome(undefined, 'ran out of time')), async () => { resets++; }).run(dev, cfgWithLocal(), () => {});
  assert.equal(resets, 1, 'half-made local edits are undone before Claude starts');
});

test('routing runner: stages not routed locally go straight to Claude', async () => {
  const claude = new Recorder(outcome({ passed: true, summary: 's', testFiles: [], failures: [] }));
  const local = new Recorder(outcome({}));
  await new RoutingAgentRunner(claude, local, async () => {}).run({ role: 'tester', cwd: '.', prompt: '', schema: {} }, cfgWithLocal(), () => {});
  assert.equal(local.calls, 0);
  assert.equal(claude.calls, 1);
});

test('trim does nothing under the limit, then cuts older tool results in one go (keeps Ollama\'s cache)', () => {
  const big = 'x'.repeat(5000);
  const m = [
    { role: 'system', content: 's' }, { role: 'user', content: 'task' },
    { role: 'tool', content: big }, { role: 'assistant', content: 'a' }, { role: 'tool', content: big },
    { role: 'assistant', content: 'b' }, { role: 'tool', content: big }, { role: 'assistant', content: 'c' },
    { role: 'tool', content: big }, { role: 'assistant', content: 'd' },
  ];
  const before = JSON.stringify(m);
  assert.equal(trim(m, 25000), false, 'under the limit: nothing changes');
  assert.equal(JSON.stringify(m), before);
  assert.equal(trim(m, 18000), true);
  assert.equal(m[0].content, 's');
  assert.equal(m[1].content, 'task');
  assert.match(m[2].content, /removed/);
  assert.match(m[4].content, /removed/, 'cut down to about half the limit, not just under it');
  assert.equal(m[8].content, big, 'the latest tool result is kept');
  const after = JSON.stringify(m);
  assert.equal(trim(m, 18000), false, 'right after a cut there is room again, so the next call changes nothing');
  assert.equal(JSON.stringify(m), after);
});

test('the default transport (node:http) streams a reply that is slow to start', async () => {
  // Ollama on a slow CPU sends nothing until it has read the whole prompt; Node's fetch would give up
  // after 5 minutes without headers (cycle 22). The runner's own transport has no such limit.
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { role: 'assistant', content: '' } }) + '\n');
      setTimeout(() => res.end(JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [call('submit', { found: false, reason: 'slow but fine' })] }, done: true }) + '\n'), 50);
    }, 300));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const o = await new OllamaAgentRunner().run({ role: 'requirements', cwd: worktree(), prompt: 'pick', schema: REQUIREMENT_SCHEMA }, cfgWithLocal({ url: `http://127.0.0.1:${port}` }), () => {});
    assert.deepEqual(o.output, { found: false, reason: 'slow but fine' });
  } finally {
    server.close();
  }
});
