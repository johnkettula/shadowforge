// AP-0006 acceptance, on the repository: the blueprint serialization unit test (criterion 3), the
// OpenApiDocumentTest class and that its check is real (criteria 4-5), the docs/API.md sentence
// (criterion 8), and that no AP-0006 commit touches workflow, security, catalog or application config
// files, adds Security/Auth files, or adds/removes Temporal annotations (criterion 9).
//
//   node --test tests/acceptance/ap-0006/docs_and_repo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const TEST_DIR = 'backend/src/test/java/com/example/vmintent/api';
const OADT = `${TEST_DIR}/OpenApiDocumentTest.java`;

/** Java source with comments removed, so assertions can't be satisfied by a comment. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"])\/\/.*$/gm, '$1');

function javaFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...javaFiles(p));
    else if (name.endsWith('.java')) out.push(p);
  }
  return out;
}

// ---- Criterion 3 ----
test('3: a backend unit test checks the blueprint response has exactly blueprint, releasedVersions, inputs', () => {
  const tests = javaFiles(join(ROOT, 'backend', 'src', 'test', 'java')).map((p) => [p, readFileSync(p, 'utf8')])
    .filter(([, src]) => /VsphereBlueprintResponse|\.blueprint\("/.test(code(src)) && /releasedVersions/.test(code(src)));
  assert.ok(tests.length > 0, 'a backend test exercises the blueprint response');
  const src = tests.map(([, s]) => code(s)).join('\n');
  assert.match(src, /ObjectMapper|writeValueAsString|valueToTree|jsonPath/, 'the test serializes the response to JSON');
  assert.match(src, /VsphereTestKit|MockVcfa|new\s+VsphereController\.VsphereBlueprintResponse\(/,
    'the test uses VsphereTestKit / MockVcfa or serializes the record directly');
  // Exactly these top-level keys, in a single assertion (a list or a full JSON string).
  const exact = /List\.of\(\s*"blueprint"\s*,\s*"releasedVersions"\s*,\s*"inputs"\s*\)|Set\.of\(\s*"blueprint"\s*,\s*"releasedVersions"\s*,\s*"inputs"\s*\)|\{\\"blueprint\\":[^;]*\\"releasedVersions\\":[^;]*\\"inputs\\":/;
  assert.match(src, exact, 'the test asserts the exact set of top-level keys');
  assert.match(src, /assert\w*\([^;]*"(id|name)"[^;]*\)|\\"id\\":/, 'the test checks the nested blueprint fields');
  // inputs is the 'properties' object when present, else the whole schema.
  assert.match(src, /"properties"/, 'the test covers the inputs-schema-has-properties case');
  assert.match(src, /\{\\"type\\":\\"object\\"\}|without[^\n]*properties/i, 'the test covers a schema without properties');
});

test('3: the controller still returns schema.properties when present, else the whole schema', () => {
  const src = code(read('backend/src/main/java/com/example/vmintent/api/VsphereController.java'));
  assert.match(src, /schema\.has\("properties"\)\s*\?\s*schema\.get\("properties"\)\s*:\s*schema/, 'inputs logic unchanged');
  assert.match(src, /public\s+VsphereBlueprintResponse\s+blueprint\(/, 'blueprint() returns the named record');
  assert.doesNotMatch(src, /public\s+Map<String,\s*Object>\s+blueprint\(/, 'blueprint() no longer returns Map<String,Object>');
});

// ---- Criteria 4-5 ----
test('4: OpenApiDocumentTest exists in the api test package and builds a context with springdoc and OpenApiConfig', () => {
  assert.ok(existsSync(join(ROOT, OADT)), `${OADT} exists`);
  const raw = read(OADT);
  const src = code(raw);
  assert.match(src, /package\s+com\.example\.vmintent\.api;/, 'in package com.example.vmintent.api');
  assert.match(src, /class\s+OpenApiDocumentTest\b/);
  assert.match(src, /@(WebMvcTest|SpringBootTest)/, 'builds a Spring context');
  assert.match(src, /OpenApiConfig/, 'includes the existing OpenApiConfig');
  assert.match(src, /springdoc/i, 'includes springdoc');
  assert.match(src, /"\/v3\/api-docs"/, 'fetches /v3/api-docs');
  assert.match(src, /@Test\b/, 'has a @Test method');
  assert.doesNotMatch(src, /@Disabled|@Tag\(|assumeTrue|assumeFalse/, 'not disabled, tagged out or skipped by assumption');
  for (const id of ['getVsphereBlueprint', 'listClassifications', 'getVsphereStatus']) {
    assert.match(src, new RegExp(`"${id}"`), `asserts the document has ${id}`);
  }
});

test('4: every allow-list entry has a comment giving its reason', () => {
  const raw = read(OADT);
  const start = raw.search(/\bALLOWED\s*=/);
  assert.ok(start > 0, 'the test has an ALLOWED allow-list');
  const block = raw.slice(start, raw.indexOf(';', start));
  const entries = [...block.matchAll(/"(\w+) (2\d\d)"/g)];
  let prev = 0;
  for (const m of entries) {
    const between = block.slice(prev, m.index);
    assert.match(between, /\/\/\s*\S/, `allow-list entry "${m[1]} ${m[2]}" has a comment before it`);
    prev = m.index + m[0].length;
  }
});

test('5: OpenApiDocumentTest walks every path, operation and 2xx response, and names operationId and status on failure', () => {
  const src = code(read(OADT));
  assert.match(src, /path\("paths"\)|get\("paths"\)|getPaths\(\)/, 'reads all of "paths"');
  assert.match(src, /fields\(\)|forEach|for\s*\(/, 'iterates rather than looking up a fixed list');
  assert.match(src, /operationId/, 'reads each operationId');
  assert.match(src, /"responses"|getResponses\(\)/, 'reads each responses map');
  assert.match(src, /startsWith\("2"\)|matches\("2\\\\d\\\\d"\)|charAt\(0\)\s*==\s*'2'/, 'selects every 2xx response');
  assert.match(src, /additionalProperties/, 'checks for inline additionalProperties');
  assert.match(src, /\$ref/, 'treats $ref as named');
  assert.match(src, /"properties"/, 'flags inline objects without properties');
  // The failure message is built from the operationId and the status code.
  assert.match(src, /(id|operationId)\s*\+\s*" "\s*\+\s*\w+\.getKey\(\)|String\.format\([^)]*operationId/, 'the failure key joins operationId and status code');
  assert.match(src, /assert\w*\(\s*broken\.isEmpty\(\)[^;]*String\.join\([^;]*broken/, 'the failure message lists the broken operationId/status entries');
  // No hard-coded list of operations to check (the three required ids are a separate presence check).
  const lists = [...src.matchAll(/List\.of\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(lists.every((l) => (l.match(/"/g) || []).length <= 6), 'no long hard-coded operation list drives the check');
});

// ---- Criterion 8 ----
test('8: docs/API.md "Checking the contract" says mvn test runs OpenApiDocumentTest and to return named records', () => {
  const md = read('docs/API.md');
  const at = md.indexOf('## Checking the contract');
  assert.ok(at >= 0, 'docs/API.md has "## Checking the contract"');
  const next = md.indexOf('\n## ', at + 5);
  // Whitespace (including line wraps) collapsed to single spaces.
  const section = md.slice(at, next < 0 ? undefined : next).replace(/\s+/g, ' ');
  assert.match(section, /mvn test/, 'mentions mvn test');
  assert.match(section, /OpenApiDocumentTest/, 'mentions OpenApiDocumentTest');
  assert.match(section, /free-form map/i, 'says it fails on a free-form map');
  assert.match(section, /2xx/, 'about 2xx responses');
  assert.match(section, /fail/i, 'says it fails the build');
  assert.match(section, /named record/i, 'says to return named record types');
  assert.match(section, /Map<String,\s*Object>/, 'mentions Map<String,Object>');
});

// ---- Criterion 9 ----
function ap0006Commits() {
  let base;
  for (const ref of ['main', 'origin/main']) {
    try { base = git('merge-base', 'HEAD', ref).trim(); break; } catch { /* next */ }
  }
  const range = base ? git('rev-list', `${base}..HEAD`).split(/\r?\n/).filter(Boolean) : [];
  const tagged = git('log', '--format=%H', '--grep=^AP-0006', 'HEAD').split(/\r?\n/).filter(Boolean);
  const all = [...new Set([...range, ...tagged])];
  assert.ok(all.length > 0, 'found the AP-0006 commits');
  return all;
}

