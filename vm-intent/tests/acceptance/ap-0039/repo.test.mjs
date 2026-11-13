// AP-0039 acceptance, repository half (criteria 1-6, 8's snapshot part and 9): a signed-in owner's spec hash covers
// the owner, the anonymous hash is unchanged. Checks that the unit tests exist, are active and assert the right
// things (the build gates run mvn test, so whether they pass is theirs to say), recomputes the golden hashes
// independently with node:crypto, and checks what AP-0039's commits may not change (old histories, workflow
// signatures, OpenAPI snapshots, docs/SECURITY.md, the security package) and what the docs now say.
//
// Files are read as they were at the newest AP-0039 commit that changed them (git show), and the "must not change"
// checks look only at commits whose subject starts with AP-0039:, so later requirements can change these files.
// Nothing under target/ is read.
//
//   node --test tests/acceptance/ap-0039/repo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const HIST = 'backend/src/test/resources/histories';
const TEST_SRC = 'backend/src/test/java';
const MAIN_SRC = 'backend/src/main/java';
const PKG = 'com/example/vmintent';
const VMID_TEST = `${TEST_SRC}/${PKG}/spec/VmIdentityTest.java`;
const VMID = `${MAIN_SRC}/${PKG}/spec/VmIdentity.java`;
const REPLAY = `${TEST_SRC}/${PKG}/workflow/ReplayTest.java`;

const git = (args) => execFileSync('git', args,
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
const subject = (sha) => git(['log', '-1', '--format=%s', sha]).trim();
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const flat = (s) => s.replace(/\s+/g, ' ');

// Oldest first.
const COMMITS = git(['log', '--reverse', '--format=%H', '--grep', '^AP-0039:']).split('\n').filter(Boolean);
const changed = (sha) => git(['diff', '--name-status', '--no-renames', `${sha}^`, sha]).split('\n').filter(Boolean)
  .map((l) => { const [status, path] = l.split('\t'); return { status, path }; });
const CHANGES = new Map(COMMITS.map((sha) => [sha, changed(sha)]));
const touching = (prefix) => COMMITS.filter((sha) => CHANGES.get(sha).some((c) => c.path.startsWith(prefix)));
const SRC_COMMITS = touching('vm-intent/backend/src/');
const LAST = SRC_COMMITS[SRC_COMMITS.length - 1];
const BEFORE = COMMITS.length ? `${COMMITS[0]}^` : null;
/** The commit's own changes, leaving out the acceptance tests (whose comments name the things they check). */
const ownChanges = (sha) => CHANGES.get(sha).filter((c) => !c.path.startsWith('vm-intent/tests/acceptance/'));

function at(sha, rel) {
  try { return git(['show', `${sha}:vm-intent/${rel}`]).replace(/\r\n/g, '\n'); } catch { return null; }
}
/** A file as it was at the newest AP-0039 commit that changed it (or, failing that, that changed backend/src). */
function must(rel) {
  assert.ok(LAST, 'no AP-0039 commit changes vm-intent/backend/src/');
  const own = touching(`vm-intent/${rel}`).filter((sha) => ownChanges(sha).some((c) => c.path === `vm-intent/${rel}`));
  const sha = own.length ? own[own.length - 1] : LAST;
  const t = at(sha, rel);
  assert.ok(t !== null, `${rel} doesn't exist at ${sha.slice(0, 8)}`);
  return t;
}

// --------------------------------------------------------------- Java helpers

/** Blanks comments (same length); with `strings`, also blanks string/char literal contents. */
function strip(src, strings) {
  let out = '';
  for (let i = 0; i < src.length;) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { const e = src.indexOf('\n', i); const j = e < 0 ? src.length : e; out += ' '.repeat(j - i); i = j; }
    else if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); const j = e < 0 ? src.length : e + 2; out += src.slice(i, j).replace(/[^\n]/g, ' '); i = j; }
    else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      j = Math.min(j + 1, src.length);
      out += strings ? c + ' '.repeat(Math.max(0, j - i - 2)) + (j - i >= 2 ? src[j - 1] : '') : src.slice(i, j);
      i = j;
    } else { out += c; i++; }
  }
  return out;
}

