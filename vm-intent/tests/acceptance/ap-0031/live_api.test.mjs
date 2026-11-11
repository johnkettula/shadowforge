// AP-0031 acceptance, live half: AP-0031 only changes docs, so the running server must do what those docs now say
// and behave as before (criterion 10). The served OpenAPI document matches the committed snapshot; GET /api/v2/runs
// and /api/v2/runs/{runId} are served and every run's state is one DEFINITIONS.md lists (criterion 4); and the
// definition checker accepts a step's timeoutMinutes 1-1440 and refuses values outside it (criterion 5). Only
// read-only calls are made (validating a definition doesn't publish it).
//
//   node --test tests/acceptance/ap-0031/live_api.test.mjs      (VMINTENT_API defaults to http://127.0.0.1:19010)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19010').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const RUN = Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, 'x');
const RUN_STATES = ['STARTING', 'RUNNING', 'AWAITING_APPROVAL', 'AWAITING_RECOVERY', 'COMPLETED', 'TEARING_DOWN',
  'TORN_DOWN', 'TEARDOWN_INCOMPLETE'];

async function call(method, path, body) {
  const headers = { Accept: 'application/json', ...AUTH };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, json };
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

let served;
async function servedOps() {
  if (!served) {
    const r = await call('GET', '/v3/api-docs');
    assert.equal(r.status, 200, r.text.slice(0, 200));
    served = operations(r.json);
  }
  return served;
}

/** A small provisioning definition with one check.until step. */
function definition({ timeoutMinutes, everySeconds = 30, checkTimeout = 30 }) {
  return [
    'kind: Provisioning',
    `name: ap0031-probe-${RUN}`,
    'version: 1',
    'description: AP-0031 acceptance probe (validated only, never published).',
    'owner: qa',
    'classification: C3',
    'inputs:',
    '  app: { type: string, required: true }',
    'steps:',
    '  - id: ready',
    '    action: check.until',
    '    with:',
    '      vm: abc123',
    '      until: "probe.ready"',
    `      everySeconds: ${everySeconds}`,
    `      timeoutMinutes: ${checkTimeout}`,
    `    timeoutMinutes: ${timeoutMinutes}`,
    '',
  ].join('\n');
}
async function validate(opts) {
  const r = await call('POST', '/api/v2/definitions/validate', { yaml: definition(opts) });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.equal(typeof r.json?.ok, 'boolean', r.text.slice(0, 300));
  return r.json;
}

test('criterion 10: the served OpenAPI document has the same operations as the committed snapshot', async () => {
  const snapshot = JSON.parse(readFileSync(resolve(ROOT, 'docs/openapi.json'), 'utf8'));
  assert.deepEqual(await servedOps(), operations(snapshot));
});

test('criterion 4: the run endpoints DEFINITIONS.md names are served, and every run is in a documented state', async () => {
  const ops = await servedOps();
  assert.ok(ops.includes('GET /api/v2/runs'), 'GET /api/v2/runs is not served');
  assert.ok(ops.includes('GET /api/v2/runs/{runId}'), 'GET /api/v2/runs/{runId} is not served');
  const list = await call('GET', '/api/v2/runs');
  assert.equal(list.status, 200, list.text.slice(0, 200));
  assert.ok(Array.isArray(list.json), 'GET /api/v2/runs is not a list');
  for (const run of list.json) {
    const state = run.state ?? run.status;
    if (state === undefined) continue;
    assert.ok(RUN_STATES.includes(state), `run ${run.runId ?? run.id} is in state ${state}, which DEFINITIONS.md doesn't list`);
  }
  const bad = await call('GET', '/api/v2/runs/not-a-run');
  assert.equal(bad.status, 400, bad.text.slice(0, 200));
  const missing = await call('GET', `/api/v2/runs/run-ap0031-no-such-run-${RUN}`);
  assert.equal(missing.status, 404, missing.text.slice(0, 200));
});

test('criterion 5: a step\'s timeoutMinutes 1-1440 is accepted and values outside it are refused', async () => {
  for (const t of [1, 30, 1440]) {
    const v = await validate({ timeoutMinutes: t });
    assert.equal(v.ok, true, `timeoutMinutes ${t} was refused: ${JSON.stringify(v.problems)}`);
  }
  for (const t of [0, 1441]) {
    const v = await validate({ timeoutMinutes: t });
    assert.equal(v.ok, false, `timeoutMinutes ${t} was accepted`);
    assert.ok(v.problems.some((p) => /timeoutMinutes/.test(p)), `no timeoutMinutes problem for ${t}: ${JSON.stringify(v.problems)}`);
  }
});
