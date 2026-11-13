// AP-0039 acceptance, live half (criteria 5, 7 and 8) against the running server, with sign-in off. Builds one
// simulated VM per run:
// - 'a small ubuntu server on aws called web-01-<random>' reaches COMPLETED; its specHash is the SHA-256 of the
//   spec's canonical string (worked out here with node:crypto, the same way SpecCanonicalizer does), so the anonymous
//   hash, and so every VM built before the deploy, is unchanged; the vm-<hash> build workflow exists.
// - The same text again, from a client claiming userId "mallory", ends DUPLICATE with the same specHash and builds
//   nothing new: a userId in the body changes nothing.
// - The VM record (looked up by specHash) shows the asked-for name, and its day-2 calls (lifecycle, renew, power)
//   work under that hash.
// - VMs already on the server when the run starts are still found under their stored hash (read-only checks).
// - The served OpenAPI document still equals docs/openapi.json.
//
// The API has no GET /api/v2/vms/{specHash} (criteria 7 and 8 name it, but AP-0039 may not change the API), so the
// record is looked up by specHash in GET /api/v2/vms; if a later requirement adds the single-VM read, it is used.
//
//   node --test tests/acceptance/ap-0039/live_api.test.mjs      (VMINTENT_API defaults to http://127.0.0.1:19090)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19090').replace(/\/+$/, '');
const TOKEN = process.env.VMINTENT_TOKEN;
const AUTH = TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {};
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const RUN = Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, 'x');
const USER = `ap0039-${RUN}`;
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
async function runToEnd(text, userId) {
  const r = await call('POST', '/api/v2/requests', { text, userId });
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

/** The VM record for a spec hash: GET /api/v2/vms/{specHash} if the server has it, else its entry in GET /api/v2/vms. */
async function vmRecord(specHash) {
  const one = await call('GET', `/api/v2/vms/${encodeURIComponent(specHash)}`);
  if (one.status === 200 && one.body?.specHash) return one.body;
  const mine = (await allVms()).filter((v) => v.specHash === specHash);
  assert.equal(mine.length, 1, `${specHash} is listed ${mine.length} times`);
  return mine[0];
}

async function lifecycleActive(specHash) {
  const end = Date.now() + 90_000;
  let last;
  while (Date.now() < end) {
    last = await call('GET', `/api/v2/vms/${specHash}/lifecycle`);
    if (last.status === 200 && last.body?.state === 'ACTIVE') return last.body;
    await sleep(500);
  }
  assert.fail(`the VM's lifecycle never became ACTIVE: ${last?.status} ${last?.text.slice(0, 200)}`);
}

// VMs on the server before this run built anything.
const EARLIER = await allVms().catch(() => []);

test('criterion 8: GET /v3/api-docs (servers left out) still equals docs/openapi.json (servers left out)', async () => {
  const r = await call('GET', '/v3/api-docs');
  assert.equal(r.status, 200, `GET /v3/api-docs: ${r.text.slice(0, 200)}`);
  const strip = ({ servers, ...rest }) => rest;
  const snapshot = strip(JSON.parse(readFileSync(join(ROOT, 'docs', 'openapi.json'), 'utf8')));
  assert.deepEqual(strip(r.body), snapshot);
});

test('criteria 5, 7, 8: a request builds web-01-<random> under the anonymous (SpecCanonicalizer) hash; the same '
  + 'text with userId "mallory" is DUPLICATE with the same hash; the record and day-2 calls work under that hash',
{ timeout: 900_000 }, async () => {
  const name = `web-01-${RUN}`;
  const text = `a small ubuntu server on aws called ${name}`;

  // Criterion 7: it builds.
  const first = await runToEnd(text, USER);
  assert.equal(first.done.state, 'COMPLETED', `first request: ${first.done.message || ''}`);
  const h = first.specHash;
  assert.match(h || '', /^[0-9a-f]{64}$/, `the request shows a 64-hex specHash: ${h}`);

  const vm = await vmRecord(h);
  assert.equal(vm.specHash, h);
  assert.equal(vm.spec?.name, name, `the VM record's spec.name: ${JSON.stringify(vm).slice(0, 400)}`);
  assert.equal(vm.state, 'RUNNING', `the VM record's state: ${JSON.stringify(vm).slice(0, 400)}`);
  const vmId = vm.result?.vmId;

  // The hash is SpecCanonicalizer's: the SHA-256 of the spec's canonical string, as before AP-0039.
  const spec = first.done.interpretation?.spec || vm.spec;
  if (!TOKEN) {
    assert.equal(h, sha256(canonical(spec)), `with sign-in off the hash is SHA-256(${canonical(spec)})`);
  }
  assert.equal(sha256(canonical(vm.spec)), sha256(canonical(spec)), 'the record keeps the requested spec');

  // Its build workflow is vm-<hash>.
  const replay = await call('POST', '/api/v2/compliance/replays', { workflowId: `vm-${h}` });
  assert.equal(replay.status, 200, `replay vm-${h}: ${replay.text.slice(0, 300)}`);
  assert.match(JSON.stringify(replay.body), /VmReconcileWorkflow/, `vm-${h} is a build workflow: ${replay.text.slice(0, 300)}`);

  // Criteria 5 and 7: the same text again, claiming to be someone else, is DUPLICATE under the same hash.
  const second = await runToEnd(text, 'mallory');
  assert.equal(second.done.state, 'DUPLICATE', `the same text again (userId mallory): ${second.done.state} ${second.done.message || ''}`);
  assert.equal(second.specHash, h, 'a userId in the body does not change the hash');
  const listed = (await allVms()).filter((v) => v.spec?.name === name);
  assert.equal(listed.length, 1, `${name} is listed ${listed.length} times after the duplicate`);
  const again = await vmRecord(h);
  assert.equal(again.state, 'RUNNING', 'still RUNNING after the duplicate');
  if (vmId) assert.equal(again.result?.vmId, vmId, 'the duplicate built no new VM (same vmId)');

  // Criterion 8: day-2 calls work under the hash.
  await lifecycleActive(h);
  const ok = (r, what) => {
    assert.equal(r.status, 200, `${what}: ${r.status} ${r.text.slice(0, 300)}`);
    assert.equal(typeof r.body?.state, 'string', `${what}: VmLifecycle has a state`);
  };
  ok(await call('POST', `/api/v2/vms/${h}/renew`, { days: 7 }), 'renew');
  ok(await call('POST', `/api/v2/vms/${h}/power`, { on: false }), 'power off');
  ok(await call('POST', `/api/v2/vms/${h}/power`, { on: true }), 'power on');
  ok(await call('GET', `/api/v2/vms/${h}/lifecycle`), 'lifecycle');
});

test('criterion 8: VMs already on the server are still found under their stored hash', async (t) => {
  const earlier = EARLIER.filter((v) => /^[0-9a-f]{64}$/.test(v.specHash || '') && v.state === 'RUNNING').slice(0, 5);
  if (!earlier.length) {
    t.skip(`no RUNNING VM was on the server when the run started (${EARLIER.length} listed)`);
    return;
  }
  for (const v of earlier) {
    const r = await vmRecord(v.specHash);
    assert.equal(r.specHash, v.specHash);
    assert.equal(r.spec?.name, v.spec?.name, `${v.specHash} still has its name`);
    const life = await call('GET', `/api/v2/vms/${v.specHash}/lifecycle`);
    // 404 only for a VM built before lifecycles existed, and then with the usual error.
    assert.ok(life.status === 200 || (life.status === 404 && /lifecycle/i.test(life.text)),
      `lifecycle of ${v.specHash}: ${life.status} ${life.text.slice(0, 200)}`);
    const audit = await call('GET', `/api/v2/audit?specHash=${v.specHash}&limit=5`);
    assert.equal(audit.status, 200, `audit of ${v.specHash}: ${audit.text.slice(0, 200)}`);
  }
});
