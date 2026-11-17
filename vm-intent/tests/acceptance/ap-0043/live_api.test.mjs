// AP-0043 acceptance, live half (criteria 8, 9 and 10) against the running server. Builds one simulated VM per run:
// - The served OpenAPI document (servers left out) equals docs/openapi.json, and its Interpretation schema describes
//   the per-user specHash and the new cloudName.
// - POST /api/v2/interpret: a named VM's cloudName is its spec.name; with no name, the cloudName is the generated
//   spec.name (vm- + 8 hex); a text that needs a question has no cloudName.
// - No behaviour change: 'a small ubuntu server on aws called web-01-<run>' builds under the specHash that
//   POST /api/v2/interpret returned for the text beforehand (with sign-in off, the SHA-256 of the canonical spec, as
//   before AP-0043), GET /api/v2/vms lists it once with the asked-for name, and the same request again is DUPLICATE
//   and builds nothing.
//
//   node --test tests/acceptance/ap-0043/live_api.test.mjs      (VMINTENT_API defaults to http://127.0.0.1:19030)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19030').replace(/\/+$/, '');
const TOKEN = process.env.VMINTENT_TOKEN;
const AUTH = TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {};
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const RUN = Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, 'x');
const FINAL = ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'DUPLICATE'];
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

async function call(method, path, body) {
  const headers = { Accept: 'application/json', ...AUTH };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: res.status, text, body: json };
}

/** SpecCanonicalizer.canonicalString, written again here: sorted keys, no name key without a name. */
function canonical(spec) {
  const keys = ['provider', 'region', 'vcpu', 'memoryGiB', 'os', 'osVersion', 'diskGiB', 'diskTier', 'env', 'ttlDays', 'publicIp'];
  if (spec.name != null) keys.push('name');
  keys.sort();
  return '{' + keys.map((k) => {
    const v = spec[k];
    return `"${k}":${typeof v === 'string' ? `"${v}"` : String(v)}`;
  }).join(',') + '}';
}

async function interpret(text) {
  const r = await call('POST', '/api/v2/interpret', { text });
  assert.equal(r.status, 200, `interpret "${text}": ${r.status} ${r.text.slice(0, 300)}`);
  assert.ok(r.body && typeof r.body === 'object', `interpret "${text}" returned no JSON: ${r.text.slice(0, 300)}`);
  return r.body;
}

async function waitState(id, states, timeoutMs = 240_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    const r = await call('GET', `/api/v2/requests/${id}`);
    if (r.status === 200) {
      last = r.body;
      if (states.includes(last.state)) return last;
    }
    await sleep(700);
  }
  assert.fail(`request ${id} never reached ${states.join('/')} (last: ${last?.state} ${last?.message || ''})`);
}

/** Creates a request, confirms it with its specHash when it asks, and returns its final status. */
async function runToEnd(text) {
  const r = await call('POST', '/api/v2/requests', { text });
  assert.equal(r.status, 200, `createRequest "${text}": ${r.text.slice(0, 200)}`);
  const id = r.body?.requestId;
  assert.ok(id, 'createRequest returns a requestId');
  const pending = await waitState(id, ['AWAITING_CONFIRMATION', 'AWAITING_CLARIFICATION', ...FINAL], 120_000);
  assert.notEqual(pending.state, 'AWAITING_CLARIFICATION', `"${text}" asked a question: ${pending.message || ''}`);
  if (FINAL.includes(pending.state)) return { id, specHash: pending.interpretation?.specHash, done: pending };
  const specHash = pending.interpretation?.specHash;
  assert.ok(specHash, 'the pending request shows a specHash');
  const c = await call('POST', `/api/v2/requests/${id}/confirm`, { specHash });
  assert.equal(c.status, 200, `confirmRequest: ${c.text.slice(0, 200)}`);
  const done = await waitState(id, FINAL);
  return { id, specHash: done.interpretation?.specHash || specHash, done };
}

async function allVms() {
  const all = await call('GET', '/api/v2/vms');
  assert.equal(all.status, 200, `GET /api/v2/vms: ${all.text.slice(0, 200)}`);
  assert.ok(Array.isArray(all.body), 'GET /api/v2/vms is a list');
  return all.body;
}

// ------------------------------------------------------------------ 8. served OpenAPI

test('criterion 8: GET /v3/api-docs (servers left out) equals docs/openapi.json (servers left out)', async () => {
  const r = await call('GET', '/v3/api-docs');
  assert.equal(r.status, 200, `GET /v3/api-docs: ${r.text.slice(0, 200)}`);
  const strip = ({ servers, ...rest }) => rest;
  const snapshot = strip(JSON.parse(readFileSync(join(ROOT, 'docs', 'openapi.json'), 'utf8')));
  assert.deepEqual(strip(r.body), snapshot);
});

