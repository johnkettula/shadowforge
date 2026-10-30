// AP-0004 acceptance: the contract test has the new catalog and compliance checks, docs/API.md and the
// OpenAPI snapshots match the change and the live document, a backend unit test covers the
// listClassifications keys, and nothing changed in the workflows, security or seeded catalog YAML.
// Covers criteria 3 (the script), 6, 7 (snapshots and unit test) and 8 (files untouched).
//
//   VMINTENT_API=http://127.0.0.1:19040 node --test tests/acceptance/ap-0004/docs_and_repo.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19040').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });

let live;
let liveYaml;

before(async () => {
  const res = await fetch(BASE + '/v3/api-docs', { headers: AUTH });
  assert.equal(res.status, 200, 'GET /v3/api-docs');
  live = await res.json();
  const y = await fetch(BASE + '/v3/api-docs.yaml', { headers: AUTH });
  liveYaml = y.status === 200 ? await y.text() : null;
});

const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
const withoutServers = (d) => { const c = structuredClone(d); delete c.servers; return c; };

function firstDiff(a, b, path = '') {
  if (JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDiff(a[k], b[k], `${path}/${k}`);
      if (d) return d;
    }
  }
  return `${path}: snapshot ${JSON.stringify(b)?.slice(0, 120)} vs live ${JSON.stringify(a)?.slice(0, 120)}`;
}

/** The contract test's checks: each top-level or indented statement that calls call(...). */
function contractCalls() {
  return read('tests/api_contract_test.py').split(/\r?\n/).filter((l) => /^\s*(\w+\s*=\s*)?call\(/.test(l));
}

/** One call(...) statement, with its continuation lines, found by a regex on its first line. */
function contractCall(re) {
  const lines = read('tests/api_contract_test.py').split(/\r?\n/);
  const i = lines.findIndex((l) => /^\s*(\w+\s*=\s*)?call\(/.test(l) && re.test(l));
  if (i < 0) return null;
  let out = lines[i];
  for (let j = i + 1; j < lines.length && /^\s{4,}\S/.test(lines[j]) && !/^\s*(\w+\s*=\s*)?call\(/.test(lines[j]); j++) out += '\n' + lines[j];
  return out;
}

// ---- Criterion 3: the contract test has the new checks ----
const NEW_CHECKS = [
  ['listDefinitions 200 with Provisioning web-server', /"GET",\s*"\/api\/v2\/definitions",\s*200/, [/web-server/, /Provisioning/]],
  ['getDefinition web-server 200', /"GET",\s*"\/api\/v2\/definitions\/Provisioning\/web-server",\s*200/, []],
  ['getDefinition does-not-exist 404 {error}', /"GET",\s*"\/api\/v2\/definitions\/Provisioning\/does-not-exist",\s*404/, [/error/]],
  ['validateDefinition JSON {yaml} 200 ok true', /"POST",\s*"\/api\/v2\/definitions\/validate",\s*200/, [/"yaml"/, /ok/]],
  ['listClassifications 200', /"GET",\s*"\/api\/v2\/classifications",\s*200/, []],
  ['listRuns 200', /"GET",\s*"\/api\/v2\/runs(\?[^"]*)?",\s*200/, []],
  ['getRun unknown 404', /"GET",\s*"\/api\/v2\/runs\/[\w-]*does-not-exist[\w-]*",\s*404/, []],
  ['startRun unknown definition 404', /"POST",\s*"\/api\/v2\/runs",\s*404,\s*\{\s*"definition":\s*"does-not-exist"\s*\}/, []],
  ['startRun {} 400', /"POST",\s*"\/api\/v2\/runs",\s*400,\s*\{\s*\}/, []],
  ['listDecisions 200', /"GET",\s*"\/api\/v2\/compliance\/decisions(\?[^"]*)?",\s*200/, []],
  ['listArchive 200', /"GET",\s*"\/api\/v2\/compliance\/archive(\?[^"]*)?",\s*200/, []],
  ['downloadArchivedHistory unknown 404', /"GET",\s*"\/api\/v2\/compliance\/archive\/[^"/]+\/[^"/]+",\s*404/, []],
  ['replayWorkflow {} 400', /"POST",\s*"\/api\/v2\/compliance\/replays",\s*400,\s*\{\s*\}/, []],
];

