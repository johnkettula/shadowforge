// AP-0008 acceptance, criteria 1-5 and 7, by running Maven in a scratch copy of backend/ and docs/ (made under
// backend/target/, which git ignores, so the real snapshots are never touched):
//   A. plain mvn test passes as a whole (OpenApiDocumentTest, the snapshot test, ReplayTest), the snapshot test
//      takes no more than about 30 s, and neither snapshot file changes (5, 7);
//   B. on the clean copy, -Dopenapi.write=true passes and reproduces both committed files byte for byte (4);
//   C. one description changed in docs/openapi.json fails the test, naming the JSON path and the exact
//      -Dopenapi.write=true command, and the file isn't rewritten (1, 3, 5);
//   D. one value changed in docs/openapi.yaml fails it too (2, 3, 5);
//   E. with both files hand-edited, -Dopenapi.write=true restores them byte for byte and passes (4);
//   F. a following plain run passes (4).
// Needs Maven and a JDK on PATH (set MVN to choose the command). Takes several minutes.
//
//   node --test tests/acceptance/ap-0008/mvn_snapshot.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const MVN = process.env.MVN || (process.platform === 'win32' ? 'mvn.cmd' : 'mvn');
const SCRATCH = join(ROOT, 'backend', 'target', 'ap-0008-scratch');
const S_BACKEND = join(SCRATCH, 'backend');
const S_JSON = join(SCRATCH, 'docs', 'openapi.json');
const S_YAML = join(SCRATCH, 'docs', 'openapi.yaml');
const ORIG_JSON = readFileSync(join(ROOT, 'docs', 'openapi.json'));
const ORIG_YAML = readFileSync(join(ROOT, 'docs', 'openapi.yaml'));
const REPORTS = join(S_BACKEND, 'target', 'surefire-reports');
const API_TEST_DIR = join(ROOT, 'backend', 'src', 'test', 'java', 'com', 'example', 'vmintent', 'api');

/** The test class that reads openapi.write (OpenApiSnapshotTest, or OpenApiDocumentTest if it holds the check). */
const SNAPSHOT_CLASS = (() => {
  const f = readdirSync(API_TEST_DIR).find((n) => n.endsWith('.java')
    && /openapi\.write/.test(readFileSync(join(API_TEST_DIR, n), 'utf8')));
  return f ? basename(f, '.java') : 'OpenApiSnapshotTest';
})();
const FQCN = `com.example.vmintent.api.${SNAPSHOT_CLASS}`;

function mvn(...args) {
  // mvn.cmd needs a shell on Windows; one command string avoids Node's args-with-shell warning.
  const opts = { cwd: S_BACKEND, encoding: 'utf8', timeout: 1_700_000, maxBuffer: 256 * 1024 * 1024 };
  const r = process.platform === 'win32'
    ? spawnSync([MVN, '-B', ...args].join(' '), { ...opts, shell: true })
    : spawnSync(MVN, ['-B', ...args], opts);
  assert.ok(!r.error, `could not run ${MVN}: ${r.error?.message}`);
  let out = (r.stdout || '') + (r.stderr || '');
  for (const ext of ['.txt']) {
    const p = join(REPORTS, `${FQCN}${ext}`);
    if (existsSync(p)) out += '\n' + readFileSync(p, 'utf8');
  }
  return { status: r.status, out };
}

function report(cls) {
  const p = join(REPORTS, `TEST-${cls}.xml`);
  assert.ok(existsSync(p), `surefire report for ${cls} exists (did it run?)`);
  const xml = readFileSync(p, 'utf8');
  const suite = /<testsuite\b[^>]*>/.exec(xml)[0];
  const attr = (n) => Number(new RegExp(`\\b${n}="([\\d.,]+)"`).exec(suite)?.[1]?.replace(',', '') ?? NaN);
  return { xml, tests: attr('tests'), failures: attr('failures'), errors: attr('errors'), skipped: attr('skipped'), time: attr('time') };
}

const resetSnapshots = () => { writeFileSync(S_JSON, ORIG_JSON); writeFileSync(S_YAML, ORIG_YAML); };
const sameBytes = (file, orig) => readFileSync(file).equals(orig);

