// AP-0013 acceptance, live half: VM day-2 changes (renew, resize, power, snapshot, decommission) give 404 for a
// spec hash that matches no VM, 409 for a VM that exists but was decommissioned, and work as before on a running
// VM; the OpenAPI document lists the 404 and docs/openapi.* equal the live document. Covers criteria 1-4 against
// the running server. Builds one simulated VM.
//
//   VMINTENT_API=http://127.0.0.1:19030 node --test tests/acceptance/ap-0013/live_api.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19030').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const RUN = Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, 'x');
const USER = `ap0013-${RUN}`;
const FINAL = ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'DUPLICATE'];
const UNKNOWN = '0'.repeat(64);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

const CHANGES = [
  ['renew', { days: 7 }],
  ['resize', { vcpu: 2, memoryGiB: 4 }],
  ['power', { on: false }],
  ['snapshot', { label: 'x' }],
  ['decommission', {}],
];
const OPS = ['renewVm', 'resizeVm', 'powerVm', 'snapshotVm', 'decommissionVm'];

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

function assertError(r, what) {
  assert.ok(r.body && typeof r.body === 'object' && !Array.isArray(r.body), `${what}: body is a JSON object: ${r.text.slice(0, 200)}`);
  assert.equal(typeof r.body.error, 'string', `${what}: body has an "error" string: ${r.text.slice(0, 200)}`);
  assert.ok(r.body.error.length > 0, `${what}: "error" is not empty`);
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

/** Builds one VM through POST /api/v2/requests + confirm and returns its specHash from GET /api/v2/requests/{id}. */
async function buildVm(name) {
  const r = await call('POST', '/api/v2/requests', { text: `a small ubuntu server on aws called ${name}`, userId: USER });
  assert.equal(r.status, 200, `createRequest: ${r.text.slice(0, 200)}`);
  const id = r.body?.requestId;
  assert.ok(id, 'createRequest returns a requestId');
  const pending = await waitState(id, ['AWAITING_CONFIRMATION', 'AWAITING_CLARIFICATION', ...FINAL], 120_000);
  assert.equal(pending.state, 'AWAITING_CONFIRMATION', `request waits for confirmation: ${pending.message || ''}`);
  const c = await call('POST', `/api/v2/requests/${id}/confirm`, { specHash: pending.interpretation?.specHash });
  assert.equal(c.status, 200, `confirmRequest: ${c.text.slice(0, 200)}`);
  const done = await waitState(id, FINAL);
  assert.equal(done.state, 'COMPLETED', `the VM was built: ${done.message || ''}`);
  const specHash = done.interpretation?.specHash;
  assert.match(specHash || '', /^[0-9a-f]{64}$/, `GET /api/v2/requests/${id} shows the specHash`);
  // Wait for the VM's lifecycle workflow to be ACTIVE.
  const end = Date.now() + 60_000;
  let last;
  while (Date.now() < end) {
    last = await call('GET', `/api/v2/vms/${specHash}/lifecycle`);
    if (last.status === 200 && last.body?.state === 'ACTIVE') return specHash;
    await sleep(500);
  }
  assert.fail(`the VM's lifecycle never became ACTIVE: ${last?.status} ${last?.text.slice(0, 200)}`);
}

function operation(d, operationId) {
  for (const [p, item] of Object.entries(d.paths)) {
    for (const [m, op] of Object.entries(item)) if (op && op.operationId === operationId) return { path: p, method: m, op };
  }
  return null;
}

const resolveRef = (d, s) => (s && s.$ref ? d.components.schemas[s.$ref.split('/').pop()] : s);

before(async () => {
  const res = await fetch(BASE + '/v3/api-docs', { headers: AUTH });
  assert.equal(res.status, 200, 'GET /v3/api-docs');
  doc = await res.json();
});

// ---- Criterion 1 ----
for (const [op, body] of CHANGES) {
  test(`1: POST /api/v2/vms/{unknown}/${op} -> 404 {"error": "No VM with that spec hash"}`, async () => {
    const r = await call('POST', `/api/v2/vms/${UNKNOWN}/${op}`, body);
    assert.equal(r.status, 404, `${op} on an unknown spec hash: ${r.status} ${r.text.slice(0, 200)}`);
    assertError(r, op);
    assert.match(r.body.error, /no vm/i, `the error says there is no VM: ${r.body.error}`);
    assert.match(r.body.error, /spec hash/i, `the error mentions the spec hash: ${r.body.error}`);
  });
}

test('1: another unknown lowercase-hex spec hash is also 404 on renew', async () => {
  const h = ('ab12' + RUN.replace(/[^0-9a-f]/g, 'c') + 'f'.repeat(64)).slice(0, 64);
  assert.match(h, /^[0-9a-f]{64}$/);
  const r = await call('POST', `/api/v2/vms/${h}/renew`, { days: 7 });
  assert.equal(r.status, 404, `renew on ${h}: ${r.status} ${r.text.slice(0, 200)}`);
  assertError(r, 'renew');
});

// ---- Criteria 2 and 3 (one built VM) ----
test('2-3: on a running VM the changes return 200 with VmLifecycle; after decommission changes are 409', { timeout: 600_000 }, async () => {
  const h = await buildVm(`ap13-${RUN}`);
  const isLifecycle = (r, what) => {
    assert.equal(r.status, 200, `${what}: ${r.status} ${r.text.slice(0, 300)}`);
    assert.ok(r.body && typeof r.body === 'object', `${what}: JSON body`);
    // VmLifecycle carries no specHash; this VM is the only one owned by this run's user.
    assert.equal(r.body.owner, USER, `${what}: VmLifecycle for this VM: ${r.text.slice(0, 300)}`);
    assert.equal(typeof r.body.state, 'string', `${what}: VmLifecycle has a state`);
    assert.ok(Array.isArray(r.body.history), `${what}: VmLifecycle has a history`);
  };

  // Criterion 3: existing behaviour unchanged.
  isLifecycle(await call('POST', `/api/v2/vms/${h}/renew`, { days: 7 }), 'renew 7 days');
  const zero = await call('POST', `/api/v2/vms/${h}/renew`, { days: 0 });
  assert.equal(zero.status, 409, `renew 0 days is still 409: ${zero.status} ${zero.text.slice(0, 200)}`);
  assertError(zero, 'renew 0 days');
  isLifecycle(await call('POST', `/api/v2/vms/${h}/resize`, { vcpu: 4, memoryGiB: 16 }), 'resize');
  isLifecycle(await call('POST', `/api/v2/vms/${h}/power`, { on: false }), 'power off');
  isLifecycle(await call('POST', `/api/v2/vms/${h}/snapshot`, { label: `ap13-${RUN}` }), 'snapshot');
  const dec = await call('POST', `/api/v2/vms/${h}/decommission`, { reason: 'AP-0013 acceptance' });
  isLifecycle(dec, 'decommission');

  // Criterion 2: a decommissioned VM is 409, not 404, both straight away and once the lifecycle has closed.
  const canNotChange = /can'?t be changed|cannot be changed/i;
  const check = async (round) => {
    const again = await call('POST', `/api/v2/vms/${h}/decommission`, {});
    assert.equal(again.status, 409, `${round}: second decommission: ${again.status} ${again.text.slice(0, 200)}`);
    assertError(again, `${round}: second decommission`);
    assert.match(again.body.error, canNotChange, `${round}: second decommission error says the VM can't be changed: ${again.body.error}`);
    const renew = await call('POST', `/api/v2/vms/${h}/renew`, { days: 7 });
    assert.equal(renew.status, 409, `${round}: renew after decommission: ${renew.status} ${renew.text.slice(0, 200)}`);
    assertError(renew, `${round}: renew after decommission`);
    assert.match(renew.body.error, canNotChange, `${round}: renew error says the VM can't be changed: ${renew.body.error}`);
  };
  await check('right after decommission');
  await sleep(5_000); // the lifecycle workflow closes after the removal; the registry record stays (DELETED)
  await check('a few seconds later');
});

test('3: a malformed specHash ("abc") is still 400 on every change', async () => {
  for (const [op, body] of CHANGES) {
    const r = await call('POST', `/api/v2/vms/abc/${op}`, body);
    assert.equal(r.status, 400, `${op} on "abc": ${r.status} ${r.text.slice(0, 200)}`);
    assertError(r, op);
  }
});

test('3: GET /api/v2/vms/{unknown}/lifecycle is still 404', async () => {
  const r = await call('GET', `/api/v2/vms/${UNKNOWN}/lifecycle`);
  assert.equal(r.status, 404, `getVmLifecycle on an unknown spec hash: ${r.status} ${r.text.slice(0, 200)}`);
  assertError(r, 'getVmLifecycle');
});

// ---- Criterion 4 ----
test('4: the five change operations document 404 (ApiError) and keep 200, 400 and 409; specHash is described', () => {
  for (const id of OPS) {
    const found = operation(doc, id);
    assert.ok(found, `the live document has ${id}`);
    const { responses, parameters } = found.op;
    for (const code of ['200', '400', '404', '409']) assert.ok(responses[code], `${id} documents ${code}`);
    const schema = responses['404'].content?.['application/json']?.schema;
    assert.ok(schema, `${id} 404 has an application/json schema`);
    assert.equal(schema.$ref, '#/components/schemas/ApiError', `${id} 404 schema is ApiError`);
    for (const code of ['400', '409']) {
      assert.equal(responses[code].content?.['application/json']?.schema?.$ref, '#/components/schemas/ApiError', `${id} ${code} is ApiError`);
    }
    const p = (parameters || []).find((x) => x.name === 'specHash' && x.in === 'path');
    assert.ok(p, `${id} has a specHash path parameter`);
    assert.ok(typeof p.description === 'string' && p.description.trim().length > 0, `${id} specHash has a description`);
  }
  const apiError = resolveRef(doc, { $ref: '#/components/schemas/ApiError' });
  assert.ok(apiError?.properties?.error, 'ApiError has an error property');
});

test('4: operationIds, paths, methods and request bodies of the change operations and getVmLifecycle are unchanged', () => {
  // Compare against docs/openapi.json as it was just before the first AP-0013 commit.
  const shas = execFileSync('git', ['log', '--format=%H', '--no-merges', '--grep=^AP-0013:'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  assert.ok(shas.length > 0, 'found the AP-0013 commits');
  const oldest = shas[shas.length - 1];
  const prev = JSON.parse(execFileSync('git', ['show', `${oldest}^:vm-intent/docs/openapi.json`],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  for (const id of [...OPS, 'getVmLifecycle']) {
    const now = operation(doc, id);
    const was = operation(prev, id);
    assert.ok(now, `live document has ${id}`);
    assert.ok(was, `earlier document had ${id}`);
    assert.equal(now.path, was.path, `${id} path`);
    assert.equal(now.method, was.method, `${id} method`);
    assert.deepEqual(now.op.requestBody, was.op.requestBody, `${id} request body`);
    for (const code of Object.keys(was.op.responses)) assert.ok(now.op.responses[code], `${id} still documents ${code}`);
  }
  // The request body schemas these operations refer to are unchanged too.
  for (const name of ['RenewBody', 'ResizeBody', 'PowerBody', 'SnapshotBody', 'DecommissionBody']) {
    if (prev.components.schemas[name]) {
      assert.deepEqual(doc.components.schemas[name], prev.components.schemas[name], `schema ${name} unchanged`);
    }
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
