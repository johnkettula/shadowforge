// AP-0051 acceptance, live half: the inventory check the new Troubleshooting rows and the Help page's Missing bullet
// describe is there on the running server, and any note it has written uses the wording the docs quote
// ("Not marked missing: the listing left out N of M running VMs; check the provider's route settings", and
// "listed again:" followed by spec hashes). Read-only: no check is started and nothing is built.
//
//   node --test tests/acceptance/ap-0051/live_api.test.mjs      (VMINTENT_API defaults to http://127.0.0.1:19010)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19010').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};

async function get(path) {
  const res = await fetch(BASE + path, { headers: { Accept: 'application/json', ...AUTH } });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: res.status, text, body: json };
}

test('the OpenAPI document lists GET /api/v2/inventory-checks, whose findings carry a note', async () => {
  const r = await get('/v3/api-docs');
  assert.equal(r.status, 200, `GET /v3/api-docs: ${r.status}`);
  assert.ok(r.body?.paths?.['/api/v2/inventory-checks']?.get, 'no GET /api/v2/inventory-checks');
  const schemas = r.body?.components?.schemas ?? {};
  assert.ok(schemas.InventoryFinding?.properties?.note, 'InventoryFinding has no note property');
  assert.ok(schemas.InventoryFinding?.properties?.missing, 'InventoryFinding has no missing property');
});

test('GET /api/v2/inventory-checks answers with a list, and any note uses the wording the docs quote', async () => {
  const r = await get('/api/v2/inventory-checks?limit=50');
  assert.equal(r.status, 200, `GET /api/v2/inventory-checks: ${r.status} ${r.text.slice(0, 400)}`);
  assert.ok(Array.isArray(r.body), 'the answer is not a list');
  const bad = [];
  for (const report of r.body) {
    for (const f of report.findings ?? []) {
      const note = f.note ?? '';
      if (/not marked missing/i.test(note)
          && !/Not marked missing: the listing left out \d+ of \d+ running VMs; check the provider's route settings/.test(note)) {
        bad.push(`${report.checkId} ${f.provider}: ${note}`);
      }
      if (/listed again/i.test(note) && !/listed again: [0-9a-f]{8,}/.test(note)) bad.push(`${report.checkId} ${f.provider}: ${note}`);
      // A held-back finding marks none of its VMs missing.
      if (/^Not marked missing|; Not marked missing/.test(note)) {
        assert.deepEqual(f.missing ?? [], [], `${report.checkId} ${f.provider} holds back but lists missing VMs`);
      }
    }
  }
  assert.deepEqual(bad, [], 'notes that do not match the documented wording');
});
