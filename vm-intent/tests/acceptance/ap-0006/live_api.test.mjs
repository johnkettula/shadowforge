// AP-0006 acceptance, against the running server: getVsphereBlueprint's 200 response is a named schema
// (criterion 1), it keeps its operationId and 404/502/503 ApiError responses, and the vSphere endpoints
// behave as before on a server without VCF Automation (criterion 2), no 2xx response in the live document
// is a free-form map or an untyped object apart from the allow-listed one (what OpenApiDocumentTest
// guards, criteria 4-5), and docs/openapi.json / openapi.yaml match the live document for the operation and
// its schemas (criterion 7).
//
//   VMINTENT_API=http://127.0.0.1:19060 node --test tests/acceptance/ap-0006/live_api.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19060').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const BP_PATH = '/api/v2/vsphere/blueprints/{nameOrId}';

let live;
let liveYaml;

before(async () => {
  const res = await fetch(BASE + '/v3/api-docs', { headers: AUTH });
  assert.equal(res.status, 200, 'GET /v3/api-docs');
  live = await res.json();
  const y = await fetch(BASE + '/v3/api-docs.yaml', { headers: AUTH });
  liveYaml = y.status === 200 ? (await y.text()).replace(/\r\n/g, '\n') : null;
});

const refName = (s) => (s && typeof s.$ref === 'string' ? s.$ref.replace('#/components/schemas/', '') : null);
const schemaOf = (doc, s) => (refName(s) ? doc.components.schemas[refName(s)] : s);
const bpOp = (doc) => doc.paths?.[BP_PATH]?.get;
const jsonSchemas = (resp) => Object.entries(resp?.content || {}).map(([media, c]) => [media, c.schema]);

// ---- Criterion 1 ----
test('1: getVsphereBlueprint 200 is a $ref to a named component schema, not an inline map', () => {
  const op = bpOp(live);
  assert.ok(op, `/v3/api-docs has GET ${BP_PATH}`);
  const ok = op.responses?.['200'];
  assert.ok(ok, 'getVsphereBlueprint documents a 200 response');
  const schemas = jsonSchemas(ok);
  assert.ok(schemas.length > 0, 'the 200 response has content');
  for (const [media, s] of schemas) {
    assert.ok(refName(s), `200 ${media} schema is a $ref, got ${JSON.stringify(s)}`);
    assert.equal(s.additionalProperties, undefined, `200 ${media} schema has no inline additionalProperties`);
    assert.ok(live.components.schemas[refName(s)], `component schema ${refName(s)} exists`);
  }
});

test('1: the named schema has blueprint (id, name, description, status, projectId), releasedVersions (string[]) and inputs (object)', () => {
  const [, s] = jsonSchemas(bpOp(live).responses['200'])[0];
  const name = refName(s);
  const comp = live.components.schemas[name];
  assert.ok(comp.type === 'object' || comp.properties, `${name} is an object schema`);
  const props = comp.properties || {};
  assert.deepEqual(Object.keys(props).sort(), ['blueprint', 'inputs', 'releasedVersions'],
    `${name} has exactly blueprint, releasedVersions and inputs: ${JSON.stringify(Object.keys(props))}`);

  const bp = schemaOf(live, props.blueprint);
  assert.ok(bp && bp.properties, `blueprint is a $ref or object with properties: ${JSON.stringify(props.blueprint)}`);
  for (const k of ['id', 'name', 'description', 'status', 'projectId']) {
    assert.ok(bp.properties[k], `blueprint has property ${k}: ${JSON.stringify(Object.keys(bp.properties))}`);
    assert.equal(bp.properties[k].type, 'string', `blueprint.${k} is a string`);
  }

  const rv = schemaOf(live, props.releasedVersions);
  assert.equal(rv.type, 'array', `releasedVersions is an array: ${JSON.stringify(rv)}`);
  assert.equal(schemaOf(live, rv.items)?.type, 'string', `releasedVersions items are strings: ${JSON.stringify(rv.items)}`);

  const inputs = schemaOf(live, props.inputs);
  assert.ok(inputs && (inputs.type === 'object' || inputs.additionalProperties !== undefined || inputs.properties),
    `inputs is an object: ${JSON.stringify(props.inputs)}`);
  assert.notEqual(inputs.type, 'array', 'inputs is not an array');
  assert.notEqual(inputs.type, 'string', 'inputs is not a string');
});