for (const [label, re, extra] of NEW_CHECKS) {
  test(`3: api_contract_test.py checks ${label}`, () => {
    const stmt = contractCall(re);
    assert.ok(stmt, `tests/api_contract_test.py has a call(...) matching ${re}`);
    for (const e of extra) assert.match(stmt, e, `the ${label} check looks at ${e}`);
  });
}

test('3: every call(...) in the contract test validates against the live document', () => {
  const src = read('tests/api_contract_test.py');
  assert.match(src, /doc\s*=\s*HTTP\.get\(BASE \+ "\/v3\/api-docs"/, 'the document is fetched live');
  const fn = src.slice(src.indexOf('def call('), src.indexOf('def wait_request('));
  // openapi-core's validate_response finds the operation from the request (method, path) and checks the
  // status and body against it; the script has used only this since before AP-0004.
  assert.match(fn, /api\.validate_response\(\s*RequestsOpenAPIRequest\(resp\.request\)/, 'call() validates each response against the document');  assert.match(fn, /resp\.status_code\s*!=\s*expect|expect\s*!=\s*resp\.status_code/, 'call() checks the status');
});

test('4 (script): the existing checks are all still in the contract test', () => {
  const src = read('tests/api_contract_test.py');
  for (const name of ['clarifyRequest', 'cancelRequest', 'confirmRequest', 'renewVm', 'resizeVm', 'powerVm', 'snapshotVm',
    'decommissionVm', 'createBatch', 'getBatch', 'runInventoryCheck', 'listInventoryChecks', 'createLegacyVm',
    'getVsphereStatus', 'listVsphereTemplates', 'listVsphereBlueprints', 'getVsphereBlueprint', 'listVms', 'getStats',
    'getAuditTrail', 'listRequests', 'interpret']) {
    assert.ok(src.includes(name), `contract test still checks ${name}`);
  }
  assert.ok(contractCalls().length >= 42 + NEW_CHECKS.length, `at least ${42 + NEW_CHECKS.length} checks (has ${contractCalls().length})`);
});

// ---- Criterion 6: docs/API.md ----
test('6: "It runs N checks" matches the contract test and mentions the catalog and compliance endpoints', () => {
  const md = read('docs/API.md');
  const section = md.slice(md.indexOf('## Checking the contract'));
  assert.ok(section.length > 30, 'docs/API.md has "Checking the contract"');
  const m = /It runs (\d+) checks([\s\S]*?)(?:\.\s|\n\n)/.exec(section);
  assert.ok(m, 'the section has "It runs N checks"');
  assert.equal(Number(m[1]), contractCalls().length, `documented count ${m[1]} vs ${contractCalls().length} call(...) statements in the contract test`);
  const sentence = section.slice(m.index, section.indexOf('\n\n', m.index));
  assert.match(sentence, /catalog/i, 'the sentence mentions the catalog endpoints');
  assert.match(sentence, /compliance/i, 'the sentence mentions the compliance endpoints');
});

test('6: the listClassifications row describes the default code plus the list', () => {
  const row = read('docs/API.md').split(/\r?\n/).find((l) => /^\|\s*`listClassifications`\s*\|/.test(l));
  assert.ok(row, 'the Operations table has a listClassifications row');
  assert.match(row, /GET \/api\/v2\/classifications/);
  const desc = row.split('|').slice(3).join('|');
  assert.match(desc, /default/, 'the description mentions default');
  assert.match(desc, /classifications/, 'the description mentions the classifications list');
  for (const k of ['code', 'label', 'retentionYears']) assert.match(desc, new RegExp(k), `the description mentions ${k}`);
});

// ---- Criterion 7: snapshots and unit test ----
test('7: docs/openapi.json matches the live document (apart from servers)', () => {
  const snap = JSON.parse(read('docs/openapi.json'));
  const d = firstDiff(withoutServers(live), withoutServers(snap));
  assert.equal(d, null, 'docs/openapi.json differs from /v3/api-docs at ' + d);
});

test('7: docs/openapi.yaml matches the live document', () => {
  const snap = read('docs/openapi.yaml').replace(/\r\n/g, '\n');
  if (liveYaml !== null) {
    // Same text as the server's /v3/api-docs.yaml, once the servers block (the address) is left out.
    const strip = (t) => t.replace(/\r\n/g, '\n').replace(/^servers:\n(?:[ -].*\n)*/m, '').trimEnd();
    const a = strip(liveYaml).split('\n');
    const b = strip(snap).split('\n');
    const i = a.findIndex((l, n) => l !== b[n]);
    assert.ok(i < 0 && a.length === b.length,
      `docs/openapi.yaml differs from /v3/api-docs.yaml at line ${i + 1}: live ${JSON.stringify(a[i])} vs snapshot ${JSON.stringify(b[i])}`);
  }
  // Every live operation, with its response codes, is in the YAML snapshot.
  const ids = [...snap.matchAll(/^\s+operationId:\s*(\S+)\s*$/gm)].map((m) => m[1]).sort();
  const liveIds = Object.values(live.paths).flatMap((p) => Object.values(p).map((o) => o.operationId)).sort();
  assert.deepEqual(ids, liveIds, 'the YAML snapshot has the live operations');
  const schemas = snap.slice(snap.search(/^components:/m));
  for (const name of Object.keys(live.components.schemas)) {
    assert.match(schemas, new RegExp(`^    ${name}:\\s*$`, 'm'), `the YAML snapshot has schema ${name}`);
  }
  const op = snap.slice(snap.indexOf('operationId: listClassifications'));
  assert.match(op.slice(0, 400), /"200":[\s\S]*\$ref: "?#\/components\/schemas\/ClassificationsResponse"?/,
    'YAML listClassifications 200 refers to ClassificationsResponse');
});

function javaFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...javaFiles(p));
    else if (name.endsWith('.java')) out.push(p);
  }
  return out;
}

