// AP-0028 acceptance, live half: AP-0028 only changes docs, so the running server must do what those docs now say
// and behave as before (criterion 10). The batch endpoints behind vm_batch_submit / vm_batch_status are served
// (criterion 2); the inventory-check endpoint the nightly-check section names is served (criterion 3); and, when
// vSphere isn't set up on the server, templates and blueprints give 503 and the status response leaves out empty
// fields (criterion 4). The served OpenAPI document matches the committed snapshot. Only read-only calls are made.
//
//   node --test tests/acceptance/ap-0028/live_api.test.mjs      (VMINTENT_API defaults to http://127.0.0.1:19080)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19080').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const RUN = Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, 'x');

async function call(method, path) {
  const res = await fetch(BASE + path, { method, headers: { Accept: 'application/json', ...AUTH } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, json };
}

/** "METHOD /path" for every operation in an OpenAPI document. */
function operations(doc) {
  const out = [];
  for (const [p, item] of Object.entries(doc.paths || {})) {
    for (const m of Object.keys(item)) {
      if (['get', 'put', 'post', 'delete', 'patch', 'head', 'options'].includes(m)) out.push(`${m.toUpperCase()} ${p}`);
    }
  }
  return out.sort();
}

let served;
async function servedOps() {
  if (!served) {
    const r = await call('GET', '/v3/api-docs');
    assert.equal(r.status, 200, r.text.slice(0, 200));
    served = operations(r.json);
  }
  return served;
}

test('criterion 10: the served OpenAPI document has the same operations as the committed snapshot', async () => {
  const snapshot = JSON.parse(readFileSync(resolve(ROOT, 'docs/openapi.json'), 'utf8'));
  assert.deepEqual(await servedOps(), operations(snapshot));
});

test('criterion 2: the endpoints behind vm_batch_submit and vm_batch_status are served', async () => {
  const ops = await servedOps();
  assert.ok(ops.includes('POST /api/v2/batches'), 'POST /api/v2/batches (vm_batch_submit) is not served');
  assert.ok(ops.some((o) => /^GET \/api\/v2\/batches\/\{[^}]+\}$/.test(o)), 'GET /api/v2/batches/{id} (vm_batch_status) is not served');
  const r = await call('GET', `/api/v2/batches/ap0028-no-such-batch-${RUN}`);
  assert.equal(r.status, 404, r.text.slice(0, 200));
});

test('criterion 3: the inventory-check endpoint named next to the nightly check is served', async () => {
  assert.ok((await servedOps()).includes('POST /api/v2/inventory-checks'));
});

test('criterion 4: vSphere status leaves out empty fields; templates and blueprints give 503 when not set up', async () => {
  const s = await call('GET', '/api/v2/vsphere/status');
  assert.equal(s.status, 200, s.text.slice(0, 200));
  assert.ok(s.json && typeof s.json === 'object', 'status is not JSON');
  // No null values or empty strings anywhere in the response.
  const empties = [];
  (function walk(v, path) {
    if (v === null || v === '') empties.push(path);
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  })(s.json, '$');
  assert.deepEqual(empties, [], `status response has empty fields: ${empties.join(', ')}`);

  const vcenter = s.json.vcenter?.configured;
  const automation = s.json.automation?.configured;
  assert.equal(typeof vcenter, 'boolean', 'status has no vcenter.configured');
  assert.equal(typeof automation, 'boolean', 'status has no automation.configured');

  if (vcenter === false) {
    assert.deepEqual(Object.keys(s.json.vcenter), ['configured'], 'unconfigured vcenter block carries empty fields');
    const t = await call('GET', '/api/v2/vsphere/templates');
    assert.equal(t.status, 503, t.text.slice(0, 200));
  }
  if (automation === false) {
    assert.deepEqual(Object.keys(s.json.automation), ['configured'], 'unconfigured automation block carries empty fields');
    const b = await call('GET', '/api/v2/vsphere/blueprints');
    assert.equal(b.status, 503, b.text.slice(0, 200));
    const one = await call('GET', `/api/v2/vsphere/blueprints/ap0028-no-such-blueprint-${RUN}`);
    assert.equal(one.status, 503, one.text.slice(0, 200));
  } else {
    // With VCF Automation set up, an unknown blueprint is 404.
    const one = await call('GET', `/api/v2/vsphere/blueprints/ap0028-no-such-blueprint-${RUN}`);
    assert.equal(one.status, 404, one.text.slice(0, 200));
  }
});
