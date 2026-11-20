// AP-0052 acceptance, live half (criterion 8): on the running server, POST /api/v2/inventory-checks answers 202 with a
// checkId; within 3 minutes GET /api/v2/inventory-checks?limit=1 returns the report with that checkId and one finding
// for each of vsphere, aws, azure and gcp; and a VM built and confirmed RUNNING just before the check is still RUNNING
// afterwards in GET /api/v2/vms/{specHash}.
// Builds one simulated VM per run and decommissions it at the end.
//
//   node --test tests/acceptance/ap-0052/live_api.test.mjs      (VMINTENT_API defaults to http://127.0.0.1:19020)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19020').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};
const RUN = Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, 'x');
const FINAL = ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'DUPLICATE'];
const PROVIDERS = ['vsphere', 'aws', 'azure', 'gcp'];
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

/** Creates a request, confirms it with its specHash, and returns its final status. */
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

let built;
after(async () => {
  if (built) await call('POST', `/api/v2/vms/${built}/decommission`, { reason: `AP-0052 acceptance ${RUN}` }).catch(() => {});
});

test('criterion 8: a manual inventory check reports every provider and leaves a just-built RUNNING VM RUNNING',
  { timeout: 900_000 }, async () => {
    // A VM built and confirmed RUNNING just before the check.
    const name = `invchk-${RUN}`;
    const r = await runToEnd(`a small ubuntu server on aws called ${name}`);
    assert.equal(r.done.state, 'COMPLETED', `the request: ${r.done.state} ${r.done.message || ''}`);
    const h = r.specHash;
    assert.match(h || '', /^[0-9a-f]{64}$/, `the request has no specHash: ${JSON.stringify(r.done).slice(0, 300)}`);
    built = h;
    const vm = await call('GET', `/api/v2/vms/${h}`);
    assert.equal(vm.status, 200, `GET /api/v2/vms/${h}: ${vm.status} ${vm.text.slice(0, 300)}`);
    assert.equal(vm.body?.state, 'RUNNING', `the just-built VM is ${vm.body?.state}, not RUNNING`);

    // Run the check.
    const start = await call('POST', '/api/v2/inventory-checks');
    assert.equal(start.status, 202, `POST /api/v2/inventory-checks: ${start.status} ${start.text.slice(0, 300)}`);
    const checkId = start.body?.checkId;
    assert.ok(typeof checkId === 'string' && checkId.length > 0, `no checkId in ${start.text.slice(0, 300)}`);

    // Within 3 minutes, GET ?limit=1 returns that report.
    const end = Date.now() + 180_000;
    let report; let last;
    while (Date.now() < end) {
      const g = await call('GET', '/api/v2/inventory-checks?limit=1');
      assert.equal(g.status, 200, `GET /api/v2/inventory-checks?limit=1: ${g.status} ${g.text.slice(0, 300)}`);
      assert.ok(Array.isArray(g.body), `not a list: ${g.text.slice(0, 300)}`);
      assert.ok(g.body.length <= 1, `limit=1 returned ${g.body.length} reports`);
      last = g.body[0];
      if (last?.checkId === checkId) { report = last; break; }
      await sleep(2000);
    }
    assert.ok(report, `GET /api/v2/inventory-checks?limit=1 did not return ${checkId} within 3 minutes (last: ${last?.checkId})`);

    // One finding for each of vsphere, aws, azure and gcp.
    assert.ok(Array.isArray(report.findings), `the report has no findings list: ${JSON.stringify(report).slice(0, 300)}`);
    const providers = report.findings.map((f) => f.provider);
    for (const p of PROVIDERS) {
      assert.equal(providers.filter((x) => x === p).length, 1, `findings for ${p}: ${JSON.stringify(providers)}`);
    }
    for (const f of report.findings) {
      assert.equal(typeof f.note, 'string', `${f.provider} finding has no note`);
      assert.ok(Array.isArray(f.missing), `${f.provider} finding has no missing list`);
    }
    const aws = report.findings.find((f) => f.provider === 'aws');
    assert.ok(!aws.missing.includes(h), `the just-built VM is in the aws finding's missing list: ${aws.note}`);
    assert.equal(typeof report.missingCount, 'number', 'the report has no missingCount');

    // The VM is still RUNNING afterwards.
    const afterCheck = await call('GET', `/api/v2/vms/${h}`);
    assert.equal(afterCheck.status, 200, `GET /api/v2/vms/${h} after the check: ${afterCheck.status} ${afterCheck.text.slice(0, 300)}`);
    assert.equal(afterCheck.body?.state, 'RUNNING', `after the check the VM is ${afterCheck.body?.state}; aws note: ${aws.note}`);
  });
