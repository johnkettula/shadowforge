// AP-0016 acceptance, repository half: ArmClient gets a non-blocking path (begin / operation) with a per-call time
// budget under 15 s, 409 becomes CloudBusy, MockArm/ArmClientTest cover it, docs/AZURE.md describes it, and no
// AP-0016 commit touches AzureProvider, the workflow/activity interfaces, REST controllers, docs/openapi.* or deploy/.
// Covers criteria 1-9 and the commit part of 10 by reading files and git history. `mvn test` itself (criterion 9)
// is run by the pipeline's build gate, not here; this file checks that the tests it runs exist and say the right thing.
//
//   node --test tests/acceptance/ap-0016/repo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const PKG = join('com', 'example', 'vmintent', 'provider', 'azure');
const MAIN = join(ROOT, 'backend', 'src', 'main', 'java', PKG);
const TEST = join(ROOT, 'backend', 'src', 'test', 'java', PKG);
const TEST_ROOT = join(ROOT, 'backend', 'src', 'test');
const DOC = join(ROOT, 'docs', 'AZURE.md');
const ARM_TEST_REL = 'backend/src/test/java/com/example/vmintent/provider/azure/ArmClientTest.java';

const read = (p) => readFileSync(p, 'utf8');
const git = (args) => execFileSync('git', args,
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

/** Java source without comments (string literals kept). */
function noComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"])\/\/.*$/gm, '$1');
}

/** The body of the first method whose signature matches re (balanced braces), or null. */
function methodBody(src, re) {
  const m = re.exec(src);
  if (!m) return null;
  const i = src.indexOf('{', m.index + m[0].length - 1);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(i + 1, j);
  }
  return null;
}

