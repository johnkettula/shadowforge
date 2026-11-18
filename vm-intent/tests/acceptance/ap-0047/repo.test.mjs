// AP-0047 acceptance, repository half (criteria 1-3, 9 and 10): spec/VmNames holds the one VM-name pattern and is
// used by RuleBasedIntentExtractor; SpecValidator.problems rejects a non-blank name that breaks it; unit tests cover
// the listed cases; API.md and USER-GUIDE.md state the rule; and the AP-0047 commits leave the replay histories,
// workflow/ and security/ alone.
//
// "This requirement's commits" are the non-merge commits whose subject starts with "AP-0047:" (the pipeline's own
// "acceptance tests" and "record the requirement" commits are left out when picking file versions). Files are read
// with git show as they were at the newest such commit that changed them, so later requirements can change them
// freely. Only sources are read, never build outputs; the build gates run mvn test (including ReplayTest).
//
//   node --test tests/acceptance/ap-0047/repo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = 'AP-0047';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const RULE = '[a-z0-9][a-z0-9-]{1,40}';
const MAIN = 'backend/src/main/java/com/example/vmintent';
const TESTS = 'backend/src/test/java/com/example/vmintent';
const VM_NAMES = `${MAIN}/spec/VmNames.java`;
const SPEC_VALIDATOR = `${MAIN}/spec/SpecValidator.java`;
const EXTRACTOR = `${MAIN}/intent/RuleBasedIntentExtractor.java`;
const UNIT_TESTS = [`${TESTS}/spec/SpecValidatorTest.java`, `${TESTS}/spec/VmNamesTest.java`];

const git = (args) => execFileSync('git', args,
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

// Oldest first; subjects are checked here, because --grep also matches body lines.
const ALL = git(['log', '--no-merges', '--reverse', '--format=%H %s', '--grep', `^${ID}:`]).split('\n').filter(Boolean)
  .map((l) => ({ sha: l.slice(0, 40), subject: l.slice(41) })).filter((c) => c.subject.startsWith(`${ID}:`));
const isPipeline = (c) => /^AP-\d+: (acceptance tests|record the requirement)\b/.test(c.subject);
const COMMITS = ALL.filter((c) => !isPipeline(c)).map((c) => c.sha);
const NEWEST = COMMITS[COMMITS.length - 1];
/** [status, path] pairs a commit made, without rename detection (a rename shows as D + A). */
const statuses = (sha) => git(['diff', '--name-status', '--no-renames', `${sha}^`, sha]).split('\n').filter(Boolean)
  .map((l) => { const [s, p] = l.split('\t'); return [s, p]; });
const CHANGES = new Map(ALL.map((c) => [c.sha, statuses(c.sha)]));
const touching = (rel) => COMMITS.filter((sha) => CHANGES.get(sha).some(([, p]) => p === `vm-intent/${rel}`));

function at(sha, rel) {
  try { return git(['show', `${sha}:vm-intent/${rel}`]).replace(/\r\n/g, '\n'); } catch { return null; }
}
/** A file as it was at the newest AP-0047 commit that changed it (or the newest AP-0047 commit). */
function now(rel) {
  assert.ok(NEWEST, `no ${ID} commit`);
  const own = touching(rel);
  const sha = own.length ? own[own.length - 1] : NEWEST;
  const t = at(sha, rel);
  assert.ok(t !== null, `${rel} doesn't exist at ${sha.slice(0, 8)}`);
  return t;
}
const squash = (s) => s.replace(/\s+/g, ' ').trim();

/** Java source with // and /* comments removed (string literals kept). */
function noComments(src) {
  let out = '';
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1); i = j + 1;
    } else if (src.startsWith('//', i)) { const j = src.indexOf('\n', i); i = j < 0 ? src.length : j; }
    else if (src.startsWith('/*', i)) { const j = src.indexOf('*/', i + 2); i = j + 2; out += ' '; }
    else { out += c; i++; }
  }
  return out;
}
const javaUnescape = (s) => s.replace(/\\\\/g, '\\');

