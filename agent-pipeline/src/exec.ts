// Running commands and processes, the same way on Windows (basement) and Linux.

import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
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

/** Is this process alive and is its program called something containing `name`? */
export function processNamed(pid: number, name: string): boolean {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
      return (r.stdout ?? '').toLowerCase().includes(name.toLowerCase());
    }
    return readFileSync(`/proc/${pid}/comm`, 'utf8').toLowerCase().includes(name.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Stops Postgres servers whose data folders are under `dir`. An embedded Postgres (the backend's
 * own database) starts itself as a separate process, so stopping the backend's process tree leaves
 * it running, holding the folders open (Windows then refuses to delete them). Its postmaster.pid
 * says which process it is; it's only stopped if that process really is Postgres.
 */
export function killPostgresIn(dir: string): number[] {
  const killed: number[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 4 || !existsSync(d)) return;
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    if (names.includes('postmaster.pid')) {
      try {
        const pid = Number(readFileSync(path.join(d, 'postmaster.pid'), 'utf8').split(/\r?\n/)[0]);
        if (pid > 0 && processNamed(pid, 'postgres')) {
          killTree(pid);
          killed.push(pid);
        }
      } catch {
        /* unreadable: leave it */
      }
    }
    for (const n of names) {
      const p = path.join(d, n);
      try {
        if (statSync(p).isDirectory()) walk(p, depth + 1);
      } catch {
        /* gone meanwhile */
      }
    }
  };
  walk(dir, 0);
  return killed;
}

/** Deletes a folder, retrying while Windows still has files in it open. False if it couldn't. */
export function removeDir(dir: string): boolean {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    return !existsSync(dir);
  } catch {
    return false;
  }
}

/**
 * Stops whatever is listening on these TCP ports. A deploy's processes are normally stopped by
 * killTree, but on Windows a process can outlive its recorded parent (the live backend did, and
 * kept the jar locked so the next build failed). The ports belong to that deploy alone, so
 * anything still listening on them is a leftover. Returns the pids it stopped.
 */
export function killListeners(ports: number[]): number[] {
  const wanted = ports.filter((p) => Number.isInteger(p) && p > 0);
  if (!wanted.length) return [];
  const pids = new Set<number>();
  if (process.platform === 'win32') {
    const ps =
      `$p = @(${wanted.join(',')}); ` +
      'Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ' +
      'Where-Object { $p -contains $_.LocalPort } | Select-Object -ExpandProperty OwningProcess -Unique';
    const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true });
    for (const line of (r.stdout ?? '').split(/\r?\n/)) if (/^\d+$/.test(line.trim())) pids.add(Number(line.trim()));
  } else {
    for (const port of wanted) {
      const r = spawnSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
      for (const line of (r.stdout ?? '').split(/\r?\n/)) if (/^\d+$/.test(line.trim())) pids.add(Number(line.trim()));
    }
  }
  pids.delete(process.pid);
  pids.delete(0);
  for (const pid of pids) {
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      else process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  return [...pids];
}

/**
 * Processes whose command line names a path inside `dir` (the deploy's backend runs a jar copied
 * into it, and its embedded Postgres runs with its data folder there). Finds them even when they
 * outlived their recorded parent and listen on no port. Never includes this process.
 */
export function processesUsing(dir: string): number[] {
  const want = path.resolve(dir).replace(/[\\/]+$/, '');
  if (!want || want.length < 8) return []; // never match something as broad as a drive root
  const pids = new Set<number>();
  if (process.platform === 'win32') {
    // Followed by a separator, so state\live never matches state\live2. $PID leaves out this
    // PowerShell itself, whose own command line contains the folder.
    const needle = (want.replace(/\//g, '\\') + '\\').toLowerCase().replace(/'/g, "''");
    const ps =
      `$n = '${needle}'; ` +
      'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ' +
      "Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Replace('/', '\\').ToLower().Contains($n) } | " +
      'Select-Object -ExpandProperty ProcessId';
    const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true });
    for (const line of (r.stdout ?? '').split(/\r?\n/)) if (/^\d+$/.test(line.trim())) pids.add(Number(line.trim()));
  } else {
    let entries: string[] = [];
    try {
      entries = readdirSync('/proc').filter((n) => /^\d+$/.test(n));
    } catch {
      return [];
    }
    for (const n of entries) {
      try {
        const cmd = readFileSync(`/proc/${n}/cmdline`, 'utf8').replace(/\0/g, ' ');
        if (cmd.includes(want + '/')) pids.add(Number(n));
      } catch {
        /* gone meanwhile */
      }
    }
  }
  pids.delete(process.pid);
  pids.delete(0);
  return [...pids];
}

/**
 * Stops every process using `dir` (see processesUsing) and waits until none is left, so a new
 * deploy doesn't start while the old one still holds its files (on 2026-11-08 the live backend
 * crashed with "could not lock …\pgdata\epg-lock" because the old one hadn't exited yet).
 * Returns what was still running when it gave up; empty means the folder is free.
 */
export async function stopProcessesUsing(dir: string, timeoutMs = 90_000, find = processesUsing): Promise<number[]> {
  const until = Date.now() + timeoutMs;
  let left = find(dir);
  while (left.length) {
    for (const pid of left) killTree(pid);
    if (Date.now() >= until) break;
    await new Promise((r) => setTimeout(r, 2000));
    left = find(dir);
  }
  return left;
}
