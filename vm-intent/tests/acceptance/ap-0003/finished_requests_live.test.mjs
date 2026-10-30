// AP-0003 acceptance: clarify and cancel on a request that has already finished give 409 (like confirm);
// unknown IDs still give 404; the happy paths are unchanged. Covers criteria 1-5 and the live half of 6
// against the running server. Every response is checked against the live OpenAPI document.
//
//   VMINTENT_API=http://127.0.0.1:19030 node --test tests/acceptance/ap-0003/finished_requests_live.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19030').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};
const RUN = Math.random().toString(16).slice(2, 8);
const FINISHED = /already finished/i;

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

async function waitState(id, states, timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    const r = await call('GET', `/api/v2/requests/${id}`);
    if (r.status === 200) {
      last = r.body.state;
      if (states.includes(last)) return r.body;
    }
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  assert.fail(`request ${id} never reached ${states.join('/')} (last state ${last})`);
}

// ---- A small OpenAPI 3.0 schema validator (enough for this document's schemas) ----
function resolveRef(schema) {
  let s = schema;
  for (let i = 0; s && s.$ref && i < 20; i++) {
    const m = /^#\/components\/schemas\/(.+)$/.exec(s.$ref);
    assert.ok(m, 'unsupported $ref ' + s.$ref);
    s = doc.components.schemas[m[1]];
    assert.ok(s, 'unknown schema ' + schema.$ref);
  }
  return s;
}

function validate(value, schema, path = '$', errors = []) {
  const s = resolveRef(schema);
  if (!s || Object.keys(s).length === 0) return errors;
  if (value === null) {
    if (!s.nullable) errors.push(`${path}: null is not allowed`);
    return errors;
  }
  if (s.allOf) for (const sub of s.allOf) validate(value, sub, path, errors);
  if (s.oneOf || s.anyOf) {
    const subs = s.oneOf || s.anyOf;
    const ok = subs.filter((sub) => validate(value, sub, path, []).length === 0).length;
    if (s.oneOf ? ok !== 1 : ok === 0) errors.push(`${path}: matches ${ok} of the ${s.oneOf ? 'oneOf' : 'anyOf'} schemas`);
  }
  if (s.enum && !s.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  const t = s.type;
  if (t === 'object' || (!t && (s.properties || s.additionalProperties))) {
    if (typeof value !== 'object' || Array.isArray(value)) { errors.push(`${path}: expected object`); return errors; }
    for (const r of s.required || []) if (!(r in value)) errors.push(`${path}: missing required "${r}"`);
    const props = s.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) validate(v, props[k], `${path}.${k}`, errors);
      else if (s.additionalProperties === false) errors.push(`${path}: unexpected property "${k}"`);
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') validate(v, s.additionalProperties, `${path}.${k}`, errors);
    }
  } else if (t === 'array') {
    if (!Array.isArray(value)) { errors.push(`${path}: expected array`); return errors; }
    value.forEach((v, i) => s.items && validate(v, s.items, `${path}[${i}]`, errors));
  } else if (t === 'string') {
    if (typeof value !== 'string') errors.push(`${path}: expected string, got ${typeof value}`);
  } else if (t === 'boolean') {
    if (typeof value !== 'boolean') errors.push(`${path}: expected boolean, got ${typeof value}`);
  } else if (t === 'integer') {
    if (!Number.isInteger(value)) errors.push(`${path}: expected integer`);
  } else if (t === 'number') {
    if (typeof value !== 'number') errors.push(`${path}: expected number`);
  }
  return errors;
}

function operation(operationId) {
  for (const [p, item] of Object.entries(doc.paths)) {
    for (const [m, op] of Object.entries(item)) if (op && op.operationId === operationId) return { path: p, method: m, op };
  }
  return null;
}

/** The response is documented for this operation and its body matches the documented schema. */
function assertDocumented(operationId, r) {
  const found = operation(operationId);
  assert.ok(found, `the live document has operation ${operationId}`);
  const spec = found.op.responses?.[String(r.status)];
  assert.ok(spec, `${operationId} documents a ${r.status} response (has ${Object.keys(found.op.responses || {}).join(', ')})`);
  const media = spec.content && (spec.content['application/json'] || spec.content['*/*'] || Object.values(spec.content)[0]);
  if (media?.schema) {
    assert.ok(r.body !== undefined, `${operationId} ${r.status} has a JSON body (got ${JSON.stringify(r.text.slice(0, 200))})`);
    const errors = validate(r.body, media.schema);
    assert.deepEqual(errors, [], `${operationId} ${r.status} body matches the document: ${JSON.stringify(r.body)}`);
  } else {
    assert.equal(r.text, '', `${operationId} ${r.status} has no body, as documented`);
  }
}

