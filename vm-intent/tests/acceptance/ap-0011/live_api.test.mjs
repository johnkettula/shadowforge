// AP-0011 acceptance, live half: clarify and cancel are Temporal updates with validators, so a change that
// can't be made gives 409 at once instead of a 204 that is silently dropped. Covers criteria 1-4 and the live
// half of 7 against the running server. Builds a few simulated VMs.
//
//   VMINTENT_API=http://127.0.0.1:19010 node --test tests/acceptance/ap-0011/live_api.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19010').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const RUN = Math.random().toString(16).slice(2, 8);
const USER = `ap0011-${RUN}`;
const FINAL = ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'DUPLICATE'];
const FINISHED = /already finished/i;
const BUILD_STARTED = /build has (already )?started/i;
const QUESTION_TEXT = 'I need a big linux machine';
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

let doc;

async function call(method, path, body) {
  const headers = { Accept: 'application/json', ...AUTH };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: res.status, contentType: res.headers.get('content-type') || '', text, body: json };
}

async function get(id) {
  const r = await call('GET', `/api/v2/requests/${id}`);
  assert.equal(r.status, 200, `getRequest ${id}: ${r.text.slice(0, 200)}`);
  return r.body;
}

async function waitState(id, states, timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    const r = await call('GET', `/api/v2/requests/${id}`);
    if (r.status === 200) {
      last = r.body.state;
      if (states.includes(last)) return r.body;
    }
    await sleep(500);
  }
  assert.fail(`request ${id} never reached ${states.join('/')} (last state ${last})`);
}

async function create(text) {
  const r = await call('POST', '/api/v2/requests', { text, userId: USER });
  assert.equal(r.status, 200, `createRequest: ${r.text.slice(0, 200)}`);
  assert.ok(r.body?.requestId, 'createRequest returns a requestId');
  return r.body.requestId;
}

/** A request with a unique name, so it's never a DUPLICATE of an earlier run's VM. */
const buildable = (tag) => `small debian 12 box on gcp us-central called ap11-${tag}-${RUN}`;

function operation(operationId) {
  for (const [p, item] of Object.entries(doc.paths)) {
    for (const [m, op] of Object.entries(item)) if (op && op.operationId === operationId) return { path: p, method: m, op };
  }
  return null;
}

/** A standard {"error": "..."} body, documented for this operation and status as ApiError. */
function assertApiError(operationId, r, reason) {
  assert.match(r.contentType, /json/, `${operationId} ${r.status} is JSON (got ${r.contentType})`);
  assert.ok(r.body && typeof r.body === 'object', `${operationId} ${r.status} body is an object: ${r.text.slice(0, 200)}`);
  assert.equal(typeof r.body.error, 'string', `${operationId} ${r.status} body has a string "error": ${r.text}`);
  assert.ok(r.body.error.length > 0, 'error message is not empty');
  if (reason) assert.match(r.body.error, reason, `${operationId} ${r.status} error says why: ${r.body.error}`);
  const found = operation(operationId);
  assert.ok(found, `the live document has ${operationId}`);
  const spec = found.op.responses?.[String(r.status)];
  assert.ok(spec, `${operationId} documents ${r.status}`);
  const refs = Object.values(spec.content || {}).map((m) => m.schema?.$ref);
  assert.ok(refs.length > 0 && refs.every((s) => s === '#/components/schemas/ApiError'), `${operationId} ${r.status} is ApiError`);
}

before(async () => {
  const res = await fetch(BASE + '/v3/api-docs', { headers: AUTH });
  assert.equal(res.status, 200, 'GET /v3/api-docs');
  doc = await res.json();
});

// ---- Criterion 1: happy paths ----
test('1: a question request reaches AWAITING_CLARIFICATION; clarify -> 204 and the request moves on', async () => {
  const id = await create(QUESTION_TEXT);
  const asked = await waitState(id, ['AWAITING_CLARIFICATION']);
  const r = await call('POST', `/api/v2/requests/${id}/clarify`, { answer: 'azure' });
  assert.equal(r.status, 204, `clarifyRequest: ${r.text.slice(0, 200)}`);
  assert.equal(r.text, '', '204 has no body');

  // The answer is used: within a while the request leaves this question behind.
  const end = Date.now() + 60_000;
  let s;
  while (Date.now() < end) {
    s = await get(id);
    if (s.state !== 'AWAITING_CLARIFICATION' || s.message !== asked.message) break;
    await sleep(500);
  }
  assert.ok(s.state !== 'AWAITING_CLARIFICATION' || s.message !== asked.message,
    `the request moved on after the answer (still ${s.state}: ${s.message})`);
  assert.ok(['INTERPRETING', 'AWAITING_CONFIRMATION', 'AWAITING_CLARIFICATION'].includes(s.state),
    `the request moved on to INTERPRETING, AWAITING_CONFIRMATION or another question (got ${s.state})`);
  const done = await waitState(id, ['AWAITING_CONFIRMATION', 'AWAITING_CLARIFICATION', ...FINAL], 60_000);
  if (done.state === 'AWAITING_CONFIRMATION') {
    assert.equal(done.interpretation?.spec?.provider, 'azure', 'the answer "azure" was used');
  }
  await call('POST', `/api/v2/requests/${id}/cancel`); // tidy up
});

