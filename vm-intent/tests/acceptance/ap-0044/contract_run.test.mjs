// AP-0044 acceptance, criterion 8 (contract part): python tests/api_contract_test.py passes every check against the
// server, including its getVm checks (a built VM, a malformed hash, an unknown hash). Needs Python with openapi-core
// and requests (pip install openapi-core requests); set PYTHON to choose the interpreter. Builds a few simulated VMs.
//
//   node --test tests/acceptance/ap-0044/contract_run.test.mjs      (VMINTENT_API defaults to http://127.0.0.1:19040)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19040').replace(/\/+$/, '');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

test('criterion 8: python tests/api_contract_test.py passes every check against staging, getVm\'s included', { timeout: 1_500_000 }, () => {
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
  // The built-VM check only runs when the script's request completes; it must have run here.
  assert.ok(passed.some((p) => /^getVm\b(?!:)/.test(p)), `the getVm check on a built VM ran and passed:\n${passed.join('\n')}`);
  assert.ok(passed.some((p) => /^getVm\b.*400/.test(p)), `a getVm 400 check ran and passed:\n${passed.join('\n')}`);
  assert.ok(passed.some((p) => /^getVm\b.*404/.test(p)), `a getVm 404 check ran and passed:\n${passed.join('\n')}`);
  const m = /(\d+)\/(\d+) checks passed/.exec(out);
  assert.ok(m, 'the script prints its "N/M checks passed" summary: ' + out.slice(-1000));
  assert.equal(m[1], m[2], `every check passed: ${m[0]}`);
  assert.ok(Number(m[2]) >= 60, `the script runs at least 60 checks (${m[2]})`);
  assert.equal(r.status, 0, `the script exits 0 (exit ${r.status}): ${out.slice(-1000)}`);
});
