// AP-0006 acceptance, criterion 6 (and the run half of 3-4): mvn test passes in backend/, and its surefire
// reports show OpenApiDocumentTest, the blueprint serialization test in VsphereControllerTest and the
// Temporal ReplayTest ran with no failures, errors or skips. Needs Maven and a JDK on PATH (set MVN to
// choose the command). Takes several minutes.
//
//   node --test tests/acceptance/ap-0006/mvn_test.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const BACKEND = join(ROOT, 'backend');
const MVN = process.env.MVN || (process.platform === 'win32' ? 'mvn.cmd' : 'mvn');
const REPORTS = join(BACKEND, 'target', 'surefire-reports');

function report(cls) {
  const p = join(REPORTS, `TEST-${cls}.xml`);
  assert.ok(existsSync(p), `surefire report for ${cls} exists (did it run?)`);
  const xml = readFileSync(p, 'utf8');
  const suite = /<testsuite\b[^>]*>/.exec(xml)[0];
  const attr = (n) => Number(new RegExp(`\\b${n}="(\\d+)"`).exec(suite)?.[1] ?? NaN);
  return { xml, tests: attr('tests'), failures: attr('failures'), errors: attr('errors'), skipped: attr('skipped') };
}

test('6: mvn test passes, including OpenApiDocumentTest, the blueprint serialization test and ReplayTest', { timeout: 1_800_000 }, () => {
  // mvn.cmd needs a shell on Windows; one command string avoids Node's args-with-shell warning.
  const opts = { cwd: BACKEND, encoding: 'utf8', timeout: 1_700_000, maxBuffer: 256 * 1024 * 1024 };
  const r = process.platform === 'win32'
    ? spawnSync(`${MVN} -B test`, { ...opts, shell: true })
    : spawnSync(MVN, ['-B', 'test'], opts);
  assert.ok(!r.error, `could not run ${MVN}: ${r.error?.message}`);
  const out = (r.stdout || '') + (r.stderr || '');
  assert.match(out, /BUILD SUCCESS/, 'mvn test reports BUILD SUCCESS:\n' + out.slice(-4000));
  assert.equal(r.status, 0, `mvn test exits 0 (exit ${r.status})`);

  for (const cls of ['com.example.vmintent.api.OpenApiDocumentTest', 'com.example.vmintent.api.VsphereControllerTest',
    'com.example.vmintent.workflow.ReplayTest']) {
    const s = report(cls);
    assert.ok(s.tests > 0, `${cls} ran tests (${s.tests})`);
    assert.equal(s.failures, 0, `${cls} has no failures`);
    assert.equal(s.errors, 0, `${cls} has no errors`);
    assert.equal(s.skipped, 0, `${cls} skipped nothing`);
  }
  const vc = report('com.example.vmintent.api.VsphereControllerTest').xml;
  assert.match(vc, /<testcase\b[^>]*name="blueprint\w*"/i, 'VsphereControllerTest ran a blueprint serialization test case');
  const oa = report('com.example.vmintent.api.OpenApiDocumentTest').xml;
  assert.doesNotMatch(oa, /<skipped/, 'OpenApiDocumentTest skipped no test case');
});