test('1: cancel in AWAITING_CLARIFICATION -> 204 and GET shows CANCELLED within a few seconds', async () => {
  const id = await create(QUESTION_TEXT);
  await waitState(id, ['AWAITING_CLARIFICATION']);
  const r = await call('POST', `/api/v2/requests/${id}/cancel`);
  assert.equal(r.status, 204, `cancelRequest: ${r.text.slice(0, 200)}`);
  const s = await waitState(id, FINAL, 10_000);
  assert.equal(s.state, 'CANCELLED');
});

test('1: cancel in AWAITING_CONFIRMATION -> 204 and GET shows CANCELLED within a few seconds', async () => {
  const id = await create(buildable('cc'));
  await waitState(id, ['AWAITING_CONFIRMATION']);
  const r = await call('POST', `/api/v2/requests/${id}/cancel`);
  assert.equal(r.status, 204, `cancelRequest: ${r.text.slice(0, 200)}`);
  const s = await waitState(id, FINAL, 10_000);
  assert.equal(s.state, 'CANCELLED');
});

// ---- Criterion 2: AP-0003 behaviour kept ----
test('2: clarify and cancel on a cancelled request -> 409 "already finished"', async () => {
  const id = await create(QUESTION_TEXT);
  await waitState(id, ['AWAITING_CLARIFICATION']);
  assert.equal((await call('POST', `/api/v2/requests/${id}/cancel`)).status, 204);
  await waitState(id, ['CANCELLED'], 10_000);
  const c = await call('POST', `/api/v2/requests/${id}/cancel`);
  assert.equal(c.status, 409, `cancel on CANCELLED: ${c.text.slice(0, 200)}`);
  assertApiError('cancelRequest', c, FINISHED);
  const q = await call('POST', `/api/v2/requests/${id}/clarify`, { answer: 'azure' });
  assert.equal(q.status, 409, `clarify on CANCELLED: ${q.text.slice(0, 200)}`);
  assertApiError('clarifyRequest', q, FINISHED);
  assert.equal((await get(id)).state, 'CANCELLED');
});

test('2: clarify and cancel on an unknown ID -> 404 {"error": ...}', async () => {
  const c = await call('POST', `/api/v2/requests/intent-unknown-${RUN}/cancel`);
  assert.equal(c.status, 404, c.text.slice(0, 200));
  assertApiError('cancelRequest', c);
  const q = await call('POST', `/api/v2/requests/intent-unknown-${RUN}/clarify`, { answer: 'x' });
  assert.equal(q.status, 404, q.text.slice(0, 200));
  assertApiError('clarifyRequest', q);
});

// ---- Criterion 3: clarify when not waiting for an answer ----
test('3: clarify in AWAITING_CONFIRMATION -> 409 naming the state; nothing changes; confirm still 200', async () => {
  const id = await create(buildable('cf'));
  const before = await waitState(id, ['AWAITING_CONFIRMATION']);
  const r = await call('POST', `/api/v2/requests/${id}/clarify`, { answer: 'aws' });
  assert.equal(r.status, 409, `clarify in AWAITING_CONFIRMATION must be 409, not ${r.status}: ${r.text.slice(0, 200)}`);
  assertApiError('clarifyRequest', r, /awaiting[ _]confirmation/i);

  await sleep(2000);
  const after = await get(id);
  assert.equal(after.state, 'AWAITING_CONFIRMATION', 'state unchanged');
  assert.deepEqual(after.interpretation, before.interpretation, 'interpretation unchanged');

  const c = await call('POST', `/api/v2/requests/${id}/confirm`, { specHash: before.interpretation.specHash });
  assert.equal(c.status, 200, `confirm after the refused clarify: ${c.text.slice(0, 200)}`);
  const done = await waitState(id, FINAL);
  assert.ok(['COMPLETED', 'FAILED'].includes(done.state), `confirmed request finished normally (${done.state})`);
});

test('3: after a refused clarify, a request in AWAITING_CONFIRMATION can still be cancelled (204)', async () => {
  const id = await create(buildable('cx'));
  await waitState(id, ['AWAITING_CONFIRMATION']);
  const r = await call('POST', `/api/v2/requests/${id}/clarify`, { answer: 'aws' });
  assert.equal(r.status, 409, `clarify in AWAITING_CONFIRMATION: ${r.text.slice(0, 200)}`);
  const c = await call('POST', `/api/v2/requests/${id}/cancel`);
  assert.equal(c.status, 204, `cancel: ${c.text.slice(0, 200)}`);
  assert.equal((await waitState(id, FINAL, 10_000)).state, 'CANCELLED');
});