// ---- Criterion 2 ----
test('2: getVsphereBlueprint keeps its operationId and its 404, 502 and 503 ApiError responses', () => {
  const op = bpOp(live);
  assert.equal(op.operationId, 'getVsphereBlueprint');
  for (const code of ['404', '502', '503']) {
    const r = op.responses?.[code];
    assert.ok(r, `getVsphereBlueprint documents ${code}`);
    const schemas = jsonSchemas(r);
    assert.ok(schemas.length > 0, `${code} has content`);
    for (const [media, s] of schemas) assert.equal(refName(s), 'ApiError', `${code} ${media} is ApiError`);
  }
});

async function getJson(path) {
  const res = await fetch(BASE + path, { headers: { Accept: 'application/json', ...AUTH } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = undefined; }
  return { status: res.status, text, body, type: res.headers.get('content-type') || '' };
}

function assertApiError(r, label) {
  assert.match(r.type, /json/, `${label}: JSON content type (${r.type})`);
  assert.ok(r.body && typeof r.body === 'object' && !Array.isArray(r.body), `${label}: JSON object body: ${r.text.slice(0, 200)}`);
  assert.equal(typeof r.body.error, 'string', `${label}: has a string "error": ${r.text.slice(0, 200)}`);
  assert.ok(r.body.error.length > 0, `${label}: "error" is not empty`);
  const allowed = Object.keys(live.components.schemas.ApiError?.properties || { error: 1 });
  for (const k of Object.keys(r.body)) assert.ok(allowed.includes(k), `${label}: key ${k} is in ApiError (${allowed})`);
}

test('2: GET /api/v2/vsphere/blueprints/anything returns 503 with {"error": "..."}', async () => {
  const r = await getJson('/api/v2/vsphere/blueprints/anything');
  assert.equal(r.status, 503, `status (body ${r.text.slice(0, 200)})`);
  assertApiError(r, 'blueprints/anything');
});

test('2: GET /api/v2/vsphere/status is 200, /templates and /blueprints are 503 with {"error"}', async () => {
  const s = await getJson('/api/v2/vsphere/status');
  assert.equal(s.status, 200, `status: ${s.text.slice(0, 200)}`);
  assert.ok(s.body && typeof s.body === 'object', 'status returns a JSON object');
  for (const k of ['datacenters', 'vcenter', 'automation']) assert.ok(k in s.body, `status body has ${k}: ${s.text.slice(0, 300)}`);
  for (const p of ['/api/v2/vsphere/templates', '/api/v2/vsphere/blueprints']) {
    const r = await getJson(p);
    assert.equal(r.status, 503, `${p} (body ${r.text.slice(0, 200)})`);
    assertApiError(r, p);
  }
});

// ---- Criteria 4-5 (what OpenApiDocumentTest guards), on the live document ----
const ALLOWED = new Set(['downloadArchivedHistory 200']);
function problem(s) {
  if (!s) return 'no schema';
  if (s.$ref || s.oneOf || s.anyOf || s.allOf) return null;
  if (s.additionalProperties !== undefined) return 'free-form map';
  if (s.type === 'array') { const p = problem(s.items); return p ? 'array of ' + p : null; }
  if ((!s.type || s.type === 'object') && !s.properties) return 'untyped inline object';
  return null;
}

test('4, 5: no 2xx response in the live document is a free-form map or untyped inline object (bar the allow-list)', () => {
  const broken = [];
  let count = 0;
  for (const [path, item] of Object.entries(live.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'].includes(method)) continue;
      for (const [code, resp] of Object.entries(op.responses || {})) {
        if (!code.startsWith('2')) continue;
        for (const [media, s] of jsonSchemas(resp)) {
          count++;
          const p = problem(s);
          if (p && !ALLOWED.has(`${op.operationId} ${code}`)) broken.push(`${op.operationId} ${code} ${method.toUpperCase()} ${path} ${media}: ${p}`);
        }
      }
    }
  }
  assert.ok(count > 20, `walked the 2xx responses (${count})`);
  assert.deepEqual(broken, [], 'untyped 2xx responses:\n' + broken.join('\n'));
  const ids = Object.values(live.paths).flatMap((i) => Object.values(i).map((o) => o.operationId));
  for (const id of ['getVsphereBlueprint', 'listClassifications', 'getVsphereStatus']) assert.ok(ids.includes(id), `live document has ${id}`);
});

// ---- Criterion 7: snapshots ----
function referenced(doc, start) {
  const out = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') {
      const n = refName(v);
      if (n && !out.has(n)) { out.add(n); walk(doc.components.schemas[n]); }
      Object.values(v).forEach(walk);
    }
  };
  walk(start);
  return [...out].sort();
}

