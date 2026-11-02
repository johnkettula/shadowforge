// AP-0011 acceptance, repository half: the workflow interface, the controller, the unit tests, docs/API.md,
// the web app's error path and the commit scope. Covers criteria 5, 6, 8, 9 and the repository part of 10.
// Reads files and git history only; it does not run mvn (the pipeline's build gates do).
//
//   node --test tests/acceptance/ap-0011/docs_and_repo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const JAVA = 'backend/src/main/java/com/example/vmintent/';
const TEST = 'backend/src/test/java/com/example/vmintent/';
const iface = () => read(JAVA + 'workflow/IntentWorkflow.java');

/** The text of a Java method from its signature to the closing brace at the same indent. */
function methodBody(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `found "${signature}"`);
  const end = src.indexOf('\n    }\n', start);
  assert.ok(end > start, `found the end of "${signature}"`);
  return src.slice(start, end);
}

/** The annotations and declaration of one interface method, e.g. "void answerQuestion(String". */
function declaration(src, decl) {
  const i = src.indexOf(decl);
  assert.ok(i >= 0, `IntentWorkflow declares ${decl}`);
  const before = src.slice(0, i);
  const prev = before.lastIndexOf(';');           // end of the previous declaration
  return src.slice(prev + 1, src.indexOf(';', i) + 1);
}

// ---- Criterion 5 ----
test('5: answerQuestion and cancelRequest are @UpdateMethods with @UpdateValidatorMethods', () => {
  const src = iface();
  assert.match(declaration(src, 'void answerQuestion(String'), /@UpdateMethod\b/);
  assert.match(declaration(src, 'void cancelRequest()'), /@UpdateMethod\b/);
  assert.match(src, /@UpdateValidatorMethod\(\s*updateName\s*=\s*"answerQuestion"\s*\)\s*void\s+\w+\(\s*String\s+\w+\s*\)/,
    'a validator for answerQuestion taking the same String argument');
  assert.match(src, /@UpdateValidatorMethod\(\s*updateName\s*=\s*"cancelRequest"\s*\)\s*void\s+\w+\(\s*\)/,
    'a validator for cancelRequest with no arguments');
});

test('5: clarify / cancel signals, confirmSpec update and status query keep their names and signatures', () => {
  const src = iface();
  assert.match(declaration(src, 'void clarify(String'), /@SignalMethod\b/);
  assert.match(declaration(src, 'void cancel()'), /@SignalMethod\b/);
  assert.match(declaration(src, ' confirmSpec('), /@UpdateMethod\b/);
  assert.match(declaration(src, 'RequestStatus status()'), /@QueryMethod\b/);
  // Same signatures as before this requirement.
  const shas = git('log', '--format=%H', '--no-merges', '--grep=^AP-0011:').split('\n').filter(Boolean);
  assert.ok(shas.length > 0, 'found the AP-0011 commits');
  const oldest = shas[shas.length - 1];
  const before = git('show', `${oldest}^:vm-intent/${JAVA}workflow/IntentWorkflow.java`).replace(/\r\n/g, '\n');
  for (const decl of ['void clarify(String', 'void cancel()', ' confirmSpec(', 'RequestStatus status()']) {
    const sig = (s) => declaration(s, decl).replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();
    assert.equal(sig(src), sig(before), `${decl.trim()} is declared as before`);
  }
});

