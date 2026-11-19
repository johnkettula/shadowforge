// AP-0049 acceptance, live half (staging runs with sign-in off): the cloud name is unchanged for an anonymous owner.
// - POST /api/v2/interpret of a named text returns cloudName == spec.name; an unnamed text gets vm-<8 hex> for both.
// - A VM built through POST /api/v2/requests reads back from GET /api/v2/vms/{specHash} with the asked-for name.
// - The served OpenAPI document describes Interpretation.cloudName with the new rule (criterion 6).
// The VM built here is decommissioned at the end (best effort).
//
//   node --test tests/acceptance/ap-0049/live_api.test.mjs      (VMINTENT_API defaults to http://127.0.0.1:19090)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19090').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};
const RUN = (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).replace(/[^a-z0-9]/g, 'x');
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

test('criterion 7: interpreting a named text previews cloudName equal to spec.name', async () => {
  const name = `ap49-${RUN}`;
  const r = await call('POST', '/api/v2/interpret', { text: `a small ubuntu server on aws called ${name}` });
  assert.equal(r.status, 200, `POST /api/v2/interpret: ${r.status} ${r.text.slice(0, 400)}`);
  assert.ok(!r.body?.question, `the preview asks a question: ${r.body?.question}`);
  assert.equal(r.body?.spec?.name, name, 'spec.name is the name asked for');
  assert.equal(r.body?.cloudName, r.body?.spec?.name, 'with sign-in off, cloudName is spec.name (no suffix)');
  assert.match(r.body?.specHash || '', /^[0-9a-f]{64}$/);
});

test('criterion 7: interpreting a text with no name previews cloudName equal to spec.name, vm-<8 hex>', async () => {
  const r = await call('POST', '/api/v2/interpret', { text: 'a small ubuntu server on aws' });
  assert.equal(r.status, 200, `POST /api/v2/interpret: ${r.status} ${r.text.slice(0, 400)}`);
  assert.ok(!r.body?.question, `the preview asks a question: ${r.body?.question}`);
  assert.match(String(r.body?.spec?.name), /^vm-[0-9a-f]{8}$/);
  assert.equal(r.body?.cloudName, r.body?.spec?.name);
  assert.equal(r.body.spec.name, 'vm-' + r.body.specHash.slice(0, 8), 'the generated name is vm- + the first 8 hex of specHash');
});

test('criterion 7: a VM built through POST /api/v2/requests reads back with the asked-for spec.name', { timeout: 600_000 }, async () => {
  const name = `ap49b-${RUN}`;
  const text = `a small ubuntu server on aws called ${name}`;
  const r = await call('POST', '/api/v2/requests', { text });
  assert.equal(r.status, 200, `createRequest: ${r.status} ${r.text.slice(0, 300)}`);
  const id = r.body?.requestId;
  assert.ok(id, 'createRequest returns a requestId');
  const pending = await waitState(id, ['AWAITING_CONFIRMATION', 'AWAITING_CLARIFICATION', ...FINAL], 120_000);
  assert.equal(pending.state, 'AWAITING_CONFIRMATION', `the request: ${pending.state} ${pending.message || ''}`);
  const specHash = pending.interpretation?.specHash;
  assert.match(specHash || '', /^[0-9a-f]{64}$/, 'the pending request shows a specHash');
  assert.equal(pending.interpretation?.spec?.name, name);
  if (pending.interpretation && 'cloudName' in pending.interpretation) {
    assert.equal(pending.interpretation.cloudName, name, 'with sign-in off the request\'s cloudName is the asked-for name');
  }
  const c = await call('POST', `/api/v2/requests/${id}/confirm`, { specHash });
  assert.equal(c.status, 200, `confirmRequest: ${c.status} ${c.text.slice(0, 300)}`);
  try {
    const done = await waitState(id, FINAL);
    assert.equal(done.state, 'COMPLETED', `the request: ${done.state} ${done.message || ''}`);
    const vm = await call('GET', `/api/v2/vms/${specHash}`);
    assert.equal(vm.status, 200, `GET /api/v2/vms/${specHash}: ${vm.status} ${vm.text.slice(0, 300)}`);
    assert.equal(vm.body?.specHash, specHash);
    assert.equal(vm.body?.spec?.name, name, 'the VM record keeps the name asked for');
  } finally {
    await call('POST', `/api/v2/vms/${specHash}/decommission`, { reason: `AP-0049 acceptance ${RUN}` }).catch(() => {});
  }
});

test('criterion 6: the served /v3/api-docs describes Interpretation.cloudName with the new rule', async () => {
  const r = await call('GET', '/v3/api-docs');
  assert.equal(r.status, 200, `GET /v3/api-docs: ${r.status} ${r.text.slice(0, 200)}`);
  const d = r.body?.components?.schemas?.Interpretation?.properties?.cloudName?.description;
  assert.equal(typeof d, 'string', 'Interpretation.cloudName has no description');
  assert.ok(d.includes('name in its cloud'), d);
  assert.ok(d.includes('same as spec.name'), d);
  assert.match(d, /signed-in/i, d);
  assert.match(d, /['"`]-['"`] plus the first 8 characters of specHash/, d);
});
