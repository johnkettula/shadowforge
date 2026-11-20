// AP-0053 acceptance, live half (criterion 8): vSphere behaviour on the running server is unchanged by the move onto
// RoutedProvider. POST /api/v2/interpret with a vsphere request in dc1, then the usual request and confirm, builds a
// VM that GET /api/v2/vms/{specHash} reports RUNNING within 3 minutes with a vmId starting "vm-"; a resize of it
// through POST /api/v2/vms/{specHash}/resize is accepted; POST /api/v2/inventory-checks answers 202 and within
// 3 minutes GET /api/v2/inventory-checks?limit=1 shows that check with a vsphere finding whose missing list doesn't
// contain the VM just built.
// Builds one VM per run and decommissions it at the end.
//
//   node --test tests/acceptance/ap-0053/live_api.test.mjs      (VMINTENT_API defaults to http://127.0.0.1:19030)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19030').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};
const RUN = Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, 'x');
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

async function waitState(id, states, timeoutMs) {
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

let built;
after(async () => {
  if (built) await call('POST', `/api/v2/vms/${built}/decommission`, { reason: `AP-0053 acceptance ${RUN}` }).catch(() => {});
});

test('criterion 8: a vSphere dc1 VM builds RUNNING with a vm- ID, resizes, and an inventory check does not mark it missing',
  { timeout: 900_000 }, async () => {
    const text = `a small ubuntu server on vsphere in dc1 called rp-${RUN}`;

    // Interpret: a vsphere spec in dc1.
    const i = await call('POST', '/api/v2/interpret', { text });
    assert.equal(i.status, 200, `POST /api/v2/interpret: ${i.status} ${i.text.slice(0, 300)}`);
    assert.equal(i.body?.spec?.provider, 'vsphere', `interpreted provider: ${i.text.slice(0, 300)}`);
    assert.equal(i.body?.spec?.region, 'dc1', `interpreted region: ${i.text.slice(0, 300)}`);
    const shown = i.body?.specHash;
    assert.match(shown || '', /^[0-9a-f]{64}$/, `interpret returned no specHash: ${i.text.slice(0, 300)}`);

    // The usual request and confirm, with the specHash interpret showed.
    const started = Date.now();
    const r = await call('POST', '/api/v2/requests', { text });
    assert.equal(r.status, 200, `POST /api/v2/requests: ${r.status} ${r.text.slice(0, 300)}`);
    const id = r.body?.requestId;
    assert.ok(id, `no requestId: ${r.text.slice(0, 300)}`);
    const pending = await waitState(id, ['AWAITING_CONFIRMATION', 'AWAITING_CLARIFICATION', ...FINAL], 120_000);
    assert.equal(pending.state, 'AWAITING_CONFIRMATION', `the request is ${pending.state}: ${pending.message || ''}`);
    assert.equal(pending.interpretation?.specHash, shown, 'the request waits on a different specHash than interpret showed');
    const c = await call('POST', `/api/v2/requests/${id}/confirm`, { specHash: shown });
    assert.equal(c.status, 200, `confirm: ${c.status} ${c.text.slice(0, 300)}`);
    built = shown;

    // GET /api/v2/vms/{specHash} reports RUNNING within 3 minutes, with a vmId starting "vm-".
    const end = started + 180_000;
    let vm;
    while (Date.now() < end) {
      const g = await call('GET', `/api/v2/vms/${shown}`);
      if (g.status === 200) {
        vm = g.body;
        if (vm?.state === 'RUNNING') break;
        if (['FAILED', 'ROLLED_BACK', 'DECOMMISSIONED'].includes(vm?.state)) break;
      }
      await sleep(1500);
    }
    assert.equal(vm?.state, 'RUNNING', `GET /api/v2/vms/${shown} within 3 minutes: ${JSON.stringify(vm)?.slice(0, 400)}`);
    const vmId = vm.result?.vmId ?? vm.vmId;
    assert.match(String(vmId || ''), /^vm-/, `the vmId is ${vmId}, not vm-...: ${JSON.stringify(vm).slice(0, 400)}`);
    assert.equal(vm.spec?.provider, 'vsphere', `the VM's provider is ${vm.spec?.provider}`);
    assert.equal(vm.spec?.region, 'dc1', `the VM's region is ${vm.spec?.region}`);

    // A resize through the existing VM endpoint is accepted.
    const rs = await call('POST', `/api/v2/vms/${shown}/resize`, { vcpu: 4, memoryGiB: 8 });
    assert.ok(rs.status === 200 || rs.status === 202, `POST /api/v2/vms/${shown}/resize: ${rs.status} ${rs.text.slice(0, 400)}`);

    // An inventory check: 202, then within 3 minutes the report, with a vsphere finding not listing this VM as missing.
    const start = await call('POST', '/api/v2/inventory-checks');
    assert.equal(start.status, 202, `POST /api/v2/inventory-checks: ${start.status} ${start.text.slice(0, 300)}`);
    const checkId = start.body?.checkId;
    assert.ok(typeof checkId === 'string' && checkId.length > 0, `no checkId in ${start.text.slice(0, 300)}`);
    const until = Date.now() + 180_000;
    let report; let last;
    while (Date.now() < until) {
      const g = await call('GET', '/api/v2/inventory-checks?limit=1');
      assert.equal(g.status, 200, `GET /api/v2/inventory-checks?limit=1: ${g.status} ${g.text.slice(0, 300)}`);
      assert.ok(Array.isArray(g.body), `not a list: ${g.text.slice(0, 300)}`);
      last = g.body[0];
      if (last?.checkId === checkId) { report = last; break; }
      await sleep(2000);
    }
    assert.ok(report, `GET /api/v2/inventory-checks?limit=1 did not show ${checkId} within 3 minutes (last: ${last?.checkId})`);
    assert.ok(Array.isArray(report.findings), `the report has no findings: ${JSON.stringify(report).slice(0, 300)}`);
    const vs = report.findings.find((f) => f.provider === 'vsphere');
    assert.ok(vs, `no vsphere finding: ${JSON.stringify(report.findings.map((f) => f.provider))}`);
    assert.ok(Array.isArray(vs.missing), `the vsphere finding has no missing list: ${JSON.stringify(vs).slice(0, 300)}`);
    assert.ok(!vs.missing.includes(shown) && !vs.missing.includes(vmId),
      `the VM just built is in the vsphere finding's missing list: ${JSON.stringify(vs).slice(0, 400)}`);

    // Still RUNNING afterwards.
    const g = await call('GET', `/api/v2/vms/${shown}`);
    assert.equal(g.status, 200, `GET /api/v2/vms/${shown} after the check: ${g.status}`);
    assert.equal(g.body?.state, 'RUNNING', `after the check the VM is ${g.body?.state}; vsphere note: ${vs.note}`);
  });
