// Types mirror the Java records in the backend (Models.java, VmSpec.java, Interpretation.java).

export interface VmSpec {
  name: string;
  provider: string;
  region: string;
  vcpu: number;
  memoryGiB: number;
  os: string;
  osVersion: string;
  diskGiB: number;
  diskTier: string;
  env: string;
  ttlDays: number;
  publicIp: boolean;
}

export interface Interpretation {
  text: string;
  extractor: string;
  spec: VmSpec | null;
  specHash: string | null;
  summary: string | null;
  assumptions: string[];
  question: string | null;
  /** How many identical VMs; left out when it's one. */
  count?: number;
}

export interface VmResult {
  vmId: string;
  ipAddress: string;
  provider: string;
  nativeRegion: string;
  nativeSize: string;
  nativeImage: string;
}

export interface RequestStatus {
  requestId: string;
  state: string;
  message: string;
  interpretation: Interpretation | null;
  vm: VmResult | null;
  history: string[];
  requestedBy?: string;
  /** Every VM of a request for more than one. */
  vms?: VmResult[];
}

/** A running VM's life after its build (VmLifecycleWorkflow). */
export interface VmLifecycle {
  state: "ACTIVE" | "DECOMMISSIONING" | "DECOMMISSIONED" | "MISSING";
  expiresAt: string;
  expiresAtMs: number;
  warned: boolean;
  power: "ON" | "OFF";
  vcpu: number;
  memoryGiB: number;
  snapshots: string[];
  owner: string;
  history: string[];
}

export interface RequestSummary {
  requestId: string;
  state?: string;
  requestedBy?: string;
  provider?: string;
  env?: string;
  startedAt?: string;
  closedAt?: string;
  workflowStatus: string;
}

export interface InventoryFinding {
  provider: string;
  note: string;
  recordedRunning: number;
  inCloud: number;
  missing: string[];
  orphans: string[];
}

export interface InventoryReport {
  checkId: string;
  startedAt: string;
  finishedAt: string;
  missingCount: number;
  orphanCount: number;
  findings: InventoryFinding[];
}

export interface VmRecord {
  specHash: string;
  spec: VmSpec;
  state: string;
  detail: string;
  result: VmResult | null;
  updatedAt: string;
  lifecycle?: VmLifecycle;
}

export interface AuditEvent {
  id: number;
  at: string;
  requestId: string | null;
  specHash: string | null;
  event: string;
  actor: string | null;
  detail: string | null;
}

// ------------------------------------------------------------------ catalog (CatalogModels.java)

export interface DefinitionEntry {
  kind: "Provisioning" | "Blueprint";
  name: string;
  version: number;
  description?: string;
  sha256: string;
  publishedBy: string;
  publishedAt: string;
  retired: boolean;
}

export interface InputDef {
  name: string;
  type: "string" | "int" | "bool" | "list";
  description?: string;
  required: boolean;
  defaultValue?: unknown;
  allowed?: unknown[];
}

export interface StepDef {
  id: string;
  action: string;
  title?: string;
  when?: string;
}

export interface Definition {
  name: string;
  version: number;
  description?: string;
  owner?: string;
  classification?: string;
  blueprint?: string;
  inputs: InputDef[];
  steps: StepDef[];
  recoveryWaitHours: number;
}

export interface DefinitionView {
  entry: DefinitionEntry;
  definition?: Definition;
  yaml: string;
}

export interface Classification {
  code: string;
  label: string;
  retentionYears: number;
}

