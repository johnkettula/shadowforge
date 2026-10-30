// AP-0004 acceptance: listClassifications keeps its JSON shape and is documented with a named schema;
// the catalog and compliance calls the contract test now makes behave as the live OpenAPI document says.
// Covers criteria 1, 2, 3 (live half) and 5 against the running server. Publishes nothing, starts no run.
//
//   VMINTENT_API=http://127.0.0.1:19040 node --test tests/acceptance/ap-0004/catalog_compliance_live.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19040').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};

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

/** The live document's operation for this method and path (a path template, e.g. /api/v2/runs/{runId}). */
function operationAt(method, template) {
  const op = doc.paths[template]?.[method.toLowerCase()];
  assert.ok(op, `the live document has ${method} ${template}`);
  return op;
}

/** The response's status is documented for the operation and its body matches the documented schema. */
function assertDocumented(method, template, r, operationIds) {
  const op = operationAt(method, template);
  if (operationIds) assert.ok(operationIds.includes(op.operationId), `${method} ${template} is ${operationIds.join(' or ')} (is ${op.operationId})`);
  const spec = op.responses?.[String(r.status)];
  assert.ok(spec, `${op.operationId} documents a ${r.status} response (has ${Object.keys(op.responses || {}).join(', ')})`);
  const media = spec.content && (spec.content['application/json'] || spec.content['*/*'] || Object.values(spec.content)[0]);
  if (media?.schema) {
    assert.ok(r.body !== undefined, `${op.operationId} ${r.status} has a JSON body (got ${JSON.stringify(r.text.slice(0, 200))})`);
    const errors = validate(r.body, media.schema);
    assert.deepEqual(errors, [], `${op.operationId} ${r.status} body matches the document: ${r.text.slice(0, 300)}`);
  }
  return op;
}

/** The standard error body {"error": "..."}, documented as ApiError for this status. */
function assertApiError(method, template, r) {
  assert.match(r.contentType, /json/, `${method} ${template} ${r.status} is JSON`);
  assert.ok(r.body && typeof r.body === 'object' && !Array.isArray(r.body), `${r.status} body is an object: ${r.text.slice(0, 200)}`);
  assert.equal(typeof r.body.error, 'string', `${r.status} body has a string "error": ${r.text.slice(0, 200)}`);
  assert.ok(r.body.error.length > 0, 'error message is not empty');
  const op = assertDocumented(method, template, r);
  const schema = op.responses[String(r.status)].content?.['application/json']?.schema;
  assert.equal(schema?.$ref, '#/components/schemas/ApiError', `${op.operationId} ${r.status} is documented as ApiError`);
}

before(async () => {
  const res = await fetch(BASE + '/v3/api-docs', { headers: AUTH });
  assert.equal(res.status, 200, 'GET /v3/api-docs');
  doc = await res.json();
});

// ---- Criterion 1 ----
test('1: GET /api/v2/classifications -> 200 {default: string, classifications: [{code, label, retentionYears}]}', async () => {
  const r = await call('GET', '/api/v2/classifications');
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.match(r.contentType, /json/);
  const b = r.body;
  assert.ok(b && typeof b === 'object' && !Array.isArray(b), 'body is an object');
  assert.deepEqual(Object.keys(b).sort(), ['classifications', 'default'], `only the keys default and classifications: ${r.text}`);
  assert.equal(typeof b.default, 'string', '"default" is a string');
  assert.ok(Array.isArray(b.classifications) && b.classifications.length > 0, '"classifications" is a non-empty array');
  for (const c of b.classifications) {
    assert.equal(typeof c.code, 'string', `code is a string: ${JSON.stringify(c)}`);
    assert.equal(typeof c.label, 'string', `label is a string: ${JSON.stringify(c)}`);
    assert.ok(Number.isInteger(c.retentionYears), `retentionYears is an integer: ${JSON.stringify(c)}`);
  }
  assert.ok(b.classifications.map((c) => c.code).includes(b.default),
    `default ${b.default} is one of ${b.classifications.map((c) => c.code).join(', ')}`);
});

