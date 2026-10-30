// AP-0004 acceptance: python tests/api_contract_test.py passes every check against the server, the new
// catalog and compliance ones and all the existing ones, and the number it runs is the number docs/API.md
// gives. Covers criterion 4 and the live half of 6. Needs Python with openapi-core and requests
// (pip install openapi-core requests); set PYTHON to choose the interpreter. Builds a few simulated VMs.
//
//   VMINTENT_API=http://127.0.0.1:19040 node --test tests/acceptance/ap-0004/contract_run.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19040').replace(/\/+$/, '');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

const NEW = ['listDefinitions', 'getDefinition: web-server', 'getDefinition: unknown', 'validateDefinition',
  'listClassifications', 'listRuns', 'getRun: unknown', 'startRun: unknown definition', 'startRun: no definition',
  'listDecisions', 'listArchive', 'downloadArchivedHistory', 'replayWorkflow'];
const EXISTING = ['clarifyRequest', 'cancelRequest', 'confirmRequest', 'renewVm', 'resizeVm', 'powerVm', 'snapshotVm',
  'decommissionVm', 'createBatch', 'getBatch', 'runInventoryCheck', 'listInventoryChecks', 'createLegacyVm',
  'getVsphereStatus', 'listVsphereTemplates', 'listVsphereBlueprints', 'getVsphereBlueprint'];

test('4, 6: python tests/api_contract_test.py passes every check, and runs as many as docs/API.md says', { timeout: 1_500_000 }, () => {
  const r = spawnSync(PYTHON, [join(ROOT, 'tests', 'api_contract_test.py'), BASE], {
    cwd: ROOT, encoding: 'utf8', timeout: 1_400_000, env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });
  assert.ok(!r.error, `could not run ${PYTHON}: ${r.error?.message}`);
  const out = (r.stdout || '') + (r.stderr || '');
  assert.doesNotMatch(out, /No module named/, 'openapi-core and requests are installed: ' + out.slice(-400));

  const lines = out.split(/\r?\n/);
  const failed = lines.filter((l) => l.startsWith('FAIL '));
  const passed = lines.filter((l) => l.startsWith('PASS ')).map((l) => l.slice(5));
  for (const name of [...NEW, ...EXISTING]) {
    assert.ok(passed.some((p) => p.startsWith(name)), `check "${name}..." ran and passed (failed: ${failed.join(' | ')})`);
  }
  assert.deepEqual(failed, [], 'no check failed:\n' + out.slice(-3000));

  const m = /(\d+)\/(\d+) checks passed/.exec(out);
  assert.ok(m, 'the script prints its "N/M checks passed" summary: ' + out.slice(-1000));
  assert.equal(m[1], m[2], `every check passed: ${m[0]}`);
  assert.equal(r.status, 0, `the script exits 0 (exit ${r.status}): ${out.slice(-1000)}`);

  const md = readFileSync(join(ROOT, 'docs', 'API.md'), 'utf8');
  const doc = /It runs (\d+) checks/.exec(md);
  assert.ok(doc, 'docs/API.md says "It runs N checks"');
  assert.equal(Number(doc[1]), Number(m[2]), `docs/API.md says ${doc[1]} checks; the script ran ${m[2]}`);
});