test('criterion 8: the served Interpretation schema: specHash covers a signed-in user\'s ID; cloudName is the VM\'s name in its cloud', async () => {
  const r = await call('GET', '/v3/api-docs');
  assert.equal(r.status, 200);
  const s = r.body?.components?.schemas?.Interpretation;
  assert.ok(s, 'no Interpretation schema');
  const d = s.properties?.specHash?.description || '';
  assert.notEqual(d.trim().replace(/\.$/, ''), 'SHA-256 of the canonical spec', 'specHash still reads only "SHA-256 of the canonical spec"');
  assert.match(d, /signed-in/i, `specHash description: ${d}`);
  assert.match(d, /user ID/i, `specHash description: ${d}`);
  const c = s.properties?.cloudName;
  assert.ok(c, 'the served Interpretation has no cloudName property');
  assert.equal(c.type, 'string');
  assert.match(c.description || '', /name in its cloud/i, `cloudName description: ${c.description}`);
  assert.match(c.description || '', /same as spec\.name/i, `cloudName description: ${c.description}`);
});

// ------------------------------------------------------------------ 9. interpret shows the cloud name

test('criterion 9: interpret of a named VM returns 200 with cloudName equal to spec.name (the asked-for name)', async () => {
  const name = `web-01-${RUN}`;
  const it = await interpret(`a small ubuntu server on aws called ${name}`);
  assert.ok(!it.question, `asked a question: ${it.question}`);
  assert.equal(it.spec?.name, name, `spec.name: ${JSON.stringify(it).slice(0, 400)}`);
  assert.equal(it.cloudName, it.spec.name, `cloudName: ${JSON.stringify(it).slice(0, 400)}`);
});

test('criterion 9: interpret of a text with no name returns cloudName equal to the generated spec.name (vm- + 8 hex)', async () => {
  const it = await interpret('small debian vm on azure'); // a preview builds nothing, so it needn't be unique
  assert.ok(!it.question, `asked a question: ${it.question}`);
  assert.match(it.spec?.name || '', /^vm-[0-9a-f]{8}$/, `spec.name: ${JSON.stringify(it).slice(0, 400)}`);
  assert.equal(it.cloudName, it.spec.name, `cloudName: ${JSON.stringify(it).slice(0, 400)}`);
  assert.equal(it.spec.name, `vm-${it.specHash.slice(0, 8)}`, 'the generated name comes from the hash as before');
});

test('criterion 9: interpret of a text that needs a question has no cloudName', async () => {
  const it = await interpret('a small server');
  assert.ok(it.question, `"a small server" asked no question: ${JSON.stringify(it).slice(0, 400)}`);
  assert.ok(it.cloudName === null || it.cloudName === undefined, `cloudName is ${JSON.stringify(it.cloudName)}`);
});

// ------------------------------------------------------------------ 10. no behaviour change

test('criterion 10: a new request builds under the hash interpret gave beforehand, lists the asked-for name, and its repeat is DUPLICATE',
  { timeout: 900_000 }, async () => {
    const name = `web-01-${RUN}b`;
    const text = `a small ubuntu server on aws called ${name}`;
    const before = await interpret(text);
    const h0 = before.specHash;
    assert.match(h0 || '', /^[0-9a-f]{64}$/, `interpret gave no specHash: ${JSON.stringify(before).slice(0, 300)}`);
    assert.equal(before.cloudName, name, 'interpret shows the asked-for name as the cloud name');
    if (!TOKEN) {
      assert.equal(h0, sha256(canonical(before.spec)), `the anonymous hash is still SHA-256(${canonical(before.spec)})`);
    }
    assert.equal((await allVms()).filter((v) => v.spec?.name === name).length, 0, `${name} already exists`);

    const first = await runToEnd(text);
    assert.equal(first.done.state, 'COMPLETED', `first request: ${first.done.state} ${first.done.message || ''}`);
    assert.equal(first.specHash, h0, 'the request\'s specHash is the one interpret returned before it');
    assert.equal(first.done.interpretation?.cloudName, name, 'the request\'s interpretation has the asked-for cloud name');

    const listed = (await allVms()).filter((v) => v.specHash === h0);
    assert.equal(listed.length, 1, `${h0} is listed ${listed.length} times`);
    assert.equal(listed[0].spec?.name, name, `the VM list shows ${listed[0].spec?.name}, not the asked-for name`);
    assert.equal(listed[0].state, 'RUNNING', `the VM's state: ${JSON.stringify(listed[0]).slice(0, 300)}`);
    const vmId = listed[0].result?.vmId;

    const second = await runToEnd(text);
    assert.equal(second.done.state, 'DUPLICATE', `the same request again: ${second.done.state} ${second.done.message || ''}`);
    assert.equal(second.specHash, h0, 'the duplicate has the same specHash');
    const after = (await allVms()).filter((v) => v.spec?.name === name);
    assert.equal(after.length, 1, `${name} is listed ${after.length} times after the duplicate`);
    assert.equal(after[0].specHash, h0);
    assert.equal(after[0].state, 'RUNNING', 'still RUNNING after the duplicate');
    if (vmId) assert.equal(after[0].result?.vmId, vmId, 'the duplicate built no new VM (same vmId)');

    // And interpret still gives the same hash afterwards.
    assert.equal((await interpret(text)).specHash, h0, 'interpret gives the same hash after the build');
  });
