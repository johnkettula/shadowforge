// AP-0029 acceptance, live half: on the running server (simulator) nothing visible changes. A new single-VM request
// reaches COMPLETED; the same text again ends DUPLICATE and builds nothing (GET /api/v2/vms lists the VM once, with
// the same vmId) (criterion 9). The served OpenAPI document still equals docs/openapi.json (criterion 8).
// Builds one simulated VM with a unique name per run.
//
//   node --test tests/acceptance/ap-0029/live_api.test.mjs      (VMINTENT_API defaults to http://127.0.0.1:19090)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19090').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const RUN = Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, 'x');
const USER = `ap0029-${RUN}`;
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

/** Creates a request, confirms it with its specHash and returns its final status and spec hash. */
async function runToEnd(text) {
  const r = await call('POST', '/api/v2/requests', { text, userId: USER });
  assert.equal(r.status, 200, `createRequest "${text}": ${r.text.slice(0, 200)}`);
  const id = r.body?.requestId;
  assert.ok(id, 'createRequest returns a requestId');
  const pending = await waitState(id, ['AWAITING_CONFIRMATION', 'AWAITING_CLARIFICATION', ...FINAL], 120_000);
  if (FINAL.includes(pending.state)) return { id, done: pending, specHash: pending.interpretation?.specHash };
  assert.equal(pending.state, 'AWAITING_CONFIRMATION', `"${text}" waits for confirmation: ${pending.message || ''}`);
  const specHash = pending.interpretation?.specHash;
  assert.ok(specHash, 'the pending request shows a specHash');
  const c = await call('POST', `/api/v2/requests/${id}/confirm`, { specHash });
  assert.equal(c.status, 200, `confirmRequest: ${c.text.slice(0, 200)}`);
  return { id, done: await waitState(id, FINAL), specHash };
}

/** Inventory entries whose spec name is exactly this name. */
async function vmsNamed(name) {
  const inv = await call('GET', '/api/v2/vms');
  assert.equal(inv.status, 200, `listVms: ${inv.text.slice(0, 200)}`);
  assert.ok(Array.isArray(inv.body), 'GET /api/v2/vms returns a list');
  return inv.body.filter((v) => v.spec?.name === name);
}

test('9: a new single VM reaches COMPLETED; the same text again is DUPLICATE and builds nothing new',
  { timeout: 900_000 }, async () => {
    const name = `adopt${RUN}`;
    const text = `1 small ubuntu server on aws called ${name}`;

    const first = await runToEnd(text);
    assert.equal(first.done.state, 'COMPLETED', `first request: ${first.done.message}`);
    const after1 = await vmsNamed(name);
    assert.equal(after1.length, 1, `the inventory lists ${name} once: ${JSON.stringify(after1).slice(0, 400)}`);
    const vmId = after1[0].result?.vmId;
    assert.ok(vmId, `${name} has a vmId: ${JSON.stringify(after1[0]).slice(0, 400)}`);

    const second = await runToEnd(text);
    assert.equal(second.done.state, 'DUPLICATE', `same text again: ${second.done.message}`);
    if (first.specHash && second.specHash) assert.equal(second.specHash, first.specHash, 'the same text gives the same spec hash');

    const after2 = await vmsNamed(name);
    assert.equal(after2.length, 1, `the inventory still lists ${name} once: ${JSON.stringify(after2).slice(0, 400)}`);
    assert.equal(after2[0].result?.vmId, vmId, 'the VM is the same one (no new build)');
  });

test('8: GET /v3/api-docs (servers left out) still equals docs/openapi.json (servers left out)', async () => {
  const r = await call('GET', '/v3/api-docs');
  assert.equal(r.status, 200, r.text.slice(0, 200));
  const strip = ({ servers, ...rest }) => rest;
  const snapshot = strip(JSON.parse(readFileSync(join(ROOT, 'docs', 'openapi.json'), 'utf8')));
  assert.deepEqual(strip(r.body), snapshot);
});