/** Every method in a Java source: its annotations, name, parameters and body (comments removed, strings kept). */
function methods(src) {
  const keep = strip(src, false), bare = strip(src, true);
  const re = /((?:@[\w.]+(?:\([^)]*\))?\s+)*)((?:(?:public|protected|private|static|final|synchronized|default|abstract)\s+)*(?:<[^>]*>\s*)?[\w.<>\[\], ?]+)\s+(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w.,\s]+)?([{;])/g;
  const out = [];
  let m;
  while ((m = re.exec(bare))) {
    if (['if', 'for', 'while', 'switch', 'catch', 'synchronized', 'return', 'new', 'else'].includes(m[3])) continue;
    if (/\b(return|new|throw)\b/.test(m[2])) continue;
    const sig = `${m[2].trim().replace(/\s+/g, ' ')} ${m[3]}(${m[4].replace(/\s+/g, ' ').trim()})`;
    if (m[5] === ';') { out.push({ annotations: m[1] || '', name: m[3], sig, body: '' }); continue; }
    const open = m.index + m[0].length - 1;
    let depth = 0, end = bare.length;
    for (let k = open; k < bare.length; k++) {
      if (bare[k] === '{') depth++;
      else if (bare[k] === '}' && --depth === 0) { end = k; break; }
    }
    out.push({ annotations: m[1] || '', name: m[3], sig, body: keep.slice(open + 1, end) });
  }
  return out;
}
const active = (m) => /@Test\b/.test(m.annotations) && !/@Disabled\b/.test(m.annotations);
function classDisabled(src) {
  const bare = strip(src, true);
  return /@Disabled\b/.test(bare.slice(0, bare.search(/\bclass\s+\w+/)));
}

