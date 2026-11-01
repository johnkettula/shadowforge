// AP-0008 acceptance, criterion 6 (live half): docs/openapi.json, with the top-level 'servers' left out, equals
// the live GET /v3/api-docs with 'servers' left out; and docs/openapi.yaml, with its 'servers' block left
// out, is the live GET /v3/api-docs.yaml text with its 'servers' block left out.
//
//   VMINTENT_API=http://127.0.0.1:19080 node --test tests/acceptance/ap-0008/live_api.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.VMINTENT_API || 'http://127.0.0.1:19080').replace(/\/+$/, '');
const AUTH = process.env.VMINTENT_TOKEN ? { Authorization: 'Bearer ' + process.env.VMINTENT_TOKEN } : {};
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // vm-intent/
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** The first path where a and b differ (object key order ignored, array order not), or null. */
function firstDiff(a, b, path = '') {
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    if (Array.isArray(a)) {
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        const d = firstDiff(a[i], b[i], `${path}[${i}]`);
        if (d) return d;
      }
      return a.length === b.length ? null : `${path}: ${a.length} items vs ${b.length}`;
    }
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const at = path ? `${path}.${k}` : k;
      if (!(k in a)) return `${at}: only live`;
      if (!(k in b)) return `${at}: only in snapshot`;
      const d = firstDiff(a[k], b[k], at);
      if (d) return d;
    }
    return null;
  }
  return Object.is(a, b) || a === b ? null : `${path}: ${JSON.stringify(a)?.slice(0, 200)} vs ${JSON.stringify(b)?.slice(0, 200)}`;
}

function withoutServers(doc) {
  const { servers, ...rest } = doc;
  return rest;
}

/** YAML lines without the top-level 'servers:' line and the lines under it. */
function yamlWithoutServers(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const start = lines.indexOf('servers:');
  if (start < 0) return lines;
  let end = start + 1;
  while (end < lines.length && (lines[end].startsWith(' ') || lines[end].startsWith('-'))) end++;
  return [...lines.slice(0, start), ...lines.slice(end)];
}

test('6: docs/openapi.json (servers left out) equals the live /v3/api-docs (servers left out)', async () => {
  const res = await fetch(BASE + '/v3/api-docs', { headers: AUTH });
  assert.equal(res.status, 200, 'GET /v3/api-docs');
  const live = withoutServers(await res.json());
  const snapshot = withoutServers(JSON.parse(read('docs/openapi.json')));
  assert.equal(firstDiff(live, snapshot), null, 'live document (left) and docs/openapi.json (right) differ');
  assert.deepEqual(snapshot, live);
});

test('6: docs/openapi.yaml (servers left out) equals the live /v3/api-docs.yaml (servers left out)', async () => {
  const res = await fetch(BASE + '/v3/api-docs.yaml', { headers: AUTH });
  assert.equal(res.status, 200, 'GET /v3/api-docs.yaml');
  const live = yamlWithoutServers(await res.text());
  const snapshot = yamlWithoutServers(read('docs/openapi.yaml'));
  const i = live.findIndex((l, n) => l !== snapshot[n]);
  assert.ok(i < 0 && live.length === snapshot.length,
    `docs/openapi.yaml differs from the live YAML at line ${i + 1}:\n  live:     ${live[i]}\n  snapshot: ${snapshot[i]}`
    + ` (${live.length} vs ${snapshot.length} lines)`);
});
