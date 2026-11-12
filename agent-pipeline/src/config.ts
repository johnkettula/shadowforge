// The pipeline's settings: defaults for vm-intent, then pipeline.config.json, then environment.

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PipelineConfig } from './types.js';

const P = 'vm-intent';

/** Runs the backend jar from a worktree with its own ports, data folders and Temporal address. */
const backendService = (readyPath: string) => ({
  name: 'backend',
  cwd: 'backend',
  cmd:
    'node "{pipelineDir}/scripts/run-jar.mjs" target ' +
    '--server.port={port.api} --vmintent.db.embedded-port={port.db} "--vmintent.db.embedded-data-dir={stateDir}/pgdata"',
  env: {
    TEMPORAL_ADDRESS: '127.0.0.1:{port.temporal}',
    VMINTENT_FILES_DIR: '{stateDir}/files',
    // run-jar.mjs runs a copy of the jar from here, so a build can replace target/*.jar.
    RUN_JAR_DIR: '{stateDir}/run',
    VMINTENT_TARGETS_DIR: '{stateDir}/targets',
    VMINTENT_LINK_OUTBOX: '{stateDir}/link/outbox',
    VMINTENT_LINK_INBOX: '{stateDir}/link/inbox',
    VMINTENT_ARCHIVE_DIR: '{stateDir}/archive',
    VMINTENT_LLM_PROVIDER: 'none',
  },
  readyUrl: `http://127.0.0.1:{port.api}${readyPath}`,
  readyTimeoutSeconds: 240,
});

const temporalService = {
  name: 'temporal',
  cmd: '"{temporal}" server start-dev --port {port.temporal} --ui-port {port.temporalUi} "--db-filename={stateDir}/temporal.db" --log-level warn',
  readyUrl: 'http://127.0.0.1:{port.temporalUi}',
  readyTimeoutSeconds: 90,
};

export function defaultConfig(): PipelineConfig {
  return {
    home: path.join(os.homedir(), 'agent-pipeline-home'),
    repoUrl: 'https://github.com/johnkettula/shadowforge.git',
    baseBranch: 'main',
    projectDir: P,
    push: true,
    git: { authorName: 'vm-intent agent pipeline', authorEmail: 'agent-pipeline@users.noreply.github.com' },
    agent: {
      mode: 'claude',
      effort: 'high',
      // The developer does the coding, so it keeps the strongest model; the other stages use Sonnet (half the price).
      stageModels: { developer: 'claude-opus-5-5', requirements: 'claude-sonnet-5-5', tester: 'claude-sonnet-5-5', reviewer: 'claude-sonnet-5-5', redesign: 'claude-sonnet-5-5' },
    },
    docsEveryDays: 3,
    protectedPaths: [
      'agent-pipeline/**',
      '.github/**',
      '.gitlab-ci.yml',
      `${P}/deploy/azure/**`,
      `${P}/deploy/pki/**`,
      `${P}/deploy/catalog/gitlab-ci*`,
      `${P}/*.cmd`,
      `${P}/*.ps1`,
      `${P}/backend/src/main/java/com/example/vmintent/security/**`,
      `${P}/backend/src/main/resources/application-tls.yml`,
      `${P}/docs/SECURITY.md`,
    ],
    // A person approves each requirement before it's built, and each change before it's merged.
    // John decides at the end of a run, from its synopsis, instead of approving each step (2026-11-05).
    approval: { beforeBuild: false, beforeMerge: false, waitDays: 7 },
    dailyDocs: true,
    generated: [`${P}/docs/openapi.json`, `${P}/docs/openapi.yaml`, `${P}/frontend/package-lock.json`, `${P}/backend/src/test/resources/histories/**`],
    appendOnly: [`${P}/backend/src/main/resources/db/migration/**`, `${P}/backend/src/test/resources/histories/**`],
    writableBy: {
      developer: [`${P}/**`],
      tester: [`${P}/tests/acceptance/**`],
      redesign: [`${P}/docs/redesign/**`],
    },
    acceptanceDir: `${P}/tests/acceptance`,
    requirementsDoc: `${P}/docs/AGENT-REQUIREMENTS.md`,
    allowedCommands: {
      readonly: [
        '^git (status|diff|log|show|ls-files|grep|blame)\\b',
        '^(ls|dir|cat|type|head|tail|wc|grep|rg|find|tree|pwd|echo|sort|uniq|cut|file|which|where)\\b',
        '^sed -n\\b',
        '^(java|mvn|node|npm|python3?) (-version|--version|-v)$',
      ],
      developer: [
        '^(mvn|mvn\\.cmd|\\./mvnw)( |$)',
        '^npm (ci|test|install)( --(no-audit|no-fund|silent|prefer-offline))*\\s*$',
        '^npm run [\\w:-]+',
        '^npx (tsc|vite|vitest)\\b',
        '^node [\\w./@-]+',
        '^python3? [\\w./-]+\\.py\\b',
        '^python3? -m (pytest|py_compile|unittest)\\b',
        '^git (add|restore)\\b',
        // Removing a stray file the developer added (a reviewer asked for this in cycle 18 and the developer
        // couldn't). One file at a time; recursive deletes stay refused by DENY_ALWAYS.
        '^git rm( -q| -f| --cached)* [\\w./-]+$',
        '^rm( -f)? [\\w./-]+$',
        '^(mkdir|touch)\\b',
        '^(cp|mv) [\\w./-]+ [\\w./-]+$',
      ],
      tester: ['^node [\\w./@-]+', '^node --test\\b', '^python3? [\\w./-]+\\.py\\b', '^curl\\s', '^(mkdir|touch)\\b'],
    },
    gates: [
      { name: 'backend: unit, workflow and replay tests', cmd: 'mvn -q -B test', cwd: 'backend', timeoutMinutes: 45, onlyIfChanged: [`${P}/backend/**`] },
      { name: 'web app: type-check and build', cmd: 'npm ci --no-audit --no-fund && npm run build', cwd: 'frontend', timeoutMinutes: 15, onlyIfChanged: [`${P}/frontend/**`] },
    ],
    checks: [
      { name: 'API contract (OpenAPI)', cmd: '{python} tests/api_contract_test.py {apiUrl}', timeoutMinutes: 15 },
      { name: 'load test (60 VMs, 3 failing on purpose)', cmd: 'node loadtest/run-loadtest.mjs --count 60 --shard 30 --fail 3 --api {apiUrl} --out "{stateDir}/loadtest.json"', timeoutMinutes: 15 },
    ],
    staging: {
      mode: 'processes',
      build: [{ name: 'package the backend', cmd: 'mvn -q -B -DskipTests package', cwd: 'backend', timeoutMinutes: 20 }],
      services: [temporalService, backendService('/v3/api-docs')],
      apiUrl: 'http://127.0.0.1:{port.api}',
      healthUrl: 'http://127.0.0.1:{port.api}/api/v2/requests',
    },
    live: {
      mode: 'processes',
      build: [{ name: 'package the backend', cmd: 'mvn -q -B -DskipTests package', cwd: 'backend', timeoutMinutes: 20 }],
      services: [temporalService, backendService('/v3/api-docs')],
      apiUrl: 'http://127.0.0.1:{port.api}',
      healthUrl: 'http://127.0.0.1:{port.api}/api/v2/requests',
    },
    stagingPortBase: 19000,
    livePortBase: 18080,
    limits: {
      maxCyclesPerDay: 2,
      maxUsdPerDay: 12,
      maxUsdPerCycle: 8,
      maxUsdPerAgentRun: 3,
      maxAgentTurns: 80,
      maxDevAttempts: 3,
      maxChangedFiles: 25,
      maxChangedLines: 800,
      consecutiveFailuresToPause: 3,
      redesignEvery: 5,
      minutesBetweenCycles: 30,
    },
    vars: { temporal: 'temporal' },
    goals:
      'Make vm-intent more reliable and complete: fix anything that fails, close gaps between the docs ' +
      '(docs/, README) and the code, add missing tests for important behaviour, and make small ' +
      'improvements users of the web app and API would notice. Leave sign-in and security, the Azure ' +
      'and Terraform files, and this pipeline alone.',
  };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

function merge<T>(base: T, over: DeepPartial<T> | undefined): T {
  if (!over) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    const b = (base as Record<string, unknown>)[k];
    // A deploy section is replaced whole: mixing a custom one with the default's build steps surprises.
    const whole = k === 'staging' || k === 'live';
    out[k] = !whole && v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b) ? merge(b, v as never) : v;
  }
  return out as T;
}

