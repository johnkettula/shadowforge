// AP-0012 acceptance, live half: a multi-VM request whose missing VMs all build ends COMPLETED (not PARTIAL)
// when the others already existed; the all-existing DUPLICATE and all-failed FAILED outcomes are unchanged;
// the getRequest description names PARTIAL and the five final states; docs/openapi.* equal the live document.
// Covers criteria 1-4 against the running server. Builds a few simulated VMs.
//
//   VMINTENT_API=http://127.0.0.1:19020 node --test tests/acceptance/ap-0012/live_api.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19020').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const RUN = Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, 'x');
const USER = `ap0012-${RUN}`;
const FINAL = ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'DUPLICATE'];
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

let doc;

async function call(method, path, body) {
  const headers = { Accept: 'application/json', ...AUTH };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: res.status, text, body: json };
}

async function waitState(id, states, timeoutMs = 240_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    const r = await call('GET', `/api/v2/requests/${id}`);
    if (r.status === 200) {
      last = r.body;
      if (states.includes(last.state)) return last;
    }
    await sleep(700);
  }
  assert.fail(`request ${id} never reached ${states.join('/')} (last: ${last?.state} ${last?.message || ''})`);
}

/** Creates a request, confirms it with its specHash and returns its final status. */
async function runToEnd(text) {
  const r = await call('POST', '/api/v2/requests', { text, userId: USER });
  assert.equal(r.status, 200, `createRequest "${text}": ${r.text.slice(0, 200)}`);
  const id = r.body?.requestId;
  assert.ok(id, 'createRequest returns a requestId');
  const pending = await waitState(id, ['AWAITING_CONFIRMATION', 'AWAITING_CLARIFICATION', ...FINAL], 120_000);
  assert.equal(pending.state, 'AWAITING_CONFIRMATION', `"${text}" waits for confirmation: ${pending.message || ''}`);
  const specHash = pending.interpretation?.specHash;
  assert.ok(specHash, 'the pending request shows a specHash');
  const c = await call('POST', `/api/v2/requests/${id}/confirm`, { specHash });
  assert.equal(c.status, 200, `confirmRequest: ${c.text.slice(0, 200)}`);
  const done = await waitState(id, FINAL);
  return { id, done };
}

function operation(d, operationId) {
  for (const [p, item] of Object.entries(d.paths)) {
    for (const [m, op] of Object.entries(item)) if (op && op.operationId === operationId) return { path: p, method: m, op };
  }
  return null;
}

before(async () => {
  const res = await fetch(BASE + '/v3/api-docs', { headers: AUTH });
  assert.equal(res.status, 200, 'GET /v3/api-docs');
  doc = await res.json();
});

// ---- Criteria 1 and 2 ----
test('1-2: 2 then 3 servers called N -> COMPLETED, COMPLETED naming N-01/N-02 with N-03 built, then DUPLICATE',
  { timeout: 900_000 }, async () => {
    const N = `pd${RUN}`;
    const first = await runToEnd(`2 small ubuntu servers on aws called ${N}`);
    assert.equal(first.done.state, 'COMPLETED', `first request (2 VMs): ${first.done.message}`);

    const second = await runToEnd(`3 small ubuntu servers on aws called ${N}`);
    const s = second.done;
    assert.notEqual(s.state, 'PARTIAL', `3 VMs with 2 already existing must not be PARTIAL: ${s.message}`);
    assert.equal(s.state, 'COMPLETED', `second request (3 VMs, 2 existed): ${s.message}`);
    assert.match(s.message || '', /already existed/i, `message says VMs already existed: ${s.message}`);
    assert.ok((s.message || '').includes(`${N}-01`), `message names ${N}-01: ${s.message}`);
    assert.ok((s.message || '').includes(`${N}-02`), `message names ${N}-02: ${s.message}`);
    assert.ok(Array.isArray(s.vms) && s.vms.length > 0, `status has a vms list: ${JSON.stringify(s).slice(0, 400)}`);
    // A vms entry (VmResult) carries the provider's vmId, not the name: look the name up in the inventory.
    const inv = await call('GET', '/api/v2/vms');
    assert.equal(inv.status, 200, `listVms: ${inv.text.slice(0, 200)}`);
    const nameByVmId = new Map((inv.body || []).filter((v) => v.result?.vmId).map((v) => [v.result.vmId, v.spec?.name]));
    const names = s.vms.map((v) => nameByVmId.get(v.vmId));
    assert.ok(names.includes(`${N}-03`), `vms contains ${N}-03 (vms resolve to ${JSON.stringify(names)}): ${JSON.stringify(s.vms)}`);

    // Criterion 2: a third identical request still ends DUPLICATE, since all three exist.
    const third = await runToEnd(`3 small ubuntu servers on aws called ${N}`);
    assert.equal(third.done.state, 'DUPLICATE', `third request (all 3 existed): ${third.done.message}`);
  });