/** A standard error body: {"error": "..."}, workflowId (if any) the request ID, documented as ApiError. */
function assertApiError(operationId, r, id, reason) {
  assert.match(r.contentType, /json/, `${operationId} ${r.status} is JSON`);
  assert.ok(r.body && typeof r.body === 'object', `${operationId} ${r.status} body is an object: ${r.text.slice(0, 200)}`);
  assert.equal(typeof r.body.error, 'string', `${operationId} ${r.status} body has a string "error": ${r.text}`);
  assert.ok(r.body.error.length > 0, 'error message is not empty');
  if (reason) assert.match(r.body.error, reason, `${operationId} ${r.status} error says why: ${r.body.error}`);
  if (id !== undefined && 'workflowId' in r.body && r.body.workflowId !== null) {
    assert.equal(r.body.workflowId, id, `${operationId} ${r.status} workflowId is the request ID`);
  }
  assertDocumented(operationId, r);
}

before(async () => {
  const res = await fetch(BASE + '/v3/api-docs', { headers: AUTH });
  assert.equal(res.status, 200, 'GET /v3/api-docs');
  doc = await res.json();
});

// ---- Criteria 1, 2 and 5: question -> answer -> cancel; then cancel and clarify again give 409 ----
test('1, 2, 5: a cancelled request gives 409 on cancel and clarify; the happy paths still give 204', async (t) => {
  const created = await call('POST', '/api/v2/requests', { text: 'I need a big linux machine', userId: `ap0003-${RUN}` });
  assert.equal(created.status, 200, `createRequest: ${created.text.slice(0, 200)}`);
  assertDocumented('createRequest', created);
  const id = created.body.requestId;
  assert.ok(id, 'createRequest returns a requestId');

  await waitState(id, ['AWAITING_CLARIFICATION']);

  await t.test('5: clarify on AWAITING_CLARIFICATION -> 204', async () => {
    const r = await call('POST', `/api/v2/requests/${id}/clarify`, { answer: 'azure' });
    assert.equal(r.status, 204, `clarifyRequest: ${r.text.slice(0, 200)}`);
    assertDocumented('clarifyRequest', r);
  });

  await waitState(id, ['AWAITING_CONFIRMATION']);

  await t.test('5: cancel on AWAITING_CONFIRMATION -> 204 and the request becomes CANCELLED', async () => {
    const r = await call('POST', `/api/v2/requests/${id}/cancel`);
    assert.equal(r.status, 204, `cancelRequest: ${r.text.slice(0, 200)}`);
    assertDocumented('cancelRequest', r);
    const s = await waitState(id, ['CANCELLED', 'COMPLETED', 'FAILED', 'DUPLICATE'], 60_000);
    assert.equal(s.state, 'CANCELLED');
  });

  await t.test('1: a second cancel -> 409 "already finished" (not 404)', async () => {
    const r = await call('POST', `/api/v2/requests/${id}/cancel`);
    assert.notEqual(r.status, 404, `second cancel must not be 404: ${r.text}`);
    assert.equal(r.status, 409, `second cancel: ${r.text.slice(0, 200)}`);
    assertApiError('cancelRequest', r, id, FINISHED);
  });

  await t.test('1: cancelling again is repeatable (still 409) and the request stays CANCELLED', async () => {
    const r = await call('POST', `/api/v2/requests/${id}/cancel`);
    assert.equal(r.status, 409, `third cancel: ${r.text.slice(0, 200)}`);
    const s = await call('GET', `/api/v2/requests/${id}`);
    assert.equal(s.status, 200);
    assert.equal(s.body.state, 'CANCELLED');
  });

  await t.test('2: clarify {"answer":"azure"} on the finished request -> 409 "already finished"', async () => {
    const r = await call('POST', `/api/v2/requests/${id}/clarify`, { answer: 'azure' });
    assert.notEqual(r.status, 404, `clarify on a finished request must not be 404: ${r.text}`);
    assert.equal(r.status, 409, `clarify on a finished request: ${r.text.slice(0, 200)}`);
    assertApiError('clarifyRequest', r, id, FINISHED);
  });

  // Not a weaker version of the checks above (those stand as written): this tells apart "never 409"
  // from "409 only once the workflow has closed, after GET already shows CANCELLED".
  await t.test('1, 2: a few seconds later, cancel and clarify on the cancelled request are still 409', async () => {
    await new Promise((ok) => setTimeout(ok, 5000));
    const c = await call('POST', `/api/v2/requests/${id}/cancel`);
    assert.equal(c.status, 409, `cancel 5 s after CANCELLED: ${c.text.slice(0, 200)}`);
    assertApiError('cancelRequest', c, id, FINISHED);
    const q = await call('POST', `/api/v2/requests/${id}/clarify`, { answer: 'azure' });
    assert.equal(q.status, 409, `clarify 5 s after CANCELLED: ${q.text.slice(0, 200)}`);
    assertApiError('clarifyRequest', q, id, FINISHED);
  });
});