export interface StepState {
  id: string;
  action: string;
  title: string;
  state: string;
  attempts: number;
  output?: Record<string, unknown>;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface RunStatus {
  runId: string;
  definition: string;
  version: number;
  state: string;
  message: string;
  requestedBy: string;
  classification: Classification;
  params: Record<string, unknown>;
  steps: StepState[];
  failedStep?: string;
  recoveryDeadline?: string;
  approval?: { step: string; message: string; approvers: string[]; deadline: string };
  history: string[];
}

export interface RunRow {
  runId: string;
  definition: string;
  version: number;
  classification: string;
  requestedBy: string;
  state: string;
  startedAt: string;
  finishedAt?: string;
}

export interface Decision {
  id: number;
  at: string;
  actor: string;
  roles?: string;
  action: string;
  resource?: string;
  decision: "ALLOW" | "DENY";
  policy: string;
  reason?: string;
  classification: string;
  keepUntil: string;
}

export interface ArchiveRow {
  workflowId: string;
  runId: string;
  workflowType: string;
  classification: string;
  retentionYears: number;
  closedAt: string;
  archivedAt: string;
  keepUntil: string;
  sha256: string;
  sizeBytes: number;
  events: number;
  expiredAt?: string;
}

export interface ReplayResult {
  workflowId: string;
  runId: string;
  workflowType: string;
  source: "archive" | "temporal";
  events: number;
  sha256?: string;
  matches: boolean;
  problem?: string;
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    // Not JSON (a proxy or server error page): show what the server said instead of a parse error.
    throw new Error(`The server answered ${res.status}${res.ok ? "" : " (error)"}: ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  preview: (text: string) => call<Interpretation>("POST", "/api/v2/interpret", { text }),
  submit: (text: string) => call<{ requestId: string }>("POST", "/api/v2/requests", { text }),
  status: (id: string) => call<RequestStatus>("GET", `/api/v2/requests/${id}`),
  clarify: (id: string, answer: string) => call<void>("POST", `/api/v2/requests/${id}/clarify`, { answer }),
  confirm: (id: string, specHash?: string | null) =>
    call<RequestStatus>("POST", `/api/v2/requests/${id}/confirm`, { specHash: specHash ?? null }),
  requests: (filter: Record<string, string>) =>
    call<RequestSummary[]>("GET", `/api/v2/requests?${new URLSearchParams({ limit: "20", ...filter })}`),
  cancel: (id: string) => call<void>("POST", `/api/v2/requests/${id}/cancel`),
  vms: () => call<VmRecord[]>("GET", "/api/v2/vms"),
  audit: (requestId: string) => call<AuditEvent[]>("GET", `/api/v2/audit?requestId=${encodeURIComponent(requestId)}`),
  legacy: (json: unknown) => call<Record<string, unknown>>("POST", "/api/v1/vms", json),
  lifecycle: (hash: string) => call<VmLifecycle>("GET", `/api/v2/vms/${hash}/lifecycle`),
  renew: (hash: string, days: number) => call<VmLifecycle>("POST", `/api/v2/vms/${hash}/renew`, { days }),
  resize: (hash: string, vcpu: number, memoryGiB: number) =>
    call<VmLifecycle>("POST", `/api/v2/vms/${hash}/resize`, { vcpu, memoryGiB }),
  power: (hash: string, on: boolean) => call<VmLifecycle>("POST", `/api/v2/vms/${hash}/power`, { on }),
  snapshot: (hash: string, label: string) => call<VmLifecycle>("POST", `/api/v2/vms/${hash}/snapshot`, { label }),
  decommission: (hash: string, reason: string) =>
    call<VmLifecycle>("POST", `/api/v2/vms/${hash}/decommission`, { reason }),
  inventoryChecks: () => call<InventoryReport[]>("GET", "/api/v2/inventory-checks?limit=1"),
  runInventoryCheck: () => call<{ checkId: string }>("POST", "/api/v2/inventory-checks"),

  definitions: () => call<DefinitionEntry[]>("GET", "/api/v2/definitions"),
  definition: (name: string) => call<DefinitionView>("GET", `/api/v2/definitions/Provisioning/${encodeURIComponent(name)}`),
  classifications: () => call<{ default: string; classifications: Classification[] }>("GET", "/api/v2/classifications"),
  startRun: (definition: string, params: Record<string, unknown>, classification?: string) =>
    call<{ runId: string; existing: boolean; status: RunStatus }>("POST", "/api/v2/runs", {
      definition,
      params,
      classification: classification || null,
    }),
  runs: () => call<RunRow[]>("GET", "/api/v2/runs?limit=15"),
  run: (id: string) => call<RunStatus>("GET", `/api/v2/runs/${id}`),
  resume: (id: string, note: string) => call<RunStatus>("POST", `/api/v2/runs/${id}/resume`, { note }),
  teardown: (id: string, reason: string) => call<RunStatus>("POST", `/api/v2/runs/${id}/teardown`, { reason }),
  approve: (id: string, approved: boolean, note: string) =>
    call<RunStatus>("POST", `/api/v2/runs/${id}/approve`, { approved, note }),

  decisions: (resource: string) =>
    call<Decision[]>("GET", `/api/v2/compliance/decisions?limit=30${resource ? "&resource=" + encodeURIComponent(resource) : ""}`),
  archive: () => call<ArchiveRow[]>("GET", "/api/v2/compliance/archive?limit=30"),
  replay: (workflowId: string, runId?: string) =>
    call<ReplayResult>("POST", "/api/v2/compliance/replays", { workflowId, runId: runId ?? null }),
  sweep: () => call<{ workflowId: string }>("POST", "/api/v2/compliance/sweeps"),
};
