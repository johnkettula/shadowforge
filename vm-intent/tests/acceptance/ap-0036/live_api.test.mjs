// AP-0036 acceptance, live half (criteria 7 and 8): on the simulator nothing changes. The served OpenAPI document
// still equals docs/openapi.json; a new single VM with a unique name reaches COMPLETED, its VM record (looked up by
// the request's specHash) shows the name asked for and RUNNING, and the same text again ends DUPLICATE without a
// second VM. Builds one simulated VM per run.
//
// The API has no GET /api/v2/vms/{specHash} (and AP-0036 may not change the API), so the record is looked up by
// specHash in GET /api/v2/vms; if a later requirement adds the single-VM read, it is used instead.
//
//   node --test tests/acceptance/ap-0036/live_api.test.mjs      (VMINTENT_API defaults to http://127.0.0.1:19060)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19060').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const RUN = Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, 'x');
const USER = `ap0036-${RUN}`;
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

/** Creates a request, confirms it with its specHash when it asks, and returns its final status. */
async function runToEnd(text) {
  const r = await call('POST', '/api/v2/requests', { text, userId: USER });
  assert.equal(r.status, 200, `createRequest "${text}": ${r.text.slice(0, 200)}`);
  const id = r.body?.requestId;
  assert.ok(id, 'createRequest returns a requestId');
  const pending = await waitState(id, ['AWAITING_CONFIRMATION', 'AWAITING_CLARIFICATION', ...FINAL], 120_000);
  assert.notEqual(pending.state, 'AWAITING_CLARIFICATION', `"${text}" asked a question: ${pending.message || ''}`);
  if (FINAL.includes(pending.state)) return { id, specHash: pending.interpretation?.specHash, done: pending };
  const specHash = pending.interpretation?.specHash;
  assert.ok(specHash, 'the pending request shows a specHash');
  const c = await call('POST', `/api/v2/requests/${id}/confirm`, { specHash });
  assert.equal(c.status, 200, `confirmRequest: ${c.text.slice(0, 200)}`);
  const done = await waitState(id, FINAL);
  return { id, specHash: done.interpretation?.specHash || specHash, done };
}

/** The VM record for a spec hash: GET /api/v2/vms/{specHash} if the server has it, else its entry in GET /api/v2/vms. */
async function vmRecord(specHash) {
  const one = await call('GET', `/api/v2/vms/${encodeURIComponent(specHash)}`);
  if (one.status === 200 && one.body?.specHash) return one.body;
  const all = await call('GET', '/api/v2/vms');
  assert.equal(all.status, 200, `GET /api/v2/vms: ${all.text.slice(0, 200)}`);
  assert.ok(Array.isArray(all.body), 'GET /api/v2/vms is a list');
  const mine = all.body.filter((v) => v.specHash === specHash);
  assert.equal(mine.length, 1, `${specHash} is listed ${mine.length} times`);
  return mine[0];
}

test('criterion 7: GET /v3/api-docs (servers left out) still equals docs/openapi.json (servers left out)', async () => {
  const r = await call('GET', '/v3/api-docs');
  assert.equal(r.status, 200, `GET /v3/api-docs: ${r.text.slice(0, 200)}`);
  const strip = ({ servers, ...rest }) => rest;
  const snapshot = strip(JSON.parse(readFileSync(join(ROOT, 'docs', 'openapi.json'), 'utf8')));
  assert.deepEqual(strip(r.body), snapshot);
});

test('criterion 8: a single simulator VM reaches COMPLETED, its record keeps the asked-for name and is RUNNING, '
  + 'and the same text again is DUPLICATE and builds nothing new', { timeout: 900_000 }, async () => {
  const name = `ap36-${RUN}`;
  const text = `a small ubuntu server on aws called ${name}`;

  const first = await runToEnd(text);
  assert.equal(first.done.state, 'COMPLETED', `first request: ${first.done.message || ''}`);
  assert.ok(first.specHash, 'the request shows its specHash');

  const vm = await vmRecord(first.specHash);
  assert.equal(vm.spec?.name, name, `the VM record's spec.name: ${JSON.stringify(vm).slice(0, 400)}`);
  assert.equal(vm.state, 'RUNNING', `the VM record's state: ${JSON.stringify(vm).slice(0, 400)}`);
  const vmId = vm.result?.vmId;
  const before = (await call('GET', '/api/v2/vms')).body.filter((v) => v.spec?.name === name).length;
  assert.equal(before, 1, `${name} is listed ${before} times after the first build`);

  const second = await runToEnd(text);
  assert.equal(second.done.state, 'DUPLICATE', `the same text again: ${second.done.message || ''}`);
  if (second.specHash) assert.equal(second.specHash, first.specHash, 'the same text gives the same spec hash');

  const after = (await call('GET', '/api/v2/vms')).body.filter((v) => v.spec?.name === name);
  assert.equal(after.length, 1, `${name} is listed ${after.length} times after the duplicate: ${JSON.stringify(after).slice(0, 600)}`);
  const again = await vmRecord(first.specHash);
  assert.equal(again.state, 'RUNNING', 'the VM is still RUNNING after the duplicate');
  if (vmId) assert.equal(again.result?.vmId, vmId, 'the duplicate built no new VM (same vmId)');
});