test('5: RequestController.clarify and cancel call the update methods, not the signals', () => {
  const src = read(JAVA + 'api/RequestController.java');
  const clarify = methodBody(src, 'public void clarify(');
  assert.match(clarify, /\.answerQuestion\(/, 'clarify calls answerQuestion');
  assert.doesNotMatch(clarify, /\.clarify\(/, 'clarify no longer sends the clarify signal');
  const cancel = methodBody(src, 'public void cancel(');
  assert.match(cancel, /\.cancelRequest\(/, 'cancel calls cancelRequest');
  assert.doesNotMatch(cancel, /\.cancel\(\s*\)/, 'cancel no longer sends the cancel signal');
});

// ---- Criterion 6 (presence; mvn test itself runs in the pipeline's build gate) ----
test('6: unit tests cover the validators and replay a history made with the new updates', () => {
  const wf = read(TEST + 'workflow/IntentWorkflowTest.java');
  const ctl = read(TEST + 'api/RequestControllerTest.java');
  const all = wf + '\n' + ctl;
  assert.match(all, /answerQuestion\(/, 'answerQuestion is exercised');
  assert.match(all, /cancelRequest\(|controller\.cancel\(/, 'cancelRequest is exercised');
  assert.match(all, /WorkflowUpdateException|assertRefused\(/, 'refusals are asserted as WorkflowUpdateException');
  assert.match(all, /not waiting for an answer/, 'answerQuestion refused when not waiting for an answer');
  assert.match(all, /AWAITING_CONFIRMATION/, 'a refusal in AWAITING_CONFIRMATION');
  assert.match(all, /build has already started/, 'cancelRequest refused once the build has started');
  assert.match(all, /PROVISIONING/, 'the build case waits for PROVISIONING');
  assert.match(all, /already finished \(cancelled\)/, 'cancelRequest refused after the request has been cancelled');
  assert.match(wf, /WorkflowReplayer\.replayWorkflowExecution\(\s*[^;]*fetchHistory\([^;]*IntentWorkflowImpl\.class/,
    'a history fetched from TestWorkflowEnvironment is replayed against IntentWorkflowImpl');
  const lifecycle = read(TEST + 'workflow/LifecycleWorkflowTest.java');
  assert.match(lifecycle, /static void assertRefused[\s\S]{0,200}WorkflowUpdateException/,
    'assertRefused expects WorkflowUpdateException');
  const replay = read(TEST + 'workflow/ReplayTest.java');
  for (const h of ['intent-v1-completed', 'intent-v1-cancelled', 'intent-v1-open']) {
    assert.ok(replay.includes(`"${h}"`), `ReplayTest still replays ${h}`);
  }
});

// ---- Criterion 8 ----
function operationRow(id) {
  const row = read('docs/API.md').split('\n').find((l) => l.startsWith(`| \`${id}\``));
  assert.ok(row, `docs/API.md has a ${id} row`);
  return row;
}

test('8: docs/API.md describes the new refusals in the clarifyRequest and cancelRequest rows', () => {
  const clarify = operationRow('clarifyRequest');
  assert.match(clarify, /already finished/);
  assert.match(clarify, /409/);
  assert.match(clarify, /not waiting for an answer/i, `clarifyRequest row: ${clarify}`);
  const cancel = operationRow('cancelRequest');
  assert.match(cancel, /already finished/);
  assert.match(cancel, /409/);
  assert.match(cancel, /build has (already )?started/i, `cancelRequest row: ${cancel}`);
  assert.match(cancel, /PROVISIONING/, `cancelRequest row: ${cancel}`);
});

test('8: the cancelRequest @Operation no longer says "Has no effect once the build has started"', () => {
  const src = read(JAVA + 'api/RequestController.java');
  const op = /@Operation\(\s*operationId\s*=\s*"cancelRequest"[\s\S]*?\)\s*\n\s*@/.exec(src);
  assert.ok(op, 'found the cancelRequest @Operation');
  assert.doesNotMatch(op[0], /Has no effect once the build has started/i);
});

test('8: the IntentWorkflow javadoc no longer says the UI uses signals for clarify and cancel', () => {
  const src = iface();
  const doc = /\/\*\*([\s\S]*?)\*\/\s*@WorkflowInterface/.exec(src);
  assert.ok(doc, 'IntentWorkflow has a javadoc above @WorkflowInterface');
  const text = doc[1].replace(/\s*\*\s*/g, ' ');
  assert.doesNotMatch(text, /UI talks to it with signals/i, text);
  assert.doesNotMatch(text, /signals \(clarify \/ cancel\)/i, text);
});

// ---- Criterion 9 ----
test('9: in the web app a 409 from Cancel or the answer form shows the server\'s error message', () => {
  const api = read('frontend/src/api.ts');
  const start = api.indexOf('async function call<');
  assert.ok(start >= 0, 'api.ts has the call() helper');
  const call = api.slice(start, api.indexOf('\n}\n', start));
  assert.match(call, /if \(!res\.ok\) throw new Error\(data\?\.error/, 'a non-2xx answer rejects with the server\'s "error"');
  assert.match(api, /clarify: \(id: string, answer: string\) => call<void>\("POST", `\/api\/v2\/requests\/\$\{id\}\/clarify`/);
  assert.match(api, /cancel: \(id: string\) => call<void>\("POST", `\/api\/v2\/requests\/\$\{id\}\/cancel`/);

  const app = read('frontend/src/App.tsx');
  const run = /const run = async \(fn: \(\) => Promise<void>\) => \{([\s\S]*?)\n  \};/.exec(app);
  assert.ok(run, 'App has a run() helper');
  assert.match(run[1], /catch \(e\)\s*\{\s*setError\(e instanceof Error \? e\.message : String\(e\)\)/,
    'run() shows the rejection message');
  assert.match(app, /\{error && <div className="error">\{error\}<\/div>\}/, 'the error is rendered');
  const cancels = app.match(/run\(\(\) => api\.cancel\(status\.requestId\)\)/g) || [];
  assert.ok(cancels.length >= 2, 'both Cancel buttons go through run()');
  const answers = app.match(/run\(async \(\) => \{\s*await api\.clarify\(status\.requestId, answer\)/g) || [];
  assert.ok(answers.length >= 2, 'Enter and the Answer button both go through run()');
});

// ---- Criterion 10 (repository part) ----
test('10: no AP-0011 commit touches protected paths or changes / deletes a replay history or ReplayTest', () => {
  const shas = git('log', '--format=%H', '--no-merges', '--grep=^AP-0011:').split('\n').filter(Boolean);
  assert.ok(shas.length > 0, 'found the AP-0011 commits');
  const protectedPath = [
    /(^|\/)backend\/src\/main\/java\/com\/example\/vmintent\/security\//,
    /(^|\/)backend\/src\/main\/resources\/catalog\//,
    /(^|\/)backend\/src\/main\/resources\/application[^/]*\.(ya?ml|properties)$/,
    /^vm-intent\/deploy\//,
    /^agent-pipeline\//,
  ];
  for (const sha of shas) {
    const changes = git('show', '--name-status', '--format=', '--no-renames', sha).split('\n').filter(Boolean)
      .map((l) => l.split('\t'));
    for (const [st, path] of changes) {
      for (const re of protectedPath) assert.doesNotMatch(path, re, `${sha.slice(0, 7)} touches protected ${path}`);
      if (/backend\/src\/test\/resources\/histories\//.test(path)) {
        assert.equal(st, 'A', `${sha.slice(0, 7)} changes or deletes existing history ${path} (${st})`);
      }
      assert.doesNotMatch(path, /workflow\/ReplayTest\.java$/, `${sha.slice(0, 7)} changes ReplayTest.java`);
    }
  }
});
