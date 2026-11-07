// Benchmarks local Ollama models on real vm-intent pipeline steps, on this PC's CPU.
//   node benchmark.mjs qwen3.5:4b qwen3.5:9b
// Three tests per model:
//   1. speed: a short answer, to measure prompt and generation speed;
//   2. requirements step: the real backlog in, one requirement out as JSON (the requirements agent's job);
//   3. developer step with tools: a small real code change (a new vCPU/memory rule in SpecValidator) done through read_file / list_dir / write_file
//      tool calls. Reads are real (from the pipeline's clone); writes are only recorded, never made.
// Results are written to results.txt and results.json next to this file.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OLLAMA = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
const REPO = process.env.VMINTENT_REPO ?? path.join(os.homedir(), 'agent-pipeline-home', 'repo', 'vm-intent');
const BACKLOG = path.join(os.homedir(), 'agent-pipeline-home', 'backlog.md');
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CALL_LIMIT_MS = 25 * 60_000;
const models = process.argv.slice(2);
const out = [];
const log = (s) => { console.log(s); out.push(s); };

async function chat(model, messages, { tools, numCtx = 8192, json = false } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), CALL_LIMIT_MS);
  const t0 = Date.now();
  try {
    const r = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, tools, stream: false, think: false, format: json ? 'json' : undefined, options: { num_ctx: numCtx, temperature: 0.2 } }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    const s = (ns) => ns / 1e9;
    return {
      message: j.message,
      wallSec: (Date.now() - t0) / 1000,
      promptTokens: j.prompt_eval_count ?? 0,
      promptTokPerSec: j.prompt_eval_duration ? j.prompt_eval_count / s(j.prompt_eval_duration) : null,
      outTokens: j.eval_count ?? 0,
      outTokPerSec: j.eval_duration ? j.eval_count / s(j.eval_duration) : null,
    };
  } finally {
    clearTimeout(t);
  }
}
const fmt = (r) => `${r.wallSec.toFixed(0)} s; prompt ${r.promptTokens} tok at ${r.promptTokPerSec?.toFixed(1)} tok/s; output ${r.outTokens} tok at ${r.outTokPerSec?.toFixed(1)} tok/s`;
const read = (rel) => readFileSync(path.join(REPO, rel), 'utf8');

async function speed(model) {
  const r = await chat(model, [{ role: 'user', content: 'In about 120 words, explain what a Temporal workflow is to a junior Java developer.' }]);
  return { ok: true, detail: fmt(r), r };
}

async function requirements(model) {
  const backlog = readFileSync(BACKLOG, 'utf8');
  const readme = read('README.md').slice(0, 6000);
  const sys = `You are the REQUIREMENTS agent of a software pipeline for the vm-intent project. Choose the ONE next requirement from the backlog: the first open item that is not already done. Answer with JSON only: {"id":"AP-0022","title":"...","rationale":"...","acceptanceCriteria":["..."],"risk":"low|medium|high"}. Each acceptance criterion must be checkable by a tester. Never require a change to docs/SECURITY.md (protected).`;
  const user = `Already merged: AP-0021 (VmIdentity: one place for the identity hash and workflow IDs).\n\nBACKLOG:\n${backlog}\n\nREADME (start):\n${readme}`;
  const r = await chat(model, [{ role: 'system', content: sys }, { role: 'user', content: user }], { numCtx: 16384, json: true });
  let parsed = null;
  try { parsed = JSON.parse(r.message.content); } catch { /* not JSON */ }
  const fields = parsed && ['title', 'rationale', 'acceptanceCriteria', 'risk'].every((k) => k in parsed);
  const picked = parsed?.title ?? '(none)';
  const sensible = /histor/i.test(picked);
  return { ok: !!fields, detail: `${fmt(r)}\n    valid JSON with all fields: ${!!fields}; picked: "${picked.slice(0, 160)}"; picked the expected item (replay histories): ${sensible}; criteria: ${parsed?.acceptanceCriteria?.length ?? 0}`, r, parsed };
}