// ---- Criterion 2 ----
test('2: listClassifications 200 refers to a named schema with default (string) and classifications[code, label, retentionYears]', async () => {
  const op = operationAt('GET', '/api/v2/classifications');
  assert.equal(op.operationId, 'listClassifications');
  const schema = op.responses?.['200']?.content?.['application/json']?.schema;
  assert.ok(schema, 'listClassifications documents a 200 JSON body');
  assert.match(schema.$ref || '', /^#\/components\/schemas\/.+/, `200 schema is a $ref to a named schema: ${JSON.stringify(schema)}`);
  const named = resolveRef(schema);
  assert.ok(!(named.additionalProperties && !named.properties), 'not a bare additionalProperties map');
  assert.equal(named.type, 'object');
  assert.equal(resolveRef(named.properties?.default || {}).type, 'string', '"default" is documented as a string');
  const list = resolveRef(named.properties?.classifications || {});
  assert.equal(list.type, 'array', '"classifications" is documented as an array');
  const item = resolveRef(list.items || {});
  for (const k of ['code', 'label', 'retentionYears']) assert.ok(item.properties?.[k], `classifications items have ${k}`);
  assert.equal(resolveRef(item.properties.code).type, 'string');
  assert.equal(resolveRef(item.properties.label).type, 'string');
  assert.equal(resolveRef(item.properties.retentionYears).type, 'integer');

  const r = await call('GET', '/api/v2/classifications');
  assert.equal(r.status, 200);
  assertDocumented('GET', '/api/v2/classifications', r, ['listClassifications']);
});

// ---- Criteria 3 and 5: each new contract-test call, live, against the live document ----
test('3: listDefinitions -> 200 and includes Provisioning web-server', async () => {
  const r = await call('GET', '/api/v2/definitions');
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assertDocumented('GET', '/api/v2/definitions', r, ['listDefinitions']);
  assert.ok(Array.isArray(r.body), 'the list is an array');
  assert.ok(r.body.some((d) => d.kind === 'Provisioning' && d.name === 'web-server'), 'the list has Provisioning web-server');
});

test('3: getDefinition Provisioning/web-server -> 200; validateDefinition {yaml} of it -> 200 ok true', async () => {
  const r = await call('GET', '/api/v2/definitions/Provisioning/web-server');
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assertDocumented('GET', '/api/v2/definitions/{kind}/{name}', r, ['getDefinition']);
  assert.equal(typeof r.body.yaml, 'string', 'getDefinition returns the YAML');
  assert.ok(r.body.yaml.length > 0);

  const v = await call('POST', '/api/v2/definitions/validate', { yaml: r.body.yaml });
  assert.equal(v.status, 200, v.text.slice(0, 300));
  assertDocumented('POST', '/api/v2/definitions/validate', v, ['validateDefinition', 'validateDefinitionJson']);
  assert.equal(v.body.ok, true, `ok is true: ${v.text.slice(0, 300)}`);
});

test('3, 5: getDefinition Provisioning/does-not-exist -> 404 {"error": ...}', async () => {
  const r = await call('GET', '/api/v2/definitions/Provisioning/does-not-exist');
  assert.equal(r.status, 404, r.text.slice(0, 200));
  assertApiError('GET', '/api/v2/definitions/{kind}/{name}', r);
});

test('3: listRuns -> 200', async () => {
  const r = await call('GET', '/api/v2/runs?limit=5');
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assertDocumented('GET', '/api/v2/runs', r, ['listRuns']);
  assert.ok(Array.isArray(r.body), 'listRuns returns an array');
});

test('3, 5: getRun run-does-not-exist -> 404', async () => {
  const r = await call('GET', '/api/v2/runs/run-does-not-exist');
  assert.equal(r.status, 404, r.text.slice(0, 200));
  assertApiError('GET', '/api/v2/runs/{runId}', r);
});

test('3, 5: startRun {"definition": "does-not-exist"} -> 404', async () => {
  const r = await call('POST', '/api/v2/runs', { definition: 'does-not-exist' });
  assert.equal(r.status, 404, r.text.slice(0, 200));
  assertApiError('POST', '/api/v2/runs', r);
});

test('3, 5: startRun {} -> 400', async () => {
  const r = await call('POST', '/api/v2/runs', {});
  assert.equal(r.status, 400, r.text.slice(0, 200));
  assertApiError('POST', '/api/v2/runs', r);
});

test('3: listDecisions -> 200', async () => {
  const r = await call('GET', '/api/v2/compliance/decisions?limit=5');
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assertDocumented('GET', '/api/v2/compliance/decisions', r, ['listDecisions']);
});

test('3: listArchive -> 200', async () => {
  const r = await call('GET', '/api/v2/compliance/archive?limit=5');
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assertDocumented('GET', '/api/v2/compliance/archive', r, ['listArchive']);
});

test('3, 5: downloadArchivedHistory for an unknown workflow/run -> 404', async () => {
  const r = await call('GET', '/api/v2/compliance/archive/wf-does-not-exist/run-does-not-exist');
  assert.equal(r.status, 404, r.text.slice(0, 200));
  assertApiError('GET', '/api/v2/compliance/archive/{workflowId}/{runId}', r);
});

test('3, 5: replayWorkflow {} -> 400', async () => {
  const r = await call('POST', '/api/v2/compliance/replays', {});
  assert.equal(r.status, 400, r.text.slice(0, 200));
  assertApiError('POST', '/api/v2/compliance/replays', r);
});
