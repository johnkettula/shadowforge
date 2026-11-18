// AP-0047 acceptance, live half (criteria 4-8 against the running server): one VM-name rule for new requests.
// A batch item, or a legacy JSON request, whose name breaks [a-z0-9][a-z0-9-]{1,40} is rejected (400, with a
// message naming it) and nothing is built under that name or a lower-cased copy of it; valid names, including a
// 41-character one, are accepted; text previews still pick up "called web-01" and still generate vm-<hash8> when
// no name is given. Accepted items build VMs on the (simulated) staging clouds with a one-day lifetime; every name
// they use carries a fresh run value, so re-runs never collide.
//
//   node --test tests/acceptance/ap-0047/live_api.test.mjs      (VMINTENT_API defaults to http://127.0.0.1:19070)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19070').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};
const RUN = (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toLowerCase().replace(/[^a-z0-9]/g, '');
const SETTLE_MS = 3000;   // time for a wrongly started build to show up in GET /api/v2/vms

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

const spec = (name) => ({
  name, provider: 'aws', region: 'us-east', vcpu: 2, memoryGiB: 4, os: 'ubuntu', osVersion: '24.04',
  diskGiB: 50, diskTier: 'ssd', env: 'dev', ttlDays: 1, publicIp: false,
});
const batch = (name) => call('POST', '/api/v2/batches', { items: [{ spec: spec(name) }], requestedBy: 'ap-0047-acceptance' });
const reasonOf = (e) => String(e?.reason ?? e?.message ?? '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** specHashes of the VM records with exactly this name. */
async function recordsNamed(name) {
  const r = await call('GET', '/api/v2/vms');
  assert.equal(r.status, 200, `GET /api/v2/vms: ${r.status} ${r.text.slice(0, 200)}`);
  const items = Array.isArray(r.json) ? r.json : (r.json?.items ?? r.json?.content ?? []);
  return new Set(items.filter((v) => v?.spec?.name === name).map((v) => v.specHash));
}
/** Records with these names that appeared after `before` was taken. */
async function newRecords(before) {
  const fresh = [];
  for (const [name, hashes] of before) {
    for (const h of await recordsNamed(name)) if (!hashes.has(h)) fresh.push(`${name} (${h})`);
  }
  return fresh;
}
async function snapshot(names) {
  return new Map(await Promise.all(names.map(async (n) => [n, await recordsNamed(n)])));
}

/** A batch refused with 400 whose rejected list is one entry for item 0 that mentions `name`. */
function assertRefused(r, name) {
  assert.equal(r.status, 400, `POST /api/v2/batches with name '${name}': ${r.status} ${r.text.slice(0, 400)}`);
  const rejected = r.json?.rejected;
  assert.ok(Array.isArray(rejected), `no rejected list in the 400 body: ${r.text.slice(0, 400)}`);
  assert.equal(rejected.length, 1, `rejected: ${JSON.stringify(rejected)}`);
  assert.equal(rejected[0].index, 0, `rejected: ${JSON.stringify(rejected)}`);
  assert.ok(reasonOf(rejected[0]).includes(name), `the rejection doesn't mention '${name}': ${reasonOf(rejected[0])}`);
}
function assertAccepted(r, name) {
  assert.ok(r.status >= 200 && r.status < 300, `POST /api/v2/batches with name '${name}': ${r.status} ${r.text.slice(0, 400)}`);
  assert.deepEqual(r.json?.rejected ?? [], [], `the batch rejected something: ${r.text.slice(0, 400)}`);
  assert.equal(r.json?.accepted, 1, `accepted count: ${r.text.slice(0, 400)}`);
}

test('criterion 4: a batch item named "Web 01" is refused with 400, its rejection names it, and nothing is built', async () => {
  const before = await snapshot(['Web 01', 'web-01', 'web 01', 'web01']);
  const r = await batch('Web 01');
  assertRefused(r, 'Web 01');
  await sleep(SETTLE_MS);
  assert.deepEqual(await newRecords(before), [], 'a VM was built for the refused name');
});

test('criterion 5: an upper-cased name is refused with 400 and not built under the lower-cased name; the lower-case one is accepted', async () => {
  const lower = `web-01-${RUN}`;
  const upper = lower.toUpperCase();
  assert.notEqual(lower, upper, 'the run value has no letters to upper-case');

  const r1 = await batch(upper);
  assertRefused(r1, upper);
  await sleep(SETTLE_MS);
  assert.deepEqual([...await recordsNamed(lower)], [], `a VM named ${lower} exists after the upper-case request was refused`);
  assert.deepEqual([...await recordsNamed(upper)], [], `a VM named ${upper} exists`);

  const r2 = await batch(lower);
  assertAccepted(r2, lower);
});

test('criterion 6: a 42-character name is refused with a rejection naming it; the 41-character one is accepted', async () => {
  const shape = (prefix, len) => (prefix + '-x'.repeat(30)).slice(0, len).replace(/-$/, 'x');
  const n42 = shape(`ap47-long-${RUN}`, 42);
  const n41 = shape(`ap47-ok-${RUN}`, 41);
  assert.equal(n42.length, 42);
  assert.equal(n41.length, 41);
  assert.match(n42, /^[a-z0-9][a-z0-9-]*$/);
  assert.match(n41, /^[a-z0-9][a-z0-9-]*$/);

  const before = await snapshot([n42, n42.slice(0, 41)]);
  assertRefused(await batch(n42), n42);
  assertAccepted(await batch(n41), n41);
  await sleep(SETTLE_MS);
  assert.deepEqual(await newRecords(before), [], 'a VM was built for the 42-character name (or a shortened copy)');
});

const legacy = (name) => ({
  name, cloud: 'AWS', location: 'us-east-1', cpu: 2, ramGb: 4, image: { os: 'Ubuntu', version: '24.04' },
  disk: { sizeGb: 50, type: 'SSD' }, environment: 'dev', ttlDays: 1, publicIp: false,
});

test('criterion 7: POST /api/v1/vms with name "web 01" returns 400 and the message names it', async () => {
  const before = await snapshot(['web 01', 'web-01', 'web01']);
  const r = await call('POST', '/api/v1/vms', legacy('web 01'));
  assert.equal(r.status, 400, `POST /api/v1/vms: ${r.status} ${r.text.slice(0, 400)}`);
  const msg = String(r.json?.error ?? r.json?.message ?? r.text);
  assert.ok(msg.includes('web 01'), `the 400 message doesn't mention 'web 01': ${msg}`);
  await sleep(SETTLE_MS);
  assert.deepEqual(await newRecords(before), [], 'a VM was built for the refused legacy name');
});

test('criterion 7 (control): the same legacy body with a valid name is accepted, so the 400 was about the name', async () => {
  const name = `ap47-legacy-${RUN}`;
  const r = await call('POST', '/api/v1/vms', legacy(name));
  assert.ok(r.status >= 200 && r.status < 300, `POST /api/v1/vms with name ${name}: ${r.status} ${r.text.slice(0, 400)}`);
  assert.equal(r.json?.spec?.name, name);
});

test('criterion 8: "a small ubuntu server on aws called web-01" still previews as web-01 with no question', async () => {
  const r = await call('POST', '/api/v2/interpret', { text: 'a small ubuntu server on aws called web-01' });
  assert.equal(r.status, 200, `POST /api/v2/interpret: ${r.status} ${r.text.slice(0, 400)}`);
  assert.ok(!r.json?.question, `the preview asks a question: ${r.json?.question}`);
  assert.equal(r.json?.spec?.name, 'web-01', r.text.slice(0, 400));
});

test('criterion 8: a text request with no name still gets a generated vm-<8 hex> name', async () => {
  const r = await call('POST', '/api/v2/interpret', { text: 'a small ubuntu server on aws' });
  assert.equal(r.status, 200, `POST /api/v2/interpret: ${r.status} ${r.text.slice(0, 400)}`);
  assert.ok(!r.json?.question, `the preview asks a question: ${r.json?.question}`);
  assert.match(String(r.json?.spec?.name), /^vm-[0-9a-f]{8}$/);
});
