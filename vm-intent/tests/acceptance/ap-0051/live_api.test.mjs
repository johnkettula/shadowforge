// AP-0051 acceptance, live half: the docs this requirement edits still describe the running server (staging runs
// with sign-in off). README's spec/ entry, TEMPORAL-FEATURES' recorded-value paragraph and DEFINITIONS' 'Cloud name'
// paragraph say that, with nobody signed in, the cloud name VmIdentity.of gives is the spec's name (or the generated
// vm-<8 hex> name), and that POST /api/v2/interpret shows it. Read-only: nothing is built.
//
//   node --test tests/acceptance/ap-0051/live_api.test.mjs      (VMINTENT_API defaults to http://127.0.0.1:19010)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19010').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};
const RUN = (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).replace(/[^a-z0-9]/g, 'x');

async function call(method, path, body) {
  const headers = { Accept: 'application/json', ...AUTH };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: res.status, text, body: json };
}

test('POST /api/v2/interpret shows a named spec\'s cloud name, which with sign-in off is the spec\'s name', async () => {
  const name = `ap51-${RUN}`;
  const r = await call('POST', '/api/v2/interpret', { text: `a small ubuntu server on aws called ${name}` });
  assert.equal(r.status, 200, `POST /api/v2/interpret: ${r.status} ${r.text.slice(0, 400)}`);
  assert.ok(!r.body?.question, `the preview asks a question: ${r.body?.question}`);
  assert.equal(r.body?.spec?.name, name, 'spec.name is the name asked for');
  assert.ok(r.body && 'cloudName' in r.body, 'the interpretation has no cloudName');
  assert.equal(r.body.cloudName, name, 'with sign-in off the cloud name is the spec\'s name, with no suffix');
  assert.match(r.body?.specHash || '', /^[0-9a-f]{64}$/);
});

test('POST /api/v2/interpret gives an unnamed spec the generated vm-<8 hex> name as its cloud name, with no second suffix', async () => {
  const r = await call('POST', '/api/v2/interpret', { text: 'a small ubuntu server on aws' });
  assert.equal(r.status, 200, `POST /api/v2/interpret: ${r.status} ${r.text.slice(0, 400)}`);
  assert.ok(!r.body?.question, `the preview asks a question: ${r.body?.question}`);
  assert.equal(r.body?.spec?.name, 'vm-' + String(r.body?.specHash).slice(0, 8), 'the generated name is vm- + the first 8 hex of specHash');
  assert.equal(r.body?.cloudName, r.body.spec.name, 'the cloud name is the generated name');
});

test('the same named text previews the same cloud name every time', async () => {
  const text = `a small ubuntu server on aws called ap51s-${RUN}`;
  const a = await call('POST', '/api/v2/interpret', { text });
  const b = await call('POST', '/api/v2/interpret', { text });
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(a.body?.specHash, b.body?.specHash);
  assert.equal(a.body?.cloudName, b.body?.cloudName);
});
