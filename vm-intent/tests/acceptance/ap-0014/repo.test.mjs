// AP-0014 acceptance, repository half: the Azure Resource Manager client (ArmClient), its settings
// (AzureProperties), application.yml, the MockArm test server and ArmClientTest are as the requirement says;
// no secret is written anywhere; no Azure test points at real Azure; and no AP-0014 commit touches AzureProvider,
// the workflow interfaces, the REST controllers or docs/openapi.*. Covers criteria 1-9 and the commit part of 11
// by reading files and git history. Criterion 10 (mvn test) is run by the pipeline's build gate, not here.
//
//   node --test tests/acceptance/ap-0014/repo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const MAIN = join(ROOT, 'backend', 'src', 'main', 'java', 'com', 'example', 'vmintent', 'provider', 'azure');
const TEST = join(ROOT, 'backend', 'src', 'test', 'java', 'com', 'example', 'vmintent', 'provider', 'azure');
const TEST_ROOT = join(ROOT, 'backend', 'src', 'test');
const YML = join(ROOT, 'backend', 'src', 'main', 'resources', 'application.yml');

const read = (p) => readFileSync(p, 'utf8');
const git = (args) => execFileSync('git', args,
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

/** Java source without comments and with string literals blanked (keeps the quotes). */
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"])\/\/.*$/gm, '$1')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

/** The body of the first method whose signature matches re (balanced braces). */
function methodBody(src, re) {
  const m = re.exec(src);
  if (!m) return null;
  let i = src.indexOf('{', m.index + m[0].length - 1);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(i + 1, j);
  }
  return null;
}

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const armSrc = () => read(join(MAIN, 'ArmClient.java'));
const propsSrc = () => read(join(MAIN, 'AzureProperties.java'));

// ---- Criterion 1 ----
test('1: provider/azure has ArmClient and AzureProperties (@ConfigurationProperties vmintent.azure)', () => {
  assert.ok(existsSync(join(MAIN, 'ArmClient.java')), 'ArmClient.java exists');
  assert.ok(existsSync(join(MAIN, 'AzureProperties.java')), 'AzureProperties.java exists');
  assert.match(armSrc(), /\bclass\s+ArmClient\b/, 'ArmClient is a class');
  const p = propsSrc();
  assert.match(p, /\b(record|class)\s+AzureProperties\b/, 'AzureProperties is a record or class');
  assert.match(p, /@ConfigurationProperties\(\s*(?:(?:prefix|value)\s*=\s*)?"vmintent\.azure"\s*\)/,
    'AzureProperties is @ConfigurationProperties under vmintent.azure');
  assert.match(p, /package\s+com\.example\.vmintent\.provider\.azure\s*;/);
});

// ---- Criterion 2 ----
test('2: AzureProperties has the IDs, secret, resource group, location and login/management URLs with Azure defaults', () => {
  const p = code(propsSrc());
  for (const f of ['tenantId', 'clientId', 'clientSecret', 'subscriptionId', 'resourceGroup', 'location', 'loginUrl', 'managementUrl']) {
    assert.match(p, new RegExp(`\\bString\\s+${f}\\b`), `AzureProperties has String ${f}`);
  }
  const raw = propsSrc();
  assert.ok(raw.includes('"https://login.microsoftonline.com"'), 'login URL defaults to https://login.microsoftonline.com');
  assert.ok(raw.includes('"https://management.azure.com"'), 'management URL defaults to https://management.azure.com');
});

