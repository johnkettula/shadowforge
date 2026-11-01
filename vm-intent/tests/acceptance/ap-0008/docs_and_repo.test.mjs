// AP-0008 acceptance, from the repository: the snapshot test exists where criterion 1 says and reuses the
// slim OpenApiDocumentTest context (criteria 1, 7); docs/API.md 'Checking the contract' describes the check
// and the regenerate command (criterion 8); the requirement's commits stay out of the protected areas
// (criterion 9); the committed snapshots are clean in the working tree (criteria 4-5).
//
//   node --test tests/acceptance/ap-0008/docs_and_repo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const API_TEST_DIR = 'backend/src/test/java/com/example/vmintent/api';

function snapshotTestSource() {
  const files = readdirSync(join(ROOT, API_TEST_DIR)).filter((f) => f.endsWith('.java'));
  return files.map((f) => [f, read(`${API_TEST_DIR}/${f}`)])
    .filter(([, src]) => /openapi\.write/.test(src) && /openapi\.json/.test(src) && /openapi\.yaml/.test(src));
}

test('1: a test under backend/src/test/java/com/example/vmintent/api/ compares /v3/api-docs with both snapshots', () => {
  const found = snapshotTestSource();
  assert.ok(found.length > 0, `a test in ${API_TEST_DIR} reads openapi.write, docs/openapi.json and docs/openapi.yaml`);
  const [name, src] = found[0];
  assert.match(src, /\/v3\/api-docs/, `${name} fetches /v3/api-docs`);
  assert.match(src, /servers/, `${name} handles the top-level 'servers' key`);
  assert.match(src, /@Test/, `${name} has @Test methods`);
});

test('7: the snapshot test reuses the existing slim context (no second @SpringBootTest configuration)', () => {
  const [name, src] = snapshotTestSource()[0];
  const reusesDocTest = /extends\s+OpenApiDocumentTest\b/.test(src) || name === 'OpenApiDocumentTest.java';
  assert.ok(reusesDocTest, `${name} is OpenApiDocumentTest or extends it, so Spring's context cache reuses the context`);
  if (name !== 'OpenApiDocumentTest.java') {
    for (const a of ['@SpringBootTest', '@WebMvcTest', '@MockBean', '@MockitoBean', '@TestPropertySource',
      '@ContextConfiguration', '@Import', '@ActiveProfiles', '@DirtiesContext']) {
      assert.ok(!src.includes(a), `${name} adds no ${a}, which would start another context`);
    }
  }
});

test('8: docs/API.md "Checking the contract" says mvn test compares with both snapshots and gives the regenerate command', () => {
  const md = read('docs/API.md');
  const start = md.indexOf('## Checking the contract');
  assert.ok(start >= 0, 'docs/API.md has a "## Checking the contract" section');
  const rest = md.slice(start + 3);
  const next = rest.search(/^## /m);
  const section = next < 0 ? rest : rest.slice(0, next);
  assert.match(section, /mvn test/, 'the section mentions mvn test');
  assert.match(section, /docs\/openapi\.json/, 'the section names docs/openapi.json');
  assert.match(section, /docs\/openapi\.yaml/, 'the section names docs/openapi.yaml');
  assert.match(section, /compar/i, 'the section says the generated document is compared with the snapshots');
  const cmd = /mvn\s+test\b[^\n`]*-Dopenapi\.write=true[^\n`]*/.exec(section);
  assert.ok(cmd, 'the section gives an mvn test command with -Dopenapi.write=true');
  assert.match(section, /backend\//, 'the section says to run it from backend/');
  // The command, as written, must select the snapshot test.
  const testArg = /-Dtest=(\S+)/.exec(cmd[0]);
  if (testArg) {
    const cls = testArg[1].split('#')[0];
    assert.ok(existsSync(join(ROOT, API_TEST_DIR, `${cls}.java`)), `-Dtest=${cls} names an existing test class`);
  }
});

test('8: the "Snapshot in the repo" row or nearby text points to the check', () => {
  const md = read('docs/API.md');
  const row = md.split('\n').find((l) => l.includes('Snapshot in the repo'));
  assert.ok(row, 'docs/API.md still has the "Snapshot in the repo" row');
  assert.match(row, /openapi\.yaml/);
  assert.match(row, /openapi\.json/);
});

// Only commits made for AP-0008 count (subject starting "AP-0008:"), not the whole branch: these tests are
// re-run on every later cycle's branch, and later requirements may legitimately change these areas.
// (Changed on 2026-11-01 by a person; the first version used every commit on the branch.)
function requirementCommits() {
  return git('log', '--format=%H', '--no-merges', '--grep=^AP-0008:').split('\n').filter(Boolean);
}

test('9: no commit for the requirement touches the protected paths, adds Security/Auth files, or changes Temporal annotations', () => {
  const shas = requirementCommits();
  assert.ok(shas.length > 0, 'found the requirement commits');
  const protectedPath = [
    /backend\/src\/main\/java\/com\/example\/vmintent\/workflow\//,
    /backend\/src\/main\/java\/com\/example\/vmintent\/security\//,
    /backend\/src\/main\/resources\/catalog\//,
    /backend\/src\/main\/resources\/application[^/]*\.(ya?ml|properties)$/,
  ];
  const annotation = /^[+-](?![+-]).*@(WorkflowInterface|WorkflowMethod|SignalMethod|QueryMethod|UpdateMethod|UpdateValidatorMethod|ActivityInterface|ActivityMethod)\b/m;
  for (const sha of shas) {
    const changes = git('show', '--name-status', '--format=', '--no-renames', sha).split('\n').filter(Boolean)
      .map((l) => l.split('\t'));
    for (const [st, path] of changes) {
      for (const re of protectedPath) assert.doesNotMatch(path, re, `${sha.slice(0, 7)} touches protected ${path}`);
      if (st === 'A') {
        const base = path.split('/').pop();
        assert.doesNotMatch(base, /Security|Auth/, `${sha.slice(0, 7)} adds ${path}`);
      }
    }
    const diff = git('show', '--format=', '-U0', sha, '--', '*.java');
    assert.doesNotMatch(diff, annotation, `${sha.slice(0, 7)} adds or removes a Temporal annotation`);
  }
});

test('4-5: the committed snapshots have no uncommitted change in the working tree', () => {
  assert.equal(git('status', '--porcelain', '--', 'docs/openapi.json', 'docs/openapi.yaml').trim(), '',
    'docs/openapi.json and docs/openapi.yaml are clean');
});
