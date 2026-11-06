// AP-0017 acceptance, live half (criterion 11): adding AzureArmBackend changes nothing a user sees. An Azure request
// (a small linux VM on azure, then confirm) still completes with a simulated VM whose ID starts with az-vm-, and
// GET /v3/api-docs lists the same paths as the checked-in docs/openapi.json snapshot. Builds one simulated Azure VM.
//
//   VMINTENT_API=http://127.0.0.1:19070 node --test tests/acceptance/ap-0017/live_api.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19070').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};
const RUN = Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, 'x');
const USER = `ap0017-${RUN}`;
const FINAL = ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'DUPLICATE'];
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

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

test('11: an Azure request (small linux VM on azure, then confirm) still completes with a simulated az-vm- VM', { timeout: 600_000 }, async () => {
  const name = `ap17-${RUN}`;
  const r = await call('POST', '/api/v2/requests', { text: `a small linux VM on azure called ${name}`, userId: USER });
  assert.equal(r.status, 200, `createRequest: ${r.status} ${r.text.slice(0, 300)}`);
  const id = r.body?.requestId;
  assert.ok(id, `createRequest returns a requestId: ${r.text.slice(0, 300)}`);

  const pending = await waitState(id, ['AWAITING_CONFIRMATION', 'AWAITING_CLARIFICATION', ...FINAL], 120_000);
  assert.equal(pending.state, 'AWAITING_CONFIRMATION', `request waits for confirmation: ${pending.state} ${pending.message || ''}`);
  assert.match(JSON.stringify(pending.interpretation || {}).toLowerCase(), /azure/,
    `the request was understood as Azure: ${JSON.stringify(pending.interpretation).slice(0, 400)}`);

  const c = await call('POST', `/api/v2/requests/${id}/confirm`, { specHash: pending.interpretation?.specHash });
  assert.equal(c.status, 200, `confirmRequest: ${c.status} ${c.text.slice(0, 300)}`);

  const done = await waitState(id, FINAL);
  assert.equal(done.state, 'COMPLETED', `the Azure VM was built: ${done.state} ${done.message || ''}`);
  assert.ok(done.vm, `the completed request has a vm: ${JSON.stringify(done).slice(0, 400)}`);
  assert.match(done.vm.vmId || '', /^az-vm-/, `simulated Azure VM ID starts with az-vm-: ${done.vm.vmId}`);
  assert.doesNotMatch(done.vm.vmId || '', /^arm:/, 'the request did not go to AzureArmBackend');
  assert.equal(done.vm.provider, 'azure', `the VM's provider is azure: ${JSON.stringify(done.vm)}`);
});

test('11: GET /v3/api-docs lists the same paths as docs/openapi.json', async () => {
  const r = await call('GET', '/v3/api-docs');
  assert.equal(r.status, 200, `/v3/api-docs: ${r.status}`);
  const live = Object.keys(r.body?.paths || {}).sort();
  const snap = Object.keys(JSON.parse(readFileSync(join(ROOT, 'docs', 'openapi.json'), 'utf8')).paths || {}).sort();
  assert.ok(live.length > 0, 'the server lists paths');
  assert.deepEqual(live, snap, `live paths match the snapshot (missing: ${snap.filter((p) => !live.includes(p))}; extra: ${live.filter((p) => !snap.includes(p))})`);
});