/** docs/openapi.json with one description under paths changed in place (rest of the text untouched). */
function editJsonDescription() {
  const text = ORIG_JSON.toString('utf8');
  const doc = JSON.parse(text);
  for (const ops of Object.values(doc.paths)) {
    for (const op of Object.values(ops)) {
      for (const d of [op.description, ...Object.values(op.responses || {}).map((r) => r.description)]) {
        if (typeof d !== 'string' || !d) continue;
        const needle = `"description": ${JSON.stringify(d)}`;
        const at = text.indexOf(needle);
        if (at >= 0 && text.indexOf(needle, at + 1) < 0) {
          const edited = needle.replace(/"$/, ' (hand edit)"');
          return text.slice(0, at) + edited + text.slice(at + needle.length);
        }
      }
    }
  }
  throw new Error('no unique description under paths in docs/openapi.json');
}

/** docs/openapi.yaml with one operationId value changed. */
function editYamlValue() {
  const text = ORIG_YAML.toString('utf8');
  const m = /^(\s+operationId: )(\S+?)(\r?)$/m.exec(text);
  assert.ok(m, 'docs/openapi.yaml has an operationId line');
  return { text: text.slice(0, m.index) + m[1] + m[2] + 'HandEdit' + m[3] + text.slice(m.index + m[0].length), id: m[2] };
}

before(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  const backend = join(ROOT, 'backend');
  // Entry by entry: cpSync refuses to copy a folder into its own subfolder (target/).
  for (const entry of readdirSync(backend).filter((e) => !['target', '.idea', 'node_modules'].includes(e))) {
    cpSync(join(backend, entry), join(S_BACKEND, entry), { recursive: true });
  }
  mkdirSync(join(SCRATCH, 'docs'));
  resetSnapshots();
});

after(() => rmSync(SCRATCH, { recursive: true, force: true }));

test('A (5, 7): plain mvn test passes as a whole, the snapshot test is quick and nothing in docs/ changes', { timeout: 1_800_000 }, () => {
  const r = mvn('test');
  assert.match(r.out, /BUILD SUCCESS/, 'mvn test reports BUILD SUCCESS:\n' + r.out.slice(-5000));
  assert.equal(r.status, 0, `mvn test exits 0 (exit ${r.status})`);
  for (const cls of [FQCN, 'com.example.vmintent.api.OpenApiDocumentTest', 'com.example.vmintent.workflow.ReplayTest']) {
    const s = report(cls);
    assert.ok(s.tests > 0, `${cls} ran tests (${s.tests})`);
    assert.equal(s.failures, 0, `${cls} has no failures`);
    assert.equal(s.errors, 0, `${cls} has no errors`);
    assert.equal(s.skipped, 0, `${cls} skipped nothing`);
  }
  const snap = report(FQCN);
  assert.ok(snap.time <= 30, `${SNAPSHOT_CLASS} takes no more than about 30 s (took ${snap.time} s)`);
  assert.ok(sameBytes(S_JSON, ORIG_JSON), 'plain mvn test leaves docs/openapi.json unchanged');
  assert.ok(sameBytes(S_YAML, ORIG_YAML), 'plain mvn test leaves docs/openapi.yaml unchanged');
});

test('B (4): on the clean copy, -Dopenapi.write=true passes and reproduces both committed snapshots byte for byte', { timeout: 1_200_000 }, () => {
  resetSnapshots();
  const r = mvn('test', `-Dtest=${SNAPSHOT_CLASS}`, '-Dopenapi.write=true');
  assert.equal(r.status, 0, `the write run passes (exit ${r.status}):\n${r.out.slice(-5000)}`);
  assert.ok(sameBytes(S_JSON, ORIG_JSON), 'docs/openapi.json is byte-for-byte the committed file after writing');
  assert.ok(sameBytes(S_YAML, ORIG_YAML), 'docs/openapi.yaml is byte-for-byte the committed file after writing');
});