// ---- Criterion 4: cancel once the build has started ----
test('4: cancel while GET shows PROVISIONING -> 409 "build has already started"; the request finishes normally', async () => {
  // A simulated build may be quick, so try a few requests until one is caught in PROVISIONING.
  let caught = null;
  const notes = [];
  for (let attempt = 0; attempt < 5 && !caught; attempt++) {
    const id = await create(buildable(`pv${attempt}`));
    const pending = await waitState(id, ['AWAITING_CONFIRMATION']);
    const c = await call('POST', `/api/v2/requests/${id}/confirm`, { specHash: pending.interpretation.specHash });
    assert.equal(c.status, 200, `confirm: ${c.text.slice(0, 200)}`);
    let state = c.body?.state;
    const end = Date.now() + 30_000;
    while (state !== 'PROVISIONING' && !FINAL.includes(state) && Date.now() < end) {
      state = (await get(id)).state;
    }
    if (state !== 'PROVISIONING') { notes.push(`${id}: went to ${state} before PROVISIONING was seen`); continue; }
    const r = await call('POST', `/api/v2/requests/${id}/cancel`);
    const s = await get(id);
    if (r.status === 409 && FINISHED.test(r.body?.error || '') && FINAL.includes(s.state) && s.state !== 'CANCELLED') {
      notes.push(`${id}: finished (${s.state}) between GET and cancel`);
      continue;
    }
    caught = { id, r };
  }
  assert.ok(caught, `a request was caught in PROVISIONING (${notes.join('; ')})`);
  const { id, r } = caught;
  assert.notEqual(r.status, 204, 'cancel during PROVISIONING must not be a silent 204');
  assert.equal(r.status, 409, `cancel during PROVISIONING: ${r.text.slice(0, 200)}`);
  assertApiError('cancelRequest', r, BUILD_STARTED);
  const done = await waitState(id, FINAL);
  assert.ok(['COMPLETED', 'FAILED'].includes(done.state), `the request carried on to COMPLETED or FAILED, not ${done.state}`);
});

test('4: cancel straight after confirm returns 200 -> 409 (never 204), and the request is not CANCELLED', async () => {
  const id = await create(buildable('ac'));
  const pending = await waitState(id, ['AWAITING_CONFIRMATION']);
  const c = await call('POST', `/api/v2/requests/${id}/confirm`, { specHash: pending.interpretation.specHash });
  assert.equal(c.status, 200, `confirm: ${c.text.slice(0, 200)}`);
  const r = await call('POST', `/api/v2/requests/${id}/cancel`);
  assert.equal(r.status, 409, `cancel after confirm: ${r.text.slice(0, 200)}`);
  // Refused because the build started, or (if the simulated build was already done) because it finished.
  const err = r.body?.error || '';
  assert.ok(BUILD_STARTED.test(err) || FINISHED.test(err), `error says why: ${err}`);
  assertApiError('cancelRequest', r);
  const done = await waitState(id, FINAL);
  assert.ok(['COMPLETED', 'FAILED'].includes(done.state), `finished normally, not ${done.state}`);
});

// ---- Criterion 7 (live document) ----
test('7: live clarifyRequest and cancelRequest keep operationIds, paths, 204/403/404, and describe the new 409s', () => {
  const clarify = operation('clarifyRequest');
  const cancel = operation('cancelRequest');
  assert.ok(clarify && cancel, 'both operations are in the live document');
  assert.equal(clarify.path, '/api/v2/requests/{id}/clarify');
  assert.equal(clarify.method, 'post');
  assert.equal(cancel.path, '/api/v2/requests/{id}/cancel');
  assert.equal(cancel.method, 'post');
  for (const { op } of [clarify, cancel]) {
    for (const code of ['204', '403', '404', '409']) assert.ok(op.responses[code], `${op.operationId} documents ${code}`);
  }
  const c409 = clarify.op.responses['409'].description;
  assert.match(c409, /already finished/i, `clarifyRequest 409: ${c409}`);
  assert.match(c409, /not waiting for an answer/i, `clarifyRequest 409: ${c409}`);
  const x409 = cancel.op.responses['409'].description;
  assert.match(x409, /already finished/i, `cancelRequest 409: ${x409}`);
  assert.match(x409, /build has (already )?started/i, `cancelRequest 409: ${x409}`);
  assert.doesNotMatch(cancel.op.description || '', /Has no effect once the build has started/i);
});

test('7: docs/openapi.json (servers left out) equals the live /v3/api-docs (servers left out)', () => {
  const strip = ({ servers, ...rest }) => rest;
  const snapshot = strip(JSON.parse(readFileSync(join(ROOT, 'docs', 'openapi.json'), 'utf8')));
  assert.deepEqual(snapshot, strip(doc));
});

test('7: docs/openapi.yaml (servers left out) equals the live /v3/api-docs.yaml (servers left out)', async () => {
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
