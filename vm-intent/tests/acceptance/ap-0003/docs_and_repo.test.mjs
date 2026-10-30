// AP-0003 acceptance: the OpenAPI snapshots, docs/API.md, the contract test and the backend unit test
// match the change, and the workflow code is untouched. Covers criteria 6 (snapshots), 7, 8 and 9.
//
//   VMINTENT_API=http://127.0.0.1:19030 node --test tests/acceptance/ap-0003/docs_and_repo.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19030').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let live;

before(async () => {
  const res = await fetch(BASE + '/v3/api-docs', { headers: AUTH });
  assert.equal(res.status, 200, 'GET /v3/api-docs');
  live = await res.json();
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

// ---- Criterion 6: docs/openapi.json and docs/openapi.yaml ----
test('6: docs/openapi.json matches the live document (apart from servers)', () => {
  const snap = JSON.parse(read('docs/openapi.json'));
  const d = firstDiff(withoutServers(live), withoutServers(snap));
  assert.equal(d, null, 'docs/openapi.json differs from /v3/api-docs at ' + d);
});

test('6: docs/openapi.json documents 409 ApiError on clarifyRequest and cancelRequest', () => {
  const snap = JSON.parse(read('docs/openapi.json'));
  for (const [p, op] of [['/api/v2/requests/{id}/clarify', 'clarifyRequest'], ['/api/v2/requests/{id}/cancel', 'cancelRequest']]) {
    const o = snap.paths[p]?.post;
    assert.ok(o, `openapi.json has POST ${p}`);
    assert.equal(o.operationId, op);
    for (const c of ['204', '403', '404', '409']) assert.ok(o.responses[c], `openapi.json ${op} documents ${c}`);
    const refs = Object.values(o.responses['409'].content || {}).map((m) => m.schema?.$ref);
    assert.ok(refs.length > 0 && refs.every((r) => r === '#/components/schemas/ApiError'), `openapi.json ${op} 409 uses ApiError`);
  }
});

/** The YAML block of one path's POST operation, from "  <path>:" to the next path. */
function yamlPathBlock(text, path) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l === `  ${path}:` || l === `  "${path}":`);
  assert.ok(start >= 0, `openapi.yaml has ${path}`);
  const out = [];
  for (let i = start + 1; i < lines.length && !/^ {0,2}\S/.test(lines[i]); i++) out.push(lines[i]);
  return out;
}

/** Response code -> lines of that response, in the POST operation of the block. */
function yamlResponses(block) {
  const res = new Map();
  let inPost = false; let inResponses = false; let code = null;
  for (const l of block) {
    if (!l.trim()) continue;
    const indent = l.length - l.trimStart().length;
    if (indent === 4) { inPost = l.trim() === 'post:'; inResponses = false; code = null; continue; }
    if (!inPost) continue;
    if (indent === 6) { inResponses = l.trim() === 'responses:'; code = null; continue; }
    if (inResponses && indent === 8) {
      const m = /^"?(\d{3}|default)"?:$/.exec(l.trim());
      code = m ? m[1] : null;
      if (code) res.set(code, []);
      continue;
    }
    if (inResponses && code && indent > 8) res.get(code).push(l.trim());
  }
  return res;
}

test('6: docs/openapi.yaml documents 409 ApiError on clarifyRequest and cancelRequest, matching the live codes', () => {
  const text = read('docs/openapi.yaml');
  for (const [p, op] of [['/api/v2/requests/{id}/clarify', 'clarifyRequest'], ['/api/v2/requests/{id}/cancel', 'cancelRequest']]) {
    const block = yamlPathBlock(text, p);
    assert.ok(block.some((l) => new RegExp(`^\\s*operationId:\\s*"?${op}"?$`).test(l)), `openapi.yaml ${p} is ${op}`);
    const res = yamlResponses(block);
    assert.deepEqual([...res.keys()].sort(), Object.keys(live.paths[p].post.responses).sort(), `openapi.yaml ${op} response codes`);
    for (const c of ['403', '404', '409']) {
      assert.ok(res.get(c)?.some((l) => /\$ref:\s*"?#\/components\/schemas\/ApiError"?/.test(l)), `openapi.yaml ${op} ${c} uses ApiError`);
    }
  }
});

// ---- Criterion 7: docs/API.md ----
function operationRow(id) {
  const md = read('docs/API.md');
  const line = md.split(/\r?\n/).find((l) => new RegExp('^\\|\\s*`' + id + '`\\s*\\|').test(l));
  assert.ok(line, `docs/API.md has a row for ${id}`);
  return line;
}

test('7: API.md clarifyRequest and cancelRequest rows say an already finished request gives 409', () => {
  for (const id of ['clarifyRequest', 'cancelRequest']) {
    const row = operationRow(id);
    assert.match(row, /409/, `${id} row mentions 409`);
    assert.match(row, /already finished/i, `${id} row says "already finished"`);
  }
  // confirmRequest's row still documents its 409.
  assert.match(operationRow('confirmRequest'), /409/);
});

