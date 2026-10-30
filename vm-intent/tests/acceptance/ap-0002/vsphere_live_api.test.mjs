// AP-0002 acceptance: the vSphere endpoints on the running server match the API contract.
// Covers criteria 1, 2, 3, 4 and 6 (and the documented 404/502 half of 5) against the live server.
//
//   VMINTENT_API=http://127.0.0.1:19020 node --test tests/acceptance/ap-0002/vsphere_live_api.test.mjs
//
// Staging has neither vCenter nor VCF Automation set up, so the lookups are expected to be 503.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19020').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};

const OPS = {
  getVsphereStatus: { method: 'get', path: '/api/v2/vsphere/status' },
  listVsphereTemplates: { method: 'get', path: '/api/v2/vsphere/templates' },
  listVsphereBlueprints: { method: 'get', path: '/api/v2/vsphere/blueprints' },
  getVsphereBlueprint: { method: 'get', path: '/api/v2/vsphere/blueprints/{nameOrId}' },
};

let doc;

async function get(path) {
  const res = await fetch(BASE + path, { headers: { Accept: 'application/json', ...AUTH } });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
  return { status: res.status, contentType: res.headers.get('content-type') || '', text, body };
}

// ---- A small OpenAPI 3.0 schema validator (enough for this document's schemas) ----
function resolve(schema) {
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
  const s = resolve(schema);
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

function responseSchema(opPath, status) {
  const op = doc.paths[opPath]?.get;
  assert.ok(op, `GET ${opPath} is not in /v3/api-docs`);
  const r = op.responses?.[String(status)] || op.responses?.default;
  assert.ok(r, `GET ${opPath} documents no ${status} response`);
  const content = r.content || {};
  const media = content['application/json'] || content['*/*'] || Object.values(content)[0];
  assert.ok(media?.schema, `GET ${opPath} ${status} response has no schema`);
  return media.schema;
}

function assertValid(opPath, res) {
  assert.match(res.contentType, /json/, `GET ${opPath}: content type ${res.contentType}`);
  assert.notEqual(res.body, undefined, `GET ${opPath}: body is not JSON: ${res.text.slice(0, 200)}`);
  const errors = validate(res.body, responseSchema(opPath, res.status));
  assert.deepEqual(errors, [], `GET ${opPath} ${res.status} body does not match the OpenAPI document: ${res.text.slice(0, 300)}`);
}

function findNulls(v, path = '$', out = []) {
  if (v === null) out.push(path);
  else if (Array.isArray(v)) v.forEach((x, i) => findNulls(x, `${path}[${i}]`, out));
  else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) findNulls(x, `${path}.${k}`, out);
  return out;
}

before(async () => {
  const res = await fetch(BASE + '/v3/api-docs', { headers: AUTH });
  assert.equal(res.status, 200, 'GET /v3/api-docs');
  doc = await res.json();
});

// ---- Criterion 1 ----
test('1: the four vSphere operations have stable operationIds', () => {
  for (const [id, { method, path }] of Object.entries(OPS)) {
    const op = doc.paths[path]?.[method];
    assert.ok(op, `${method.toUpperCase()} ${path} is missing from /v3/api-docs`);
    assert.equal(op.operationId, id, `${method.toUpperCase()} ${path} operationId`);
  }
  // Each ID is used exactly once in the whole document.
  const all = Object.values(doc.paths).flatMap((p) => Object.values(p)).map((o) => o.operationId);
  for (const id of Object.keys(OPS)) assert.equal(all.filter((x) => x === id).length, 1, `operationId ${id} is unique`);
});

// ---- Criterion 2 ----
test('2: the status response is a named type in the document', () => {
  const schema = responseSchema(OPS.getVsphereStatus.path, 200);
  assert.ok(schema.$ref, `200 schema should be a $ref to a named type, got ${JSON.stringify(schema)}`);
  const s = resolve(schema);
  assert.equal(s.type, 'object');
  for (const f of ['defaultRoute', 'datacenters', 'vcenter', 'automation']) {
    assert.ok(s.properties?.[f], `VsphereStatus schema has property ${f}`);
  }
  assert.equal(resolve(s.properties.defaultRoute).type, 'string', 'defaultRoute is a string');
  const dcs = resolve(s.properties.datacenters);
  assert.equal(dcs.type, 'object', 'datacenters is an object');
  assert.equal(resolve(dcs.additionalProperties || {}).type, 'string', 'datacenters maps names to route strings');
  for (const b of ['vcenter', 'automation']) {
    const bs = resolve(s.properties[b]);
    assert.equal(bs.type, 'object', `${b} is an object`);
    assert.equal(resolve(bs.properties?.configured || {}).type, 'boolean', `${b}.configured is boolean`);
    assert.ok((bs.required || []).includes('configured'), `${b}.configured is required`);
    assert.equal(resolve(bs.properties?.url || {}).type, 'string', `${b}.url is string`);
    assert.equal(resolve(bs.properties?.ok || {}).type, 'boolean', `${b}.ok is boolean`);
    assert.equal(resolve(bs.properties?.detail || {}).type, 'string', `${b}.detail is string`);
    for (const opt of ['url', 'ok', 'detail']) assert.ok(!(bs.required || []).includes(opt), `${b}.${opt} is optional`);
  }
});

