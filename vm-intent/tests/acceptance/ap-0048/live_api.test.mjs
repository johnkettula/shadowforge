// AP-0048 acceptance, live half: the docs this requirement edits still describe the running server. Every operation
// in API.md's Operations table (as AP-0048 left it, which criterion 5 says is unchanged) is served by the staging
// server's OpenAPI document, and a text request with no name still previews the generated vm-<8 hex> name that
// API.md's VM-names bullet and DEFINITIONS' 'Cloud name' paragraph describe. Read-only: nothing is built.
//
//   node --test tests/acceptance/ap-0048/live_api.test.mjs      (VMINTENT_API defaults to http://127.0.0.1:19080)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = 'AP-0048';
const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19080').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/

const git = (args) => execFileSync('git', args,
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...AUTH },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, text, json };
}

/** API.md as the newest AP-0048 commit (other than the pipeline's own) that changed it left it. */
function apiMd() {
  const all = git(['log', '--no-merges', '--format=%H %s', '--grep', `^${ID}:`, '--', ':(top)vm-intent/docs/API.md'])
    .split('\n').filter(Boolean).map((l) => ({ sha: l.slice(0, 40), subject: l.slice(41) }))
    .filter((c) => c.subject.startsWith(`${ID}:`) && !/^AP-\d+: (acceptance tests|record the requirement)\b/.test(c.subject));
  assert.ok(all.length > 0, `no ${ID} commit changes docs/API.md`);
  return git(['show', `${all[0].sha}:vm-intent/docs/API.md`]).replace(/\r\n/g, '\n');
}

test('every operation in API.md\'s Operations table is served by the staging server', async () => {
  const lines = apiMd().split('\n');
  const i = lines.findIndex((l) => l.startsWith('| Operation ID |'));
  assert.ok(i >= 0, 'API.md has no Operations table');
  const documented = [];
  for (let j = i + 2; j < lines.length && lines[j].startsWith('|'); j++) {
    const m = lines[j].match(/^\| `?(\w+)`? \|/);
    // A row may say the OpenAPI document uses another ID ("... this operation is `validateDefinitionJson`").
    const alias = lines[j].match(/In the OpenAPI document[^|]*this operation is `(\w+)`/);
    if (m) documented.push(alias ? alias[1] : m[1]);
  }
  assert.ok(documented.length > 0, 'the Operations table is empty');
  const r = await call('GET', '/v3/api-docs');
  assert.equal(r.status, 200, `GET /v3/api-docs: ${r.status} ${r.text.slice(0, 200)}`);
  const served = new Set();
  for (const ops of Object.values(r.json?.paths ?? {})) for (const op of Object.values(ops)) if (op?.operationId) served.add(op.operationId);
  assert.deepEqual(documented.filter((id) => !served.has(id)), [], 'documented operations the server does not serve');
});

test('a text request with no name still previews a generated vm-<8 hex> name', async () => {
  const r = await call('POST', '/api/v2/interpret', { text: 'a small ubuntu server on aws' });
  assert.equal(r.status, 200, `POST /api/v2/interpret: ${r.status} ${r.text.slice(0, 400)}`);
  assert.ok(!r.json?.question, `the preview asks a question: ${r.json?.question}`);
  assert.match(String(r.json?.spec?.name), /^vm-[0-9a-f]{8}$/);
});
