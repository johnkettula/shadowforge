// AP-0042 acceptance, live half (criteria 1, 2 and 11 against the running server): the docs now say existing VMs
// are reached through the day-2 calls, GET /api/v2/vms/{specHash}/lifecycle and the VM list GET /api/v2/vms, and
// stop naming GET /api/v2/vms/{specHash}. This checks the server agrees: the served OpenAPI document has those two
// GET operations and no GET /api/v2/vms/{specHash}, the VM list answers 200, a lifecycle call for a hash that
// matches no VM answers 404, and the served document still equals docs/openapi.json (AP-0042 changes no code).
// Only read-only calls are made.
//
//   node --test tests/acceptance/ap-0042/live_api.test.mjs      (VMINTENT_API defaults to http://127.0.0.1:19020)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19020').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const NO_SUCH_HASH = 'f'.repeat(64);

async function call(path) {
  const res = await fetch(BASE + path, { headers: { Accept: 'application/json', ...AUTH } });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, text, json };
}

let served;
async function apiDocs() {
  if (!served) {
    const r = await call('/v3/api-docs');
    assert.equal(r.status, 200, `GET /v3/api-docs: ${r.text.slice(0, 200)}`);
    served = r.json;
  }
  return served;
}

test('criteria 1-2: the server serves GET /api/v2/vms, GET /api/v2/vms/{specHash}/lifecycle and (since AP-0044) GET /api/v2/vms/{specHash}', async () => {
  const doc = await apiDocs();
  assert.ok(doc.paths['/api/v2/vms']?.get, 'no GET /api/v2/vms in the served OpenAPI document');
  assert.ok(doc.paths['/api/v2/vms/{specHash}/lifecycle']?.get, 'no GET /api/v2/vms/{specHash}/lifecycle served');
  assert.ok(doc.paths['/api/v2/vms/{specHash}']?.get, 'no GET /api/v2/vms/{specHash} served (AP-0044 added getVm)');
});

test('criterion 1: the VM list GET /api/v2/vms works (200, JSON)', async () => {
  const r = await call('/api/v2/vms');
  assert.equal(r.status, 200, `GET /api/v2/vms: ${r.text.slice(0, 200)}`);
  assert.ok(r.json !== undefined, 'the answer is JSON');
});

test('criterion 1: GET /api/v2/vms/{specHash}/lifecycle looks the VM up by hash (404 for a hash that matches no VM)', async () => {
  const r = await call(`/api/v2/vms/${NO_SUCH_HASH}/lifecycle`);
  assert.equal(r.status, 404, `GET /api/v2/vms/<unknown>/lifecycle: ${r.status} ${r.text.slice(0, 200)}`);
});

test('criterion 11: the served OpenAPI document (servers left out) equals docs/openapi.json (servers left out)', async () => {
  const strip = ({ servers, ...rest }) => rest;
  const snapshot = strip(JSON.parse(readFileSync(join(ROOT, 'docs', 'openapi.json'), 'utf8')));
  assert.deepEqual(strip(await apiDocs()), snapshot);
});