// ---- Criterion 3: a request finished through confirm; cancel gives 409, confirm still gives 409 ----
test('3: cancel on a request that finished through confirm -> 409; confirm already finished -> 409 unchanged', async () => {
  const created = await call('POST', '/api/v2/requests',
    { text: `small debian 12 box on gcp us-central called ap3-${RUN}`, userId: `ap0003-${RUN}` });
  assert.equal(created.status, 200, `createRequest: ${created.text.slice(0, 200)}`);
  const id = created.body.requestId;
  const pending = await waitState(id, ['AWAITING_CONFIRMATION']);

  const confirmed = await call('POST', `/api/v2/requests/${id}/confirm`, { specHash: pending.interpretation.specHash });
  assert.equal(confirmed.status, 200, `confirmRequest: ${confirmed.text.slice(0, 200)}`);
  assertDocumented('confirmRequest', confirmed);

  const done = await waitState(id, ['COMPLETED', 'FAILED', 'DUPLICATE', 'CANCELLED']);
  assert.ok(['COMPLETED', 'FAILED', 'DUPLICATE'].includes(done.state), `finished through confirm (state ${done.state})`);

  const cancel = await call('POST', `/api/v2/requests/${id}/cancel`);
  assert.equal(cancel.status, 409, `cancel after ${done.state}: ${cancel.text.slice(0, 200)}`);
  assertApiError('cancelRequest', cancel, id, FINISHED);

  const clarify = await call('POST', `/api/v2/requests/${id}/clarify`, { answer: 'azure' });
  assert.equal(clarify.status, 409, `clarify after ${done.state}: ${clarify.text.slice(0, 200)}`);
  assertApiError('clarifyRequest', clarify, id, FINISHED);

  const confirm = await call('POST', `/api/v2/requests/${id}/confirm`);
  assert.equal(confirm.status, 409, `confirm after ${done.state}: ${confirm.text.slice(0, 200)}`);
  assertApiError('confirmRequest', confirm, id, FINISHED);

  const after = await call('GET', `/api/v2/requests/${id}`);
  assert.equal(after.body.state, done.state, 'the 409 calls did not change the request');
});

// ---- Criterion 4: unknown IDs still give 404 ----
test('4: cancel on an unknown ID -> 404 {"error": ...}', async () => {
  const r = await call('POST', '/api/v2/requests/intent-does-not-exist/cancel');
  assert.equal(r.status, 404, r.text.slice(0, 200));
  assertApiError('cancelRequest', r);
});

test('4: clarify {"answer":"x"} on an unknown ID -> 404 {"error": ...}', async () => {
  const r = await call('POST', '/api/v2/requests/intent-does-not-exist/clarify', { answer: 'x' });
  assert.equal(r.status, 404, r.text.slice(0, 200));
  assertApiError('clarifyRequest', r);
});

test('4: confirm and get on an unknown ID still -> 404', async () => {
  const c = await call('POST', '/api/v2/requests/intent-does-not-exist/confirm');
  assert.equal(c.status, 404, c.text.slice(0, 200));
  assertApiError('confirmRequest', c);
  const g = await call('GET', '/api/v2/requests/intent-does-not-exist');
  assert.equal(g.status, 404, g.text.slice(0, 200));
  assertApiError('getRequest', g);
});

// ---- Criterion 6 (live document) ----
test('6: /v3/api-docs documents 409 ApiError on clarifyRequest and cancelRequest, like confirmRequest', () => {
  const confirm = operation('confirmRequest');
  assert.ok(confirm, 'confirmRequest is in the live document');
  const confirm409 = confirm.op.responses['409'];
  assert.ok(confirm409, 'confirmRequest documents 409');
  for (const id of ['clarifyRequest', 'cancelRequest']) {
    const found = operation(id);
    assert.ok(found, `${id} is in the live document`);
    assert.equal(found.method, 'post');
    const codes = Object.keys(found.op.responses || {});
    for (const c of ['204', '403', '404', '409']) assert.ok(codes.includes(c), `${id} documents ${c} (has ${codes.join(', ')})`);
    for (const c of ['403', '404', '409']) {
      const content = found.op.responses[c].content;
      assert.ok(content, `${id} ${c} has content`);
      const schemas = Object.values(content).map((m) => m.schema?.$ref);
      assert.ok(schemas.length > 0 && schemas.every((s) => s === '#/components/schemas/ApiError'),
        `${id} ${c} uses the ApiError schema (got ${JSON.stringify(schemas)})`);
    }
    // Same style as confirmRequest's 409: same media types, ApiError schema.
    assert.deepEqual(Object.keys(found.op.responses['409'].content).sort(), Object.keys(confirm409.content).sort(),
      `${id} 409 has the same media types as confirmRequest 409`);
    assert.ok(found.op.responses['409'].description, `${id} 409 has a description`);
  }
});
