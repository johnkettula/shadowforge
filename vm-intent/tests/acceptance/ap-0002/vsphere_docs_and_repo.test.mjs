// AP-0002 acceptance: docs/API.md, the OpenAPI snapshots, the contract test and the unit test agree
// with the running server. Covers criteria 5 (unit test), 7, 8 (contract test calls) and 9 (snapshots).
//
//   VMINTENT_API=http://127.0.0.1:19020 node --test tests/acceptance/ap-0002/vsphere_docs_and_repo.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19020').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const VSPHERE = [
  { id: 'getVsphereStatus', method: 'GET', path: '/api/v2/vsphere/status', can503: false },
  { id: 'listVsphereTemplates', method: 'GET', path: '/api/v2/vsphere/templates', can503: true },
  { id: 'listVsphereBlueprints', method: 'GET', path: '/api/v2/vsphere/blueprints', can503: true },
  { id: 'getVsphereBlueprint', method: 'GET', path: '/api/v2/vsphere/blueprints/{nameOrId}', can503: true },
];
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace']);

let live;
let liveOpCount;

before(async () => {
  const res = await fetch(BASE + '/v3/api-docs', { headers: AUTH });
  assert.equal(res.status, 200, 'GET /v3/api-docs');
  live = await res.json();
  liveOpCount = Object.values(live.paths).reduce((n, p) => n + Object.keys(p).filter((m) => HTTP_METHODS.has(m)).length, 0);
});

const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
const withoutServers = (d) => { const c = structuredClone(d); delete c.servers; return c; };

function firstDiff(a, b, path = '') {
  if (JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDiff(a[k], b[k], `${path}/${k}`);
      if (d) return d;
    }
  }
  return `${path}: snapshot ${JSON.stringify(b)?.slice(0, 120)} vs live ${JSON.stringify(a)?.slice(0, 120)}`;
}