test('2: configured() is true only when tenant, client id, client secret, subscription and resource group are set', () => {
  const body = methodBody(code(propsSrc()), /\bboolean\s+configured\s*\(\s*\)\s*\{/);
  assert.ok(body, 'AzureProperties has boolean configured()');
  for (const f of ['tenantId', 'clientId', 'clientSecret', 'subscriptionId', 'resourceGroup']) {
    assert.match(body, new RegExp(`\\b${f}\\b`), `configured() checks ${f}`);
  }
  assert.doesNotMatch(body, /\|\|/, 'configured() requires all of them (no "or")');
  assert.doesNotMatch(body, /\b(location|loginUrl|managementUrl)\b/, 'configured() does not depend on location or URLs');
});

test('2: application.yml binds the IDs and secret only to the VMINTENT_AZURE_* variables with empty defaults', () => {
  const lines = read(YML).replace(/\r\n/g, '\n').split('\n');
  const v = lines.findIndex((l) => /^vmintent:\s*$/.test(l));
  assert.ok(v >= 0, 'application.yml has vmintent:');
  const a = lines.findIndex((l, i) => i > v && /^  azure:\s*(#.*)?$/.test(l));
  assert.ok(a >= 0, 'application.yml has vmintent.azure');
  const block = {};
  for (let i = a + 1; i < lines.length && (lines[i].startsWith('    ') || /^\s*(#.*)?$/.test(lines[i])); i++) {
    const m = /^    ([a-z-]+):\s*(.*?)\s*(#.*)?$/.exec(lines[i]);
    if (m) block[m[1]] = m[2];
  }
  const want = {
    'tenant-id': '${VMINTENT_AZURE_TENANT_ID:}',
    'client-id': '${VMINTENT_AZURE_CLIENT_ID:}',
    'client-secret': '${VMINTENT_AZURE_CLIENT_SECRET:}',
    'subscription-id': '${VMINTENT_AZURE_SUBSCRIPTION_ID:}',
  };
  for (const [k, val] of Object.entries(want)) assert.equal(block[k], val, `vmintent.azure.${k} is ${val}`);
  for (const k of ['login-url', 'management-url']) {
    if (block[k] !== undefined) {
      const ok = k === 'login-url' ? /login\.microsoftonline\.com/ : /management\.azure\.com/;
      assert.match(block[k], ok, `vmintent.azure.${k} defaults to Azure: ${block[k]}`);
    }
  }
});

test('2: no other Spring config file sets the Azure IDs or secret', () => {
  const dir = dirname(YML);
  for (const f of readdirSync(dir).filter((n) => /^application.*\.(ya?ml|properties)$/.test(n) && n !== 'application.yml')) {
    const t = read(join(dir, f));
    assert.doesNotMatch(t, /(client-secret|clientSecret|tenant-id|subscription-id)\s*[:=]\s*[^\s$#]/,
      `${f} does not set an Azure ID or secret`);
  }
});

test('2: no client secret value is written in any tracked file', () => {
  // Assignments of the secret to anything other than an empty value, a ${...} placeholder or an obvious test value.
  let out = '';
  try {
    out = git(['grep', '-n', '-I', '-i', '-E',
      '(VMINTENT_AZURE_CLIENT_SECRET|AZURE_CLIENT_SECRET|client[-_]?secret)["\']?\\s*[:=]\\s*["\']?[A-Za-z0-9~._-]{8,}',
      '--', ':/', ':!*.env', ':!*.env.*', ':!.env*', ':!*.tfvars', ':!*.tfvars.*']);
  } catch (e) {
    if (e.status !== 1) throw e; // 1 = no match
  }
  const hits = out.split('\n').filter(Boolean)
    .filter((l) => !/\$\{|%[A-Z_]+%|\$env:|\$[A-Z_]+|<[^>]+>|test-only|not-a-secret|wrong|example|placeholder|changeme|your[-_]/i.test(l))
    .filter((l) => !/\bString\s+clientSecret\b|clientSecret\s*=\s*(cfg|p|props|this)\b|\.clientSecret\(\)/.test(l));
  assert.deepEqual(hits, [], 'no line writes a client secret value');
});

// ---- Criterion 3 ----
test('3: AzureProperties.toString() leaves the client secret out', () => {
  const p = code(propsSrc());
  const isRecord = /\brecord\s+AzureProperties\b/.test(p);
  const body = methodBody(p, /\bString\s+toString\s*\(\s*\)\s*\{/);
  if (isRecord) assert.ok(body, 'a record must override toString() to hide the secret (the default prints every component)');
  assert.ok(body, 'AzureProperties overrides toString()');
  // Every remaining use of clientSecret in toString() may only test whether it is set.
  const rest = body
    .replace(/\b(blank|isBlank|hasText|isEmpty|StringUtils\.\w+)\(\s*clientSecret\s*\)/g, '')
    .replace(/\bclientSecret\s*(==|!=)\s*null/g, '')
    .replace(/\bclientSecret\s*\.\s*(isBlank|isEmpty)\s*\(\s*\)/g, '');
  assert.doesNotMatch(rest, /\bclientSecret\b/, `toString() does not print clientSecret: ${body.trim()}`);
  assert.doesNotMatch(body, /\bsuper\.toString\b|ReflectionToStringBuilder/, 'toString() does not print every field');
});

test('3: no log statement in the azure package logs the client secret or the access token', () => {
  for (const f of readdirSync(MAIN).filter((n) => n.endsWith('.java'))) {
    const src = code(read(join(MAIN, f)));
    const stmts = [...src.matchAll(/\b(?:log|logger|LOG|LOGGER)\s*\.\s*(?:trace|debug|info|warn|error)\s*\(([\s\S]*?)\)\s*;/g)].map((m) => m[1]);
    stmts.push(...[...src.matchAll(/System\s*\.\s*(?:out|err)\s*\.\s*print\w*\s*\(([\s\S]*?)\)\s*;/g)].map((m) => m[1]));
    for (const s of stmts) {
      assert.doesNotMatch(s, /\bclientSecret\b|client_secret|\btoken\b|\baccess_token\b|\bbearer\s*\(|\bform\b|\bAuthorization\b/i,
        `${f}: log statement does not log the secret or token: ${s.replace(/\s+/g, ' ').slice(0, 200)}`);
    }
  }
});

// ---- Criterion 4 ----
test('4: ArmClient signs in with client credentials at {login}/{tenant}/oauth2/v2.0/token and sends Bearer tokens', () => {
  const raw = armSrc();
  assert.match(raw, /\/oauth2\/v2\.0\/token/, 'token URL path');
  assert.match(raw, /loginUrl\(\)/, 'token URL uses the login base URL');
  assert.match(raw, /tenantId\(\)/, 'token URL uses the tenant');
  assert.match(raw, /grant_type=client_credentials/, 'grant_type=client_credentials');
  assert.match(raw, /client_id=/, 'client_id in the form');
  assert.match(raw, /client_secret=/, 'client_secret in the form');
  assert.match(raw, /scope=/, 'scope in the form');
  assert.match(raw, /"https:\/\/management\.azure\.com\/\.default"/, 'scope is https://management.azure.com/.default');
  assert.match(raw, /application\/x-www-form-urlencoded/, 'the sign-in is a form POST');
  assert.match(raw, /"POST"/, 'the sign-in is a POST');
  assert.match(raw, /"Authorization"\s*,\s*"Bearer "\s*\+/, 'ARM calls send Authorization: Bearer <token>');
  assert.match(raw, /expires_in/, 'reads expires_in');
  assert.match(raw, /Duration\.ofMinutes\(\s*5\s*\)|Duration\.ofSeconds\(\s*300\s*\)|300_?000/, 'renews 5 minutes before expiry');
});

// ---- Criterion 5 ----
test('5: ArmClient has generic put/get/delete with api-version and polls Azure-AsyncOperation / Location', () => {
  const raw = armSrc();
  const c = code(raw);
  assert.match(c, /public\s+\S+\s+put\s*\(\s*String\s+\w+\s*,\s*\w+\s+\w+\s*\)/, 'public put(path, body)');
  assert.match(c, /public\s+\S+\s+get\s*\(\s*String\s+\w+\s*\)/, 'public get(path)');
  assert.match(c, /public\s+\S+\s+delete\s*\(\s*String\s+\w+\s*\)/, 'public delete(path)');
  assert.match(raw, /api-version=/, 'adds an api-version query parameter');
  assert.match(raw, /"Azure-AsyncOperation"/, 'reads Azure-AsyncOperation');
  assert.match(raw, /"Location"/, 'reads Location');
  assert.match(raw, /"Succeeded"/, 'waits for Succeeded');
  assert.match(raw, /"Failed"/, 'handles Failed');
  assert.match(raw, /"Canceled"/, 'handles Canceled');
  assert.match(raw, /"Failed"[\s\S]{0,200}"Canceled"[\s\S]{0,300}newNonRetryableFailure/,
    'Failed or Canceled throws a non-retryable ApplicationFailure');
  assert.match(raw, /errorText\(|path\(\s*"error"\s*\)|"message"/, 'the failure carries ARM\'s error message');
});

// ---- Criterion 6 ----
test('6: ArmClient retries 429/5xx with backoff and Retry-After, then maps statuses to the failure types', () => {
  const raw = armSrc();
  assert.match(raw, /"Retry-After"/, 'honours Retry-After');
  assert.match(raw, /maxAttempts/, 'a limited number of attempts');
  assert.match(raw, /429/, 'handles 429');
  assert.match(raw, /newFailure\([^;]*"CloudBusy"\s*\)/, 'retryable CloudBusy');
  assert.match(raw, /newFailure\([^;]*"CloudError"\s*\)/, 'retryable CloudError');
  assert.match(raw, /s\s*==\s*429\s*\|\|\s*s\s*==\s*502\s*\|\|\s*s\s*==\s*503\s*\|\|\s*s\s*==\s*504[^;]*"CloudBusy"/,
    '429/502/503/504 -> CloudBusy');
  assert.match(raw, /newNonRetryableFailure\([^;]*"CloudAuth"\s*\)/, 'non-retryable CloudAuth');
  assert.match(raw, /401[\s\S]{0,40}403/, '401 and 403 -> CloudAuth');
  assert.match(raw, /404\)?\s*throw\s+ApplicationFailure\.newNonRetryableFailure\([^;]*"NotFound"\s*\)/, '404 -> non-retryable NotFound');
  assert.match(raw, /newNonRetryableFailure\([^;]*"InvalidSpec"\s*\)/, 'other 4xx -> non-retryable InvalidSpec');
});

// ---- Criterion 7 ----
test('7: MockArm is an in-process HTTP server on 127.0.0.1 with token endpoint, auth, state, async operations and failure injection', () => {
  const p = join(TEST, 'MockArm.java');
  assert.ok(existsSync(p), 'backend/src/test/.../provider/azure/MockArm.java exists');
  const raw = read(p);
  assert.match(raw, /HttpServer\.create\(\s*new\s+InetSocketAddress\(\s*"127\.0\.0\.1"\s*,\s*0\s*\)/, 'bound to 127.0.0.1 on a random port');
  assert.match(raw, /\/oauth2\/v2\.0\/token/, 'serves the token endpoint');
  assert.match(raw, /Bearer /, 'checks the bearer token');
  assert.match(raw, /\b401\b/, 'answers 401 without a valid token');
  for (const t of ['Microsoft.Compute/virtualMachines', 'Microsoft.Network/networkInterfaces', 'Microsoft.Network/publicIPAddresses']) {
    assert.ok(raw.includes(`"${t}"`), `keeps state for ${t}`);
  }
  assert.match(raw, /"Azure-AsyncOperation"/, 'answers with an Azure-AsyncOperation URL');
  assert.match(raw, /"InProgress"/, 'operation status InProgress');
  assert.match(raw, /"Succeeded"/, 'operation status Succeeded');
  assert.match(raw, /"provisioningState"/, 'sets properties.provisioningState');
  assert.match(raw, /"tags"/, 'stores tags');
  assert.match(raw, /\bcalls\b[\s\S]*calls\.add\(/, 'records every call');
  assert.match(raw, /\bvoid\s+failNext\s*\(\s*int\s+\w+\s*,\s*int\s+\w+\s*\)/, 'can be told to fail the next N calls with a status');
});

// ---- Criterion 8 ----
test('8: ArmClientTest uses MockArm and covers every listed scenario', () => {
  const p = join(TEST, 'ArmClientTest.java');
  assert.ok(existsSync(p), 'ArmClientTest.java exists');
  const raw = read(p);
  assert.match(raw, /new\s+MockArm\s*\(/, 'uses MockArm');
  const tests = raw.split(/@Test\b/).slice(1);
  assert.ok(tests.length >= 8, `at least 8 tests (${tests.length})`);
  const some = (re, what) => assert.ok(tests.some((t) => re.every((r) => r.test(t))), `a test shows ${what}`);
  some([/calls\.get\(\s*0\s*\)/, /oauth2\/v2\.0\/token/], 'the token is fetched before the first ARM call');
  some([/assertEquals\(\s*1\s*,\s*\w+\.tokenRequests\.size\(\)/, /client\.(put|get|delete)[\s\S]*client\.(put|get|delete)/],
    'one token is reused across several calls');
  some([/assertEquals\(\s*2\s*,\s*\w+\.tokenRequests\.size\(\)/, /now\.set|plus\(\s*Duration/], 'a token close to expiry is renewed');
  some([/\.put\(/, /\/operations\//, /"Succeeded"/, /provisioningState/, /tags/],
    'a PUT polled through Azure-AsyncOperation, read back Succeeded with its tags');
  some([/failNextOperation/, /isNonRetryable\(\)/], 'a Failed async operation raises a non-retryable failure');
  some([/failNext\([^)]*429\)/, /failNext\([^)]*500\)/], '429 and 500 are retried and the call succeeds');
  some([/"InvalidSpec"/, /assertEquals\(\s*1\s*,/], 'a 400 is sent exactly once and raises InvalidSpec');
  some([/"NotFound"/], 'a 404 raises NotFound');
});

// ---- Criterion 9 ----
test('9: no test in backend/src/test points the login or management URL at a real Azure host', () => {
  const files = walk(TEST_ROOT).filter((f) => /\.(java|ya?ml|properties|json)$/.test(f));
  for (const f of files) {
    const t = read(f);
    assert.doesNotMatch(t, /login\.microsoftonline\.com|login\.windows\.net|login\.microsoft\.com/i,
      `${f} does not name a real Entra ID host`);
    for (const m of t.matchAll(/management\.(azure|core\.windows)\.(com|net)[^\s"']*/gi)) {
      assert.match(m[0], /^management\.azure\.com\/\.default$/i, `${f}: real ARM host only as the token scope, not a URL: ${m[0]}`);
    }
    assert.doesNotMatch(t, /(login-url|management-url|vmintent\.azure\.(login|management))[^\n]*https?:\/\/(?!127\.0\.0\.1|localhost)/i,
      `${f} does not configure a non-local Azure URL`);
  }
  // Every ArmClient a test builds uses MockArm's settings, never AzureProperties whose URLs fall back to Azure.
  for (const f of files.filter((x) => x.endsWith('.java'))) {
    const t = code(read(f));
    const defaulted = [...t.matchAll(/(\w+)\s*=\s*new\s+AzureProperties\(([^;]*)\)\s*;/g)]
      .filter(([, , args]) => { const a = args.split(',').map((s) => s.trim()); return a.length >= 8 && (/^(null|"")$/.test(a[6]) || /^(null|"")$/.test(a[7])); })
      .map(([, name]) => name);
    for (const name of defaulted) {
      assert.doesNotMatch(t, new RegExp(`new\\s+ArmClient\\(\\s*${name}\\b`), `${f}: no ArmClient is built from ${name}, whose URLs default to real Azure`);
    }
    assert.doesNotMatch(t, /new\s+ArmClient\(\s*new\s+AzureProperties\([^)]*\b(null|"")\s*,\s*(null|"")\s*,/,
      `${f}: no ArmClient is built with default (real Azure) URLs`);
  }
});

// ---- Criterion 10 (the part that can be checked without running mvn) ----
test('10: ArmClientTest sits next to the existing vCenter/VCF-A backend tests and replay tests', () => {
  const all = walk(TEST_ROOT).map((f) => f.replace(/\\/g, '/'));
  for (const n of ['ArmClientTest.java', 'MockArm.java', 'VcenterBackendTest.java', 'VcfaBackendTest.java']) {
    assert.ok(all.some((f) => f.endsWith('/' + n)), `backend/src/test has ${n}`);
  }
  assert.ok(all.some((f) => /Replay\w*Test\.java$/.test(f)), 'backend/src/test has the Temporal replay tests');
});

// ---- Criterion 11 (commits) ----
test('11: no AP-0014 commit changes AzureProvider, workflow interfaces, REST controllers or docs/openapi.*', () => {
  const shas = git(['log', '--format=%H', '--no-merges', '--grep=^AP-0014:']).split('\n').filter(Boolean);
  assert.ok(shas.length > 0, 'found the AP-0014 commits');
  for (const sha of shas) {
    const files = git(['show', '--name-only', '--format=', sha]).split('\n').map((s) => s.trim()).filter(Boolean);
    for (const f of files) {
      assert.doesNotMatch(f, /provider\/AzureProvider\.java$/, `${sha.slice(0, 7)} does not change AzureProvider.java`);
      assert.doesNotMatch(f, /docs\/openapi\.(json|ya?ml)$/, `${sha.slice(0, 7)} does not change ${f}`);
      assert.doesNotMatch(f, /\/api\/\w*Controller\.java$/, `${sha.slice(0, 7)} does not change the REST controller ${f}`);
      if (f.endsWith('.java') && f.includes('/src/main/')) {
        let before = '';
        let after = '';
        try { before = git(['show', `${sha}^:${f}`]); } catch { /* new file */ }
        try { after = git(['show', `${sha}:${f}`]); } catch { /* deleted file */ }
        const t = before + after;
        assert.doesNotMatch(t, /@(WorkflowInterface|ActivityInterface)\b/, `${sha.slice(0, 7)} does not change the workflow interface ${f}`);
        assert.doesNotMatch(t, /@(RestController|Controller)\b/, `${sha.slice(0, 7)} does not change the REST controller ${f}`);
      }
    }
  }
});