test('9: no AP-0006 commit touches workflow, security, catalog or application*.yml files, or adds Security/Auth files', () => {
  const bad = [];
  for (const c of ap0006Commits()) {
    const lines = git('show', '--name-status', '--format=', c).split(/\r?\n/).filter(Boolean);
    for (const l of lines) {
      const [status, ...paths] = l.split('\t');
      for (const full of paths) {
        const f = full.replace(/^vm-intent\//, '');
        const name = f.split('/').pop();
        if (/^backend\/src\/main\/java\/com\/example\/vmintent\/(workflow|security)\//.test(f)
          || /^backend\/src\/main\/resources\/catalog\//.test(f)
          || /^backend\/src\/main\/resources\/application[^/]*\.ya?ml$/.test(f)) bad.push(`${c.slice(0, 7)} ${status} ${f}`);
        if (/^[AC]/.test(status) && /Security|Auth/.test(name)) bad.push(`${c.slice(0, 7)} adds ${f}`);
        if (/^R/.test(status) && full === paths[1] && /Security|Auth/.test(name)) bad.push(`${c.slice(0, 7)} renames to ${f}`);
      }
    }
  }
  assert.deepEqual(bad, [], 'forbidden changes: ' + bad.join(', '));
});

test('9: no AP-0006 commit adds or removes Temporal workflow, signal, query, update or activity annotations', () => {
  const re = /^[+-](?![+-]).*@(WorkflowInterface|WorkflowMethod|SignalMethod|QueryMethod|UpdateMethod|UpdateValidatorMethod|ActivityInterface|ActivityMethod)\b/m;
  for (const c of ap0006Commits()) {
    const diff = git('show', '--format=', c, '--', '*.java');
    const m = re.exec(diff);
    assert.equal(m, null, `commit ${c.slice(0, 7)} changes a Temporal annotation: ${m?.[0]}`);
  }
});
