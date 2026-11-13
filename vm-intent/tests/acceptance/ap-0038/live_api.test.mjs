// AP-0038 acceptance, live half (criterion 11): AP-0038 only adds test histories, so the running server behaves as
// before: GET /api/v2/requests answers 200 and the served OpenAPI document equals docs/openapi.json (servers left
// out, since they name the address the server runs on). Only read-only calls are made.
//
//   node --test tests/acceptance/ap-0038/live_api.test.mjs      (VMINTENT_API defaults to http://127.0.0.1:19080)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19080').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/

async function call(path) {
  const res = await fetch(BASE + path, { headers: { Accept: 'application/json', ...AUTH } });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, text, json };
}

test('criterion 11: GET /api/v2/requests returns 200', async () => {
  const r = await call('/api/v2/requests');
  assert.equal(r.status, 200, `GET /api/v2/requests: ${r.text.slice(0, 200)}`);
  assert.ok(r.json !== undefined, 'the answer is JSON');
});

test('criterion 11: GET /v3/api-docs (servers left out) equals docs/openapi.json (servers left out)', async () => {
  const r = await call('/v3/api-docs');
  assert.equal(r.status, 200, `GET /v3/api-docs: ${r.text.slice(0, 200)}`);
  const strip = ({ servers, ...rest }) => rest;
  const snapshot = strip(JSON.parse(readFileSync(join(ROOT, 'docs', 'openapi.json'), 'utf8')));
  assert.deepEqual(strip(r.json), snapshot);
});