const TOOLS = [
  { type: 'function', function: { name: 'list_dir', description: 'List a directory in the vm-intent repo', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a file in the vm-intent repo', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Write the full new content of a file in the vm-intent repo', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
];

async function developer(model) {
  const task = `Task: in backend/src/main/java/com/example/vmintent/spec/SpecValidator.java, add one more rule next to the Windows disk rule: a VM with more than 32 vCPUs needs at least 64 GiB of memory, with the message \"More than 32 vCPUs needs at least 64 GiB of memory.\" in the same style as the others. Use the tools: find and read the file, then write the whole updated file with write_file. Don't change anything else. When done, reply DONE.`;
  const messages = [{ role: 'system', content: 'You are the DEVELOPER agent. You change code only through the tools given. Paths are relative to the vm-intent repo root.' }, { role: 'user', content: task }];
  const calls = [];
  let written = null;
  let bad = 0;
  let total = { wallSec: 0, promptTokens: 0, outTokens: 0 };
  let last;
  for (let turn = 0; turn < 8; turn++) {
    const r = await chat(model, messages, { tools: TOOLS, numCtx: 16384 });
    last = r;
    total.wallSec += r.wallSec; total.promptTokens += r.promptTokens; total.outTokens += r.outTokens;
    messages.push(r.message);
    const tc = r.message.tool_calls ?? [];
    if (!tc.length) break;
    for (const c of tc) {
      const name = c.function?.name;
      let args = c.function?.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = null; } }
      calls.push(`${name}(${args?.path ?? '?'})`);
      let result;
      const p = args?.path ? path.join(REPO, String(args.path).replace(/^\/+/, '').replace(/^vm-intent\//, '')) : null;
      if (!p || !p.startsWith(REPO)) { bad++; result = 'error: bad path'; }
      else if (name === 'list_dir') result = existsSync(p) ? readdirSync(p).join('\n') : 'error: no such directory';
      else if (name === 'read_file') result = existsSync(p) ? readFileSync(p, 'utf8') : 'error: no such file';
      else if (name === 'write_file') { written = { path: args.path, content: String(args.content ?? '') }; result = 'ok (recorded, not written)'; }
      else { bad++; result = 'error: unknown tool'; }
      messages.push({ role: 'tool', content: result, tool_name: name });
    }
    if (written) break;
  }
  const orig = read('backend/src/main/java/com/example/vmintent/spec/SpecValidator.java');
  const good = written && /SpecValidator\.java$/.test(written.path) && /vcpu\(\) *> *32/.test(written.content) && /64/.test(written.content) && /Windows needs at least a 64 GiB disk/.test(written.content) && written.content.length > orig.length * 0.8;
  if (written) writeFileSync(path.join(HERE, `dev-output-${model.replace(/[:/]/g, '_')}.java`), written.content);
  return { ok: !!good, detail: `${total.wallSec.toFixed(0)} s over ${calls.length} tool call(s), ${total.promptTokens} prompt tok, ${total.outTokens} output tok (last call: ${last ? fmt(last) : '-'})\n    tool calls: ${calls.join(', ') || '(none)'}; bad calls: ${bad}; wrote SpecValidator with the new vCPU/memory rule and kept the rest: ${!!good}` };
}

log(`Local model benchmark on ${os.hostname()} (${os.cpus()[0].model}, ${os.cpus().length} threads, ${(os.totalmem() / 2 ** 30).toFixed(1)} GB RAM, ${(os.freemem() / 2 ** 30).toFixed(1)} GB free) - ${new Date().toISOString()}`);
const results = {};
for (const model of models) {
  log(`\n== ${model}`);
  results[model] = {};
  for (const [name, fn] of [['speed', speed], ['requirements step', requirements], ['developer step with tools', developer]]) {
    try {
      const r = await fn(model);
      results[model][name] = { ok: r.ok, detail: r.detail };
      log(`  ${name}: ${r.ok ? 'PASS' : 'FAIL'} - ${r.detail}`);
    } catch (e) {
      results[model][name] = { ok: false, detail: String(e) };
      log(`  ${name}: ERROR - ${e}`);
    }
    writeFileSync(path.join(HERE, 'results.txt'), out.join('\n') + '\n');
    writeFileSync(path.join(HERE, 'results.json'), JSON.stringify(results, null, 2));
  }
}
log('\nfinished');
writeFileSync(path.join(HERE, 'results.txt'), out.join('\n') + '\n');
