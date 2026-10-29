// Running commands and processes, the same way on Windows (basement) and Linux.

import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';

export interface RunResult {
  code: number | null;
  timedOut: boolean;
  seconds: number;
  /** The last ~120 lines of stdout+stderr. */
  tail: string;
}

const TAIL_LINES = 120;

/** Fills {name} placeholders. Unknown names are left as they are. */
export function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{([a-zA-Z][\w.]*)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

export function fillEnv(env: Record<string, string> | undefined, vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) out[k] = fill(v, vars);
  return out;
}

/** Environment for build/test commands: inherited, minus Anthropic keys (they're only for the agents). */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const k of Object.keys(env)) if (/^ANTHROPIC_|^CLAUDE_CODE_OAUTH/.test(k)) delete env[k];
  return env;
}

export function run(
  cmd: string,
  opts: { cwd: string; env?: Record<string, string>; timeoutMs: number; logFile?: string; onOutput?: () => void },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    if (opts.logFile) mkdirSync(path.dirname(opts.logFile), { recursive: true });
    const log = opts.logFile ? createWriteStream(opts.logFile, { flags: 'a' }) : null;
    log?.write(`\n$ ${cmd}\n# in ${opts.cwd} at ${new Date().toISOString()}\n`);
    const child = spawn(cmd, {
      cwd: opts.cwd,
      env: childEnv(opts.env),
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const lines: string[] = [];
    let partial = '';
    const onData = (b: Buffer) => {
      log?.write(b);
      opts.onOutput?.();
      const text = partial + b.toString('utf8');
      const parts = text.split(/\r?\n/);
      partial = parts.pop() ?? '';
      lines.push(...parts);
      if (lines.length > TAIL_LINES * 2) lines.splice(0, lines.length - TAIL_LINES);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, opts.timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (partial) lines.push(partial);
      const tail = lines.slice(-TAIL_LINES).join('\n') + (timedOut ? `\n[stopped after ${Math.round(opts.timeoutMs / 1000)} s]` : '');
      log?.end(`\n# exit ${code}${timedOut ? ' (timed out)' : ''}\n`);
      resolve({ code, timedOut, seconds: (Date.now() - started) / 1000, tail });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      log?.end(`\n# failed to start: ${err.message}\n`);
      resolve({ code: -1, timedOut: false, seconds: (Date.now() - started) / 1000, tail: `failed to start: ${err.message}` });
    });
  });
}

/** Starts a long-running process with its output going to a log file. Returns its pid. */
export function startService(cmd: string, opts: { cwd: string; env?: Record<string, string>; logFile: string }): number {
  mkdirSync(path.dirname(opts.logFile), { recursive: true });
  const out = createWriteStream(opts.logFile, { flags: 'a' });
  const child = spawn(cmd, {
    cwd: opts.cwd,
    env: childEnv(opts.env),
    shell: true,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);
  child.unref();
  if (!child.pid) throw new Error(`could not start: ${cmd}`);
  return child.pid;
}

/** Stops a process and everything it started. */
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        process.kill(pid, 'SIGTERM');
      }
      setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }, 5000).unref();
    }
  } catch {
    /* already gone */
  }
}

/** Waits until the URL answers with any HTTP status below 500. */
export async function waitForUrl(url: string, timeoutMs: number, heartbeat?: () => void): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    heartbeat?.();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

export function git(cwd: string, args: string[], allowFail = false): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${(r.stderr || r.stdout || '').trim()}`);
  }
  return (r.stdout ?? '').trim();
}