test('7: the "It runs N checks" count equals the number of checks in the contract test', () => {
  const md = read('docs/API.md');
  const section = md.split(/^## Checking the contract\s*$/m)[1]?.split(/^## /m)[0];
  assert.ok(section, 'docs/API.md has a "Checking the contract" section');
  const m = /It runs (\d+) checks/.exec(section);
  assert.ok(m, '"It runs N checks" is in the section');
  const py = read('tests/api_contract_test.py');
  // Every check is one call(...) to the validating helper (excluding its definition).
  const calls = py.split(/\r?\n/).filter((l) => /(^|[\s=(])call\(/.test(l) && !/^\s*def\s+call\(/.test(l) && !/^\s*#/.test(l)).length;
  assert.equal(Number(m[1]), calls, `API.md says ${m[1]} checks; tests/api_contract_test.py makes ${calls}`);
});

// ---- Criterion 8: tests/api_contract_test.py ----
test('8: the contract test adds the three new checks, on the cancelled request and an unknown ID', () => {
  const py = read('tests/api_contract_test.py');
  const named = (name) => {
    const i = py.indexOf(`name="${name}"`);
    assert.ok(i >= 0, `contract test has the check "${name}"`);
    const start = py.lastIndexOf('call(', i);
    return { at: start, text: py.slice(start, i) };
  };
  const cancel409 = named('cancelRequest: already finished -> 409');
  assert.match(cancel409.text, /"POST"\s*,\s*f"\/api\/v2\/requests\/\{r\['requestId'\]\}\/cancel"\s*,\s*409/);
  const clarify409 = named('clarifyRequest: already finished -> 409');
  assert.match(clarify409.text, /"POST"\s*,\s*f"\/api\/v2\/requests\/\{r\['requestId'\]\}\/clarify"\s*,\s*409/);
  const unknown = named('cancelRequest: unknown ID -> 404');
  assert.match(unknown.text, /"POST"\s*,\s*"\/api\/v2\/requests\/intent-does-not-exist\/cancel"\s*,\s*404/);

  // The two 409 checks run on the cancelled request: after it was waited to CANCELLED, before the next createRequest.
  const cancelled = py.indexOf('wait_request(r["requestId"], {"CANCELLED"})');
  assert.ok(cancelled >= 0, 'the contract test waits for the request to be CANCELLED');
  const nextCreate = py.indexOf('call("POST", "/api/v2/requests"', cancelled);
  for (const c of [cancel409, clarify409]) assert.ok(c.at > cancelled && (nextCreate < 0 || c.at < nextCreate), 'check runs on the cancelled request');

  // Each call is validated against the live document.
  assert.match(py, /api\.validate_response\(/, 'call() validates each response against the live OpenAPI document');
  assert.match(py, /\/v3\/api-docs/, 'the contract test loads the live document');
});

// ---- Criterion 9: workflow untouched; unit test for the controller mapping ----
test('9: IntentWorkflow and IntentWorkflowImpl are not changed by AP-0003', () => {
  const files = ['backend/src/main/java/com/example/vmintent/workflow/IntentWorkflow.java',
    'backend/src/main/java/com/example/vmintent/workflow/IntentWorkflowImpl.java'];
  const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  const subjects = git('log', '--format=%s', '--', ...files).split(/\r?\n/).filter(Boolean);
  assert.deepEqual(subjects.filter((s) => /AP-0003/.test(s)), [], 'no AP-0003 commit touches the workflow');
  const dirty = git('status', '--porcelain', '--', ...files).trim();
  assert.equal(dirty, '', 'no uncommitted changes to the workflow');
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

test('9: a backend unit test covers 409 for a closed workflow and 404 for a missing one, for clarify and cancel', () => {
  const tests = javaFiles(join(ROOT, 'backend', 'src', 'test', 'java')).map((p) => ({ p, src: readFileSync(p, 'utf8') }))
    .filter(({ src }) => /controller\.(cancel|clarify)\(/.test(src) || /\/(cancel|clarify)["']/.test(src));
  assert.ok(tests.length > 0, 'a backend unit test calls the controller\'s clarify and cancel');
  const src = tests.map((t) => t.src).join('\n');
  assert.match(src, /controller\.cancel\(|\/cancel/, 'unit test calls cancel');
  assert.match(src, /controller\.clarify\(|\/clarify/, 'unit test calls clarify');
  assert.match(src, /CONFLICT|409/, 'unit test expects 409 (CONFLICT)');
  assert.match(src, /WorkflowNotFoundException|NOT_FOUND|404/, 'unit test expects 404 (not found) for an unknown ID');
  // Unknown-ID checks for both operations.
  assert.match(src, /cancel\("intent-does-not-exist"|cancel\([^)]*does-not-exist/, 'unknown ID checked for cancel');
  assert.match(src, /clarify\("intent-does-not-exist"|clarify\([^)]*does-not-exist/, 'unknown ID checked for clarify');
});
