// AP-0008 acceptance, criterion 6: the older acceptance tests in tests/acceptance/ap-0002, ap-0003, ap-0004 and
// ap-0006 still pass against the server. Their mvn_test and contract_run files are left out here: this
// folder's mvn_snapshot.test.mjs runs the full mvn test and contract_run.test.mjs runs the same contract script.
//
//   VMINTENT_API=http://127.0.0.1:19080 node --test tests/acceptance/ap-0008/older_acceptance.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19080').replace(/\/+$/, '');
const SKIP = /^(mvn_test|contract_run)\./;

for (const dir of ['ap-0002', 'ap-0003', 'ap-0004', 'ap-0006']) {
  const abs = join(ROOT, 'tests', 'acceptance', dir);
  test(`6: tests/acceptance/${dir} exists`, () => assert.ok(existsSync(abs)));
  if (!existsSync(abs)) continue;
  for (const file of readdirSync(abs).filter((f) => /\.test\.mjs$/.test(f) && !SKIP.test(f))) {
    test(`6: tests/acceptance/${dir}/${file} still passes`, { timeout: 900_000 }, () => {
      const r = spawnSync(process.execPath, ['--test', join(abs, file)], {
        cwd: ROOT, encoding: 'utf8', timeout: 850_000, maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, VMINTENT_API: BASE },
      });
      assert.ok(!r.error, `could not run node: ${r.error?.message}`);
      const out = (r.stdout || '') + (r.stderr || '');
      assert.equal(r.status, 0, `${dir}/${file} exits 0:\n${out.slice(-4000)}`);
    });
  }
}