test('7: a backend unit test checks listClassifications serializes with "default" and "classifications"', () => {
  const tests = javaFiles(join(ROOT, 'backend', 'src', 'test', 'java')).map((p) => readFileSync(p, 'utf8'))
    .filter((src) => /classifications\(\)|ClassificationsResponse|\/api\/v2\/classifications/.test(src));
  assert.ok(tests.length > 0, 'a backend unit test exercises listClassifications');
  const src = tests.join('\n');
  assert.match(src, /writeValueAsString|ObjectMapper|jsonPath|MockMvc/, 'the unit test serializes the response to JSON');
  assert.match(src, /\\?"default\\?"/, 'the unit test checks the "default" key');
  assert.match(src, /\\?"classifications\\?"/, 'the unit test checks the "classifications" key');
});

// ---- Criterion 8: nothing changed in the workflows, security or seeded catalog YAML ----
function changedFiles() {
  let base;
  for (const ref of ['main', 'origin/main']) {
    try { base = git('merge-base', 'HEAD', ref).trim(); break; } catch { /* try the next */ }
  }
  assert.ok(base, 'found the main branch to compare with');
  const committed = git('diff', '--name-only', `${base}...HEAD`).split(/\r?\n/);
  const uncommitted = git('status', '--porcelain').split(/\r?\n/).map((l) => l.slice(3));
  return [...committed, ...uncommitted].filter(Boolean).map((f) => f.replace(/^vm-intent\//, ''));
}

test('8: no changes to workflow code, security / sign-in configuration or the seeded catalog YAML', () => {
  const changed = changedFiles();
  const bad = changed.filter((f) =>
    /^backend\/src\/main\/java\/com\/example\/vmintent\/workflow\//.test(f)
    || /^backend\/src\/main\/java\/com\/example\/vmintent\/security\//.test(f)
    || /^backend\/src\/main\/resources\/catalog\//.test(f)
    || /Security|Auth/i.test(f.split('/').pop())
    || /^backend\/src\/main\/resources\/application[^/]*\.(ya?ml|properties)$/.test(f));
  assert.deepEqual(bad, [], 'files that must not change: ' + bad.join(', '));
});

test('8: workflow interfaces in the code are unchanged (no @WorkflowInterface / @WorkflowMethod edits)', () => {
  const base = (() => { for (const r of ['main', 'origin/main']) { try { return git('merge-base', 'HEAD', r).trim(); } catch { /* next */ } } })();
  const diff = git('diff', `${base}...HEAD`, '--', 'backend/src/main');
  assert.doesNotMatch(diff, /^[+-].*@(WorkflowInterface|WorkflowMethod|SignalMethod|QueryMethod|UpdateMethod|ActivityInterface)/m,
    'no workflow or activity interface annotations added or removed');
});