const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;

test('7: docs/openapi.json has the same getVsphereBlueprint operation and schemas as /v3/api-docs', () => {
  const snap = JSON.parse(read('docs/openapi.json'));
  assert.ok(bpOp(snap), `docs/openapi.json has GET ${BP_PATH}`);
  assert.deepEqual(sortKeys(bpOp(snap)), sortKeys(bpOp(live)), 'getVsphereBlueprint operation in docs/openapi.json matches live');
  const names = referenced(live, bpOp(live).responses['200']);
  assert.ok(names.length >= 2, `200 refers to the new schema and the blueprint schema: ${names}`);
  for (const n of names) {
    assert.ok(snap.components?.schemas?.[n], `docs/openapi.json has component ${n}`);
    assert.deepEqual(sortKeys(snap.components.schemas[n]), sortKeys(live.components.schemas[n]), `component ${n} matches live`);
  }
});

/** The YAML block that starts at a line equal to `head` and runs until the next line indented as much or less. */
function yamlBlock(text, head) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const i = lines.indexOf(head);
  if (i < 0) return null;
  const indent = head.length - head.trimStart().length;
  let j = i + 1;
  while (j < lines.length && (lines[j].trim() === '' || lines[j].length - lines[j].trimStart().length > indent)) j++;
  return lines.slice(i, j).join('\n').trimEnd();
}

test('7: docs/openapi.yaml has the same getVsphereBlueprint operation and schemas as the live document', () => {
  const snap = read('docs/openapi.yaml');
  const op = yamlBlock(snap, `  ${BP_PATH}:`);
  assert.ok(op, `docs/openapi.yaml has ${BP_PATH}`);
  assert.match(op, /operationId: getVsphereBlueprint/);
  const name = refName(jsonSchemas(bpOp(live).responses['200'])[0][1]);
  assert.match(op, new RegExp(`"200":[\\s\\S]*?\\$ref: "?#/components/schemas/${name}"?[\\s\\S]*?"404":`),
    `YAML 200 refers to ${name}`);
  for (const code of ['404', '502', '503']) assert.match(op, new RegExp(`"${code}":[\\s\\S]*?ApiError`), `YAML has ${code} ApiError`);
  assert.doesNotMatch(op.slice(0, op.indexOf('"404":')), /additionalProperties/, 'YAML 200 is not a free-form map');
  for (const n of referenced(live, bpOp(live).responses['200'])) {
    const block = yamlBlock(snap, `    ${n}:`);
    assert.ok(block, `docs/openapi.yaml has schema ${n}`);
    for (const p of Object.keys(live.components.schemas[n].properties || {})) {
      assert.match(block, new RegExp(`^        ${p}:`, 'm'), `YAML ${n} has property ${p}`);
    }
  }
  if (liveYaml !== null) {
    assert.equal(op, yamlBlock(liveYaml, `  ${BP_PATH}:`), 'YAML operation block matches /v3/api-docs.yaml');
    for (const n of referenced(live, bpOp(live).responses['200'])) {
      assert.equal(yamlBlock(snap, `    ${n}:`), yamlBlock(liveYaml, `    ${n}:`), `YAML schema ${n} matches /v3/api-docs.yaml`);
    }
  }
});