// ---- Criterion 7: docs/API.md ----
function operationsTable() {
  const md = read('docs/API.md');
  const section = md.split(/^## Operations\s*$/m)[1]?.split(/^## /m)[0];
  assert.ok(section, 'docs/API.md has an "## Operations" section');
  return section.split(/\r?\n/).filter((l) => /^\|\s*`[A-Za-z]+`\s*\|/.test(l)).map((l) => {
    const cells = l.split('|').slice(1, -1).map((c) => c.trim());
    return { id: cells[0].replace(/`/g, ''), methodPath: cells[1].replace(/`/g, '').trim(), text: cells.slice(2).join('|') };
  });
}

test('7: the Operations table lists the four vSphere operations with ID, method and path, OPERATOR and 503', () => {
  const rows = operationsTable();
  for (const op of VSPHERE) {
    const row = rows.find((r) => r.id === op.id);
    assert.ok(row, `API.md Operations table has a row for ${op.id}`);
    assert.equal(row.methodPath, `${op.method} ${op.path}`, `${op.id} method and path`);
    assert.ok(row.text.length > 0, `${op.id} has a description`);
    assert.match(row.text, /OPERATOR/, `${op.id} description notes the OPERATOR role`);
    if (op.can503) {
      assert.match(row.text, /503/, `${op.id} description notes the 503`);
      assert.match(row.text, /(isn't|is not|not) (set up|configured)/i, `${op.id} says 503 is when it isn't set up`);
    }
  }
  assert.match(rows.find((r) => r.id === 'getVsphereBlueprint').text, /404/, 'getVsphereBlueprint notes the 404');
});

test('7: the Operations table has one row per live operation (by method and path)', () => {
  // Matched by method and path: the operation IDs of rows outside this requirement are not checked here.
  const rows = operationsTable();
  const liveOps = [];
  for (const [p, ops] of Object.entries(live.paths)) {
    for (const m of Object.keys(ops)) if (HTTP_METHODS.has(m)) liveOps.push(`${m.toUpperCase()} ${p}`);
  }
  const listed = rows.map((r) => r.methodPath.replace(/\?.*$/, ''));
  assert.deepEqual(liveOps.filter((o) => !listed.includes(o)), [], 'live operations missing from the API.md Operations table');
  assert.deepEqual(listed.filter((o) => !liveOps.includes(o)), [], 'API.md rows that are not live operations');
  assert.equal(rows.length, liveOpCount, 'API.md Operations table row count equals the live operation count');
});

test('7: the Conventions errors bullet mentions 503', () => {
  const md = read('docs/API.md');
  const conventions = md.split(/^## Conventions\s*$/m)[1]?.split(/^## /m)[0];
  assert.ok(conventions, 'docs/API.md has a Conventions section');
  const bullet = conventions.split(/^- /m).find((b) => b.startsWith('**Errors**'));
  assert.ok(bullet, 'Conventions has an **Errors** bullet');
  assert.match(bullet, /`?503`?/, 'Errors bullet mentions 503');
});

test('7: every operation count in API.md equals the live total', () => {
  const md = read('docs/API.md');
  const counts = [...md.matchAll(/\b(?:all\s+)?(\d+)\s+operations\b/gi)].map((m) => Number(m[1]));
  assert.ok(counts.length > 0, 'API.md states an operation count');
  for (const n of counts) assert.equal(n, liveOpCount, `API.md says ${n} operations; the live document has ${liveOpCount}`);
});

// ---- Criterion 8: tests/api_contract_test.py ----
test('8: the contract test calls the four vSphere operations with the expected statuses', () => {
  const py = read('tests/api_contract_test.py');
  const calls = [...py.matchAll(/^\s*call\(\s*"(GET|POST|PUT|DELETE|PATCH)"\s*,\s*f?"([^"]+)"\s*,\s*(\d{3})/gm)]
    .map((m) => ({ method: m[1], path: m[2], status: Number(m[3]) }));
  const has = (pred, what) => assert.ok(calls.some(pred), `contract test has ${what}`);
  has((c) => c.method === 'GET' && c.path === '/api/v2/vsphere/status' && c.status === 200, 'GET /api/v2/vsphere/status -> 200');
  has((c) => c.method === 'GET' && c.path === '/api/v2/vsphere/templates' && c.status === 503, 'GET /api/v2/vsphere/templates -> 503');
  has((c) => c.method === 'GET' && c.path === '/api/v2/vsphere/blueprints' && c.status === 503, 'GET /api/v2/vsphere/blueprints -> 503');
  has((c) => c.method === 'GET' && /^\/api\/v2\/vsphere\/blueprints\/[^/]+$/.test(c.path) && c.status === 503,
    'GET /api/v2/vsphere/blueprints/{nameOrId} -> 503');
  // Every call goes through the validating helper (call() validates against the live document).
  assert.match(py, /api\.validate_response\(/, 'call() validates each response against the live OpenAPI document');
});

// ---- Criterion 9: docs/openapi.json and docs/openapi.yaml ----
test('9: docs/openapi.json matches the live document (apart from servers)', () => {
  const snap = JSON.parse(read('docs/openapi.json'));
  const d = firstDiff(withoutServers(live), withoutServers(snap));
  assert.equal(d, null, 'docs/openapi.json differs from /v3/api-docs at ' + d);
});

/** Paths, methods, operationIds, response codes and schema names from the YAML snapshot. */
function yamlOutline(text) {
  const ops = new Map(); // "GET /path" -> { operationId, codes: Set }
  const schemas = new Set();
  let top = null; let path = null; let method = null; let inResponses = false; let inSchemas = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) { top = line.replace(/:.*$/, ''); path = method = null; inSchemas = false; continue; }
    if (top === 'paths') {
      if (indent === 2) { path = line.trim().replace(/^"|"?:$/g, '').replace(/"$/, ''); method = null; continue; }
      if (indent === 4) {
        const m = line.trim().replace(/:$/, '');
        method = HTTP_METHODS.has(m) ? m.toUpperCase() : null; inResponses = false;
        if (method) ops.set(`${method} ${path}`, { operationId: null, codes: new Set() });
        continue;
      }
      if (method && indent === 6) {
        inResponses = line.trim() === 'responses:';
        const id = /^operationId:\s*"?([^"]+)"?$/.exec(line.trim());
        if (id) ops.get(`${method} ${path}`).operationId = id[1];
        continue;
      }
      if (method && inResponses && indent === 8) {
        const c = /^"?(\d{3}|default)"?:$/.exec(line.trim());
        if (c) ops.get(`${method} ${path}`).codes.add(c[1]);
      }
    } else if (top === 'components') {
      if (indent === 2) { inSchemas = line.trim() === 'schemas:'; continue; }
      if (inSchemas && indent === 4) schemas.add(line.trim().replace(/:$/, '').replace(/^"|"$/g, ''));
    }
  }
  return { ops, schemas };
}

test('9: docs/openapi.yaml has the same operations, response codes and schemas as the live document', () => {
  const text = read('docs/openapi.yaml');
  assert.match(text, /^openapi:\s*"?3\./m, 'openapi.yaml is an OpenAPI 3 document');
  const { ops, schemas } = yamlOutline(text);
  const liveOps = new Map();
  for (const [p, item] of Object.entries(live.paths)) {
    for (const [m, o] of Object.entries(item)) {
      if (HTTP_METHODS.has(m)) liveOps.set(`${m.toUpperCase()} ${p}`, { operationId: o.operationId, codes: Object.keys(o.responses || {}).sort() });
    }
  }
  assert.deepEqual([...ops.keys()].sort(), [...liveOps.keys()].sort(), 'openapi.yaml operations');
  for (const [k, v] of liveOps) {
    assert.equal(ops.get(k).operationId, v.operationId, `openapi.yaml operationId of ${k}`);
    assert.deepEqual([...ops.get(k).codes].sort(), v.codes, `openapi.yaml response codes of ${k}`);
  }
  assert.deepEqual([...schemas].sort(), Object.keys(live.components.schemas).sort(), 'openapi.yaml component schemas');
  // The vSphere error responses point at ApiError in the YAML too.
  for (const op of VSPHERE.filter((o) => o.can503)) {
    const start = text.indexOf(`\n  ${op.path}:`);
    assert.ok(start >= 0, `openapi.yaml has ${op.path}`);
    const block = text.slice(start + 1).split(/\n  (?=\S)/)[0];
    assert.match(block, /"503":[\s\S]*?\$ref: "#\/components\/schemas\/ApiError"/, `${op.path} 503 uses ApiError in openapi.yaml`);
  }
});

// ---- Criterion 5: unit test for the failure-type -> status mapping; unknown blueprint is NotFound ----
function javaFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...javaFiles(p));
    else if (name.endsWith('.java')) out.push(p);
  }
  return out;
}

test('5: a unit test covers how each vSphere failure type maps to an HTTP status', () => {
  const tests = javaFiles(join(ROOT, 'backend', 'src', 'test', 'java')).map((p) => ({ p, src: readFileSync(p, 'utf8') }))
    .filter(({ src }) => /Vsphere/.test(src) && /CloudAuth/.test(src) && /NotFound/.test(src));
  assert.ok(tests.length > 0, 'a backend unit test mentions the vSphere failure types NotFound and CloudAuth');
  const ok = tests.some(({ src }) =>
    /SERVICE_UNAVAILABLE[^;]*NOT_SET_UP|NOT_SET_UP[^;]*SERVICE_UNAVAILABLE|SERVICE_UNAVAILABLE[^;]*NotSetUp/.test(src)
    && /NOT_FOUND[^;]*"NotFound"|"NotFound"[^;]*NOT_FOUND/.test(src)
    && /BAD_GATEWAY[^;]*"CloudAuth"|"CloudAuth"[^;]*BAD_GATEWAY/.test(src)
    && (src.match(/SERVICE_UNAVAILABLE[^;]*"(?!NotFound|CloudAuth)\w+"/g) || []).length > 0);
  assert.ok(ok, 'the unit test asserts not-set-up -> 503, NotFound -> 404, CloudAuth -> 502, and another type -> 503 '
    + `(looked in ${tests.map((t) => t.p.slice(ROOT.length)).join(', ')})`);
});

test('5: an unknown blueprint is a NotFound failure (404), not InvalidSpec', () => {
  const src = read('backend/src/main/java/com/example/vmintent/provider/vsphere/VcfAutomationClient.java');
  const m = /has no blueprint[^;]*;/.exec(src);
  assert.ok(m, 'VcfAutomationClient throws when a blueprint is unknown');
  assert.match(m[0], /"NotFound"/, 'the unknown-blueprint failure type is NotFound');
});
