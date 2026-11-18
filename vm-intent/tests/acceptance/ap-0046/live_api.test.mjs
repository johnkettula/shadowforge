// AP-0046 acceptance, live half (criteria 1-3 and 7 against the running server). AP-0046 only changes docs, so
// this checks the server still does what the new text says: GET /api/v2/vms/{specHash} (getVm) is served and
// answers 400 for a malformed hash and 404 for an unknown one; the day-2 resize and snapshot calls are served;
// and a preview (POST /api/v2/interpret, which starts and builds nothing) returns a cloudName equal to the spec's
// name, as the README and TEMPORAL-FEATURES now say. No call changes anything.
//
//   node --test tests/acceptance/ap-0046/live_api.test.mjs      (VMINTENT_API defaults to http://127.0.0.1:19060)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19060').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};
const NO_SUCH_HASH = 'e'.repeat(64);

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...AUTH },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, text, json };
}

test('criteria 2 and 7: the served OpenAPI document has getVm, resizeVm and snapshotVm', async () => {
  const r = await call('GET', '/v3/api-docs');
  assert.equal(r.status, 200, `GET /v3/api-docs: ${r.text.slice(0, 200)}`);
  const p = r.json.paths;
  assert.equal(p['/api/v2/vms/{specHash}']?.get?.operationId, 'getVm');
  assert.equal(p['/api/v2/vms/{specHash}/resize']?.post?.operationId, 'resizeVm');
  assert.equal(p['/api/v2/vms/{specHash}/snapshot']?.post?.operationId, 'snapshotVm');
});

test('criterion 2: GET /api/v2/vms/{specHash} answers 400 for malformed hashes', async () => {
  for (const bad of ['abc', 'A'.repeat(64), '0'.repeat(63), 'g'.repeat(64)]) {
    const r = await call('GET', `/api/v2/vms/${bad}`);
    assert.equal(r.status, 400, `GET /api/v2/vms/${bad}: ${r.status} ${r.text.slice(0, 200)}`);
  }
});

test('criterion 2: GET /api/v2/vms/{specHash} answers 404 for a hash that matches no VM', async () => {
  const r = await call('GET', `/api/v2/vms/${NO_SUCH_HASH}`);
  assert.equal(r.status, 404, `${r.status} ${r.text.slice(0, 200)}`);
});

test('criterion 2: GET /api/v2/vms/{specHash} answers 200 with the record for a VM in the list, whatever its state', async (t) => {
  const list = await call('GET', '/api/v2/vms');
  assert.equal(list.status, 200, `GET /api/v2/vms: ${list.text.slice(0, 200)}`);
  const items = Array.isArray(list.json) ? list.json : (list.json?.items ?? list.json?.content ?? []);
  const known = items.find((v) => typeof v?.specHash === 'string' && /^[0-9a-f]{64}$/.test(v.specHash));
  if (!known) { t.skip('no VM on this server yet'); return; }
  const r = await call('GET', `/api/v2/vms/${known.specHash}`);
  assert.equal(r.status, 200, `${r.status} ${r.text.slice(0, 200)}`);
  assert.equal(r.json.specHash, known.specHash);
  assert.ok(typeof r.json.state === 'string' && r.json.state.length > 0, 'the record has no state');
});

test('criteria 1 and 3: a preview\'s cloudName is the spec\'s name today', async () => {
  const r = await call('POST', '/api/v2/interpret', { text: 'Ubuntu box, 4 cores, 16 gigs, us-east on AWS, called ap46-docs-check' });
  assert.equal(r.status, 200, `POST /api/v2/interpret: ${r.status} ${r.text.slice(0, 300)}`);
  assert.ok(r.json.spec, `no spec in the preview: ${r.text.slice(0, 300)}`);
  assert.equal(r.json.spec.name, 'ap46-docs-check');
  assert.equal(r.json.cloudName, r.json.spec.name, 'cloudName is not the spec\'s name');
});