/** The value of a `static final String NAME = "..." + "...";` constant. */
function javaConst(src, name) {
  const m = strip(src, false).match(new RegExp(`\\bString\\s+${name}\\s*=\\s*([^;]+);`));
  if (!m) return null;
  const parts = [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((p) => p[1].replace(/\\(.)/g, '$1'));
  return parts.join('');
}

/** Test sources as they were at the last AP-0039 commit that changed backend/src. */
let sources;
function testSources() {
  assert.ok(LAST, 'no AP-0039 commit changes vm-intent/backend/src/');
  if (sources) return sources;
  const files = git(['ls-tree', '--full-tree', '-r', '--name-only', LAST, `vm-intent/${TEST_SRC}`]).split('\n')
    .filter((p) => p.endsWith('.java'));
  return (sources = files.map((p) => ({ path: p, src: git(['show', `${LAST}:${p}`]).replace(/\r\n/g, '\n') })));
}
/** Active @Test methods (in classes that aren't @Disabled) that satisfy `pred`. */
function activeTests(pred) {
  const found = [];
  for (const { path, src } of testSources()) {
    if (classDisabled(src)) continue;
    const ms = methods(src);
    for (const m of ms) if (active(m) && pred(m, ms, src, path)) found.push({ ...m, path });
  }
  return found;
}
/** Every `VmIdentity.hash(spec, "owner")` call inside a piece of code. */
const hashCalls = (code) => [...code.matchAll(/VmIdentity\s*\.\s*hash\s*\(\s*([^,()]+(?:\([^()]*\))?)\s*,\s*("([^"]*)"|null)\s*\)/g)]
  .map((m) => ({ spec: m[1].trim(), owner: m[2] === 'null' ? null : m[3] }));
/** The statements of a body that call the given assertion. */
const asserts = (body, name) => [...body.matchAll(new RegExp(`\\b${name}\\s*\\(([\\s\\S]*?)\\);`, 'g'))].map((m) => m[1]);

// --------------------------------------------------------------- criteria

test('AP-0039 has commits that change backend/src', () => {
  assert.ok(COMMITS.length > 0, 'no commit subject starts with AP-0039:');
  assert.ok(LAST, `no AP-0039 commit changes vm-intent/backend/src/ (${COMMITS.map(subject).join(' | ')})`);
});

test('criterion 1: anonymous owners still get SpecCanonicalizer.hash (main code)', () => {
  const src = strip(must(VMID), false);
  const hash = methods(src).find((m) => m.name === 'hash' && /VmSpec\s+\w+\s*,\s*String\s+\w+/.test(m.sig));
  assert.ok(hash, 'VmIdentity has no hash(VmSpec, String)');
  assert.match(hash.body, /if\s*\(\s*isAnonymous\s*\(\s*\w+\s*\)\s*\)\s*return\s+SpecCanonicalizer\s*\.\s*hash\s*\(\s*\w+\s*\)\s*;/,
    `anonymous branch of VmIdentity.hash: ${flat(hash.body)}`);
  const anon = methods(src).find((m) => m.name === 'isAnonymous');
  assert.ok(anon, 'VmIdentity has no isAnonymous');
  assert.match(anon.body, /null/);
  // "anonymous", written out or as a String constant whose value it is.
  const named = [...anon.body.matchAll(/\b([A-Z_]+)\s*\.\s*equals\s*\(/g)].map((m) => m[1]);
  assert.ok(/"anonymous"/.test(anon.body) || named.some((n) => javaConst(src, n) === 'anonymous'),
    `isAnonymous doesn't compare with "anonymous": ${flat(anon.body)}`);
});

test('criterion 1: the golden canonical strings and hashes are unchanged, and are the SHA-256 of the canonical strings', () => {
  const now = must(VMID_TEST);
  const was = at(BEFORE, VMID_TEST);
  assert.ok(was, `VmIdentityTest.java did not exist before AP-0039 (${BEFORE})`);
  for (const name of ['NAMED_CANONICAL', 'NAMED_HASH', 'UNNAMED_CANONICAL', 'UNNAMED_HASH']) {
    const a = javaConst(was, name), b = javaConst(now, name);
    assert.ok(a, `${name} not found before AP-0039`);
    assert.equal(b, a, `${name} changed`);
  }
  // Worked out here, independently of Java.
  assert.equal(sha256(javaConst(now, 'NAMED_CANONICAL')), javaConst(now, 'NAMED_HASH'));
  assert.equal(sha256(javaConst(now, 'UNNAMED_CANONICAL')), javaConst(now, 'UNNAMED_HASH'));
  assert.equal(javaConst(now, 'NAMED_HASH'), '2a616b09f0ae398fdb96bb9ccb6b15a79d901fa4b8a4bb670c35d3a333148d4a');
  assert.equal(javaConst(now, 'UNNAMED_HASH'), 'f2828963ebcdbc7aef820bcd659f596a71ba4162248b1f3a6c4a79dc89db6cc1');
});

test('criterion 1: active @Test anonymousOwnersGetTodaysHash pins hash(spec, null) and hash(spec, "anonymous") '
  + 'to SpecCanonicalizer.hash and the golden values; theCanonicalStringsAreUnchanged is still active', () => {
  const src = must(VMID_TEST);
  assert.ok(!classDisabled(src), 'VmIdentityTest is @Disabled');
  const ms = methods(src);
  const canon = ms.find((m) => m.name === 'theCanonicalStringsAreUnchanged');
  assert.ok(canon && active(canon), 'theCanonicalStringsAreUnchanged is missing or not an active @Test');
  assert.match(canon.body, /assertEquals\s*\(\s*NAMED_CANONICAL\s*,\s*SpecCanonicalizer\s*\.\s*canonicalString\s*\(\s*NAMED\s*\)/);
  assert.match(canon.body, /assertEquals\s*\(\s*UNNAMED_CANONICAL\s*,\s*SpecCanonicalizer\s*\.\s*canonicalString\s*\(\s*UNNAMED\s*\)/);
  const anon = ms.find((m) => m.name === 'anonymousOwnersGetTodaysHash');
  assert.ok(anon && active(anon), 'anonymousOwnersGetTodaysHash is missing or not an active @Test');
  const eq = asserts(anon.body, 'assertEquals').map(flat);
  assert.ok(eq.some((a) => /SpecCanonicalizer\s*\.\s*hash\s*\(/.test(a)), `no assertEquals on SpecCanonicalizer.hash: ${eq.join(' | ')}`);
  assert.ok(eq.some((a) => hashCalls(a).some((c) => c.owner === null)), `no assertEquals on VmIdentity.hash(spec, null): ${eq.join(' | ')}`);
  assert.ok(eq.some((a) => hashCalls(a).some((c) => c.owner === 'anonymous')), `no assertEquals on VmIdentity.hash(spec, "anonymous"): ${eq.join(' | ')}`);
  assert.match(anon.body, /NAMED_HASH/);
  assert.match(anon.body, /UNNAMED_HASH/);
});

test('criterion 2: an active @Test shows two signed-in owners get different 64-char lowercase hex hashes, '
  + 'neither the anonymous one', () => {
  const found = activeTests((m) => {
    const owners = new Set(hashCalls(m.body).map((c) => c.owner).filter((o) => o && o !== 'anonymous'));
    return owners.size >= 2 && /assertNotEquals\s*\(/.test(m.body)
      && /\[0-9a-f\]\{64\}/.test(m.body)
      && /(_HASH|SpecCanonicalizer\s*\.\s*hash|anonymous)/.test(m.body);
  });
  assert.ok(found.length >= 1, 'no active @Test hashes one spec for two signed-in owners, asserts they differ from '
    + 'each other and from the anonymous hash and that each matches [0-9a-f]{64}');
  // The two owners' hashes and the anonymous hash are compared pairwise.
  const m = found[0];
  const ne = asserts(m.body, 'assertNotEquals').length;
  assert.ok(ne >= 3, `${m.path}#${m.name} has only ${ne} assertNotEquals (alice/bob, anonymous/alice, anonymous/bob)`);
});

test('criterion 3: an active @Test shows the same signed-in owner gets the same hash for a spec, and another '
  + 'hash for another spec', () => {
  const found = activeTests((m) => {
    const same = asserts(m.body, 'assertEquals').some((a) => {
      const c = hashCalls(a);
      return c.length >= 2 && c[0].owner && c[0].owner !== 'anonymous' && c[0].owner === c[1].owner && c[0].spec === c[1].spec;
    });
    const other = asserts(m.body, 'assertNotEquals').some((a) => {
      const c = hashCalls(a);
      return c.length >= 2 && c[0].owner && c[0].owner !== 'anonymous' && c[0].owner === c[1].owner && c[0].spec !== c[1].spec;
    });
    return same && other;
  });
  assert.ok(found.length >= 1, 'no active @Test asserts hash(X, u) == hash(X, u) and hash(X, u) != hash(Y, u) for a signed-in u');
});

test('criterion 3: the pinned signed-in hash in VmIdentityTest is the SHA-256 of "owner:5:alice" + NAMED_CANONICAL', () => {
  // Only if the test pins one: it makes "the same every time" hold across servers too.
  const src = must(VMID_TEST);
  const pinned = javaConst(src, 'NAMED_ALICE_HASH');
  if (pinned === null) return;
  const main = strip(must(VMID), false);
  const owned = methods(main).find((m) => m.name === 'ownedString');
  assert.ok(owned, 'VmIdentity.ownedString is gone but NAMED_ALICE_HASH is pinned');
  assert.equal(pinned, sha256('owner:5:alice' + javaConst(src, 'NAMED_CANONICAL')));
  assert.ok(!pinned.startsWith(javaConst(src, 'NAMED_HASH')));
});

test('criterion 4: an active @Test in RequestOwnerFlowTest (or similar) signs in alice, bob, alice through the '
  + 'request controller: bob is not DUPLICATE and gets his own vm-<hash> build, alice\'s repeat is DUPLICATE and '
  + 'builds nothing', () => {
  const found = activeTests((m, ms, src) => {
    const b = m.body;
    const ia = b.indexOf('signIn("alice")'), ib = b.indexOf('signIn("bob")'), ia2 = b.indexOf('signIn("alice")', ib + 1);
    if (!(ia >= 0 && ib > ia && ia2 > ib)) return false;
    // Through the controller: the method or a helper it calls submits via the RequestController.
    const helpers = ms.filter((h) => h !== m && new RegExp(`\\b${h.name}\\s*\\(`).test(b));
    const all = [b, ...helpers.map((h) => h.body), ...helpers.flatMap((h) => ms.filter((g) => g !== h
      && new RegExp(`\\b${g.name}\\s*\\(`).test(h.body)).map((g) => g.body))].join('\n');
    const viaController = /\brequests\s*\.\s*(submit|create\w*)\s*\(/.test(all) && /\brequests\s*\.\s*confirm\s*\(/.test(all);
    const buildIds = /VmIdentity\s*\.\s*buildWorkflowId\s*\(/.test(all);
    return viaController && buildIds && /"DUPLICATE"/.test(b.slice(ia2)) && /"COMPLETED"/.test(b.slice(ib, ia2))
      && /assertNotEquals\s*\(/.test(b.slice(ib, ia2)) && /createdCount\s*\(\s*\)/.test(b.slice(ia2));
  });
  assert.ok(found.length >= 1, 'no such test for POST /api/v2/requests');
});

test('criterion 4: an active @Test does the same through the batch controller (bob\'s item is not a duplicate, '
  + 'alice\'s repeat counts as duplicate and builds nothing)', () => {
  const found = activeTests((m, ms) => {
    const b = m.body;
    const ia = b.indexOf('signIn("alice")'), ib = b.indexOf('signIn("bob")'), ia2 = b.indexOf('signIn("alice")', ib + 1);
    if (!(ia >= 0 && ib > ia && ia2 > ib)) return false;
    const helpers = ms.filter((h) => h !== m && new RegExp(`\\b${h.name}\\s*\\(`).test(b));
    const all = [b, ...helpers.map((h) => h.body), ...helpers.flatMap((h) => ms.filter((g) => g !== h
      && new RegExp(`\\b${g.name}\\s*\\(`).test(h.body)).map((g) => g.body))].join('\n');
    return /\bbatches\s*\.\s*submit\s*\(/.test(all) && /VmIdentity\s*\.\s*buildWorkflowId\s*\(/.test(all)
      && /duplicate\s*\(\s*\)/.test(b.slice(ib, ia2)) && /duplicate\s*\(\s*\)/.test(b.slice(ia2))
      && /assertNotEquals\s*\(/.test(b.slice(ib, ia2)) && /createdCount\s*\(\s*\)/.test(b.slice(ia2));
  });
  assert.ok(found.length >= 1, 'no such test for POST /api/v2/batches');
});

test('criterion 4: an active @Test runs a catalog vm.create (CatalogActivitiesImpl) for two owners and shows the '
  + 'owner changes the prepared hash', () => {
  const found = activeTests((m, ms, src) => /CatalogActivitiesImpl/.test(src)
    && /"alice"/.test(m.body) && /"bob"/.test(m.body) && /specHash/.test(m.body)
    && /"create"/.test(m.body) && hashCalls(m.body).some((c) => c.owner === 'alice')
    && hashCalls(m.body).some((c) => c.owner === 'bob')
    && (/assertNotEquals\s*\(/.test(m.body) || /Set\s*\.\s*of\s*\([^)]*\)\s*\.\s*size\s*\(\s*\)/.test(m.body)));
  assert.ok(found.length >= 1, 'no catalog test compares the prepared spec hash of two owners');
});

test('criterion 5: an active @Test shows a body userId "mallory" with sign-in off gets the anonymous hash', () => {
  const found = activeTests((m) => {
    const b = m.body;
    const im = b.indexOf('"mallory"');
    if (im < 0) return false;
    const firstSignIn = b.search(/signIn\s*\(/);
    const head = firstSignIn < 0 ? b : b.slice(0, firstSignIn);
    // Before anyone signs in: an assertEquals ties the request's specHash to SpecCanonicalizer.hash.
    return head.includes('"mallory"') && asserts(head, 'assertEquals').some((a) =>
      /SpecCanonicalizer\s*\.\s*hash\s*\(/.test(a) && /specHash/.test(a));
  });
  assert.ok(found.length >= 1, 'no active @Test sends userId "mallory" with sign-in off and asserts the specHash is SpecCanonicalizer.hash');
  // And the file signs out between tests, so "sign-in off" really is off.
  const src = testSources().find((s) => s.path === found[0].path).src;
  assert.match(strip(src, false), /@AfterEach[\s\S]*?SecurityContextHolder\s*\.\s*clearContext\s*\(\s*\)/,
    `${found[0].path} does not clear the sign-in after each test`);
});

test('criterion 5: the main code takes the owner from sign-in, not from userId/requestedBy', () => {
  // The hash sites call VmIdentity.hash with an owner; none passes a body field.
  const files = git(['ls-tree', '--full-tree', '-r', '--name-only', LAST, `vm-intent/${MAIN_SRC}`]).split('\n')
    .filter((p) => p.endsWith('.java'));
  const bad = [];
  for (const p of files) {
    const src = strip(git(['show', `${LAST}:${p}`]), false);
    for (const m of src.matchAll(/VmIdentity\s*\.\s*hash\s*\(([^;]*?)\)\s*[;,)]/g)) {
      if (/userId|requestedBy/i.test(m[1])) bad.push(`${p}: ${flat(m[0])}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('criterion 6: no AP-0039 commit modifies or deletes an existing history file', () => {
  assert.ok(BEFORE, 'no AP-0039 commits');
  const before = git(['ls-tree', '--full-tree', '--name-only', BEFORE, `vm-intent/${HIST}/`]).split('\n').filter(Boolean);
  for (const n of ['intent-v2-signed-in.json', 'catalog-v3-signed-in.json']) {
    assert.ok(before.includes(`vm-intent/${HIST}/${n}`), `${n} did not exist before AP-0039`);
  }
  for (const sha of COMMITS) {
    const bad = CHANGES.get(sha).filter((c) => c.path.startsWith(`vm-intent/${HIST}/`) && c.status !== 'A');
    assert.deepEqual(bad, [], `${sha.slice(0, 8)} ${subject(sha)} changes histories`);
  }
  const last = COMMITS[COMMITS.length - 1];
  for (const p of before) {
    assert.equal(git(['rev-parse', `${last}:${p}`]).trim(), git(['rev-parse', `${BEFORE}:${p}`]).trim(), `${p} differs after AP-0039`);
  }
});

test('criterion 6: ReplayTest still replays every saved history, including both signed-in ones', () => {
  const src = must(REPLAY);
  const factory = methods(src).find((m) => m.name === 'everySavedHistoryReplays');
  assert.ok(factory && /@TestFactory\b/.test(factory.annotations) && !/@Disabled\b/.test(factory.annotations),
    'ReplayTest has no active @TestFactory everySavedHistoryReplays');
  assert.match(factory.body, /Files\s*\.\s*list\s*\(\s*HistoryRecorder\s*\.\s*DIR\s*\)/);
  assert.match(factory.body, /WorkflowReplayer\s*\.\s*replayWorkflowExecution\s*\(/);
  assert.ok(!classDisabled(src), 'ReplayTest is @Disabled');
  const tree = git(['ls-tree', '--full-tree', '--name-only', LAST, `vm-intent/${HIST}/`]);
  for (const f of ['intent-v2-signed-in.json', 'catalog-v3-signed-in.json']) assert.ok(tree.includes(f), `${f} not in ${HIST}`);
});

test('criterion 6: no AP-0039 commit changes a workflow interface or implementation signature', () => {
  const bad = [];
  for (const sha of COMMITS) {
    for (const c of ownChanges(sha)) {
      if (!c.path.startsWith(`vm-intent/${MAIN_SRC}/`) || !c.path.endsWith('.java')) continue;
      const rel = c.path.slice('vm-intent/'.length);
      const was = at(`${sha}^`, rel), now = at(sha, rel);
      const isWorkflow = (s) => s && (/@WorkflowInterface\b/.test(s) || /\bimplements\s+[\w\s,.]*Workflow\b/.test(strip(s, true)));
      if (!isWorkflow(was) && !isWorkflow(now)) continue;
      if (c.status === 'D' || c.status === 'A') { bad.push(`${c.status} ${rel}`); continue; }
      const sigs = (s) => methods(strip(s, false)).filter((m) => !/\bprivate\b/.test(m.sig)).map((m) => m.sig).sort();
      if (JSON.stringify(sigs(was)) !== JSON.stringify(sigs(now))) bad.push(`${sha.slice(0, 8)} ${rel}`);
    }
  }
  assert.deepEqual(bad, [], 'workflow classes whose signatures changed');
});

test('criterion 8: no AP-0039 commit changes docs/openapi.json or docs/openapi.yaml', () => {
  for (const sha of COMMITS) {
    const bad = CHANGES.get(sha).filter((c) => /^vm-intent\/docs\/openapi\.(json|yaml)$/.test(c.path));
    assert.deepEqual(bad, [], `${sha.slice(0, 8)} ${subject(sha)} changes the OpenAPI snapshots`);
  }
});

// --------------------------------------------------------------- docs (criterion 9)

const DOCS = { definitions: 'docs/DEFINITIONS.md', api: 'docs/API.md', guide: 'docs/USER-GUIDE.md' };
const doc = (rel) => {
  const own = COMMITS.filter((sha) => ownChanges(sha).some((c) => c.path === `vm-intent/${rel}`));
  assert.ok(own.length, `no AP-0039 commit changes ${rel}`);
  return flat(at(own[own.length - 1], rel));
};

test('criterion 9: DEFINITIONS.md drops "Today the owner does not change the hash" and states the new rule', () => {
  const t = doc(DOCS.definitions);
  assert.doesNotMatch(t, /Today the owner does not change the hash/i);
  assert.doesNotMatch(t, /owner (does not|doesn't) change the hash/i);
  assert.match(t, /anonymous[^.]*SHA-256 of the spec's canonical string|SHA-256 of the spec's canonical string[^.]*anonymous/i,
    'anonymous = the spec\'s SHA-256');
  assert.match(t, /signed-in user's hash also covers (their|the) user ID/i);
  assert.match(t, /duplicates are found within one user/i);
  assert.match(t, /existing VMs keep their hash/i);
});

test('criterion 9: API.md says what counts as a duplicate', () => {
  const t = doc(DOCS.api);
  assert.match(t, /duplicate is the same spec from the same user,? or from anyone when sign-in is off/i);
  assert.match(t, /never from `?userId`? or `?requestedBy`?/i);
});

test('criterion 9: USER-GUIDE.md says another user\'s identical request is no longer your duplicate', () => {
  const t = doc(DOCS.guide);
  assert.match(t, /another user's identical request no longer shows up as your duplicate/i);
});

for (const [key, rel] of Object.entries(DOCS)) {
  test(`criterion 9: ${rel} says same-named VMs of two users are refused with InvalidSpec on a real vSphere route `
    + 'until the cloud-name suffix (part 2), while the simulator builds both', () => {
    const t = doc(rel);
    const para = t.split(/(?=Until )/).find((s) => /suffix/i.test(s.slice(0, 200)));
    assert.ok(para, `${rel}: no "Until ... suffix" caveat`);
    const s = para.slice(0, 900);
    assert.match(s, /per-user suffix/i);
    assert.match(s, /part 2|later change/i, `${rel}: the suffix comes later (part 2)`);
    assert.match(s, /real vSphere route/i);
    assert.match(s, /InvalidSpec/);
    assert.match(s, /simulated clouds[^.]*build both|simulator[^.]*builds? both/i);
    void key;
  });
}

test('criterion 9: no AP-0039 commit touches docs/SECURITY.md or the security package', () => {
  for (const sha of COMMITS) {
    const bad = CHANGES.get(sha).filter((c) => c.path === 'vm-intent/docs/SECURITY.md'
      || c.path.startsWith(`vm-intent/${MAIN_SRC}/${PKG}/security/`));
    assert.deepEqual(bad, [], `${sha.slice(0, 8)} ${subject(sha)}`);
  }
});
