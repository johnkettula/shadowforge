// AP-0022 acceptance, live half: AP-0022 only changes docs, so the running server is checked for the responses
// the new TEMPORAL-FEATURES rows describe and that can be seen without building anything: answering or cancelling
// an unknown request ID gives 404 (RequestControllerTest), and a day-2 change gives 404 for a well-formed spec hash
// that matches no VM and 400 for a malformed hash (VmControllerTest). Read-only: nothing is created.
//
//   node --test tests/acceptance/ap-0022/live_api.test.mjs      (VMINTENT_API defaults to http://127.0.0.1:19020)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19020').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};
const RUN = Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, 'x');
const UNKNOWN_ID = `ap0022-no-such-request-${RUN}`;
const UNKNOWN_HASH = '0'.repeat(60) + 'a022'; // 64 hex chars that no real spec hash has
const DAY2 = [['renew', {}], ['power', { action: 'off' }], ['resize', { size: 'small' }], ['snapshot', {}],
  ['decommission', {}]];

async function call(method, path, body) {
  const headers = { Accept: 'application/json', ...AUTH };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text };
}

test('the server is up', async () => {
  const r = await call('GET', '/v3/api-docs');
  assert.equal(r.status, 200, r.text.slice(0, 200));
});

test('RequestControllerTest row: answering or cancelling an unknown request ID is 404', async () => {
  const a = await call('POST', `/api/v2/requests/${UNKNOWN_ID}/clarify`, { answer: 'aws' });
  assert.equal(a.status, 404, a.text);
  const c = await call('POST', `/api/v2/requests/${UNKNOWN_ID}/cancel`, {});
  assert.equal(c.status, 404, c.text);
});

test('VmControllerTest row: day-2 changes are 404 for an unknown spec hash and 400 for a malformed one', async () => {
  assert.match(UNKNOWN_HASH, /^[0-9a-f]{64}$/);
  for (const [op, body] of DAY2) {
    const r = await call('POST', `/api/v2/vms/${UNKNOWN_HASH}/${op}`, body);
    assert.equal(r.status, 404, `${op} on an unknown hash: ${r.text}`);
    const bad = await call('POST', `/api/v2/vms/not-a-spec-hash/${op}`, body);
    assert.equal(bad.status, 400, `${op} on a malformed hash: ${bad.text}`);
  }
});
