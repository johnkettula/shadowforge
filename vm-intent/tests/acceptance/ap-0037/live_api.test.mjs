// AP-0037 acceptance, live half: AP-0037 only changes docs, so the running server must still serve what those docs
// name: the served OpenAPI document has the same operations as the committed snapshot, the retire endpoint the new
// DEFINITIONS.md row names is served as a POST (criterion 9), the classifications keep the JSON shape
// CatalogControllerTest checks (criterion 10), and the audit API the audit-event bullet points to answers (criterion 3).
// Only read-only calls are made.
//
//   node --test tests/acceptance/ap-0037/live_api.test.mjs      (VMINTENT_API defaults to http://127.0.0.1:19070)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19070').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const RETIRE = '/api/v2/definitions/{kind}/{name}/{version}/retire';

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
async function servedDoc() {
  if (!served) {
    const r = await call('GET', '/v3/api-docs');
    assert.equal(r.status, 200, r.text.slice(0, 200));
    served = r.json;
  }
  return served;
}

test('the served OpenAPI document has the same operations as the committed snapshot', async () => {
  const snapshot = JSON.parse(readFileSync(resolve(ROOT, 'docs/openapi.json'), 'utf8'));
  assert.deepEqual(operations(await servedDoc()), operations(snapshot));
});

test('criterion 9: POST /api/v2/definitions/{kind}/{name}/{version}/retire is served', async () => {
  const doc = await servedDoc();
  assert.ok(operations(doc).includes(`POST ${RETIRE}`), `POST ${RETIRE} is not in the served API`);
  const op = doc.paths[RETIRE].post;
  assert.match(`${op.summary || ''} ${op.description || ''}`, /retire|no new runs/i, JSON.stringify(op).slice(0, 300));
  // Only POST is mapped: a GET is refused as the wrong method, not as an unknown path.
  const r = await call('GET', '/api/v2/definitions/blueprint/ap0037-no-such-definition/1/retire');
  assert.equal(r.status, 405, `GET on the retire path: ${r.status} ${r.text.slice(0, 200)}`);
});

test('criterion 10: GET /api/v2/classifications keeps the JSON shape CatalogControllerTest checks', async () => {
  const r = await call('GET', '/api/v2/classifications');
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.deepEqual(Object.keys(r.json), ['default', 'classifications'], r.text.slice(0, 200));
  assert.equal(typeof r.json.default, 'string');
  assert.ok(Array.isArray(r.json.classifications) && r.json.classifications.length > 0, r.text.slice(0, 200));
  for (const c of r.json.classifications) assert.deepEqual(Object.keys(c), ['code', 'label', 'retentionYears'], JSON.stringify(c));
  assert.ok(r.json.classifications.some((c) => c.code === r.json.default), 'the default is not one of the codes');
});

test('criterion 3: the audit API the README points to answers (an unknown spec hash has no events)', async () => {
  const r = await call('GET', '/api/v2/audit?specHash=ap0037-no-such-spec-hash');
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.ok(Array.isArray(r.json), `not a JSON list: ${r.text.slice(0, 200)}`);
  assert.equal(r.json.length, 0, r.text.slice(0, 200));
});
