// AP-0034 acceptance, live half: AP-0034 only changes docs, so the running server must still do what those docs
// name and behave as before (criterion 11): the served OpenAPI document has the same operations as the committed
// snapshot, and the inventory-check endpoints the docs point to ("Run now", POST /api/v2/inventory-checks) are
// served. Only read-only calls are made (no request or inventory check is started).
//
//   node --test tests/acceptance/ap-0034/live_api.test.mjs      (VMINTENT_API defaults to http://127.0.0.1:19040)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19040').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/

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

test('criterion 11: the served OpenAPI document has the same operations as the committed snapshot', async () => {
  const snapshot = JSON.parse(readFileSync(resolve(ROOT, 'docs/openapi.json'), 'utf8'));
  assert.deepEqual(await servedOps(), operations(snapshot));
});

test('criteria 4 and 7: the inventory-check endpoints the docs name are served', async () => {
  const ops = await servedOps();
  assert.ok(ops.includes('POST /api/v2/inventory-checks'), 'POST /api/v2/inventory-checks (Run now) is not served');
  assert.ok(ops.includes('GET /api/v2/inventory-checks'), 'GET /api/v2/inventory-checks is not served');
  const r = await call('GET', '/api/v2/inventory-checks');
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.ok(Array.isArray(r.json) || (r.json && typeof r.json === 'object'), `not JSON: ${r.text.slice(0, 200)}`);
});