test('2: GET /api/v2/vsphere/status returns 200, validates, and leaves out empty fields', async () => {
  const res = await get(OPS.getVsphereStatus.path);
  assert.equal(res.status, 200, res.text);
  assertValid(OPS.getVsphereStatus.path, res);
  const b = res.body;
  assert.deepEqual(findNulls(b), [], 'no field is sent as null');
  assert.equal(typeof b.defaultRoute, 'string');
  assert.equal(b.defaultRoute, 'simulated', 'staging without vSphere routes to simulated');
  assert.ok(b.datacenters && typeof b.datacenters === 'object' && !Array.isArray(b.datacenters), 'datacenters is an object');
  for (const [dc, route] of Object.entries(b.datacenters)) assert.equal(typeof route, 'string', `datacenters.${dc}`);
  assert.deepEqual(b.vcenter, { configured: false }, 'vcenter on a server without vSphere');
  assert.deepEqual(b.automation, { configured: false }, 'automation on a server without vSphere');
  assert.deepEqual(Object.keys(b).sort(), ['automation', 'datacenters', 'defaultRoute', 'vcenter']);
});

// ---- Criterion 3 ----
test('3: GET /api/v2/vsphere/templates is 503 with {"error"} saying vCenter isn\'t set up', async () => {
  const res = await get(OPS.listVsphereTemplates.path);
  assert.equal(res.status, 503, res.text);
  assertValid(OPS.listVsphereTemplates.path, res);
  assert.equal(typeof res.body.error, 'string');
  assert.match(res.body.error, /vCenter/);
  assert.match(res.body.error, /(isn't|is not|not) (set up|configured)/i);
  assert.deepEqual(findNulls(res.body), []);
});

// ---- Criterion 4 ----
for (const p of ['/api/v2/vsphere/blueprints', '/api/v2/vsphere/blueprints/anything', '/api/v2/vsphere/blueprints/no-such-blueprint-ap0002']) {
  test(`4: GET ${p} is 503 with {"error"} saying VCF Automation isn't set up`, async () => {
    const res = await get(p);
    assert.equal(res.status, 503, res.text);
    const opPath = p === OPS.listVsphereBlueprints.path ? p : OPS.getVsphereBlueprint.path;
    assertValid(opPath, res);
    assert.equal(typeof res.body.error, 'string');
    assert.match(res.body.error, /VCF Automation/);
    assert.match(res.body.error, /(isn't|is not|not) (set up|configured)/i);
    assert.deepEqual(findNulls(res.body), []);
  });
}

// ---- Criterion 6 (and the documented side of 5) ----
test('6: each vSphere operation documents its error responses with the ApiError schema', () => {
  const apiError = (opPath, code) => {
    const schema = responseSchema(opPath, code);
    assert.equal(schema.$ref, '#/components/schemas/ApiError', `GET ${opPath} ${code} uses ApiError`);
  };
  assert.ok(doc.components.schemas.ApiError?.properties?.error, 'ApiError schema exists with an error field');
  for (const id of ['listVsphereTemplates', 'listVsphereBlueprints', 'getVsphereBlueprint']) {
    assert.ok(doc.paths[OPS[id].path].get.responses['503'], `${id} documents 503`);
    apiError(OPS[id].path, 503);
  }
  assert.ok(doc.paths[OPS.getVsphereBlueprint.path].get.responses['404'], 'getVsphereBlueprint documents 404');
  apiError(OPS.getVsphereBlueprint.path, 404);
  // CloudAuth (VCF Automation refusing the sign-in) can happen on both blueprint calls.
  for (const id of ['listVsphereBlueprints', 'getVsphereBlueprint']) {
    assert.ok(doc.paths[OPS[id].path].get.responses['502'], `${id} documents 502`);
    apiError(OPS[id].path, 502);
  }
  // Every documented 4xx/5xx on the four operations uses ApiError.
  for (const { path } of Object.values(OPS)) {
    for (const code of Object.keys(doc.paths[path].get.responses)) {
      if (/^[45]\d\d$/.test(code)) apiError(path, code);
    }
  }
});