test('C (1, 3, 5): a changed description in docs/openapi.json fails with the JSON path and the write command, and is not rewritten', { timeout: 1_200_000 }, () => {
  resetSnapshots();
  const edited = editJsonDescription();
  writeFileSync(S_JSON, edited);
  const r = mvn('test', `-Dtest=${SNAPSHOT_CLASS}`);
  assert.notEqual(r.status, 0, 'the test fails when docs/openapi.json differs');
  assert.match(r.out, /docs\/openapi\.json[^\n]*paths[^\n]*description/,
    'the message names docs/openapi.json and the differing JSON path (paths....description):\n' + r.out.slice(-5000));
  assert.doesNotMatch(r.out, /docs\/openapi\.yaml differs/, 'the unchanged YAML snapshot is not reported');
  assert.match(r.out, /mvn test[^\n]*-Dopenapi\.write=true/, 'the message gives the mvn test -Dopenapi.write=true command');
  assert.equal(readFileSync(S_JSON, 'utf8'), edited, 'without -Dopenapi.write=true the test does not rewrite docs/openapi.json');
  assert.ok(sameBytes(S_YAML, ORIG_YAML), 'without -Dopenapi.write=true the test does not rewrite docs/openapi.yaml');
});

test('D (2, 3, 5): a changed value in docs/openapi.yaml fails with the path and the write command, and is not rewritten', { timeout: 1_200_000 }, () => {
  resetSnapshots();
  const { text, id } = editYamlValue();
  writeFileSync(S_YAML, text);
  const r = mvn('test', `-Dtest=${SNAPSHOT_CLASS}`);
  assert.notEqual(r.status, 0, 'the test fails when docs/openapi.yaml differs');
  assert.match(r.out, /docs\/openapi\.yaml[^\n]*paths[^\n]*operationId/,
    'the message names docs/openapi.yaml and the differing path (paths....operationId):\n' + r.out.slice(-5000));
  assert.ok(r.out.includes(id + 'HandEdit'), 'the message shows the differing value');
  assert.doesNotMatch(r.out, /docs\/openapi\.json differs/, 'the unchanged JSON snapshot is not reported');
  assert.match(r.out, /mvn test[^\n]*-Dopenapi\.write=true/, 'the message gives the mvn test -Dopenapi.write=true command');
  assert.equal(readFileSync(S_YAML, 'utf8'), text, 'without -Dopenapi.write=true the test does not rewrite docs/openapi.yaml');
  assert.ok(sameBytes(S_JSON, ORIG_JSON), 'without -Dopenapi.write=true the test does not rewrite docs/openapi.json');
});

test('E (4): after hand edits to both files, -Dopenapi.write=true restores them byte for byte and passes', { timeout: 1_200_000 }, () => {
  writeFileSync(S_JSON, editJsonDescription());
  writeFileSync(S_YAML, editYamlValue().text);
  const r = mvn('test', `-Dtest=${SNAPSHOT_CLASS}`, '-Dopenapi.write=true');
  assert.equal(r.status, 0, `the write run passes (exit ${r.status}):\n${r.out.slice(-5000)}`);
  assert.ok(sameBytes(S_JSON, ORIG_JSON), 'docs/openapi.json is restored to the committed file');
  assert.ok(sameBytes(S_YAML, ORIG_YAML), 'docs/openapi.yaml is restored to the committed file');
  assert.match(readFileSync(S_JSON, 'utf8'), /"servers"/, 'docs/openapi.json keeps its servers block');
  assert.match(readFileSync(S_YAML, 'utf8'), /^servers:/m, 'docs/openapi.yaml keeps its servers block');
});

test('F (4): a following plain run passes and still writes nothing', { timeout: 1_200_000 }, () => {
  const r = mvn('test', `-Dtest=${SNAPSHOT_CLASS}`);
  assert.equal(r.status, 0, `the plain run passes (exit ${r.status}):\n${r.out.slice(-5000)}`);
  assert.ok(sameBytes(S_JSON, ORIG_JSON), 'docs/openapi.json unchanged');
  assert.ok(sameBytes(S_YAML, ORIG_YAML), 'docs/openapi.yaml unchanged');
});
