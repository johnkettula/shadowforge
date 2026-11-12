import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyDocsDue, dailyDocsTask } from '../src/activities.js';
import { defaultConfig } from '../src/config.js';
import { synopsis } from '../src/synopsis.js';
import type { CycleResult } from '../src/types.js';

const row = (cycle: number, startedAt: string, title: string, outcome: CycleResult['outcome'] = 'merged', costUsd = 2): CycleResult => ({
  cycle, mode: 'feature', outcome, attempts: 1, costUsd, note: outcome === 'merged' ? 'merged' : 'live failed', startedAt, endedAt: startedAt,
  requirement: { id: `AP-${String(cycle).padStart(4, '0')}`, title, rationale: '', acceptanceCriteria: [], areas: [], risk: 'low' },
  mergeSha: outcome === 'merged' ? 'abcdef1234' : undefined,
});

test('the daily docs update is due once per UTC day, whatever happened to it', () => {
  const cfg = { ...defaultConfig(), docsEveryDays: 1 };
  const now = new Date('2026-11-06T02:00:00Z');
  assert.equal(dailyDocsDue(cfg, [], now), true);
  assert.equal(dailyDocsDue(cfg, [row(1, '2026-11-05T23:00:00Z', 'Daily docs 2026-11-05: x')], now), true, "yesterday's doesn't count");
  assert.equal(dailyDocsDue(cfg, [row(2, '2026-11-06T00:10:00Z', 'Daily docs 2026-11-06: x', 'abandoned')], now), false, 'not retried the same day');
  assert.equal(dailyDocsDue(cfg, [row(3, '2026-11-06T00:10:00Z', 'Some feature')], now), true);
  assert.equal(dailyDocsDue({ ...cfg, dailyDocs: false }, [], now), false);
});

test('the daily docs task asks for a full check and a Last updated date on each edited doc', () => {
  const t = dailyDocsTask('2026-11-07');
  assert.match(t, /Daily docs 2026-11-07:/);
  assert.match(t, /read every one of those docs in full/);
  assert.match(t, /Last updated 2026-11-07\./);
  assert.match(t, /Don't change the date of a doc you don't otherwise edit/);
});

test('approvals are off by default; daily docs on', () => {
  const cfg = defaultConfig();
  assert.equal(cfg.approval?.beforeBuild, false);
  assert.equal(cfg.approval?.beforeMerge, false);
  assert.equal(cfg.dailyDocs, true);
});

test('the synopsis lists what merged, what needs a look, and the cost', () => {
  const rows = [row(1, '2026-11-05T01:00:00Z', 'Old one'), row(2, '2026-11-06T01:00:00Z', 'Azure A2'), row(3, '2026-11-06T02:00:00Z', 'Broke live', 'reverted', 3)];
  const s = synopsis(rows, '2026-11-06T00:00:00Z');
  assert.match(s, /2 cycle\(s\)/);
  assert.match(s, /Merged and live: 1/);
  assert.match(s, /reverted: 1/);
  assert.match(s, /Cost \$5\.00/);
  assert.match(s, /AP-0002 Azure A2/);
  assert.match(s, /Needs a look:\n- cycle 3: reverted/);
  assert.doesNotMatch(s, /Old one/);
  assert.equal(synopsis([], '2026-11-06'), 'No cycles since 2026-11-06.');
});

test('the requirements prompt lists the protected files, which no criterion may require changing', async () => {
  const { requirementsPrompt, ROLE_PROMPTS: PROMPTS } = await import('../src/agents/prompts.js');
  const cfg = defaultConfig();
  const p = requirementsPrompt(cfg, '(context)');
  assert.match(p, /Protected files/);
  assert.match(p, /docs\/SECURITY\.md/);
  assert.match(PROMPTS.requirements, /Never write a criterion that needs a protected file changed/);
});

test('with docsEveryDays set, the docs update waits until that many days have passed', () => {
  const cfg = { ...defaultConfig(), docsEveryDays: 3 };
  const docs = (day: string) => row(1, `${day}T01:00:00Z`, 'Daily docs 2026-x: y');
  // last docs 2 days ago (Nov 4): not due yet
  assert.equal(dailyDocsDue(cfg, [docs('2026-11-04')], new Date('2026-11-06T02:00:00Z')), false);
  // last docs 3 days ago (Nov 3): due
  assert.equal(dailyDocsDue(cfg, [docs('2026-11-03')], new Date('2026-11-06T02:00:00Z')), true);
  // already done today: never twice
  assert.equal(dailyDocsDue(cfg, [docs('2026-11-06')], new Date('2026-11-06T02:00:00Z')), false);
  // never done: due
  assert.equal(dailyDocsDue(cfg, [], new Date('2026-11-06T02:00:00Z')), true);
});

test('each stage runs on its configured model, and the developer keeps the strongest one', () => {
  const cfg = defaultConfig();
  assert.equal(cfg.agent.stageModels?.developer, 'claude-opus-5-5');
  for (const r of ['requirements', 'tester', 'reviewer', 'redesign'] as const) assert.equal(cfg.agent.stageModels?.[r], 'claude-sonnet-5-5');
  assert.equal(cfg.limits.maxCyclesPerDay, 2);
});
