#!/usr/bin/env node
/**
 * vm-intent MCP server.
 *
 * Gives Claude (or any MCP client) tools to drive the vm-intent app running on
 * this computer: preview how a request is interpreted, start a request
 * workflow, answer its question, confirm or cancel it, list VMs, read the
 * audit trail, and run the phrasing test sets.
 *
 * It talks to the Spring Boot backend over HTTP, so start the app first
 * (1-start-temporal.cmd, 2-start-backend.cmd).
 *
 * Settings (environment variables):
 *   VMINTENT_API_BASE  backend address   (default http://localhost:8080)
 *   VMINTENT_HOME      project folder    (default: the folder above mcp-server)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_BASE = (process.env.VMINTENT_API_BASE ?? "http://localhost:8080").replace(/\/$/, "");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.VMINTENT_HOME ?? path.resolve(HERE, "..", "..");
const TESTS_DIR = path.join(HOME, "tests");

// ---------------------------------------------------------------- helpers

type Json = Record<string, unknown>;

async function api(method: "GET" | "POST", route: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(API_BASE + route, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(
      `Can't reach the vm-intent backend at ${API_BASE}. Start it with 2-start-backend.cmd (and Temporal with 1-start-temporal.cmd).`,
    );
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = (data as Json | null)?.error ?? `HTTP ${res.status}`;
    throw new Error(`Backend refused ${method} ${route}: ${msg}`);
  }
  return data;
}

function ok(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

function fail(err: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }] };
}

/** Wraps a handler so errors come back as tool errors instead of crashing the server. */
function safe<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "DUPLICATE"]);
const WAITING = new Set(["AWAITING_CLARIFICATION", "AWAITING_CONFIRMATION"]);

/** Polls a request until it needs the user, or finishes, or the timeout passes. */
async function waitForStep(requestId: string, timeoutMs: number): Promise<Json> {
  const until = Date.now() + timeoutMs;
  let status = (await api("GET", `/api/v2/requests/${encodeURIComponent(requestId)}`)) as Json;
  while (Date.now() < until && !FINAL.has(String(status.state)) && !WAITING.has(String(status.state))) {
    await sleep(700);
    status = (await api("GET", `/api/v2/requests/${encodeURIComponent(requestId)}`)) as Json;
  }
  return status;
}

/** Short, readable view of a request's status for the model. */
function describe(status: Json) {
  const it = (status.interpretation ?? null) as Json | null;
  return {
    requestId: status.requestId,
    state: status.state,
    message: status.message,
    summary: it?.summary ?? null,
    specHash: it?.specHash ?? null,
    assumptions: it?.assumptions ?? [],
    question: it?.question ?? null,
    vm: status.vm ?? null,
    nextStep:
      status.state === "AWAITING_CLARIFICATION"
        ? "Ask the user the question, then call vm_answer with their reply."
        : status.state === "AWAITING_CONFIRMATION"
          ? "Show the user the summary and assumptions. Call vm_confirm only after they say yes."
          : null,
  };
}

// ---------------------------------------------------------------- server

const server = new McpServer({ name: "vm-intent", version: "0.1.0" });

server.registerTool(
  "vm_interpret",
  {
    title: "Preview a VM request",
    description:
      "Shows how a plain-English VM request would be interpreted (the canonical spec, its hash and the defaults applied) without starting anything.",
    inputSchema: { text: z.string().min(1).describe("The request, e.g. 'small ubuntu box on AWS in Oregon'") },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ text }: { text: string }) => api("POST", "/api/v2/interpret", { text })),
);

server.registerTool(
  "vm_submit",
  {
    title: "Start a VM request",
    description:
      "Starts a request workflow for a plain-English VM request and waits until it needs the user (a question or a confirmation). Nothing is built until vm_confirm is called.",
    inputSchema: { text: z.string().min(1).describe("The request in the user's words") },
  },
  safe(async ({ text }: { text: string }) => {
    const { requestId } = (await api("POST", "/api/v2/requests", { text })) as { requestId: string };
    return describe(await waitForStep(requestId, 15000));
  }),
);

server.registerTool(
  "vm_status",
  {
    title: "Get a request's status",
    description: "Returns the current state, spec, question or VM details, and workflow history of a request.",
    inputSchema: {
      requestId: z.string().describe("The request ID from vm_submit, e.g. intent-1234…"),
      includeHistory: z.boolean().optional().describe("Include the step-by-step workflow history"),
    },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ requestId, includeHistory }: { requestId: string; includeHistory?: boolean }) => {
    const s = (await api("GET", `/api/v2/requests/${encodeURIComponent(requestId)}`)) as Json;
    return includeHistory ? { ...describe(s), history: s.history } : describe(s);
  }),
);

server.registerTool(
  "vm_answer",
  {
    title: "Answer a request's question",
    description: "Sends the user's answer to a request that is waiting for clarification, then waits for its next step.",
    inputSchema: { requestId: z.string(), answer: z.string().min(1).describe("The user's answer, e.g. 'azure'") },
  },
  safe(async ({ requestId, answer }: { requestId: string; answer: string }) => {
    await api("POST", `/api/v2/requests/${encodeURIComponent(requestId)}/clarify`, { answer });
    await sleep(500);
    return describe(await waitForStep(requestId, 15000));
  }),
);

