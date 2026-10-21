// Load test: ask for N VMs in one batch and watch them build.
//
//   node loadtest/run-loadtest.mjs                      2,000 VMs against http://localhost:8080
//   node loadtest/run-loadtest.mjs --count 500 --api http://server:8080 --fail 5
//
// Options:
//   --count N      how many VMs (default 2000)
//   --shard N      VMs per shard workflow (default 500)
//   --inflight N   VMs one shard builds at the same time (default = shard size)
//   --fail N       how many of them are named "fail-..." so the simulated boot fails
//                  and the saga rolls them back (default 0)
//   --api URL      backend address (default http://localhost:8080)
//   --out FILE     where to write the JSON report (default loadtest/report-<time>.json)
//
// Needs Node 18+ (built-in fetch). No npm install.

import { writeFile } from "node:fs/promises";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
    return acc;
  }, []),
);
const COUNT = Number(args.count ?? 2000);
const SHARD = Number(args.shard ?? 500);
const INFLIGHT = Number(args.inflight ?? SHARD);
const FAILS = Number(args.fail ?? 0);
const API = (args.api ?? "http://localhost:8080").replace(/\/$/, "");
const run = new Date().toISOString().replace(/[-:T]/g, "").slice(2, 12);
const OUT = args.out ?? `loadtest/report-${run}.json`;

// A realistic mix: four clouds, several sizes and operating systems.
const PROVIDERS = [
  { provider: "aws", regions: ["us-east", "us-west", "eu-west"] },
  { provider: "azure", regions: ["us-east", "us-central", "eu-west"] },
  { provider: "gcp", regions: ["us-central", "us-west", "us-east"] },
  { provider: "vsphere", regions: ["dc1", "dc2"] },
];
const SIZES = [[2, 4], [2, 8], [4, 16], [8, 32]];
const OS = [["ubuntu", "24.04"], ["rhel", "9"], ["debian", "12"], ["rocky", "9"]];

function specFor(i) {
  const p = PROVIDERS[i % PROVIDERS.length];
  const [vcpu, memoryGiB] = SIZES[Math.floor(i / 4) % SIZES.length];
  const [os, osVersion] = OS[Math.floor(i / 16) % OS.length];
  return {
    name: (i < FAILS ? "fail-" : "lt-") + run + "-" + String(i).padStart(5, "0"),
    provider: p.provider,
    region: p.regions[i % p.regions.length],
    vcpu, memoryGiB, os, osVersion,
    diskGiB: 80, diskTier: "ssd", env: "test", ttlDays: 1, publicIp: false,
  };
}

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const items = Array.from({ length: COUNT }, (_, i) => ({ spec: specFor(i) }));
console.log(`Submitting ${COUNT} VMs (${FAILS} set to fail) in shards of ${SHARD} to ${API} ...`);
const t0 = Date.now();
const submitted = await call("POST", "/api/v2/batches", {
  items, shardSize: SHARD, maxInFlightPerShard: INFLIGHT, requestedBy: "loadtest",
});
const submitMs = Date.now() - t0;
console.log(`Accepted ${submitted.accepted} in ${submitMs} ms as ${submitted.batchId} (${submitted.shards} shards)`);
if (submitted.rejected?.length) console.log("Rejected:", submitted.rejected.slice(0, 5));

const samples = [];
let peakInFlight = 0;
let last;
while (true) {
  await new Promise((r) => setTimeout(r, 2000));
  let s;
  try {
    s = await call("GET", `/api/v2/batches/${submitted.batchId}`);
  } catch (e) {
    console.log("  (status check failed, retrying)", e.message);
    continue;
  }
  last = s;
  const t = ((Date.now() - t0) / 1000).toFixed(0);
  peakInFlight = Math.max(peakInFlight, s.inFlight ?? 0);
  samples.push({ t: Number(t), started: s.started, inFlight: s.inFlight, running: s.running, failed: s.failed });
  console.log(
    `  t=${t.padStart(4)}s  started ${String(s.started ?? 0).padStart(5)}  in flight ${String(s.inFlight ?? 0).padStart(5)}` +
      `  running ${String(s.running ?? 0).padStart(5)}  failed ${s.failed ?? 0}  duplicate ${s.duplicate ?? 0}  [${s.state}]`,
  );
  if (s.state === "COMPLETED") break;
}

const wallSeconds = (Date.now() - t0) / 1000;
const report = {
  batchId: submitted.batchId,
  requested: COUNT,
  accepted: submitted.accepted,
  expectedFailures: FAILS,
  running: last.running,
  failed: last.failed,
  duplicate: last.duplicate,
  peakInFlightObserved: peakInFlight,
  wallSeconds,
  submitMs,
  p50Seconds: last.p50Seconds,
  p95Seconds: last.p95Seconds,
  maxSeconds: last.maxSeconds,
  failuresSample: last.failures,
  samples,
};
await writeFile(OUT, JSON.stringify(report, null, 2));

const pass = last.running === COUNT - FAILS && last.failed === FAILS && peakInFlight >= Math.min(COUNT, 0.9 * COUNT);
console.log(`
Result: ${pass ? "PASS" : "CHECK"}
  ${last.running} running, ${last.failed} failed (expected ${FAILS}), ${last.duplicate} duplicates
  Peak builds in flight at once: ${peakInFlight} of ${COUNT}
  Whole batch: ${wallSeconds.toFixed(0)} s. Per VM: p50 ${last.p50Seconds} s, p95 ${last.p95Seconds} s, max ${last.maxSeconds} s
  Report: ${OUT}`);
process.exit(pass ? 0 : 1);
