// AP-0032 acceptance, live half (criteria 8 and 9): on the simulator nothing changes. The served OpenAPI document
// still equals docs/openapi.json; a new single VM with a unique name reaches COMPLETED, the same text again ends
// DUPLICATE, and GET /api/v2/vms lists that VM once. Builds one simulated VM per run.
//
//   node --test tests/acceptance/ap-0032/live_api.test.mjs      (VMINTENT_API defaults to http://127.0.0.1:19020)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19020').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const RUN = Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, 'x');
const USER = `ap0032-${RUN}`;
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
  if (FINAL.includes(pending.state)) return { id, done: pending };
  const specHash = pending.interpretation?.specHash;
  assert.ok(specHash, 'the pending request shows a specHash');
  const c = await call('POST', `/api/v2/requests/${id}/confirm`, { specHash });
  assert.equal(c.status, 200, `confirmRequest: ${c.text.slice(0, 200)}`);
  return { id, specHash, done: await waitState(id, FINAL) };
}

test('criterion 8: GET /v3/api-docs (servers left out) still equals docs/openapi.json (servers left out)', async () => {
  const r = await call('GET', '/v3/api-docs');
  assert.equal(r.status, 200, `GET /v3/api-docs: ${r.text.slice(0, 200)}`);
  const strip = ({ servers, ...rest }) => rest;
  const snapshot = strip(JSON.parse(readFileSync(join(ROOT, 'docs', 'openapi.json'), 'utf8')));
  assert.deepEqual(strip(r.body), snapshot);
});

test('criterion 9: a new single VM reaches COMPLETED, the same text again is DUPLICATE, and the VM is listed once',
  { timeout: 900_000 }, async () => {
    const name = `ap32-${RUN}`;
    const text = `1 small ubuntu server on aws called ${name}`;

    const first = await runToEnd(text);
    assert.equal(first.done.state, 'COMPLETED', `first request: ${first.done.message || ''}`);

    const second = await runToEnd(text);
    assert.equal(second.done.state, 'DUPLICATE', `the same text again: ${second.done.message || ''}`);
    if (first.specHash && second.specHash) assert.equal(second.specHash, first.specHash, 'the same text gives the same spec hash');

    const inv = await call('GET', '/api/v2/vms');
    assert.equal(inv.status, 200, `GET /api/v2/vms: ${inv.text.slice(0, 200)}`);
    assert.ok(Array.isArray(inv.body), 'GET /api/v2/vms is a list');
    const mine = inv.body.filter((v) => v.spec?.name === name);
    assert.equal(mine.length, 1, `${name} is listed ${mine.length} times: ${JSON.stringify(mine).slice(0, 600)}`);
  });
