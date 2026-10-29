// What each agent may do. Every tool call an agent makes is checked here before it runs
// (the Agent SDK's canUseTool hook), and the activities check the resulting diff again,
// so a rule the hook misses is still caught before anything is merged.

import path from 'node:path';
import { matchesAny, toPosix } from '../glob.js';
import type { PipelineConfig, Role } from '../types.js';

export type Decision = { allow: true } | { allow: false; reason: string };

/** Files no agent may read, wherever they are: keys, passwords, Terraform variables. */
export const SECRET_GLOBS = [
  '**/.env',
  '**/.env.*',
  '**/*.tfvars',
  '**/*.tfstate',
  '**/*.tfstate.*',
  '**/*.key',
  '**/*.pem',
  '**/*.ppk',
  '**/*.p12',
  '**/*.pfx',
  '**/ai-settings.cmd',
  '**/id_rsa*',
  '**/id_ed25519*',
];

/** Never allowed in a shell command, for any role. */
const DENY_ALWAYS: [RegExp, string][] = [
  [/`|\$\(/, 'command substitution is not allowed'],
  [/\bsudo\b|\bsu\s/, 'no admin rights'],
  [/\bgit\s+(push|remote|reset|clean|config|commit|rebase|merge|cherry-pick|tag|switch|worktree|stash|branch\s+-[dDmM]|checkout\s+(?!--\s))/, 'the pipeline does commits, merges and pushes itself'],
  [/\brm\s+(-\w*\s+)*-\w*[rR]/, 'recursive delete is not allowed'],
  [/\b(ssh|scp|sftp|rsync|nc|ncat|telnet|ftp)\b/, 'no remote connections'],
  [/\b(docker|podman|kubectl|helm|terraform|az|aws|gcloud)\b/, 'the pipeline deploys; agents do not'],
  [/\b(printenv|env|set)\s*($|\|)|\bexport\b/, 'environment variables may hold keys'],
  [/ANTHROPIC|API_KEY|_TOKEN|SECRET|PASSWORD/, 'no key or password names in commands'],
  [/\b(kill|pkill|taskkill|shutdown|reboot)\b/, 'no stopping processes'],
  [/\b(chmod|chown|icacls|attrib)\b/, 'no permission changes'],
  [/\bfind\b.*\s-(delete|exec|execdir|ok)\b/, 'find may only list files'],
  [/\bsed\b(?!\s+-n\b)/, 'use the Edit tool to change files (sed -n to print is fine)'],
  [/\b(npm|npx|pnpm|yarn)\s+(publish|login|adduser|config|token)\b/, 'no registry account actions'],
  [/\bmvn\b.*\b(deploy|release:)/, 'no Maven deploys'],
];

/** Splits `a && b | c; d` into its commands, keeping quoted text whole. */
export function splitCommands(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    const two = cmd.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      out.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (c === ';' || c === '|' || c === '\n') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** True if `p` (absolute, or relative to `root`) is inside `root`. */
export function isInside(root: string, p: string): boolean {
  const abs = path.resolve(root, p);
  const rel = path.relative(path.resolve(root), abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function repoRelative(root: string, p: string): string {
  return toPosix(path.relative(path.resolve(root), path.resolve(root, p)));
}

export interface PolicyContext {
  cfg: PipelineConfig;
  role: Role;
  /** The worktree root the agent works in. */
  root: string;
  /** Hosts the tester may call (the staging stack). */
  stagingHosts?: string[];
}

export function toolsFor(role: Role): string[] {
  switch (role) {
    case 'developer':
    case 'tester':
      return ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write', 'TodoWrite'];
    case 'redesign':
      return ['Read', 'Glob', 'Grep', 'Bash', 'Write'];
    default:
      return ['Read', 'Glob', 'Grep', 'Bash'];
  }
}

export function writableGlobs(ctx: PolicyContext): string[] {
  const w = ctx.cfg.writableBy;
  if (ctx.role === 'developer') return w.developer;
  if (ctx.role === 'tester') return w.tester;
  if (ctx.role === 'redesign') return w.redesign;
  return [];
}

/** May this role change this file? Used by the edit hook and by the diff check. */
export function checkWrite(ctx: PolicyContext, file: string): Decision {
  if (!isInside(ctx.root, file)) return { allow: false, reason: `${file} is outside the working copy` };
  const rel = repoRelative(ctx.root, file);
  if (matchesAny(rel, SECRET_GLOBS)) return { allow: false, reason: `${rel} may hold secrets` };
  if (matchesAny(rel, ctx.cfg.protectedPaths)) return { allow: false, reason: `${rel} is protected (only people change it)` };
  if (ctx.role === 'developer' && matchesAny(rel, [`${ctx.cfg.acceptanceDir}/**`]))
    return { allow: false, reason: `${rel} belongs to the tester; the developer may not change the acceptance tests` };
  if (!matchesAny(rel, writableGlobs(ctx))) return { allow: false, reason: `the ${ctx.role} may not write ${rel}` };
  return { allow: true };
}

function checkRead(ctx: PolicyContext, file: string): Decision {
  if (!isInside(ctx.root, file)) return { allow: false, reason: `${file} is outside the working copy` };
  const rel = repoRelative(ctx.root, file);
  if (matchesAny(rel, SECRET_GLOBS)) return { allow: false, reason: `${rel} may hold secrets` };
  return { allow: true };
}

function allowedPatterns(ctx: PolicyContext): string[] {
  const a = ctx.cfg.allowedCommands;
  if (ctx.role === 'developer') return [...a.readonly, ...a.developer];
  if (ctx.role === 'tester') return [...a.readonly, ...a.tester];
  return a.readonly;
}

export function checkBash(ctx: PolicyContext, command: string): Decision {
  for (const [re, why] of DENY_ALWAYS) if (re.test(command)) return { allow: false, reason: why };
  // Output redirection writes files the edit hook never sees: only 2>&1 and /dev/null.
  const noSafeRedirects = command.replace(/\d?>&\d/g, '').replace(/\d?>\s*\/dev\/null/g, '').replace(/\d?>\s*NUL\b/g, '');
  if (/>/.test(noSafeRedirects.replace(/"[^"]*"|'[^']*'|->|=>|>=/g, ''))) return { allow: false, reason: 'no writing files with > (use the Write tool)' };
  if (/(^|[\s"'=])\.\.([\\/]|$)/.test(command)) return { allow: false, reason: 'no paths that leave the working copy (..)' };
  for (const m of command.matchAll(/(?:^|\s)((?:[A-Za-z]:)?[\\/][^\s"']*)/g)) {
    const p = m[1];
    if (p === '/dev/null' || /^\/(tmp|dev)\b/.test(p)) continue;
    if (!isInside(ctx.root, p)) return { allow: false, reason: `${p} is outside the working copy` };
  }
  const urls = [...command.matchAll(/https?:\/\/([^/\s:'"]+)/g)].map((m) => m[1]);
  for (const host of urls) {
    if (!(ctx.stagingHosts ?? []).includes(host)) return { allow: false, reason: `no calls to ${host}; only the staging stack` };
  }
  const allowed = allowedPatterns(ctx).map((p) => new RegExp(p));
  for (const part of splitCommands(command)) {
    const cd = /^cd\s+("?)([^"]+)\1$/.exec(part);
    if (cd) {
      if (!isInside(ctx.root, cd[2])) return { allow: false, reason: `cd ${cd[2]} leaves the working copy` };
      continue;
    }
    if (!allowed.some((re) => re.test(part))) return { allow: false, reason: `\`${part.slice(0, 80)}\` is not on the ${ctx.role}'s list of allowed commands` };
  }
  return { allow: true };
}

/** The decision for one tool call. */
export function decide(ctx: PolicyContext, toolName: string, input: Record<string, unknown>): Decision {
  if (!toolsFor(ctx.role).includes(toolName)) return { allow: false, reason: `the ${ctx.role} may not use ${toolName}` };
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined);
  switch (toolName) {
    case 'Read':
      return checkRead(ctx, str('file_path') ?? '');
    case 'Glob':
    case 'Grep': {
      const p = str('path');
      return p ? checkRead(ctx, p) : { allow: true };
    }
    case 'Edit':
    case 'Write':
      return checkWrite(ctx, str('file_path') ?? '');
    case 'Bash':
      return checkBash(ctx, str('command') ?? '');
    case 'TodoWrite':
      return { allow: true };
    default:
      return { allow: false, reason: `${toolName} is not allowed` };
  }
}