/** Defaults, then the JSON file (if any), then environment variables. */
export function loadConfig(file?: string): PipelineConfig {
  let cfg = defaultConfig();
  const f = file ?? process.env.AGENT_PIPELINE_CONFIG ?? path.join(process.cwd(), 'pipeline.config.json');
  if (existsSync(f)) cfg = merge(cfg, JSON.parse(readFileSync(f, 'utf8')) as DeepPartial<PipelineConfig>);
  if (process.env.AGENT_PIPELINE_HOME) cfg.home = process.env.AGENT_PIPELINE_HOME;
  if (process.env.AGENT_PIPELINE_AGENT === 'scripted' || process.env.AGENT_PIPELINE_AGENT === 'claude') cfg.agent.mode = process.env.AGENT_PIPELINE_AGENT;
  // A dry run (scripted agents) proves the plumbing; it doesn't stop to ask anyone.
  if (cfg.agent.mode === 'scripted') cfg.approval = { ...(cfg.approval ?? { beforeBuild: false, beforeMerge: false }), beforeBuild: false, beforeMerge: false };
  if (process.env.AGENT_PIPELINE_PUSH) cfg.push = process.env.AGENT_PIPELINE_PUSH === 'true';
  if (process.env.AGENT_PIPELINE_PORT_OFFSET) {
    const off = Number(process.env.AGENT_PIPELINE_PORT_OFFSET) || 0;
    cfg.stagingPortBase += off;
    cfg.livePortBase += off;
  }
  if (process.env.TEMPORAL_CLI) cfg.vars = { ...cfg.vars, temporal: process.env.TEMPORAL_CLI };
  cfg.home = path.resolve(cfg.home.replace(/^~(?=$|[\\/])/, os.homedir()));
  return cfg;
}

export const TASK_QUEUE = 'agent-pipeline';
export const PIPELINE_WORKFLOW_ID = 'vm-intent-agent-pipeline';
