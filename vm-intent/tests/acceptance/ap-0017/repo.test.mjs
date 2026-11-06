// AP-0017 acceptance, repository half: AzureArmBackend builds, reads and removes one tagged Linux VM (public IP, NIC,
// VM) one step per call with ArmClient's begin/get, its settings live in a new class bound in application.yml,
// AzureArmBackendTest covers it against MockArm, docs/AZURE.md describes it, and no AP-0017 commit touches
// AzureProvider, the workflow/activity interfaces, REST controllers, docs/openapi.*, deploy/ or ArmClient's
// existing public methods. Covers criteria 1-10 and the commit part of 11 by reading files and git history.
// `mvn test` itself (criterion 10) is run by the pipeline's build gate, not here.
//
//   node --test tests/acceptance/ap-0017/repo.test.mjs
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
const YML = join(ROOT, 'backend', 'src', 'main', 'resources', 'application.yml');
const ARM_REL = 'backend/src/main/java/com/example/vmintent/provider/azure/ArmClient.java';
const PROPS_REL = 'backend/src/main/java/com/example/vmintent/provider/azure/AzureProperties.java';

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

const backendFile = join(MAIN, 'AzureArmBackend.java');
const testFile = join(TEST, 'AzureArmBackendTest.java');
const src = () => noComments(read(backendFile));
const unit = () => noComments(read(testFile));
const tests = () => [...testMethods(unit()).entries()];
/** The test source with its helper methods: a check may sit in a helper the @Test calls. */
const someTest = (res, what) => {
  const hit = tests().find(([, b]) => res.every((r) => r.test(b)));
  assert.ok(hit, `a test in AzureArmBackendTest shows ${what}`);
  return hit;
};

