// AP-0026 acceptance, live half: AP-0026 only changes docs, so this checks that what the new doc lines describe is
// what the running server does. The vSphere endpoints give the status codes VSPHERE.md's VsphereControllerTest entry
// lists (503 when vCenter or VCF Automation isn't set up; a status response without empty fields), and the API behind
// the MCP batch tools (POST /api/v2/batches, GET /api/v2/batches/{id}) and the inventory-check endpoint are served.
// Only read-only calls are made; nothing is created.
//
//   node --test tests/acceptance/ap-0026/live_api.test.mjs      (VMINTENT_API defaults to http://127.0.0.1:19060)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19060').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};
const RUN = Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, 'x');

async function get(path) {
  const res = await fetch(BASE + path, { headers: { Accept: 'application/json', ...AUTH } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

/** Lists every key whose value is null, "" or an empty array, with its path. */
function emptyFields(v, path = '$') {
  if (v === null || v === '' || (Array.isArray(v) && v.length === 0)) return [path];
  if (Array.isArray(v)) return v.flatMap((x, i) => emptyFields(x, `${path}[${i}]`));
  if (typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => emptyFields(x, `${path}.${k}`));
  return [];
}

test('the OpenAPI document serves the endpoints the changed docs point at', async () => {
  const r = await get('/v3/api-docs');
  assert.equal(r.status, 200);
  const paths = r.json.paths;
  assert.ok(paths['/api/v2/batches']?.post, 'no POST /api/v2/batches (vm_batch_submit)');
  assert.ok(paths['/api/v2/batches/{id}']?.get, 'no GET /api/v2/batches/{id} (vm_batch_status)');
  assert.ok(paths['/api/v2/inventory-checks']?.post, 'no POST /api/v2/inventory-checks (TEMPORAL-FEATURES section 6)');
  for (const p of ['/api/v2/vsphere/status', '/api/v2/vsphere/templates', '/api/v2/vsphere/blueprints',
    '/api/v2/vsphere/blueprints/{nameOrId}']) {
    assert.ok(paths[p]?.get, `no GET ${p}`);
  }
});

test('vm_batch_status: an unknown batch ID is 404', async () => {
  const r = await get(`/api/v2/batches/ap0026-no-such-batch-${RUN}`);
  assert.equal(r.status, 404, r.text);
});

test('vSphere status leaves out empty fields', async () => {
  const r = await get('/api/v2/vsphere/status');
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json && typeof r.json === 'object', r.text);
  assert.ok(r.json.vcenter && typeof r.json.vcenter.configured === 'boolean', r.text);
  assert.ok(r.json.automation && typeof r.json.automation.configured === 'boolean', r.text);
  assert.deepEqual(emptyFields(r.json), [], `the status response has empty fields: ${r.text}`);
});

test("vSphere templates: 503 when vCenter isn't set up", async (t) => {
  const s = (await get('/api/v2/vsphere/status')).json;
  if (s?.vcenter?.configured) return t.skip('vCenter is set up on this server');
  const r = await get('/api/v2/vsphere/templates');
  assert.equal(r.status, 503, r.text);
  assert.match(r.json?.error || '', /vCenter isn't set up/);
});

test("vSphere blueprints: 503 when VCF Automation isn't set up, for the list and for one blueprint", async (t) => {
  const s = (await get('/api/v2/vsphere/status')).json;
  if (s?.automation?.configured) {
    // With VCF Automation set up, an unknown blueprint is 404 instead.
    const r = await get(`/api/v2/vsphere/blueprints/ap0026-no-such-blueprint-${RUN}`);
    assert.equal(r.status, 404, r.text);
    return;
  }
  for (const p of ['/api/v2/vsphere/blueprints', `/api/v2/vsphere/blueprints/ap0026-no-such-blueprint-${RUN}`]) {
    const r = await get(p);
    assert.equal(r.status, 503, `${p}: ${r.text}`);
    assert.match(r.json?.error || '', /VCF Automation isn't set up/);
  }
});