// ---- Criterion 3 ----
test('3: a multi-VM request whose VMs all fail still ends FAILED', { timeout: 600_000 }, async () => {
  const { done } = await runToEnd(`2 ubuntu boxes on gcp called fail-${RUN}`);
  assert.equal(done.state, 'FAILED', `all-failing request: ${done.message}`);
});

// ---- Criterion 4 ----
test('4: getRequest description lists PARTIAL and names the five final states; old sentence gone', () => {
  const found = operation(doc, 'getRequest');
  assert.ok(found, 'the live document has getRequest');
  const d = found.op.description || '';
  const list = /state is one of ([^.]*)/.exec(d);
  assert.ok(list, `description lists the states: ${d}`);
  assert.match(list[1], /\bPARTIAL\b/, `PARTIAL is among the states: ${list[1]}`);
  const fin = /final states? (?:are|is)[^.]*/i.exec(d);
  assert.ok(fin, `description names the final states: ${d}`);
  for (const s of FINAL) assert.match(fin[0], new RegExp(`\\b${s}\\b`), `${s} named as final: ${fin[0]}`);
  assert.doesNotMatch(d, /The last four of the first list are final/);
});

test('4: getRequest, clarifyRequest, confirmRequest, cancelRequest keep operationIds, paths and response codes', () => {
  // Compare against docs/openapi.json as it was just before the first AP-0012 commit.
  const shas = execFileSync('git', ['log', '--format=%H', '--no-merges', '--grep=^AP-0012:'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  assert.ok(shas.length > 0, 'found the AP-0012 commits');
  const oldest = shas[shas.length - 1];
  const prev = JSON.parse(execFileSync('git', ['show', `${oldest}^:vm-intent/docs/openapi.json`],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  for (const id of ['getRequest', 'clarifyRequest', 'confirmRequest', 'cancelRequest']) {
    const now = operation(doc, id);
    const was = operation(prev, id);
    assert.ok(now, `live document has ${id}`);
    assert.ok(was, `earlier document had ${id}`);
    assert.equal(now.path, was.path, `${id} path`);
    assert.equal(now.method, was.method, `${id} method`);
    assert.deepEqual(Object.keys(now.op.responses).sort(), Object.keys(was.op.responses).sort(), `${id} response codes`);
  }
});

test('4: docs/openapi.json (servers left out) equals the live /v3/api-docs (servers left out)', () => {
  const strip = ({ servers, ...rest }) => rest;
  const snapshot = strip(JSON.parse(readFileSync(join(ROOT, 'docs', 'openapi.json'), 'utf8')));
  assert.deepEqual(snapshot, strip(doc));
});

test('4: docs/openapi.yaml (servers left out) equals the live /v3/api-docs.yaml (servers left out)', async () => {
  const res = await fetch(BASE + '/v3/api-docs.yaml', { headers: AUTH });
  assert.equal(res.status, 200, 'GET /v3/api-docs.yaml');
  const strip = (text) => {
    const lines = text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
    const start = lines.indexOf('servers:');
    if (start < 0) return lines;
    let end = start + 1;
    while (end < lines.length && (lines[end].startsWith(' ') || lines[end].startsWith('-'))) end++;
    return [...lines.slice(0, start), ...lines.slice(end)];
  };
  const live = strip(await res.text());
  const snapshot = strip(readFileSync(join(ROOT, 'docs', 'openapi.yaml'), 'utf8'));
  const i = live.findIndex((l, n) => l !== snapshot[n]);
  assert.ok(i < 0 && live.length === snapshot.length,
    `docs/openapi.yaml differs from live at line ${i + 1}: live "${live[i]}" vs snapshot "${snapshot[i]}"`);
});
