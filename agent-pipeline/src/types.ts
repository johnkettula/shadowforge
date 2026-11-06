// Shared types. Everything here is plain data, because it crosses the line between
// the Temporal workflow and its activities.

/** A command the pipeline runs: a build, a test, starting or stopping a service. */
export interface CommandSpec {
  name: string;
  /** Run through the system shell, so `mvn -q test` works on Windows and Linux alike. */
  cmd: string;
  /** Relative to the worktree's project folder unless absolute. Placeholders allowed. */
  cwd?: string;
  env?: Record<string, string>;
  timeoutMinutes?: number;
  /** Only run when a changed file matches one of these globs (relative to the repo root). */
  onlyIfChanged?: string[];
}

/** A long-running process the staging deploy starts and later stops (local mode). */
export interface ServiceSpec {
  name: string;
  cmd: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Ready when this URL answers 2xx/3xx/4xx. Placeholders allowed. */
  readyUrl?: string;
  readyTimeoutSeconds?: number;
}

export interface DeploySpec {
  /**
   * processes: start each service as a child process and stop them afterwards.
   * commands:  run `start` commands (e.g. docker compose up) and `stop` commands afterwards.
   * none:      skip.
   */
  mode: 'processes' | 'commands' | 'none';
  /** Run first, in order (e.g. package the jar). */
  build?: CommandSpec[];
  services?: ServiceSpec[];
  start?: CommandSpec[];
  stop?: CommandSpec[];
  /** Base address the checks and the test agent use. Placeholders allowed. */
  apiUrl: string;
  /** Polled after start until it answers. */
  healthUrl?: string;
  healthTimeoutSeconds?: number;
}

export interface Limits {
  maxCyclesPerDay: number;
  maxUsdPerDay: number;
  maxUsdPerCycle: number;
  maxUsdPerAgentRun: number;
  maxAgentTurns: number;
  /** Developer → gates → staging → tests → review rounds before a requirement is abandoned. */
  maxDevAttempts: number;
  maxChangedFiles: number;
  /** Lines added + removed, not counting files matching `generated` (regenerated snapshots). */
  maxChangedLines: number;
  /** This many failed cycles in a row pauses the pipeline until someone resumes it. */
  consecutiveFailuresToPause: number;
  /** Every Nth cycle is a redesign review instead of a feature. 0 = never. */
  redesignEvery: number;
  minutesBetweenCycles: number;
}

/** Points where a cycle stops and waits for a person's decision (approve, skip or reject). */
export interface ApprovalGates {
  /** After the requirement is chosen, before any code is written. */
  beforeBuild: boolean;
  /** After the change passed every check and the reviewer, before it's merged and pushed. */
  beforeMerge: boolean;
  /** How long to wait for an answer before skipping (build) or rejecting (merge). Default 7 days. */
  waitDays?: number;
}

export interface PipelineConfig {
  /** The first feature cycle of each day (UTC) brings the documentation up to date. Default on. */
  dailyDocs?: boolean;
  approval?: ApprovalGates;
  /** Generated files (OpenAPI snapshots and the like): they count as files, but their lines don't count toward maxChangedLines. */
  generated?: string[];
  /** Folder the pipeline owns: its clone of the repo, worktrees, staging data, reports, logs. */
  home: string;
  /** Git URL or local path of the repository to improve. */
  repoUrl: string;
  baseBranch: string;
  /** Folder inside the repo that holds the project (vm-intent). */
  projectDir: string;
  /** Push merges and reverts to the remote's baseBranch. */
  push: boolean;
  git: { authorName: string; authorEmail: string };
  agent: {
    /** claude = Claude Agent SDK. scripted = canned behaviour, for tests and dry runs. */
    mode: 'claude' | 'scripted';
    model?: string;
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  };
  /** Paths (globs, relative to the repo root) no agent may change. Checked on every edit and again on the diff. */
  protectedPaths: string[];
  /** Files here may be added but never changed or deleted (database migrations, recorded workflow histories). */
  appendOnly: string[];
  /** Where each role may write. Developer may also not write under the tester's folder and vice versa. */
  writableBy: { developer: string[]; tester: string[]; redesign: string[] };
  /** The tester agent's acceptance tests live here; the checks stage runs all of them. */
  acceptanceDir: string;
  /** The running list of requirements the pipeline has built, inside the repo. */
  requirementsDoc: string;
  /** Bash commands agents may run (regex, matched against each command in a chain). */
  allowedCommands: { developer: string[]; tester: string[]; readonly: string[] };
  gates: CommandSpec[];
  /** Run against a deployed stack (staging and, after a merge, live). {apiUrl} is filled in. */
  checks: CommandSpec[];
  staging: DeploySpec;
  /** The long-lived deployment updated after each merge. mode none = don't deploy after merging. */
  live: DeploySpec;
  /** Base port for staging; each cycle adds 10 × (cycle mod 10) so stale stacks never collide. */
  stagingPortBase: number;
  /** Base port for the live deployment (api = base, temporal = base+1, …). */
  livePortBase: number;
  limits: Limits;
  /** Extra {placeholders} for commands, e.g. { "temporal": "C:/tools/temporal.exe" }. */
  vars: Record<string, string>;
  /** Extra direction for the requirements agent: what to focus on, what to leave alone. */
  goals: string;
}

export type Role = 'requirements' | 'developer' | 'tester' | 'reviewer' | 'redesign';

export interface Requirement {
  id: string;
  title: string;
  /** Why: which signal (failing check, gap in docs, review finding, backlog item) it answers. */
  rationale: string;
  acceptanceCriteria: string[];
  risk: 'low' | 'medium' | 'high';
  /** Folders or files the agent expects to touch. */
  areas: string[];
}

export interface GateResult {
  name: string;
  passed: boolean;
  skipped?: boolean;
  seconds: number;
  /** Last lines of output, enough for the developer agent to act on. */
  tail: string;
}

export interface AgentUsage {
  costUsd: number;
  turns: number;
  seconds: number;
}

export interface CyclePrep {
  cycle: number;
  mode: 'feature' | 'redesign';
  branch: string;
  /** The worktree's root (the repo root, not the project folder). */
  worktree: string;
  baseSha: string;
  /** Short text the requirements/redesign agents read: recent cycles, backlog, last live check. */
  context: string;
  portOffset: number;
}

export interface DiffCheck {
  sha: string;
  files: string[];
  added: number;
  removed: number;
  violations: string[];
}

export type CycleOutcome =
  | 'merged'
  | 'reverted'
  | 'abandoned'
  | 'parked'
  | 'no-work'
  | 'redesigned'
  | 'over-budget'
  | 'error'
  /** A person said not to build the requirement (or didn't answer in time). */
  | 'skipped'
  /** Built and checked, but a person said not to merge it. */
  | 'rejected';

export interface CycleResult {
  cycle: number;
  mode: 'feature' | 'redesign';
  outcome: CycleOutcome;
  requirement?: Requirement;
  attempts: number;
  costUsd: number;
  mergeSha?: string;
  revertSha?: string;
  note: string;
  reportPath?: string;
  startedAt: string;
  endedAt: string;
}

export interface StagingHandle {
  apiUrl: string;
  pids: number[];
  stopCommands: CommandSpec[];
  vars: Record<string, string>;
  logDir: string;
}
