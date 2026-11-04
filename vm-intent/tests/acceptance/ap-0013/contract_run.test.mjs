// AP-0013 acceptance, criterion 5 (run part): python tests/api_contract_test.py passes every check against the
// server, including the new unknown-spec-hash 404 and already-decommissioned 409 checks. Needs Python with
// openapi-core and requests (pip install openapi-core requests); set PYTHON to choose the interpreter. Builds a
// few simulated VMs.
//
//   VMINTENT_API=http://127.0.0.1:19030 node --test tests/acceptance/ap-0013/contract_run.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19030').replace(/\/+$/, '');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

test('5: python tests/api_contract_test.py passes every check against staging, old and new', { timeout: 1_500_000 }, () => {
  const r = spawnSync(PYTHON, [join(ROOT, 'tests', 'api_contract_test.py'), BASE], {
    cwd: ROOT, encoding: 'utf8', timeout: 1_400_000, env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });
  assert.ok(!r.error, `could not run ${PYTHON}: ${r.error?.message}`);
  const out = (r.stdout || '') + (r.stderr || '');
  assert.doesNotMatch(out, /No module named/, 'openapi-core and requests are installed: ' + out.slice(-400));

  const lines = out.split(/\r?\n/);
  const failed = lines.filter((l) => l.startsWith('FAIL '));
  const passed = lines.filter((l) => l.startsWith('PASS ')).map((l) => l.slice(5));
  assert.deepEqual(failed, [], 'no check failed:\n' + out.slice(-3000));

  // The new checks ran and passed: a change on an unknown spec hash -> 404, a change on a decommissioned VM -> 409.
  const ops = /^(renewVm|resizeVm|powerVm|snapshotVm|decommissionVm)\b/;
  assert.ok(passed.some((p) => ops.test(p) && /404/.test(p)),
    `a change-operation 404 check ran and passed (passed: ${passed.join(' | ')})`);
  assert.ok(passed.some((p) => ops.test(p) && /409/.test(p) && /decommission/i.test(p)),
    `an already-decommissioned 409 check ran and passed (passed: ${passed.join(' | ')}); it only runs if the contract script's VM built`);

  const m = /(\d+)\/(\d+) checks passed/.exec(out);
  assert.ok(m, 'the script prints its "N/M checks passed" summary: ' + out.slice(-1000));
  assert.equal(m[1], m[2], `every check passed: ${m[0]}`);
  assert.ok(Number(m[2]) >= 55, `the script runs at least 55 checks (${m[2]})`);
  assert.equal(r.status, 0, `the script exits 0 (exit ${r.status}): ${out.slice(-1000)}`);
});
