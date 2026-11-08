// AP-0024 acceptance, live half (criterion 8): AP-0024 only adds tests, histories and docs, so the running server
// must behave as before. The served OpenAPI document has the same paths and operations as the committed snapshot
// (docs/openapi.json), and read-only probes give the usual answers: an unknown request ID is 404 and a day-2 change
// on a malformed spec hash is 400. Nothing is created. The contract test and older suites are run by the pipeline.
//
//   node --test tests/acceptance/ap-0024/live_api.test.mjs      (VMINTENT_API defaults to http://127.0.0.1:19040)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19040').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const RUN = Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, 'x');
const UNKNOWN_ID = `ap0024-no-such-request-${RUN}`;

async function call(method, path, body) {
  const headers = { Accept: 'application/json', ...AUTH };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text };
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

test('the served OpenAPI document has the same operations as the committed snapshot', async () => {
  const r = await call('GET', '/v3/api-docs');
  assert.equal(r.status, 200, r.text.slice(0, 200));
  const live = JSON.parse(r.text);
  const snapshot = JSON.parse(readFileSync(resolve(ROOT, 'docs', 'openapi.json'), 'utf8'));
  assert.ok(operations(snapshot).length > 5, 'could not read the snapshot');
  assert.deepEqual(operations(live), operations(snapshot));
});

test('an unknown request ID is 404', async () => {
  const g = await call('GET', `/api/v2/requests/${UNKNOWN_ID}`);
  assert.equal(g.status, 404, g.text);
  const c = await call('POST', `/api/v2/requests/${UNKNOWN_ID}/cancel`, {});
  assert.equal(c.status, 404, c.text);
});

test('a day-2 change on a malformed spec hash is 400', async () => {
  const r = await call('POST', '/api/v2/vms/not-a-spec-hash/renew', {});
  assert.equal(r.status, 400, r.text);
});