const PUBLIC = {
  plan: /public\s+ProviderPlan\s+plan\s*\(\s*VmSpec\s+\w+\s*\)\s*\{/,
  createVm: /public\s+String\s+createVm\s*\(\s*VmSpec\s+\w+\s*,\s*ProviderPlan\s+\w+\s*,\s*String\s+\w+\s*\)\s*\{/,
  describeVm: /public\s+VmStatus\s+describeVm\s*\(\s*String\s+\w+\s*\)\s*\{/,
  deleteVm: /public\s+void\s+deleteVm\s*\(\s*String\s+\w+\s*\)\s*\{/,
  owns: /public\s+static\s+boolean\s+owns\s*\(\s*String\s+\w+\s*\)\s*\{/,
};
const body = (name) => {
  const b = methodBody(src(), PUBLIC[name]);
  assert.ok(b !== null, `AzureArmBackend has ${name}`);
  return b;
};
/** The name of the ArmClient field. */
const clientVar = () => {
  const m = /private\s+(?:final\s+)?ArmClient\s+(\w+)\s*;/.exec(src());
  assert.ok(m, 'AzureArmBackend keeps an ArmClient field');
  return m[1];
};
/** Bodies of the private helpers (by name) that a method body calls, one level deep, plus the body itself. */
function withHelpers(b) {
  const s = src();
  let out = b;
  for (const m of b.matchAll(/\b([a-z]\w*)\s*\(/g)) {
    const h = methodBody(s, new RegExp(`(?:private|static)\\s+[\\w<>,\\s]*?\\b${m[1]}\\s*\\([^)]*\\)\\s*\\{`));
    if (h) out += '\n' + h;
  }
  return out;
}

const aps17 = () => git(['log', '--format=%H', '--no-merges', '--grep=^AP-0017:']).split('\n').filter(Boolean);
const changedFiles = (sha) => git(['show', '--name-only', '--format=', sha]).split('\n').map((s) => s.trim()).filter(Boolean);

// ---- Criterion 1 ----
test('1: AzureArmBackend exists with public plan, createVm, describeVm, deleteVm and static owns', () => {
  assert.ok(existsSync(backendFile), 'provider/azure/AzureArmBackend.java exists');
  assert.match(src(), /public\s+(final\s+)?class\s+AzureArmBackend\b/, 'public class AzureArmBackend');
  for (const [name, re] of Object.entries(PUBLIC)) assert.match(src(), re, `public ${name} with the right signature`);
});

test('1: VM IDs are arm:<resource-group>:<vm-name>; owns() is true only for that prefix, never for az-vm-', () => {
  const s = src();
  const prefix = /String\s+PREFIX\s*=\s*"([^"]+)"/.exec(s)?.[1];
  assert.equal(prefix, 'arm:', 'the VM ID prefix is "arm:"');
  assert.ok(!'az-vm-x'.startsWith(prefix), 'the prefix is not the simulator\'s');
  assert.match(body('owns'), /startsWith\(\s*PREFIX\s*\)|startsWith\(\s*"arm:"\s*\)/, 'owns() checks the arm: prefix');
  assert.match(s, /PREFIX\s*\+\s*cfg\.resourceGroup\(\)\s*\+\s*":"\s*\+\s*\w+/, 'the ID is PREFIX + resource group + ":" + name');
  someTest([/owns\(\s*"arm:/, /assertTrue/, /owns\(\s*"az-vm-/, /assertFalse/], 'owns() true for arm:..., false for az-vm-...');
});

test('1: AzureArmBackend uses ArmClient begin and get, and never the blocking put(..) or delete(..)', () => {
  const s = src();
  const c = clientVar();
  assert.match(s, new RegExp(`\\b${c}\\.begin\\(`), 'calls client.begin(..)');
  assert.match(s, new RegExp(`\\b${c}\\.get\\(`), 'calls client.get(..)');
  assert.doesNotMatch(s, new RegExp(`\\b${c}\\.(put|delete)\\(`), 'never calls client.put(..) or client.delete(..)');
  assert.doesNotMatch(s, /awaitIfAsync|Thread\.sleep|\.sleep\(/, 'never waits');
});

// ---- Criterion 2 ----
test('2: the new settings are in a new @ConfigurationProperties("vmintent.azure") class, not in AzureProperties', () => {
  const files = readdirSync(MAIN).filter((f) => f.endsWith('.java') && f !== 'AzureProperties.java');
  const hit = files.map((f) => [f, noComments(read(join(MAIN, f)))])
    .find(([, t]) => /@ConfigurationProperties\(\s*(prefix\s*=\s*)?"vmintent\.azure"\s*\)/.test(t) && /subnetId/.test(t));
  assert.ok(hit, 'a new class in provider/azure binds vmintent.azure with subnetId');
  const [f, t] = hit;
  for (const n of ['subnetId', 'adminUsername', 'adminSshPublicKey']) assert.match(t, new RegExp(`\\b${n}\\b`), `${f} has ${n}`);
  const props = noComments(read(join(MAIN, 'AzureProperties.java')));
  assert.doesNotMatch(props, /subnet|adminUsername|SshPublicKey/i, 'AzureProperties gains no new component');
});

test('2: no AP-0017 commit changes the AzureProperties record components', () => {
  const header = (t) => /record\s+AzureProperties\s*\(([^)]*)\)/.exec(noComments(t))?.[1].replace(/\s+/g, ' ').trim();
  for (const sha of aps17()) {
    if (!changedFiles(sha).some((f) => f.endsWith(PROPS_REL))) continue;
    const before = header(git(['show', `${sha}^:vm-intent/${PROPS_REL}`]));
    const after = header(git(['show', `${sha}:vm-intent/${PROPS_REL}`]));
    assert.equal(after, before, `${sha.slice(0, 7)} keeps AzureProperties(${before})`);
  }
});

test('2: application.yml binds subnet-id, admin-username and admin-ssh-public-key under vmintent.azure to env vars', () => {
  const y = read(YML);
  const azure = /^ {2}azure:\s*$([\s\S]*?)(?=^ {2}\S|^\S)/m.exec(y);
  assert.ok(azure, 'application.yml has vmintent.azure');
  const block = azure[1];
  const val = (k) => new RegExp(`^ {4}${k}:\\s*(\\S+)`, 'm').exec(block)?.[1];
  assert.equal(val('subnet-id'), '${VMINTENT_AZURE_SUBNET_ID:}', 'subnet-id from VMINTENT_AZURE_SUBNET_ID, empty default');
  assert.match(val('admin-username') || '', /^\$\{VMINTENT_AZURE_ADMIN_USERNAME:(azureuser)?\}$/, 'admin-username from VMINTENT_AZURE_ADMIN_USERNAME');
  assert.equal(val('admin-ssh-public-key'), '${VMINTENT_AZURE_ADMIN_SSH_PUBLIC_KEY:}', 'admin-ssh-public-key from VMINTENT_AZURE_ADMIN_SSH_PUBLIC_KEY, empty default');
});

test('2: no AP-0017 commit adds a secret, password or private key to any file', () => {
  for (const sha of aps17()) {
    // The acceptance tests name these patterns themselves; scan everything else the commit adds.
    const added = git(['show', '--format=', '--unified=0', sha, '--', ':(top)', ':(top,exclude)vm-intent/tests/acceptance']).split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
    assert.doesNotMatch(added, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, `${sha.slice(0, 7)} adds no private key`);
    assert.doesNotMatch(added, /\b(client-secret|password|adminPassword)\s*:\s*(?!\$\{)[^\s#]+/i, `${sha.slice(0, 7)} adds no literal secret/password setting`);
    assert.doesNotMatch(added, /"adminPassword"/, `${sha.slice(0, 7)} sends no admin password`);
    // A real-looking SSH public key in main sources or config (test data is fine).
    for (const m of added.matchAll(/ssh-(rsa|ed25519) AAAA[0-9A-Za-z+/]{40,}/g)) assert.fail(`${sha.slice(0, 7)} adds a full SSH key: ${m[0].slice(0, 30)}...`);
  }
});

test('2: no log statement in provider/azure logs the client secret, the access token or the SSH key', () => {
  for (const f of readdirSync(MAIN).filter((x) => x.endsWith('.java'))) {
    const t = noComments(read(join(MAIN, f)));
    for (const m of t.matchAll(/\blog\.(trace|debug|info|warn|error)\s*\(([\s\S]*?)\);/g)) {
      const stmt = m[2];
      assert.doesNotMatch(stmt, /clientSecret|client_secret|accessToken|access_token|bearer|token\b|SshPublicKey|keyData|\bvm\)|\bcfg\)/i,
        `${f}: log statement shows no secret, token or key: log.${m[1]}(${stmt.replace(/\s+/g, ' ').slice(0, 160)})`);
    }
  }
});

// ---- Criterion 3 ----
test('3: createVm starts the public IP, then the NIC (subnet + that IP), then the VM, each only once the one before is Succeeded', () => {
  const b = body('createVm');
  const pip = b.search(/"-pip"/);
  const nic = b.search(/"-nic"/);
  const vm = b.search(/\.begin\(\s*"PUT"\s*,\s*path\(\s*COMPUTE|\.begin\(\s*"PUT"[^;]*virtualMachines/);
  assert.ok(pip >= 0 && nic > pip && vm > nic, 'the public IP, then the NIC, then the VM PUT, in that order');
  assert.match(b.slice(pip, vm), /subnetId\(\)/, 'the NIC is on the configured subnet');
  assert.match(b.slice(nic, vm), /publicIPAddress"\s*,\s*Map\.of\(\s*"id"\s*,\s*pip\./, 'the NIC uses the public IP');
  const helper = /JsonNode\s+(\w+)\s*=\s*(\w+)\(\s*path\(\s*NETWORK\s*,\s*"publicIPAddresses"/.exec(b);
  assert.ok(helper, 'the public IP goes through a helper that waits for it');
  const h = methodBody(src(), new RegExp(`private\\s+JsonNode\\s+${helper[2]}\\s*\\([^)]*\\)\\s*\\{`));
  assert.ok(h, `${helper[2]}(..) exists`);
  assert.match(h, /\.begin\(\s*"PUT"/, `${helper[2]} starts the PUT when missing`);
  assert.match(h, /"Succeeded"\.equals\(\s*\w+\s*\)\)\s*return/, `${helper[2]} returns only when Succeeded`);
  assert.match(h, /throw\s+busy\(/, `${helper[2]} throws CloudBusy otherwise`);
  assert.match(src(), /ApplicationFailure\.newFailure\([\s\S]{0,300}?"CloudBusy"\s*\)/, 'busy(..) is a retryable ApplicationFailure of type CloudBusy');
  assert.match(b, /\breturn\s+vmId\(\s*\w+\s*\)\s*;\s*$/, 'createVm returns the VM ID after starting the VM PUT');
});

test('3: all three resources get the tags vm-intent=managed and vm-intent-key=<idempotencyKey>', () => {
  const s = src();
  assert.match(s, /TAG\s*=\s*"vm-intent"/, 'tag name vm-intent');
  assert.match(s, /MANAGED\s*=\s*"managed"/, 'tag value managed');
  assert.match(s, /KEY_TAG\s*=\s*"vm-intent-key"/, 'tag name vm-intent-key');
  const b = body('createVm');
  const key = /String\s+createVm\s*\(\s*VmSpec\s+\w+\s*,\s*ProviderPlan\s+\w+\s*,\s*String\s+(\w+)\s*\)/.exec(s)[1];
  assert.match(b, new RegExp(`(\\w+)\\s*=\\s*Map\\.of\\(\\s*TAG\\s*,\\s*MANAGED\\s*,\\s*KEY_TAG\\s*,\\s*${key}\\s*\\)`), 'tags = {vm-intent: managed, vm-intent-key: key}');
  const tagsVar = new RegExp(`(\\w+)\\s*=\\s*Map\\.of\\(\\s*TAG`).exec(b)[1];
  assert.equal((b.match(new RegExp(`"tags"\\s*,\\s*${tagsVar}\\b`, 'g')) || []).length, 3, 'all three bodies carry the tags');
});

test('3: AzureArmBackendTest drives createVm with pollsUntilDone > 1, catching CloudBusy, under 5 s per call, one PUT each', () => {
  assert.ok(existsSync(testFile), 'AzureArmBackendTest.java exists');
  const u = unit();
  assert.match(u, /pollsUntilDone\s*=\s*([2-9]|\d{2,})\s*;/, 'sets MockArm.pollsUntilDone above 1');
  assert.match(u, /catch\s*\(\s*ApplicationFailure[\s\S]{0,200}"CloudBusy"/, 'catches CloudBusy and calls again');
  assert.match(u, /nanoTime\(\)[\s\S]{0,400}(5_000_000_000L|5_000|Duration\.ofSeconds\(\s*5\s*\))/, 'each call is measured under 5 s');
  const [name, b] = someTest([/createVm|build\(/, /"InProgress"/, /count\(\s*"PUT"/], 'createVm ending with the ID while MockArm is InProgress');
  assert.match(b, /assertEquals\(\s*"arm:"\s*\+/, `${name} checks the returned arm: ID`);
  for (const r of ['-pip', '-nic']) assert.match(b, new RegExp(`assertEquals\\(\\s*1\\s*,\\s*count\\(\\s*"PUT"[^;]*${r}"`), `${name}: exactly one PUT for the ${r} resource`);
  assert.match(b, /assertEquals\(\s*1\s*,\s*count\(\s*"PUT"\s*,\s*VM\b/, `${name}: exactly one PUT for the VM`);
});

// ---- Criterion 4 ----
test('4: createVm refuses before any PUT: no image (Windows), another location, an untagged VM of that name', () => {
  const s = src();
  const b = body('createVm');
  const firstSend = b.search(/\b(find|ready)\(|\.begin\(/);
  assert.ok(b.search(/\bimage\(\s*\w+\s*\)/) < firstSend, 'the image is looked up before anything is sent');
  assert.ok(b.search(/cfg\.location\(\)/) < firstSend, 'the region is checked against vmintent.azure.location before anything is sent');
  assert.match(b.slice(0, firstSend), /nativeRegion\(\)[\s\S]{0,80}location\(\)[\s\S]{0,80}throw\s+invalid\(/, 'a different location throws InvalidSpec');
  assert.match(s, /ApplicationFailure\.newNonRetryableFailure\(\s*\w+\s*,\s*"InvalidSpec"\s*\)/, 'invalid(..) is non-retryable InvalidSpec');
  const images = /Map<String,\s*Image>\s+IMAGES\s*=\s*Map\.of\(([\s\S]*?)\);/.exec(s);
  assert.ok(images, 'an image map');
  assert.doesNotMatch(images[1], /windows/i, 'no Windows image');
  assert.match(images[1], /"ubuntu-/, 'an Ubuntu image');
  assert.match(methodBody(s, /static\s+Image\s+image\s*\(\s*VmSpec\s+\w+\s*\)\s*\{/) || '', /throw\s+invalid\(/, 'an OS without an image throws InvalidSpec');
  const exist = b.slice(firstSend);
  assert.match(exist, /if\s*\(\s*!managed\(\s*\w+\s*\)\s*\)\s*throw\s+invalid\(/, 'an existing untagged VM throws InvalidSpec');
  assert.match(exist, /!managed\(\s*\w+\s*\)\s*\)\s*throw\s+invalid\([\s\S]{0,300}?\);\s*return\s+vmId\(/, 'an existing tagged VM returns its ID without a PUT');
});

test('4: AzureArmBackendTest covers the repeat call, the untagged VM and a refused spec with MockArm\'s calls', () => {
  const [n1, b1] = someTest([/calls\.clear\(\)/, /createVm/, /assertEquals\(\s*0\s*,\s*changes\(\)|assertEquals\(\s*0\s*,[^;]*PUT/], 'a repeated createVm with no PUT');
  assert.match(b1, /assertEquals\(\s*\w+\s*,\s*backend\.createVm\(/, `${n1} checks the same ID`);
  const [n2, b2] = someTest([/untagged\(\s*VM\b/, /createVm/, /"InvalidSpec"/], 'an untagged VM refused with InvalidSpec');
  assert.match(b2, /isNonRetryable\(\)/, `${n2} checks non-retryable`);
  assert.match(b2, /assertEquals\(\s*0\s*,\s*changes\(\)/, `${n2} checks no PUT or DELETE was sent`);
  const [n3, b3] = someTest([/"windows"|"us-east"|"westus|other-region/, /"InvalidSpec"/], 'a refused spec');
  assert.match(b3, /assertEquals\(\s*0\s*,\s*changes\(\)/, `${n3} checks no PUT was sent`);
  const changes = methodBody(unit(), /long\s+changes\s*\(\s*\)\s*\{/);
  assert.ok(changes && /"PUT /.test(changes) && /"DELETE /.test(changes), 'changes() counts PUTs and DELETEs recorded by MockArm');
});

// ---- Criterion 5 ----
test('5: plan() takes size and region from ProviderCatalog and names the ARM image publisher/offer/sku', () => {
  const b = body('plan');
  assert.match(b, /ProviderCatalog\.plan\(/, 'uses ProviderCatalog');
  assert.match(b, /image\(\s*\w+\s*\)\.ref\(\)/, 'names the image createVm uses');
  assert.match(src(), /publisher\s*\+\s*"\/"\s*\+\s*offer\s*\+\s*"\/"\s*\+\s*sku/, 'ref() is publisher/offer/sku');
  assert.match(body('createVm'), /Image\s+\w+\s*=\s*image\(\s*\w+\s*\)/, 'createVm uses the same image(..) lookup');
  someTest([/\.plan\(/, /nativeRegion\(\)/, /nativeSize\(\)/, /nativeImage\(\)[\s\S]*\/[\s\S]*\//], 'plan() with region, size and image reference');
});

// ---- Criterion 6 ----
test('6: describeVm only reads; PENDING / RUNNING with the IP / FAILED with ARM\'s message; VmNotFound when missing or untagged', () => {
  const b = withHelpers(body('describeVm'));
  assert.doesNotMatch(b, /\.begin\(|\.put\(\s*"|\.delete\(/, 'describeVm sends no PUT or DELETE');
  assert.match(b, /r\s*==\s*null\s*\|\|\s*!managed\(\s*r\s*\)[\s\S]{0,40}throw\s+ApplicationFailure\.newNonRetryableFailure\([\s\S]{0,300}?"VmNotFound"\s*\)/,
    'a missing or untagged VM is non-retryable VmNotFound');
  assert.match(b, /"NotFound"\.equals\([^)]*getType\(\)\)\s*\)\s*return\s+null/, 'ArmClient\'s NotFound is turned into "missing", not passed on');
  assert.match(b, /"Failed"\.equals[\s\S]{0,400}"message"[\s\S]{0,200}new\s+VmStatus\(\s*"FAILED"/, 'FAILED with ARM\'s message');
  assert.match(b, /!"Succeeded"\.equals\([^)]*\)\)\s*return\s+new\s+VmStatus\(\s*"PENDING"/, 'PENDING until Succeeded');
  assert.match(b, /"ipAddress"[\s\S]{0,120}new\s+VmStatus\(\s*"RUNNING"\s*,\s*\w+/, 'RUNNING with the public IP\'s ipAddress');
});

test('6: MockArm gives a finished public IP an ipAddress; AzureArmBackendTest shows PENDING, RUNNING with an IP, VmNotFound', () => {
  assert.match(noComments(read(join(TEST, 'MockArm.java'))), /publicIPAddresses[\s\S]{0,200}"ipAddress"/, 'MockArm sets ipAddress on a finished public IP');
  const [name, b] = someTest([/"PENDING"/, /"RUNNING"/, /ipAddress\(\)/, /"VmNotFound"/], 'PENDING, RUNNING with IP, VmNotFound');
  assert.match(b, /describeVm\(\s*"arm:"[^)]*"[^"]*"\s*\)/, `${name} uses an unknown arm: ID for VmNotFound`);
  assert.match(b, /isNonRetryable\(\)/, `${name} checks VmNotFound is non-retryable`);
});

// ---- Criterion 7 ----
test('7: deleteVm removes VM, then NIC, then public IP, one step; CloudBusy while running; refuses untagged; idempotent', () => {
  const b = body('deleteVm');
  const vm = b.search(/"virtualMachines"/);
  const nic = b.search(/"networkInterfaces"/);
  const pip = b.search(/"publicIPAddresses"/);
  assert.ok(vm >= 0 && nic > vm && pip > nic, 'the order is VM, NIC, public IP');
  const loop = b.slice(pip);
  const missing = loop.search(/==\s*null\)\s*continue/);
  const untagged = loop.search(/!managed\(\s*\w+\s*\)\s*\)\s*throw\s+\w+\(/);
  const del = loop.search(/\.begin\(\s*"DELETE"/);
  assert.ok(missing >= 0, 'a resource already gone is skipped (idempotent)');
  assert.ok(untagged >= 0 && untagged < del, 'the vm-intent=managed tag is checked before any DELETE');
  assert.match(loop.slice(untagged), /^!managed\(\s*\w+\s*\)\s*\)\s*throw\s+invalid\(/, 'an untagged resource throws a non-retryable failure');
  assert.match(loop.slice(0, del), /"Deleting"[\s\S]{0,60}throw\s+busy\(/, 'a delete still running throws CloudBusy');
  assert.match(loop.slice(del), /operationUrl\(\)\s*!=\s*null[\s\S]{0,120}throw\s+busy\(/, 'a delete it has just started throws CloudBusy');
  assert.doesNotMatch(loop, /\breturn\b/, 'it returns only after checking all three');
});

test('7: AzureArmBackendTest shows a full delete, a second deleteVm with no DELETE, and an untagged resource left alone', () => {
  const [n1, b1] = someTest([/deleteVm/, /count\(\s*"DELETE"/, /calls\.clear\(\)/], 'a full delete then a second deleteVm');
  for (const t of ['VM', 'NIC', 'PIP']) assert.match(b1, new RegExp(`assertEquals\\(\\s*1\\s*,\\s*count\\(\\s*"DELETE"\\s*,\\s*${t}\\b`), `${n1}: one DELETE for ${t}`);
  assert.match(b1, /retried\(|catch\s*\(/, `${n1} calls deleteVm repeatedly`);
  assert.match(b1, /calls\.clear\(\)\s*;\s*backend\.deleteVm\([^;]*;\s*assertEquals\(\s*0\s*,\s*changes\(\)/, `${n1}: the second deleteVm sends nothing`);
  const [n2, b2] = someTest([/untagged\(/, /deleteVm/], 'deleteVm with an untagged resource');
  assert.match(b2, /isNonRetryable\(\)/, `${n2} checks the failure is non-retryable`);
  assert.match(b2, /assertNotNull\(\s*arm\.resource\(/, `${n2} checks the resource is still in MockArm`);
  assert.match(b2, /assertEquals\(\s*0\s*,\s*changes\(\)/, `${n2} checks no DELETE was sent`);
});

// ---- Criterion 8 ----
test('8: createVm first checks the settings: non-retryable NotSetUp naming the missing one, before any request', () => {
  const b = body('createVm');
  const first = /^\s*(\w+)\(\s*\)\s*;/.exec(b);
  assert.ok(first, 'createVm starts with a settings check');
  const h = methodBody(src(), new RegExp(`private\\s+void\\s+${first[1]}\\s*\\(\\s*\\)\\s*\\{`));
  assert.ok(h, `${first[1]}() exists`);
  assert.doesNotMatch(h, /\bclient\.|\bfind\(/, `${first[1]}() sends nothing`);
  assert.match(h, /cfg\.configured\(\)/, 'checks AzureProperties.configured()');
  assert.match(h, /subnetId\(\)[\s\S]{0,40}add\([^;]*subnet-id/, 'names the subnet setting');
  assert.match(h, /adminSshPublicKey\(\)[\s\S]{0,40}add\([^;]*ssh-public-key/, 'names the SSH key setting');
  assert.match(h, /ApplicationFailure\.newNonRetryableFailure\([\s\S]{0,300}?"NotSetUp"\s*\)/, 'non-retryable NotSetUp');
  const [name, t] = someTest([/"NotSetUp"/, /createVm/], 'NotSetUp');
  assert.match(t, /calls\.isEmpty\(\)/, `${name} checks no request was sent`);
  assert.match(t, /getMessage\(\)[\s\S]*subnet/, `${name} checks the message names the setting`);
});

// ---- Criterion 9 ----
test('9: docs/AZURE.md has an AzureArmBackend section that matches the code', () => {
  const doc = read(DOC);
  const at = doc.search(/^#+\s.*AzureArmBackend/m);
  assert.ok(at >= 0, 'a heading naming AzureArmBackend');
  const rest = doc.slice(at);
  const next = rest.slice(1).search(/^## /m);
  const sec = next >= 0 ? rest.slice(0, next + 1) : rest;
  assert.match(sec, /arm:<resource-group>:<vm-name>/, 'the VM ID form');
  assert.match(sec, /az-vm-/, 'not the simulator\'s prefix');
  for (const r of ['<name>-pip', '<name>-nic']) assert.ok(sec.includes(r), `names the resource ${r}`);
  assert.match(sec, /vm-intent=managed/, 'tag vm-intent=managed');
  assert.match(sec, /vm-intent-key=/, 'tag vm-intent-key');
  assert.match(sec, /createVm[\s\S]*CloudBusy/, 'createVm steps with CloudBusy');
  assert.match(sec, /deleteVm[\s\S]*VM, then NIC, then public IP|deleteVm[\s\S]*VM[^\n]*NIC[^\n]*public IP/, 'deleteVm order');
  for (const t of ['NotSetUp', 'InvalidSpec', 'VmNotFound']) assert.ok(sec.includes(t), `names ${t}`);
  for (const e of ['VMINTENT_AZURE_SUBNET_ID', 'VMINTENT_AZURE_ADMIN_USERNAME', 'VMINTENT_AZURE_ADMIN_SSH_PUBLIC_KEY']) assert.ok(sec.includes(e), `names ${e}`);
  assert.match(sec, /not[\s\S]{0,30}used by `?AzureProvider`?/i, 'not yet used by AzureProvider');
  assert.match(sec, /A2b[\s\S]{0,80}vmintent\.azure\.route|vmintent\.azure\.route[\s\S]{0,80}A2b/, 'A2b connects it behind vmintent.azure.route');
  // The image map in the doc is the one in the code.
  const images = /Map<String,\s*Image>\s+IMAGES\s*=\s*Map\.of\(([\s\S]*?)\);/.exec(src())[1];
  for (const m of images.matchAll(/"([\w.-]+)"\s*,\s*new\s+Image\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/g)) {
    assert.ok(sec.includes(m[1]), `doc lists the image key ${m[1]}`);
    assert.ok(sec.includes(`${m[2]}/${m[3]}/${m[4]}`), `doc lists ${m[1]} as ${m[2]}/${m[3]}/${m[4]}`);
  }
});

// ---- Criterion 10 ----
test('10: the tests mvn test runs are in backend/src/test', () => {
  const all = walk(TEST_ROOT).map((f) => f.replace(/\\/g, '/'));
  for (const n of ['AzureArmBackendTest.java', 'ArmClientTest.java', 'MockArm.java', 'VcenterBackendTest.java', 'VcfaBackendTest.java']) {
    assert.ok(all.some((f) => f.endsWith('/' + n)), `backend/src/test has ${n}`);
  }
  assert.ok(all.some((f) => /Replay\w*Test\.java$/.test(f)), 'backend/src/test has the Temporal replay tests');
});

test('10: every ArmClient / AzureArmBackend a test builds uses MockArm\'s URLs; no test names a real Azure host as an address', () => {
  const files = walk(TEST_ROOT).filter((f) => /\.(java|ya?ml|properties|json)$/.test(f));
  for (const f of files) {
    const t = read(f);
    assert.doesNotMatch(t, /login\.microsoftonline\.com|login\.windows\.net|login\.microsoft\.com/i, `${f} names no Entra ID host`);
    for (const m of t.matchAll(/management\.(azure|core\.windows)\.(com|net)[^\s"']*/gi)) {
      assert.match(m[0], /^management\.azure\.com\/\.default$/i, `${f}: the real ARM host only as the token scope: ${m[0]}`);
    }
  }
  const okProps = (d, t) => /^\w+\.properties\(\)$/.test(d.trim())
    || (/new\s+AzureProperties\(/.test(d) && /\.loginUrl\(\)/.test(d) && /\.managementUrl\(\)/.test(d))
    || (/new\s+AzureProperties\(/.test(d) && /\w+\.url\(\)[\s\S]*\w+\.url\(\)/.test(d));
  for (const f of files.filter((x) => x.endsWith('.java'))) {
    const t = noComments(read(f));
    const check = (arg, what) => {
      if (/^\w+\.properties\(\)$/.test(arg)) return;
      assert.match(arg, /^\w+$/, `${f}: ${what} built from ${arg}`);
      const decl = [...t.matchAll(new RegExp(`\\b${arg}\\s*=\\s*([^;]+);`, 'g'))].map((d) => d[1]);
      assert.ok(decl.length > 0, `${f}: found where ${arg} is set`);
      for (const d of decl) assert.ok(okProps(d, t), `${f}: ${arg} takes its URLs from MockArm: ${d.replace(/\s+/g, ' ')}`);
    };
    for (const m of t.matchAll(/new\s+ArmClient\(\s*((?:[^,()]|\(\s*\))+)/g)) check(m[1].trim(), 'ArmClient');
    for (const m of t.matchAll(/new\s+AzureArmBackend\(\s*((?:[^,()]|\(\s*\))+),[^;]*?new\s+ArmClient\(\s*((?:[^,()]|\(\s*\))+)/g)) {
      check(m[1].trim(), 'AzureArmBackend');
      check(m[2].trim(), 'AzureArmBackend\'s ArmClient');
    }
  }
});

// ---- Criterion 11 (commits) ----
test('11: no AP-0017 commit changes AzureProvider, workflow/activity interfaces, REST controllers, docs/openapi.* or deploy/', () => {
  const shas = aps17();
  assert.ok(shas.length > 0, 'found the AP-0017 commits');
  for (const sha of shas) {
    const s = sha.slice(0, 7);
    for (const f of changedFiles(sha)) {
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

test('11: no AP-0017 commit changes an existing public ArmClient method', () => {
  const publics = (t) => {
    const s = noComments(t);
    const out = new Map();
    for (const m of s.matchAll(/public\s+(?!record|enum|class|static\s+final)[\w<>,.\s]*?\b(\w+)\s*\(([^)]*)\)\s*\{/g)) {
      const key = `${m[1]}(${m[2].replace(/\s+/g, ' ').trim()})`;
      out.set(key, (methodBody(s.slice(m.index), /\{/) ?? '').replace(/\s+/g, ' ').trim());
    }
    return out;
  };
  for (const sha of aps17()) {
    if (!changedFiles(sha).some((f) => f.endsWith(ARM_REL))) continue;
    const before = publics(git(['show', `${sha}^:vm-intent/${ARM_REL}`]));
    const after = publics(git(['show', `${sha}:vm-intent/${ARM_REL}`]));
    for (const [sig, b] of before) {
      assert.ok(after.has(sig), `${sha.slice(0, 7)} keeps ArmClient.${sig}`);
      assert.equal(after.get(sig), b, `${sha.slice(0, 7)} does not change ArmClient.${sig}`);
    }
  }
});
