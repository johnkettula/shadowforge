// A plain-language summary of a run (one or more days of cycles), for John to read when a run is closed
// out instead of approving each step. Built only from the pipeline's own records (reports/ledger.json).

import type { CycleResult } from './types.js';

const money = (n: number) => `$${n.toFixed(2)}`;

/** Cycles that started on or after `since` (an ISO date or time), oldest first. */
export function synopsis(rows: CycleResult[], since: string, now = new Date()): string {
  const run = rows.filter((r) => (r.startedAt ?? '') >= since);
  if (!run.length) return `No cycles since ${since}.`;
  const by = (o: string) => run.filter((r) => r.outcome === o);
  const merged = run.filter((r) => r.outcome === 'merged' || r.outcome === 'redesigned');
  const problems = run.filter((r) => !['merged', 'redesigned', 'no-work', 'skipped'].includes(r.outcome));
  const cost = run.reduce((t, r) => t + (r.costUsd || 0), 0);
  const line = (r: CycleResult) => {
    const what = r.requirement ? `${r.requirement.id} ${r.requirement.title}` : r.mode === 'redesign' ? 'design review' : r.mode;
    const sha = r.mergeSha ? ` (${r.mergeSha.slice(0, 7)})` : '';
    return `- cycle ${r.cycle}: ${r.outcome}${sha}, ${r.attempts} attempt(s), ${money(r.costUsd || 0)}: ${what}`;
  };
  const out = [
    `Synopsis: ${run.length} cycle(s) from ${run[0].startedAt.slice(0, 16).replace('T', ' ')} to ${(run[run.length - 1].endedAt ?? now.toISOString()).slice(0, 16).replace('T', ' ')} UTC`,
    `Merged and live: ${by('merged').length}; design reviews: ${by('redesigned').length}; reverted: ${by('reverted').length}; ` +
      `abandoned: ${by('abandoned').length}; other problems: ${problems.length - by('reverted').length - by('abandoned').length}. Cost ${money(cost)}.`,
    '',
    'What was built:',
    ...(merged.length ? merged.map(line) : ['- nothing merged']),
  ];
  if (problems.length) out.push('', 'Needs a look:', ...problems.map((r) => `${line(r)}\n  ${(r.note || '').split('\n')[0].slice(0, 300)}`));
  return out.join('\n');
}