/** name -> body of every @Test method in a JUnit source. */
function testMethods(src) {
  const out = new Map();
  for (const m of src.matchAll(/@Test\b[\s\S]*?\bvoid\s+(\w+)\s*\(/g)) {
    const body = methodBody(src.slice(m.index), /\bvoid\s+\w+\s*\([^)]*\)[^{]*\{/);
    if (body !== null) out.set(m[1], body);
  }
  return out;
}

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const seconds = (expr) => {
  const m = /Duration\.of(Millis|Seconds|Minutes)\(\s*(\d+)\s*\)/.exec(expr || '');
  if (!m) return NaN;
  return Number(m[2]) * { Millis: 0.001, Seconds: 1, Minutes: 60 }[m[1]];
};

const arm = () => noComments(read(join(MAIN, 'ArmClient.java')));
const armTest = () => noComments(read(join(TEST, 'ArmClientTest.java')));
const mock = () => noComments(read(join(TEST, 'MockArm.java')));
const tests = () => [...testMethods(armTest()).entries()];
const someTest = (res, what) => {
  const hit = tests().find(([, b]) => res.every((r) => r.test(b)));
  assert.ok(hit, `a test in ArmClientTest shows ${what}`);
  return hit;
};

/** The default call budget and request timeout, in seconds, as ArmClient declares them. */
function defaults() {
  const a = arm();
  const budget = seconds(/CALL_BUDGET\s*=\s*([^;]+);/.exec(a)?.[1]);
  const request = seconds(/REQUEST_TIMEOUT\s*=\s*([^;]+);/.exec(a)?.[1]);
  const dflt = /Tuning\s+DEFAULT\s*=\s*new\s+Tuning\(\s*(\d+)\s*,\s*([^,]+?)\s*,/.exec(a);
  return { budget, request, attempts: dflt ? Number(dflt[1]) : NaN, backoff: seconds(dflt?.[2]) };
}

const aps16 = () => git(['log', '--format=%H', '--no-merges', '--grep=^AP-0016:']).split('\n').filter(Boolean);

// ---- Criterion 1 ----
test('1: ArmClient keeps public put(String, Object), get(String), delete(String); put/delete still wait for the operation', () => {
  const a = arm();
  assert.match(a, /public\s+JsonNode\s+put\s*\(\s*String\s+\w+\s*,\s*Object\s+\w+\s*\)/, 'public JsonNode put(String, Object)');
  assert.match(a, /public\s+JsonNode\s+get\s*\(\s*String\s+\w+\s*\)/, 'public JsonNode get(String)');
  assert.match(a, /public\s+void\s+delete\s*\(\s*String\s+\w+\s*\)/, 'public void delete(String)');
  const put = methodBody(a, /public\s+JsonNode\s+put\s*\(\s*String\s+\w+\s*,\s*Object\s+\w+\s*\)\s*\{/);
  const del = methodBody(a, /public\s+void\s+delete\s*\(\s*String\s+\w+\s*\)\s*\{/);
  assert.match(put, /awaitIfAsync\s*\(/, 'put still polls the async operation until done');
  assert.match(del, /awaitIfAsync\s*\(/, 'delete still polls the async operation until done');
  assert.match(a, /"Failed"[\s\S]{0,200}"Canceled"[\s\S]{0,300}newNonRetryableFailure/,
    'the blocking path still throws a non-retryable failure for Failed / Canceled');
});

test('1: no AP-0016 commit removes an ArmClientTest test method or any of its assertions', () => {
  const shas = aps16();
  assert.ok(shas.length > 0, 'found the AP-0016 commits');
  for (const sha of shas) {
    let before;
    let after;
    try { before = noComments(git(['show', `${sha}^:vm-intent/${ARM_TEST_REL}`])); } catch { continue; } // file is new
    try { after = noComments(git(['show', `${sha}:vm-intent/${ARM_TEST_REL}`])); } catch { assert.fail(`${sha.slice(0, 7)} deletes ArmClientTest`); }
    const old = testMethods(before);
    const now = testMethods(after);
    for (const [name, body] of old) {
      assert.ok(now.has(name), `${sha.slice(0, 7)} keeps the test ${name}`);
      const kept = now.get(name).split('\n').map((l) => l.trim().replace(/\s+/g, ' '));
      const asserts = body.split('\n').map((l) => l.trim().replace(/\s+/g, ' ')).filter((l) => /\bassert\w*\s*\(|\bfail\s*\(/.test(l));
      for (const line of asserts) {
        assert.ok(kept.includes(line), `${sha.slice(0, 7)}: ${name} keeps the assertion "${line}"`);
      }
    }
  }
});

test('1: the ap-0014 repository acceptance test still passes', () => {
  const f = join(ROOT, 'tests', 'acceptance', 'ap-0014', 'repo.test.mjs');
  assert.ok(existsSync(f), 'tests/acceptance/ap-0014/repo.test.mjs exists');
  try {
    execFileSync(process.execPath, ['--test', f], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  } catch (e) {
    assert.fail(`ap-0014/repo.test.mjs fails:\n${(e.stdout || '').split('\n').filter((l) => /not ok|Error|expected|actual/.test(l)).slice(0, 30).join('\n')}`);
  }
});

// ---- Criterion 2 ----
test('2: ArmClient has a public begin(method, path, body) that sends once and returns status, body and the operation URL', () => {
  const a = arm();
  const sig = /public\s+(\w+)\s+begin\s*\(\s*String\s+\w+\s*,\s*String\s+\w+\s*,\s*Object\s+\w+\s*\)\s*\{/;
  const m = sig.exec(a);
  assert.ok(m, 'public X begin(String method, String path, Object body)');
  const rec = new RegExp(`record\\s+${m[1]}\\s*\\(([^)]*)\\)`).exec(a);
  assert.ok(rec, `begin returns a record ${m[1]}`);
  assert.match(rec[1], /\bint\s+status\b/, `${m[1]} carries the HTTP status`);
  assert.match(rec[1], /\bJsonNode\s+\w+/, `${m[1]} carries the response body`);
  assert.match(rec[1], /\bString\s+\w*(operation|Operation|url|Url)\w*/, `${m[1]} carries the operation URL`);
  const body = methodBody(a, sig);
  assert.doesNotMatch(body, /awaitIfAsync|sleep\s*\(|while\s*\(|for\s*\(\s*;/, 'begin does not poll or wait');
  assert.match(body, /"Azure-AsyncOperation"/, 'begin takes the operation URL from Azure-AsyncOperation');
  assert.match(body, /202[\s\S]{0,80}"Location"|"Location"[\s\S]{0,80}202/, 'or from Location on a 202');
  assert.equal((body.match(/\bsend\s*\(/g) || []).length, 1, 'begin sends exactly one request');
});

test('2: ArmClientTest shows begin() of a VM PUT returns while MockArm still reports InProgress, with no operation-status GET', () => {
  const [name, b] = someTest([/pollsUntilDone\s*=\s*([2-9]|\d{2,})\s*;/, /\.begin\(\s*"PUT"/, /"InProgress"|OperationStatus\.InProgress/],
    'begin() of a PUT with pollsUntilDone > 1 returning while InProgress');
  assert.match(b, /assertEquals\(\s*0\s*,[^;]*(operation|Poll|poll)/i, `${name} checks that no operation-status GET was sent`);
  assert.match(b, /arm\.operations|operations\.values\(\)|"InProgress"/, `${name} checks MockArm still has the operation InProgress`);
});

// ---- Criterion 3 ----
test('3: ArmClient has a public operation(url) returning InProgress/Succeeded/Failed/Canceled with ARM\'s error code and message', () => {
  const a = arm();
  const sig = /public\s+(\w+)\s+operation\s*\(\s*String\s+\w+\s*\)\s*\{/;
  const m = sig.exec(a);
  assert.ok(m, 'public X operation(String url)');
  const en = /enum\s+(\w+)\s*\{([^}]*)\}/.exec(a);
  assert.ok(en, 'an operation status enum');
  for (const s of ['InProgress', 'Succeeded', 'Failed', 'Canceled']) assert.match(en[2], new RegExp(`\\b${s}\\b`), `status ${s}`);
  const rec = new RegExp(`record\\s+${m[1]}\\s*\\(([^)]*)\\)`).exec(a);
  assert.ok(rec, `operation returns a record ${m[1]}`);
  assert.match(rec[1], new RegExp(`\\b${en[1]}\\s+\\w+`), `${m[1]} carries the status`);
  assert.ok((rec[1].match(/\bString\s+\w+/g) || []).length >= 2, `${m[1]} carries ARM's error code and message: ${rec[1]}`);
  const body = methodBody(a, sig);
  assert.match(body, /"error"/, 'reads ARM\'s error object');
  assert.match(body, /"code"/, 'reads the error code');
  assert.match(body, /"message"/, 'reads the error message');
  assert.doesNotMatch(body, /awaitIfAsync|sleep\s*\(|while\s*\(/, 'operation reads once, without waiting');
  // The only throw in operation() is the address refusal (criterion 4); Failed / Canceled are returned.
  const throws = body.match(/\bthrow\b/g) || [];
  assert.ok(throws.length <= 1, `operation() throws only to refuse a foreign URL (${throws.length} throws)`);
});

test('3: ArmClientTest calls operation() repeatedly on begin()\'s URL and sees InProgress then Succeeded', () => {
  someTest([/\.begin\(/, /\.operation\(/, /InProgress/, /Succeeded/, /operationUrl\(\)/], 'operation() polled InProgress -> Succeeded');
  const [, b] = someTest([/\.begin\(/, /\.operation\(/, /InProgress/, /Succeeded/], 'operation() polled InProgress -> Succeeded');
  assert.ok(/(do\s*\{|while\s*\(|for\s*\()[\s\S]*\.operation\(/.test(b) || (b.match(/\.operation\(/g) || []).length >= 2,
    'operation() is called more than once');
});

test('3: ArmClientTest uses failNextOperation and sees Failed (returned, not thrown) with MockArm\'s message', () => {
  const [name, b] = someTest([/failNextOperation\(\s*"([^"]+)"/, /\.operation\(/, /OperationStatus\.Failed|"Failed"/],
    'a Failed operation via failNextOperation');
  const msg = /failNextOperation\(\s*"([^"]+)"/.exec(b)[1];
  const word = msg.split(/\W+/).filter((w) => w.length >= 6).pop() || msg;
  assert.match(b, /errorMessage\(\)|\.message\(\)/, `${name} checks the error message`);
  assert.ok(b.includes(word) || b.includes(msg), `${name} checks the message is MockArm's ("${msg}")`);
  assert.doesNotMatch(b, /assertThrows\([^;]*\.operation\(/, `${name}: Failed is returned, not thrown`);
});

// ---- Criterion 4 ----
test('4: operation(url) refuses a URL outside the management URL with a non-retryable CloudError before sending anything', () => {
  const a = arm();
  const body = methodBody(a, /public\s+\w+\s+operation\s*\(\s*String\s+(\w+)\s*\)\s*\{/);
  const check = body.search(/startsWith\(\s*cfg\.managementUrl\(\)/);
  assert.ok(check >= 0, 'operation() checks the URL starts with the configured management URL');
  assert.match(body.slice(check, check + 80), /managementUrl\(\)\s*\+\s*"\/"/,
    'the check includes the "/" after the management URL (so a different port such as :80801 is refused)');
  const send = body.search(/\b(send|execute)\s*\(/);
  assert.ok(send > check, 'the check comes before any request');
  assert.match(body.slice(check, send), /throw\s+ApplicationFailure\.newNonRetryableFailure\([\s\S]*?"CloudError"\s*\)/,
    'refuses with a non-retryable ApplicationFailure of type CloudError');
});

test('4: ArmClientTest shows a URL on another host or port is refused and gets no request', () => {
  const [name, b] = someTest([/assertThrows\([^;]*\.operation\(/, /"CloudError"/, /isNonRetryable\(\)/],
    'operation() of a foreign URL throws a non-retryable CloudError');
  assert.match(b, /new\s+MockArm\(\)|\.url\(\)\s*\+\s*"\d/, `${name} uses a second address (another MockArm or another port)`);
  assert.match(b, /calls\.isEmpty\(\)|calls\.size\(\)\s*\)|assertEquals\(\s*0\s*,[^;]*calls/, `${name} checks that no request reached it`);
});

// ---- Criterion 5 ----
test('5: Tuning has a per-call budget under 15 s and a per-request timeout; begin, operation and get use the budget', () => {
  const a = arm();
  assert.match(a, /record\s+Tuning\s*\([^)]*Duration\s+\w*[Bb]udget\w*[^)]*Duration\s+\w*[Tt]imeout\w*/,
    'Tuning has a call budget and a request timeout');
  const d = defaults();
  assert.ok(d.budget > 0 && d.budget < 15, `default call budget is under 15 s (${d.budget})`);
  assert.ok(d.request > 0 && d.request < d.budget, `default request timeout is under the budget (${d.request})`);
  assert.ok(d.attempts >= 1 && d.attempts <= 10, `bounded attempts (${d.attempts})`);
  // The 4-argument constructor (used by the existing tests and Tuning.DEFAULT) falls back to those defaults.
  assert.match(a, /Tuning\s*\(\s*int\s+\w+\s*,\s*Duration\s+\w+\s*,\s*Duration\s+\w+\s*,\s*Duration\s+\w+\s*\)\s*\{[^}]*CALL_BUDGET[^}]*REQUEST_TIMEOUT/,
    'the 4-argument Tuning uses CALL_BUDGET and REQUEST_TIMEOUT');
  for (const [what, re] of [
    ['get', /public\s+JsonNode\s+get\s*\(\s*String\s+\w+\s*\)\s*\{/],
    ['begin', /public\s+\w+\s+begin\s*\([^)]*\)\s*\{/],
    ['operation', /public\s+\w+\s+operation\s*\(\s*String\s+\w+\s*\)\s*\{/],
  ]) {
    assert.match(methodBody(a, re), /deadline\s*\(|callBudget\s*\(/, `${what} runs within the call budget`);
  }
  // The sign-in is counted in the same deadline.
  assert.match(a, /bearer\s*\(\s*deadline\s*\)/, 'the sign-in uses the call\'s deadline');
});

test('5: a wait that would pass the budget is thrown as a retryable CloudBusy instead of slept', () => {
  const a = arm();
  const exec = methodBody(a, /private\s+Response\s+execute\s*\([^)]*\)\s*\{/);
  assert.ok(exec, 'ArmClient has execute(...)');
  const i = exec.search(/deadline\s*!=\s*null\s*&&[^\n]*wait/);
  assert.ok(i >= 0, 'execute compares the wait with the deadline');
  const s = exec.search(/\bsleep\s*\(\s*wait\s*\)/);
  assert.ok(s > i, 'the deadline check comes before the sleep');
  assert.match(exec.slice(i, s), /throw\s+ApplicationFailure\.newFailure\w*\([\s\S]*?"CloudBusy"/,
    'throws a retryable (newFailure*) CloudBusy instead of sleeping');
  assert.match(a, /\.timeout\(\s*requestTimeout\(|\.timeout\(\s*tuning\.requestTimeout\(/, 'each request has a timeout from the budget');
});

test('5: ArmClientTest: 429 with Retry-After: 120 on the default tuning is a retryable CloudBusy in under 15 s', () => {
  const [name, b] = someTest([/retryAfter\s*=\s*"120"/, /failNext\([^)]*429\s*\)/, /"CloudBusy"/], '429 with Retry-After 120');
  assert.match(b, /new\s+ArmClient\(\s*arm\.properties\(\)\s*\)/, `${name} uses the default tuning (ArmClient(arm.properties()))`);
  assert.match(b, /assertFalse\(\s*\w+\.isNonRetryable\(\)\s*\)/, `${name} checks the failure is retryable`);
  assert.match(b, /nanoTime\(\)|currentTimeMillis\(\)|Instant\.now\(\)/, `${name} measures wall-clock time`);
  assert.match(b, /Duration\.ofSeconds\(\s*15\s*\)|15_?000|<\s*15\b/, `${name} checks it is under 15 s`);
});

// ---- Criterion 6 ----
test('6: MockArm can hold its answer, and ArmClientTest shows a held answer is a retryable CloudBusy in under 15 s', () => {
  const m = mock();
  const hook = /public\s+volatile\s+Duration\s+(\w+)\s*=/.exec(m) || /public\s+(?:volatile\s+)?\w+\s+(\w*[Dd]elay\w*)\s*=/.exec(m);
  assert.ok(hook, 'MockArm has a response-delay hook');
  assert.match(m, /Thread\.sleep\(/, 'MockArm holds its answer');
  const [name, b] = someTest([new RegExp(`\\.${hook[1]}\\s*=`), /"CloudBusy"/], `a held answer (${hook[1]})`);
  const delay = seconds(new RegExp(`\\.${hook[1]}\\s*=\\s*([^;]+);`).exec(b)[1]);
  const d = defaults();
  assert.ok(delay > d.request, `${name} holds the answer longer than the request timeout (${delay} s > ${d.request} s)`);
  assert.match(b, /new\s+ArmClient\(\s*\w+(\.properties\(\))?\s*\)/, `${name} uses the default tuning`);
  assert.match(b, /assertFalse\(\s*\w+\.isNonRetryable\(\)\s*\)/, `${name} checks the failure is retryable`);
  assert.match(b, /nanoTime\(\)|currentTimeMillis\(\)|Instant\.now\(\)/, `${name} measures wall-clock time`);
  assert.match(b, /Duration\.ofSeconds\(\s*15\s*\)|15_?000|<\s*15\b/, `${name} checks it is under 15 s`);
});

// ---- Criterion 7 ----
test('7: 409 is a retryable CloudBusy; 404 NotFound, 401/403 CloudAuth and other 4xx InvalidSpec are unchanged', () => {
  const a = arm();
  const exec = methodBody(a, /private\s+Response\s+execute\s*\([^)]*\)\s*\{/);
  const c409 = exec.search(/s\s*==\s*409\)?\s*throw\s+ApplicationFailure\.newFailure\([^;]*"CloudBusy"\s*\)/);
  assert.ok(c409 >= 0, '409 -> ApplicationFailure.newFailure(..., "CloudBusy")');
  const inv = exec.search(/newNonRetryableFailure\([^;]*"InvalidSpec"\s*\)/);
  assert.ok(inv > c409, 'the 409 case comes before the InvalidSpec fall-through');
  assert.match(exec, /s\s*==\s*401\s*\|\|\s*s\s*==\s*403[^;]*\{?\s*throw\s+ApplicationFailure\.newNonRetryableFailure\([^;]*"CloudAuth"/,
    '401/403 -> non-retryable CloudAuth');
  assert.match(exec, /s\s*==\s*404\)?\s*throw\s+ApplicationFailure\.newNonRetryableFailure\([^;]*"NotFound"\s*\)/, '404 -> non-retryable NotFound');
  assert.match(exec, /boolean\s+retry\s*=\s*r\s*==\s*null\s*\|\|\s*s\s*==\s*429\s*\|\|\s*s\s*>=\s*500\s*;/,
    'the client itself retries only no-answer, 429 and 5xx (409 is left to Temporal)');
});

test('7: ArmClientTest: failNext(1, 409) gives a retryable CloudBusy; the 400 and 404 tests are still there', () => {
  const [name, b] = someTest([/failNext\(\s*1\s*,\s*409\s*\)/, /"CloudBusy"/], 'failNext(1, 409) -> CloudBusy');
  assert.match(b, /assertFalse\(\s*\w+\.isNonRetryable\(\)\s*\)/, `${name} checks it is retryable`);
  someTest([/"InvalidSpec"/, /isNonRetryable\(\)/], 'a 400 gives non-retryable InvalidSpec');
  someTest([/"NotFound"/], 'a 404 gives NotFound');
});

// ---- Criterion 8 ----
test('8: docs/AZURE.md describes the blocking and the non-blocking way and the A2 pattern', () => {
  const doc = read(DOC);
  assert.match(doc, /`put`[^\n]*`delete`[\s\S]{0,200}tools and tests/i, 'blocking put/delete are for tools and tests');
  assert.match(doc, /not for activities/i, 'blocking put/delete are not for activities');
  assert.match(doc, /`begin[^`]*`[\s\S]{0,400}`operation[^`]*`[\s\S]{0,400}activities|activities[\s\S]{0,400}`begin[^`]*`[\s\S]{0,400}`operation/i,
    'begin/operation are for activities');
  assert.match(doc, /\bA2\b/, 'names the pattern Azure part A2 should follow');
  assert.match(doc, /one step/i, 'each activity call moves one step');
  assert.match(doc, /not ready yet[\s\S]{0,200}CloudBusy|CloudBusy[\s\S]{0,200}not ready yet/i, '"not ready yet" is a retryable CloudBusy');
  assert.match(doc, /Failed[\s\S]{0,40}Canceled[\s\S]{0,80}returned, not thrown/i, 'operation returns Failed/Canceled');
  assert.match(doc, /`?management-url`?[\s\S]{0,120}refused|refused[\s\S]{0,120}management-url/i, 'foreign operation URLs are refused');
});

test('8: docs/AZURE.md states the per-call budget with the same default numbers as the code', () => {
  const doc = read(DOC);
  const d = defaults();
  assert.match(doc, new RegExp(`budget of ${d.budget} s|${d.budget} s budget|${d.budget}\\s*s[^\\n]{0,40}budget|budget[^\\n]{0,40}${d.budget}\\s*s`, 'i'),
    `the doc states the ${d.budget} s budget`);
  assert.match(doc, /sign-in included|including sign-in|sign-in counted/i, 'the budget includes the sign-in');
  assert.match(doc, new RegExp(`at most ${d.attempts} attempts|${d.attempts} attempts|${d.attempts} tries`, 'i'), `the doc states ${d.attempts} attempts`);
  assert.match(doc, new RegExp(`(request|requests)[^\\n]{0,40}${d.request}\\s*s|${d.request}\\s*s[^\\n]{0,40}request`, 'i'),
    `the doc states the ${d.request} s per-request timeout`);
  assert.match(doc, /15 s/, 'the doc relates the budget to the 15 s read timeout');
});

test('8: the status table in docs/AZURE.md has 409 -> CloudBusy and a too-long Retry-After -> CloudBusy without waiting', () => {
  const rows = read(DOC).split(/\r?\n/).filter((l) => /^\|/.test(l) && !/^\|[-\s|]+\|$/.test(l))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
  const row = (re) => rows.find((r) => re.test(r[0]));
  const r409 = row(/\b409\b/);
  assert.ok(r409, 'a table row for 409');
  assert.match(r409[2], /CloudBusy/, `409 fails as CloudBusy: ${r409.join(' | ')}`);
  assert.match(r409[3], /yes/i, `Temporal retries 409: ${r409.join(' | ')}`);
  assert.doesNotMatch(r409[1], /\d+\s*tries/i, `the client does not retry 409 itself: ${r409.join(' | ')}`);
  const ra = row(/Retry-After[^|]*budget|budget[^|]*Retry-After/i);
  assert.ok(ra, 'a table row for a Retry-After longer than the budget');
  assert.match(ra[1], /no\b[^|]*wait|no wait|without wait/i, `no wait for a Retry-After past the budget: ${ra.join(' | ')}`);
  assert.match(ra[2], /CloudBusy/, `it fails as CloudBusy: ${ra.join(' | ')}`);
  assert.match(ra[3], /yes/i, `Temporal retries it: ${ra.join(' | ')}`);
  const other = row(/other 4xx/i);
  assert.ok(other && /InvalidSpec/.test(other[2]), 'other 4xx is still InvalidSpec');
  const nf = row(/^404$/);
  assert.ok(nf && /NotFound/.test(nf[2]), '404 is still NotFound');
  const auth = row(/401[^|]*403/);
  assert.ok(auth && /CloudAuth/.test(auth[2]), '401/403 is still CloudAuth');
  // No row claims 409 is InvalidSpec any more.
  assert.ok(!rows.some((r) => /\b409\b/.test(r[0]) && /InvalidSpec/.test(r[2])), 'no row maps 409 to InvalidSpec');
});

// ---- Criterion 9 ----
test('9: ArmClientTest, MockArm, the replay tests and the vCenter/VCF-A backend tests are in backend/src/test', () => {
  const all = walk(TEST_ROOT).map((f) => f.replace(/\\/g, '/'));
  for (const n of ['ArmClientTest.java', 'MockArm.java', 'VcenterBackendTest.java', 'VcfaBackendTest.java']) {
    assert.ok(all.some((f) => f.endsWith('/' + n)), `backend/src/test has ${n}`);
  }
  assert.ok(all.some((f) => /Replay\w*Test\.java$/.test(f)), 'backend/src/test has the Temporal replay tests');
});

test('9: every ArmClient a test builds uses MockArm\'s properties; no test names a real Azure host as an address', () => {
  const files = walk(TEST_ROOT).filter((f) => /\.(java|ya?ml|properties|json)$/.test(f));
  for (const f of files) {
    const t = read(f);
    assert.doesNotMatch(t, /login\.microsoftonline\.com|login\.windows\.net|login\.microsoft\.com/i, `${f} names no Entra ID host`);
    for (const m of t.matchAll(/management\.(azure|core\.windows)\.(com|net)[^\s"']*/gi)) {
      assert.match(m[0], /^management\.azure\.com\/\.default$/i, `${f}: the real ARM host only as the token scope: ${m[0]}`);
    }
  }
  for (const f of files.filter((x) => x.endsWith('.java'))) {
    const t = noComments(read(f));
    for (const m of t.matchAll(/new\s+ArmClient\(\s*((?:[^,()]|\(\s*\))+)/g)) {
      const arg = m[1].trim();
      if (/^\w+\.properties\(\)$/.test(arg)) continue;
      assert.match(arg, /^\w+$/, `${f}: ArmClient built from ${arg}`);
      // The variable must come from a MockArm's properties(), or copy its login and management URLs.
      const decl = [...t.matchAll(new RegExp(`\\b${arg}\\s*=\\s*([^;]+);`, 'g'))].map((d) => d[1]);
      assert.ok(decl.length > 0, `${f}: found where ${arg} is set`);
      for (const d of decl) {
        const ok = /^\w+\.properties\(\)$/.test(d.trim())
          || (/new\s+AzureProperties\(/.test(d) && /\.loginUrl\(\)/.test(d) && /\.managementUrl\(\)/.test(d))
          || (/new\s+AzureProperties\(/.test(d) && /\w+\.url\(\)[\s\S]*\w+\.url\(\)/.test(d));
        assert.ok(ok, `${f}: ${arg} takes its URLs from MockArm: ${d.replace(/\s+/g, ' ')}`);
      }
    }
  }
});

// ---- Criterion 10 (commits) ----
test('10: no AP-0016 commit changes AzureProvider, workflow/activity interfaces, REST controllers, docs/openapi.* or deploy/', () => {
  const shas = aps16();
  assert.ok(shas.length > 0, 'found the AP-0016 commits');
  for (const sha of shas) {
    const files = git(['show', '--name-only', '--format=', sha]).split('\n').map((s) => s.trim()).filter(Boolean);
    for (const f of files) {
      const s = sha.slice(0, 7);
      assert.doesNotMatch(f, /backend\/src\/main\/java\/com\/example\/vmintent\/provider\/AzureProvider\.java$/, `${s} does not change AzureProvider.java`);
      assert.doesNotMatch(f, /(^|\/)docs\/openapi\.(json|ya?ml)$/, `${s} does not change ${f}`);
      assert.doesNotMatch(f, /^(vm-intent\/)?deploy\//, `${s} does not change ${f}`);
      assert.doesNotMatch(f, /\/api\/\w*Controller\.java$/, `${s} does not change the REST controller ${f}`);
      if (f.endsWith('.java') && f.includes('/src/main/')) {
        let before = '';
        let after = '';
        try { before = git(['show', `${sha}^:${f}`]); } catch { /* new file */ }
        try { after = git(['show', `${sha}:${f}`]); } catch { /* deleted file */ }
        assert.doesNotMatch(before + after, /@(WorkflowInterface|ActivityInterface)\b/, `${s} does not change the interface ${f}`);
        assert.doesNotMatch(before + after, /@(RestController|Controller)\b/, `${s} does not change the REST controller ${f}`);
      }
    }
  }
});