server.registerTool(
  "vm_confirm",
  {
    title: "Confirm and build a VM",
    description:
      "Confirms a request that is awaiting confirmation, which starts provisioning. Only call this after the user has seen the summary and said yes. Waits up to 60 seconds for the result.",
    inputSchema: { requestId: z.string() },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  safe(async ({ requestId }: { requestId: string }) => {
    await api("POST", `/api/v2/requests/${encodeURIComponent(requestId)}/confirm`);
    await sleep(500);
    const until = Date.now() + 60000;
    let s = (await api("GET", `/api/v2/requests/${encodeURIComponent(requestId)}`)) as Json;
    while (Date.now() < until && !FINAL.has(String(s.state))) {
      await sleep(1000);
      s = (await api("GET", `/api/v2/requests/${encodeURIComponent(requestId)}`)) as Json;
    }
    return describe(s);
  }),
);

server.registerTool(
  "vm_cancel",
  {
    title: "Cancel a request",
    description: "Cancels a request that is waiting for an answer or a confirmation.",
    inputSchema: { requestId: z.string() },
  },
  safe(async ({ requestId }: { requestId: string }) => {
    await api("POST", `/api/v2/requests/${encodeURIComponent(requestId)}/cancel`);
    await sleep(500);
    return describe((await api("GET", `/api/v2/requests/${encodeURIComponent(requestId)}`)) as Json);
  }),
);

server.registerTool(
  "vm_list",
  {
    title: "List VMs",
    description: "Lists the VMs in the inventory with their platform, size, state and spec hash, newest first.",
    inputSchema: { state: z.string().optional().describe("Only this state, e.g. RUNNING or FAILED") },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ state }: { state?: string }) => {
    const rows = (await api("GET", "/api/v2/vms")) as Json[];
    return rows
      .filter((r) => !state || String(r.state).toUpperCase() === state.toUpperCase())
      .map((r) => {
        const s = (r.spec ?? {}) as Json;
        return {
          name: s.name, provider: s.provider, region: s.region,
          size: `${s.vcpu} vCPU / ${s.memoryGiB} GiB`, os: `${s.os} ${s.osVersion}`,
          state: r.state, specHash: r.specHash, updatedAt: r.updatedAt,
        };
      });
  }),
);

server.registerTool(
  "vm_audit",
  {
    title: "Read the audit trail",
    description:
      "Returns audit events (requested, interpreted, confirmed, provisioning, running, failed…) for one request or VM, or the most recent events overall.",
    inputSchema: {
      requestId: z.string().optional(),
      specHash: z.string().optional().describe("Full spec hash, or its first 8+ characters"),
      limit: z.number().int().min(1).max(500).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ requestId, specHash, limit }: { requestId?: string; specHash?: string; limit?: number }) => {
    const q = new URLSearchParams();
    if (requestId) q.set("requestId", requestId);
    if (specHash) q.set("specHash", specHash);
    q.set("limit", String(limit ?? 50));
    return api("GET", `/api/v2/audit?${q}`);
  }),
);

server.registerTool(
  "vm_list_test_sets",
  {
    title: "List test sets",
    description: "Lists the phrasing test files in the project's tests folder and how many cases each holds.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  safe(async () => {
    const files = (await readdir(TESTS_DIR)).filter((f) => f.startsWith("phrasings") && f.endsWith(".json"));
    const out = [];
    for (const f of files) {
      const cases = await loadCases(f);
      out.push({ file: f, cases: cases.length });
    }
    return out;
  }),
);

server.registerTool(
  "vm_run_tests",
  {
    title: "Run phrasing tests",
    description:
      "Runs a phrasing test set against the running backend and reports passes, silent wrong specs, and the first failures. Use vm_list_test_sets to see the files.",
    inputSchema: {
      file: z.string().describe("Test file name, e.g. phrasings.json or phrasings-gen-s1.json"),
      maxFailures: z.number().int().min(0).max(200).optional().describe("How many failures to list (default 20)"),
    },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ file, maxFailures }: { file: string; maxFailures?: number }) => {
    const cases = await loadCases(file);
    let passed = 0, silentWrong = 0, askedWrongly = 0, missedQuestion = 0;
    const failures: Json[] = [];
    for (const c of cases) {
      const r = (await api("POST", "/api/v2/interpret", { text: c.text })) as Json;
      const diffs: string[] = [];
      if (c.expectQuestion) {
        if (!r.question) { diffs.push(`no question; built: ${r.summary}`); missedQuestion++; }
      } else if (r.question) {
        diffs.push(`asked: ${r.question}`); askedWrongly++;
      } else {
        const spec = (r.spec ?? {}) as Json;
        for (const [k, want] of Object.entries(c.expect ?? {})) {
          if (spec[k] !== want) diffs.push(`${k}=${JSON.stringify(spec[k])} (want ${JSON.stringify(want)})`);
        }
        if (diffs.length) silentWrong++;
      }
      if (diffs.length === 0) passed++;
      else if (failures.length < (maxFailures ?? 20)) failures.push({ id: c.id, text: c.text, problems: diffs });
    }
    return { file, total: cases.length, passed, silentWrong, askedWrongly, missedQuestion, failures };
  }),
);

type Case = { id: string; text: string; expect?: Json; expectQuestion?: boolean };

/** Reads either test-file format: hand-written groups, or generated cases. */
async function loadCases(file: string): Promise<Case[]> {
  if (file.includes("/") || file.includes("\\") || !file.endsWith(".json")) {
    throw new Error("Give just a test file name from the tests folder, e.g. phrasings.json");
  }
  const data = JSON.parse(await readFile(path.join(TESTS_DIR, file), "utf8"));
  if (Array.isArray(data.cases)) return data.cases as Case[];
  const out: Case[] = [];
  for (const g of data.groups ?? []) {
    (g.phrasings as string[]).forEach((text, i) =>
      out.push({ id: `${g.id}.${i + 1}`, text, expect: g.expect, expectQuestion: g.expectQuestion }),
    );
  }
  return out;
}

await server.connect(new StdioServerTransport());
console.error(`vm-intent MCP server ready (backend ${API_BASE}, tests in ${TESTS_DIR})`);
