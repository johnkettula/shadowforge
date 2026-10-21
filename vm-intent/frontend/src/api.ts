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
}

export interface VmRecord {
  specHash: string;
  spec: VmSpec;
  state: string;
  detail: string;
  result: VmResult | null;
  updatedAt: string;
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

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  preview: (text: string) => call<Interpretation>("POST", "/api/v2/interpret", { text }),
  submit: (text: string) => call<{ requestId: string }>("POST", "/api/v2/requests", { text }),
  status: (id: string) => call<RequestStatus>("GET", `/api/v2/requests/${id}`),
  clarify: (id: string, answer: string) => call<void>("POST", `/api/v2/requests/${id}/clarify`, { answer }),
  confirm: (id: string) => call<void>("POST", `/api/v2/requests/${id}/confirm`),
  cancel: (id: string) => call<void>("POST", `/api/v2/requests/${id}/cancel`),
  vms: () => call<VmRecord[]>("GET", "/api/v2/vms"),
  audit: (requestId: string) => call<AuditEvent[]>("GET", `/api/v2/audit?requestId=${encodeURIComponent(requestId)}`),
  legacy: (json: unknown) => call<Record<string, unknown>>("POST", "/api/v1/vms", json),
};