/** Methods of a Java source: annotations, name and body. */
function methods(src) {
  const out = [];
  for (const m of src.matchAll(/((?:@\w+(?:\([^)]*\))?\s*)+)(?:public\s+|protected\s+)?void\s+(\w+)\s*\([^)]*\)[^{;]*\{/g)) {
    let depth = 0; let i = m.index + m[0].length - 1; const start = i;
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
    out.push({ ann: m[1], name: m[2], body: src.slice(start, i + 1) });
  }
  return out;
}

/** Values of the string expressions in a statement: "lit", "lit".repeat(n), joined with +, or null. */
function values(stmt) {
  const out = [];
  const term = String.raw`(?:"(?:[^"\\]|\\.)*"(?:\.repeat\(\s*\d+\s*\))?)`;
  for (const m of stmt.matchAll(new RegExp(`${term}(?:\\s*\\+\\s*${term})*`, 'g'))) {
    let v = '';
    for (const t of m[0].matchAll(/"((?:[^"\\]|\\.)*)"(?:\.repeat\(\s*(\d+)\s*\))?/g)) v += t[1].repeat(t[2] ? Number(t[2]) : 1);
    out.push(v);
  }
  if (/\(\s*null\s*\)/.test(stmt)) out.push(null);
  return out;
}
// A statement asserts acceptance or rejection directly, or through a helper such as assertNameRejected(...).
const ACCEPTS = /assertTrue\(\s*VmNames\.isValid|assertEquals\(\s*List\.of\(\)|assertTrue\([^;]*\.isEmpty\(\)|\bassert\w*(Accepted|Valid)\w*\(/;
const REJECTS = /assertFalse\(\s*VmNames\.isValid|assertFalse\([^;]*\.isEmpty\(\)|\bassert\w*(Rejected|Invalid)\w*\(/;

test(`there is an ${ID} commit (other than the pipeline's own)`, () => {
  assert.ok(COMMITS.length > 0, `no non-pipeline commit subject starts with ${ID}:`);
});

// ------------------------------------------------------------------ 1. VmNames, RuleBasedIntentExtractor

test('criterion 1: spec/VmNames.java holds the pattern [a-z0-9][a-z0-9-]{1,40} and a public method saying whether a name is valid', () => {
  const src = noComments(now(VM_NAMES));
  assert.match(src, /package com\.example\.vmintent\.spec;/);
  assert.match(src, /public\s+(final\s+)?class\s+VmNames\b/);
  const literals = [...src.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => javaUnescape(m[1]));
  assert.ok(literals.includes(RULE), `VmNames has no string literal ${RULE} (literals: ${JSON.stringify(literals)})`);
  assert.equal(literals.filter((l) => l.includes('[a-z0-9]')).length, 1, 'VmNames writes the pattern more than once');
  assert.match(src, /public\s+static\s+boolean\s+\w+\s*\(\s*String\s+\w+\s*\)/, 'no public static boolean method taking a String');
});

test('criterion 1: the rule itself accepts and rejects the right names', () => {
  const re = new RegExp(`^(?:${RULE})$`);
  for (const ok of ['web-01', '01', 'a'.repeat(41), 'vm-1a2b3c4d', 'a-']) assert.ok(re.test(ok), ok);
  for (const bad of ['a', 'a'.repeat(42), 'Web-01', 'web 01', 'web_01', '-web-01', 'web.01', '']) assert.ok(!re.test(bad), bad);
});

test('criterion 1: RuleBasedIntentExtractor\'s called/named pattern uses VmNames and has no copy of the rule', () => {
  const src = noComments(now(EXTRACTOR));
  const literals = [...src.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => javaUnescape(m[1]));
  const copies = literals.filter((l) => l.includes(RULE));
  assert.deepEqual(copies, [], 'RuleBasedIntentExtractor still writes its own copy of the rule');
  const decl = src.match(/Pattern\s+NAME\s*=\s*Pattern\.compile\(([\s\S]*?)\);/);
  assert.ok(decl, 'no NAME pattern in RuleBasedIntentExtractor');
  assert.match(decl[1], /called/, 'the NAME pattern no longer matches "called"');
  assert.match(decl[1], /named/, 'the NAME pattern no longer matches "named"');
  assert.match(decl[1], /\bVmNames\.\w+/, 'the NAME pattern doesn\'t use VmNames');
});

// ------------------------------------------------------------------ 2. SpecValidator

test('criterion 2: SpecValidator.problems adds a problem naming a non-blank name that VmNames rejects', () => {
  const src = noComments(now(SPEC_VALIDATOR));
  const body = src.slice(src.search(/public\s+static\s+List<String>\s+problems\s*\(/));
  assert.ok(body.length > 0, 'no problems(...) method');
  const i = body.search(/VmNames\.\w+\(\s*s\.name\(\)\s*\)/);
  assert.ok(i >= 0, 'problems(...) doesn\'t check s.name() with VmNames');
  const stmt = body.slice(body.lastIndexOf('if', i), body.indexOf(';', i) + 1);
  assert.match(stmt, /s\.name\(\)\s*!=\s*null/, 'the name check doesn\'t skip a null name');
  assert.match(stmt, /isBlank\(\)/, 'the name check doesn\'t skip a blank name');
  assert.match(stmt, /\.add\([^;]*\+\s*s\.name\(\)\s*\+/, 'the problem doesn\'t include the name');
});

// ------------------------------------------------------------------ 3. Unit tests

test('criterion 3: active unit tests cover every case in the list', () => {
  // Either file may hold the cases; read each at the newest AP-0047 commit that changed it.
  const found = UNIT_TESTS.map((rel) => {
    const own = touching(rel);
    const t = own.length ? at(own[own.length - 1], rel) : null;
    return { rel, src: t && noComments(t) };
  }).filter((f) => f.src);
  assert.ok(found.length > 0, `no ${ID} commit changes ${UNIT_TESTS.join(' or ')}`);
  const active = [];
  for (const { rel, src } of found) {
    const header = src.split(/\bclass\s+\w+Test\b/)[0];
    if (/@Disabled\b/.test(header)) continue;
    for (const m of methods(src)) if (/@Test\b/.test(m.ann) && !/@Disabled\b/.test(m.ann)) active.push({ rel, ...m });
  }
  const accepted = []; const rejected = [];
  let generated = false;
  for (const m of active) {
    for (const stmt of m.body.split(';')) {
      const vs = values(stmt);
      if (REJECTS.test(stmt)) rejected.push(...vs);
      else if (ACCEPTS.test(stmt)) accepted.push(...vs);
      if (/withGeneratedName/.test(m.body) && /vm-\[0-9a-f\]\{8\}/.test(m.body)) generated = true;
    }
  }
  const strs = (a) => a.filter((v) => typeof v === 'string');
  const missing = [];
  const need = (ok, what) => { if (!ok) missing.push(what); };
  need(strs(accepted).some((v) => v.length === 41 && /^[a-z0-9][a-z0-9-]*$/.test(v)), 'a 41-character name accepted');
  need(strs(rejected).some((v) => v.length === 42 && /^[a-z0-9][a-z0-9-]*$/.test(v)), 'a 42-character name rejected');
  need(rejected.includes('Web-01'), 'upper case (Web-01) rejected');
  need(strs(rejected).some((v) => / /.test(v.trim())), 'a space (web 01) rejected');
  need(strs(rejected).some((v) => v.includes('_')), 'an underscore rejected');
  need(strs(rejected).some((v) => v.startsWith('-')), 'a leading hyphen rejected');
  need(accepted.includes('web-01'), 'web-01 accepted');
  need(accepted.includes(null), 'null accepted');
  need(strs(accepted).some((v) => v.trim() === ''), 'blank accepted');
  need(generated || strs(accepted).some((v) => /^vm-[0-9a-f]{8}$/.test(v)), 'vm-<hash8> accepted');
  assert.deepEqual(missing, [], `active @Test methods in ${UNIT_TESTS.join(', ')} (${active.map((m) => m.name).join(', ')}) miss cases`);
});

test('criterion 3: the unit tests that check names through SpecValidator expect the problem to mention the name', () => {
  const src = noComments(now(UNIT_TESTS[0]));
  assert.match(src, /SpecValidator\.problems\(/);
  assert.match(src, /contains\([^;]*name/, 'SpecValidatorTest doesn\'t check that the problem mentions the name');
});

// ------------------------------------------------------------------ 9. Docs

function checkDoc(text, what) {
  const s = squash(text.replace(/`/g, '').replace(/\*\*/g, ''));
  const say = (re, about) => assert.match(s, re, `${what} doesn't say ${about}`);
  say(/lower-?case letters, digits(,)? and hyphens/i, 'lower-case letters, digits and hyphens');
  say(/2 to 41 characters/, '2 to 41 characters');
  say(/not starting with a hyphen/, 'not starting with a hyphen');
  say(/rejected/, 'names breaking the rule are rejected');
  say(/(never|not) (lower-cased|changed|rewritten)|rather than (changed|lower-cased)/i, 'names are not changed');
  say(/batch[^.]*rejected|rejected[^.]*batch/i, 'a batch item is rejected');
  say(/(legacy|\/api\/v1\/vms)[^.]*400/i, 'legacy requests (POST /api/v1/vms) get 400');
  say(/question/, 'text requests get a question');
  say(/(missing|leave it out|left out)[^.]*generated|generated[^.]*(missing|leave it out)/i, 'a missing name is generated');
}

test('criterion 9: docs/API.md states the VM-name rule, that bad names are rejected not changed, and missing names are generated', () => {
  const api = now('docs/API.md');
  const i = api.indexOf('2 to 41');
  assert.ok(i >= 0, 'API.md doesn\'t say 2 to 41');
  const start = api.lastIndexOf('\n- ', i); const end = api.indexOf('\n- ', i);
  checkDoc(api.slice(start, end < 0 ? undefined : end), 'API.md\'s VM-name paragraph');
});

test('criterion 9: docs/USER-GUIDE.md states the VM-name rule, that bad names are rejected not changed, and missing names are generated', () => {
  const ug = now('docs/USER-GUIDE.md');
  const i = ug.indexOf('### What to say');
  assert.ok(i >= 0, 'USER-GUIDE.md has no "What to say" section');
  const j = ug.indexOf('\n### ', i + 5);
  checkDoc(ug.slice(i, j < 0 ? undefined : j), 'USER-GUIDE.md\'s "What to say"');
});

// ------------------------------------------------------------------ 10. Scope

test('criterion 10: no AP-0047 commit modifies or deletes an existing replay history', () => {
  const bad = ALL.flatMap((c) => CHANGES.get(c.sha)
    .filter(([s, p]) => p.startsWith('vm-intent/backend/src/test/resources/histories/') && s !== 'A')
    .map(([s, p]) => `${c.sha.slice(0, 8)} ${s} ${p}`));
  assert.deepEqual(bad, []);
});

test('criterion 10: no AP-0047 commit changes workflow/ or security/', () => {
  const bad = ALL.flatMap((c) => CHANGES.get(c.sha)
    .filter(([, p]) => p.startsWith(`vm-intent/${MAIN}/workflow/`) || p.startsWith(`vm-intent/${MAIN}/security/`))
    .map(([s, p]) => `${c.sha.slice(0, 8)} ${s} ${p}`));
  assert.deepEqual(bad, []);
});
