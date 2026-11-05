// AP-0014 acceptance, live half (criterion 11): adding the Azure Resource Manager client changes nothing a user
// sees. An Azure request still completes with a simulated VM whose ID starts with az-vm-, and GET /v3/api-docs
// lists the same paths (and methods) as docs/openapi.json did just before the first AP-0014 commit.
// Builds one simulated Azure VM.
//
//   VMINTENT_API=http://127.0.0.1:19040 node --test tests/acceptance/ap-0014/live_api.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19040').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const RUN = Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, 'x');
const USER = `ap0014-${RUN}`;
const FINAL = ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'DUPLICATE'];
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function call(method, path, body) {
  const headers = { Accept: 'application/json', ...AUTH };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: res.status, text, body: json };
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

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];
const pathsAndMethods = (d) => Object.entries(d.paths || {})
  .flatMap(([p, item]) => Object.keys(item).filter((m) => METHODS.includes(m)).map((m) => `${m.toUpperCase()} ${p}`))
  .sort();

test('11: an Azure request (small linux VM on azure, then confirm) completes with a simulated az-vm- VM', { timeout: 600_000 }, async () => {
  const name = `ap14-${RUN}`;
  const r = await call('POST', '/api/v2/requests', { text: `a small linux VM on azure called ${name}`, userId: USER });
  assert.equal(r.status, 200, `createRequest: ${r.status} ${r.text.slice(0, 300)}`);
  const id = r.body?.requestId;
  assert.ok(id, `createRequest returns a requestId: ${r.text.slice(0, 300)}`);

  const pending = await waitState(id, ['AWAITING_CONFIRMATION', 'AWAITING_CLARIFICATION', ...FINAL], 120_000);
  assert.equal(pending.state, 'AWAITING_CONFIRMATION', `request waits for confirmation: ${pending.state} ${pending.message || ''}`);
  assert.match(JSON.stringify(pending.interpretation || {}).toLowerCase(), /azure/,
    `the request was understood as Azure: ${JSON.stringify(pending.interpretation).slice(0, 400)}`);

  const c = await call('POST', `/api/v2/requests/${id}/confirm`, { specHash: pending.interpretation?.specHash });
  assert.equal(c.status, 200, `confirmRequest: ${c.status} ${c.text.slice(0, 300)}`);

  const done = await waitState(id, FINAL);
  assert.equal(done.state, 'COMPLETED', `the Azure VM was built: ${done.state} ${done.message || ''}`);
  assert.ok(done.vm, `the completed request has a vm: ${JSON.stringify(done).slice(0, 400)}`);
  assert.match(done.vm.vmId || '', /^az-vm-/, `simulated Azure VM ID starts with az-vm-: ${done.vm.vmId}`);
  assert.equal(done.vm.provider, 'azure', `the VM's provider is azure: ${JSON.stringify(done.vm)}`);
});

test('11: GET /v3/api-docs lists the same paths and methods as before AP-0014', async () => {
  const res = await fetch(BASE + '/v3/api-docs', { headers: AUTH });
  assert.equal(res.status, 200, 'GET /v3/api-docs');
  const live = await res.json();

  const shas = git(['log', '--format=%H', '--no-merges', '--grep=^AP-0014:']).split('\n').filter(Boolean);
  assert.ok(shas.length > 0, 'found the AP-0014 commits');
  const oldest = shas[shas.length - 1];
  const before = JSON.parse(git(['show', `${oldest}^:vm-intent/docs/openapi.json`]));

  const now = pathsAndMethods(live);
  const was = pathsAndMethods(before);
  const added = now.filter((x) => !was.includes(x));
  const removed = was.filter((x) => !now.includes(x));
  // Later requirements may add paths; this requirement must not remove or rename any, and must add none itself
  // (checked against the commits in repo.test.mjs). Here: nothing that existed before AP-0014 is gone.
  assert.deepEqual(removed, [], `no path/method that existed before AP-0014 is missing from the live document`);
  // While AP-0014 is the newest requirement on the branch, the live document must equal the pre-AP-0014 one.
  const newest = git(['log', '-1', '--format=%s', '--no-merges', '--grep=^AP-[0-9]']).trim();
  if (/^AP-0014:/.test(newest)) {
    assert.deepEqual(added, [], `no path/method was added by AP-0014`);
  }
});
