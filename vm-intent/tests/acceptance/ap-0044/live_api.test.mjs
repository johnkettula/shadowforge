// AP-0044 acceptance, live half (criteria 1-5 against the running server): GET /api/v2/vms/{specHash} (getVm).
// - A VM built during the run (a confirmed request) is returned by getVm with 200: same specHash, the asked-for
//   spec.name and the same state as its entry in GET /api/v2/vms.
// - After POST .../decommission, getVm still answers 200 for it (in its final state, again matching the VM list).
// - abc and 64 upper-case hex characters answer 400, 64 '0's (well-formed, no such VM) 404, each with an ApiError body.
// - The served OpenAPI document has GET /api/v2/vms/{specHash} with operationId getVm and responses 200 (VmRecord),
//   400 and 404, and (servers left out) equals docs/openapi.json.
// Builds one simulated VM per run and decommissions it.
//
//   node --test tests/acceptance/ap-0044/live_api.test.mjs      (VMINTENT_API defaults to http://127.0.0.1:19040)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19040').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const RUN = Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, 'x');
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

/** Creates a request, confirms it with its specHash, and returns its final status. */
async function runToEnd(text) {
  const r = await call('POST', '/api/v2/requests', { text });
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

/** The VM's entry in GET /api/v2/vms (exactly one). */
async function listed(specHash) {
  const all = await call('GET', '/api/v2/vms');
  assert.equal(all.status, 200, `GET /api/v2/vms: ${all.text.slice(0, 200)}`);
  assert.ok(Array.isArray(all.body), 'GET /api/v2/vms is a list');
  const mine = all.body.filter((v) => v.specHash === specHash);
  assert.equal(mine.length, 1, `${specHash} is listed ${mine.length} times in GET /api/v2/vms`);
  return mine[0];
}

function isApiError(r, what) {
  assert.ok(r.body && typeof r.body === 'object' && !Array.isArray(r.body), `${what}: the body isn't a JSON object: ${r.text.slice(0, 300)}`);
  assert.equal(typeof r.body.error, 'string', `${what}: the body has no "error" string (ApiError): ${r.text.slice(0, 300)}`);
  assert.ok(r.body.error.length > 0, `${what}: empty error`);
}

let served;
async function apiDocs() {
  if (!served) {
    const r = await call('GET', '/v3/api-docs');
    assert.equal(r.status, 200, `GET /v3/api-docs: ${r.text.slice(0, 200)}`);
    served = r.body;
  }
  return served;
}

// ------------------------------------------------------------------ 1-2. a built VM, before and after decommission

test('criteria 1-2: a VM built during the test is returned by getVm (200, same specHash, name and state as the VM list), also after decommission',
  { timeout: 900_000 }, async () => {
    const name = `getvm-${RUN}`;
    const built = await runToEnd(`a small ubuntu server on aws called ${name}`);
    assert.equal(built.done.state, 'COMPLETED', `the request: ${built.done.state} ${built.done.message || ''}`);
    const h = built.specHash;
    assert.match(h || '', /^[0-9a-f]{64}$/, `the request has no specHash: ${JSON.stringify(built.done).slice(0, 300)}`);

    // Criterion 1.
    const entry = await listed(h);
    const r = await call('GET', `/api/v2/vms/${h}`);
    assert.equal(r.status, 200, `GET /api/v2/vms/${h}: ${r.status} ${r.text.slice(0, 300)}`);
    assert.ok(r.body && typeof r.body === 'object', `getVm returned no JSON: ${r.text.slice(0, 300)}`);
    assert.equal(r.body.specHash, h, 'getVm\'s specHash');
    assert.equal(r.body.spec?.name, name, 'getVm\'s spec.name is the asked-for name');
    assert.equal(r.body.state, entry.state, `getVm's state ${r.body.state} differs from the VM list's ${entry.state}`);
    assert.equal(r.body.state, 'RUNNING', 'a just-built simulated VM is RUNNING');

    // Criterion 2.
    const d = await call('POST', `/api/v2/vms/${h}/decommission`, { reason: `AP-0044 acceptance ${RUN}` });
    assert.equal(d.status, 200, `decommissionVm: ${d.status} ${d.text.slice(0, 300)}`);
    const after = await call('GET', `/api/v2/vms/${h}`);
    assert.equal(after.status, 200, `GET /api/v2/vms/${h} right after decommission: ${after.status} ${after.text.slice(0, 300)}`);
    assert.equal(after.body?.specHash, h);

    // Wait for the record to leave RUNNING (decommissioning may finish asynchronously), then compare with the list.
    let last = after.body;
    const end = Date.now() + 120_000;
    while (last?.state === 'RUNNING' && Date.now() < end) {
      await sleep(1000);
      const again = await call('GET', `/api/v2/vms/${h}`);
      assert.equal(again.status, 200, `GET /api/v2/vms/${h} after decommission: ${again.status} ${again.text.slice(0, 300)}`);
      last = again.body;
    }
    assert.notEqual(last?.state, 'RUNNING', 'the record is still RUNNING two minutes after decommission');
    const final = await call('GET', `/api/v2/vms/${h}`);
    assert.equal(final.status, 200, `GET /api/v2/vms/${h} in state ${last?.state}: ${final.status} ${final.text.slice(0, 300)}`);
    assert.equal(final.body?.specHash, h);
    assert.equal(final.body?.spec?.name, name);
    const entryAfter = await listed(h);
    assert.equal(final.body.state, entryAfter.state, `getVm's state ${final.body.state} differs from the VM list's ${entryAfter.state}`);
  });

// ------------------------------------------------------------------ 3. errors

test('criterion 3: GET /api/v2/vms/abc answers 400 with an ApiError body', async () => {
  const r = await call('GET', '/api/v2/vms/abc');
  assert.equal(r.status, 400, `${r.status} ${r.text.slice(0, 300)}`);
  isApiError(r, 'abc');
});

test('criterion 3: GET /api/v2/vms/<64 upper-case hex> answers 400 with an ApiError body', async () => {
  const r = await call('GET', `/api/v2/vms/${'ABCDEF0123456789'.repeat(4)}`);
  assert.equal(r.status, 400, `${r.status} ${r.text.slice(0, 300)}`);
  isApiError(r, 'upper-case hex');
});

test('criterion 3: GET /api/v2/vms/<64 zeros> (well-formed, no such VM) answers 404 with an ApiError body', async () => {
  const r = await call('GET', `/api/v2/vms/${'0'.repeat(64)}`);
  assert.equal(r.status, 404, `${r.status} ${r.text.slice(0, 300)}`);
  isApiError(r, '64 zeros');
});

// ------------------------------------------------------------------ 4-5. served OpenAPI

test('criterion 4: the served document has GET /api/v2/vms/{specHash} getVm with 200 (VmRecord), 400 and 404', async () => {
  const doc = await apiDocs();
  const op = doc.paths?.['/api/v2/vms/{specHash}']?.get;
  assert.ok(op, 'no GET /api/v2/vms/{specHash} in the served document');
  assert.equal(op.operationId, 'getVm');
  for (const code of ['200', '400', '404']) assert.ok(op.responses?.[code], `getVm has no ${code} response`);
  const schema = op.responses['200'].content?.['application/json']?.schema
    || Object.values(op.responses['200'].content || {})[0]?.schema;
  assert.equal(schema?.$ref, '#/components/schemas/VmRecord', `getVm 200 schema: ${JSON.stringify(schema)}`);
  assert.ok(doc.components?.schemas?.VmRecord, 'no VmRecord schema');
  const ids = Object.values(doc.paths).flatMap((p) => Object.values(p)).map((o) => o.operationId).filter((i) => i === 'getVm');
  assert.equal(ids.length, 1, 'getVm is used once');
});

test('criterion 4: the served lifecycle and day-2 operations are still there with their operationIds', async () => {
  const doc = await apiDocs();
  const want = [['get', '/api/v2/vms/{specHash}/lifecycle', 'getVmLifecycle'], ['post', '/api/v2/vms/{specHash}/renew', 'renewVm'],
    ['post', '/api/v2/vms/{specHash}/resize', 'resizeVm'], ['post', '/api/v2/vms/{specHash}/power', 'powerVm'],
    ['post', '/api/v2/vms/{specHash}/snapshot', 'snapshotVm'], ['post', '/api/v2/vms/{specHash}/decommission', 'decommissionVm']];
  for (const [m, p, id] of want) assert.equal(doc.paths?.[p]?.[m]?.operationId, id, `${m.toUpperCase()} ${p}`);
});

test('criterion 5: the served OpenAPI document (servers left out) equals docs/openapi.json (servers left out)', async () => {
  const strip = ({ servers, ...rest }) => rest;
  const snapshot = strip(JSON.parse(readFileSync(join(ROOT, 'docs', 'openapi.json'), 'utf8')));
  assert.deepEqual(strip(await apiDocs()), snapshot);
});
