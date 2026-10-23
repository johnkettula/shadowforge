import { useEffect, useRef, useState } from "react";
import {
  api,
  AuditEvent,
  Interpretation,
  InventoryReport,
  RequestStatus,
  RequestSummary,
  VmLifecycle,
  VmRecord,
} from "./api";

// Five different ways of asking for the SAME VM. Click "Preview" on each:
// the spec hash comes out identical, which is the whole point.
const EXAMPLES = [
  "Ubuntu box, 4 cores, 16 gigs, us-east on AWS",
  "I need a medium Linux server in Virginia on Amazon",
  "aws ec2 ubuntu 24.04 4 vcpu 16GB RAM us-east-1",
  "Can you spin up a medium-sized ubuntu VM in AWS N. Virginia?",
  "I need a big linux machine",
  "windows server 2022 on azure, 8 cores 32gb ram, 200 GB ssd, production, called app-db-01",
  "small rhel 9 box on prem for 2 weeks, called fail-demo",
  "3 small ubuntu web servers on gcp for 5 days, called web",
];

const LEGACY_EXAMPLE = `{
  "name": "legacy-web-01",
  "cloud": "GCP",
  "location": "us-central1",
  "cpu": 2,
  "ramGb": 8,
  "image": { "os": "Debian", "version": "12" },
  "disk": { "sizeGb": 80, "type": "SSD" },
  "environment": "test"
}`;

const FINAL_STATES = ["COMPLETED", "PARTIAL", "FAILED", "CANCELLED", "DUPLICATE"];

export default function App() {
  const [text, setText] = useState(EXAMPLES[0]);
  const [preview, setPreview] = useState<Interpretation | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [status, setStatus] = useState<RequestStatus | null>(null);
  const [answer, setAnswer] = useState("");
  const [vms, setVms] = useState<VmRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"natural" | "legacy">("natural");
  const [legacyJson, setLegacyJson] = useState(LEGACY_EXAMPLE);
  const [legacyResult, setLegacyResult] = useState<string | null>(null);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  // Reload the audit trail whenever the request changes state.
  useEffect(() => {
    if (!status?.requestId || status.state === "STARTING") return;
    api.audit(status.requestId).then(setAudit).catch(() => setAudit([]));
  }, [status?.requestId, status?.state]);

  // Poll the workflow's status query while a request is in flight.
  useEffect(() => {
    if (!requestId) return;
    let stop = false;
    const tick = async () => {
      try {
        const s = await api.status(requestId);
        if (!stop) setStatus(s);
        if (FINAL_STATES.includes(s.state)) return;
      } catch (e) {
        if (!stop) setError(String(e));
      }
      if (!stop) setTimeout(tick, 1200);
    };
    tick();
    return () => {
      stop = true;
    };
  }, [requestId]);

  // Refresh the inventory every few seconds.
  useEffect(() => {
    const load = () => api.vms().then(setVms).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const doPreview = () => run(async () => setPreview(await api.preview(text)));

  const doSubmit = () =>
    run(async () => {
      setStatus(null);
      setPreview(null);
      const { requestId } = await api.submit(text);
      setRequestId(requestId);
    });

  const doLegacy = () =>
    run(async () => {
      const res = await api.legacy(JSON.parse(legacyJson));
      setLegacyResult(JSON.stringify(res, null, 2));
    });

  const it = status?.interpretation;

  return (
    <div className="page">
      <header>
        <div className="row between top">
          <h1>Request a virtual machine</h1>
          <HelpMenu />
        </div>
        <p className="sub">
          Describe it any way you like. One spec comes out, then a Temporal workflow builds it on vSphere, AWS,
          Azure or Google Cloud (simulated).
        </p>
      </header>

      <div className="tabs">
        <button className={tab === "natural" ? "on" : ""} onClick={() => setTab("natural")}>
          Plain English
        </button>
        <button className={tab === "legacy" ? "on" : ""} onClick={() => setTab("legacy")}>
          Legacy JSON API
        </button>
      </div>

      {tab === "natural" && (
        <section className="card">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} />
          <div className="examples">
            {EXAMPLES.map((ex) => (
              <button key={ex} className="chip" onClick={() => setText(ex)} title={ex}>
                {ex.length > 42 ? ex.slice(0, 40) + "…" : ex}
              </button>
            ))}
          </div>
          <div className="row">
            <button onClick={doPreview}>Preview</button>
            <button className="primary" onClick={doSubmit}>
              Submit request
            </button>
          </div>

          {preview && <InterpretationView it={preview} title="Preview (nothing built)" />}
        </section>
      )}

      {tab === "legacy" && (
        <section className="card">
          <p className="sub">
            Old callers keep posting JSON to <code>/api/v1/vms</code>. It skips the AI and goes straight to the
            reconcile workflow.
          </p>
          <textarea value={legacyJson} onChange={(e) => setLegacyJson(e.target.value)} rows={12} className="mono" />
          <div className="row">
            <button className="primary" onClick={doLegacy}>
              POST /api/v1/vms
            </button>
          </div>
          {legacyResult && <pre>{legacyResult}</pre>}
        </section>
      )}

      {error && <div className="error">{error}</div>}

      {status && (
        <section className="card">
          <div className="row between">
            <h2>Request</h2>
            <span className={`badge s-${status.state}`}>{status.state.replace(/_/g, " ")}</span>
          </div>
          <p>{status.message}</p>

          {status.state === "AWAITING_CLARIFICATION" && (
            <div className="row">
              <input
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder="Your answer, e.g. azure"
                onKeyDown={(e) => e.key === "Enter" && answer && run(async () => {
                  await api.clarify(status.requestId, answer);
                  setAnswer("");
                })}
              />
              <button
                className="primary"
                disabled={!answer}
                onClick={() =>
                  run(async () => {
                    await api.clarify(status.requestId, answer);
                    setAnswer("");
                  })
                }
              >
                Answer
              </button>
              <button onClick={() => run(() => api.cancel(status.requestId))}>Cancel</button>
            </div>
          )}

          {it && it.spec && <InterpretationView it={it} title="What I understood" />}

          {status.state === "AWAITING_CONFIRMATION" && (
            <div className="row">
              <button
                className="primary"
                onClick={() =>
                  run(async () => setStatus(await api.confirm(status.requestId, status.interpretation?.specHash)))
                }
              >
                Looks right, build it
              </button>
              <button onClick={() => run(() => api.cancel(status.requestId))}>Cancel</button>
            </div>
          )}

          {status.vms && status.vms.length > 1 && (
            <table>
              <thead>
                <tr>
                  <th>VM ID</th>
                  <th>IP address</th>
                  <th>Provider size</th>
                </tr>
              </thead>
              <tbody>
                {status.vms.map((v) => (
                  <tr key={v.vmId}>
                    <td className="mono">{v.vmId}</td>
                    <td className="mono">{v.ipAddress}</td>
                    <td>{v.nativeSize}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {status.vm && !(status.vms && status.vms.length > 1) && (
            <dl className="grid">
              <dt>VM ID</dt>
              <dd>{status.vm.vmId}</dd>
              <dt>IP address</dt>
              <dd>{status.vm.ipAddress}</dd>
              <dt>Provider size</dt>
              <dd>{status.vm.nativeSize}</dd>
              <dt>Provider region</dt>
              <dd>{status.vm.nativeRegion}</dd>
              <dt>Image</dt>
              <dd>{status.vm.nativeImage}</dd>
            </dl>
          )}

          <details>
            <summary>Audit trail ({audit.length})</summary>
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Event</th>
                  <th>By</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((a) => (
                  <tr key={a.id}>
                    <td className="mono">{a.at.slice(11, 19)}</td>
                    <td>{a.event}</td>
                    <td>{a.actor}</td>
                    <td>{a.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>

          <details>
            <summary>Workflow history</summary>
            <ul className="history">
              {status.history.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ul>
            <p className="sub">
              See every step in the Temporal UI:{" "}
              <a href={`${temporalUi()}/namespaces/default/workflows/${status.requestId}`} target="_blank">
                open workflow
              </a>
            </p>
          </details>
        </section>
      )}

      <RequestsList onOpen={(id) => setRequestId(id)} />

      <section className="card">
        <h2>Inventory</h2>
        <p className="sub">Click a VM to renew, resize, power, snapshot or remove it.</p>
        {vms.length === 0 ? (
          <p className="sub">No VMs yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Platform</th>
                <th>Size</th>
                <th>State</th>
                <th>Expires</th>
                <th className="hide-narrow">Spec hash</th>
              </tr>
            </thead>
            <tbody>
              {vms.map((v) => {
                const lc = v.lifecycle;
                return (
                  <tr
                    key={v.specHash}
                    className={`clickable${selected === v.specHash ? " selected" : ""}`}
                    onClick={() => setSelected(selected === v.specHash ? null : v.specHash)}
                  >
                    <td>
                      {v.spec.name}
                      {lc?.power === "OFF" && <span className="badge s-OFF">off</span>}
                    </td>
                    <td>
                      {v.spec.provider} {v.spec.region}
                    </td>
                    <td>
                      {lc ? lc.vcpu : v.spec.vcpu} vCPU / {lc ? lc.memoryGiB : v.spec.memoryGiB} GiB
                    </td>
                    <td>
                      <span className={`badge s-${v.state}`}>{v.state}</span>
                    </td>
                    <td className={lc?.warned && v.state === "RUNNING" ? "warn" : ""}>{expiry(v)}</td>
                    <td className="mono hide-narrow">{v.specHash.slice(0, 12)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {selected && (
          <VmPanel
            key={selected}
            vm={vms.find((v) => v.specHash === selected) ?? null}
            onClose={() => setSelected(null)}
          />
        )}
      </section>

      <InventoryCheckCard />
    </div>
  );
}

/** "in 5 days", "never", or the date, for the inventory table. */
function expiry(v: VmRecord) {
  const lc = v.lifecycle;
  if (!lc) return v.spec.ttlDays === 0 ? "never" : "";
  if (lc.expiresAtMs === 0) return "never";
  if (v.state !== "RUNNING") return "";
  const days = (lc.expiresAtMs - Date.now()) / 86_400_000;
  if (days < 1) return `in ${Math.max(0, Math.round(days * 24))} h`;
  return `in ${Math.round(days)} days`;
}

/** Day-2 changes for one VM. Each button is a Temporal update: refused at once if it can't be done. */
function VmPanel({ vm, onClose }: { vm: VmRecord | null; onClose: () => void }) {
  const [lc, setLc] = useState<VmLifecycle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Kept as typed (text), so clearing a box leaves it empty rather than 0.
  const [vcpu, setVcpu] = useState(String(vm?.spec.vcpu ?? 2));
  const [mem, setMem] = useState(String(vm?.spec.memoryGiB ?? 4));
  const [label, setLabel] = useState("before-change");
  const [sure, setSure] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const hash = vm?.specHash;

  // The panel opens under the inventory table, which can be long: bring it into view.
  useEffect(() => {
    panel.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  useEffect(() => {
    if (!hash) return;
    api
      .lifecycle(hash)
      .then((l) => {
        setLc(l);
        setVcpu(String(l.vcpu));
        setMem(String(l.memoryGiB));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [hash]);

  if (!vm || !hash) return null;

  const act = async (fn: () => Promise<VmLifecycle>) => {
    setError(null);
    setBusy(true);
    try {
      setLc(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const active = lc?.state === "ACTIVE";
  return (
    <div className="vm-panel" ref={panel}>
      <div className="row between">
        <h3>{vm.spec.name}</h3>
        <button onClick={onClose}>Close</button>
      </div>
      {!lc && !error && <p className="sub">Loading…</p>}
      {lc && (
        <dl className="grid">
          <dt>State</dt>
          <dd>
            <span className={`badge s-${lc.state}`}>{lc.state}</span>
          </dd>
          <dt>Expires</dt>
          <dd>
            {lc.expiresAtMs === 0 ? "Never" : new Date(lc.expiresAtMs).toLocaleString()}
            {lc.warned && active && <span className="warn"> · warning sent</span>}
          </dd>
          <dt>Power</dt>
          <dd>{lc.power}</dd>
          <dt>Size now</dt>
          <dd>
            {lc.vcpu} vCPU / {lc.memoryGiB} GiB
          </dd>
          <dt>Owner</dt>
          <dd>{lc.owner}</dd>
          <dt>Snapshots</dt>
          <dd>{lc.snapshots.length === 0 ? "None" : lc.snapshots.join(", ")}</dd>
        </dl>
      )}
      {error && <div className="error">{error}</div>}
      {active && (
        <div className="actions">
          {lc!.expiresAtMs !== 0 && (
            <div className="row">
              <span className="label">Renew</span>
              <button disabled={busy} onClick={() => act(() => api.renew(hash, 7))}>
                +7 days
              </button>
              <button disabled={busy} onClick={() => act(() => api.renew(hash, 30))}>
                +30 days
              </button>
            </div>
          )}
          <div className="row">
            <span className="label">Resize</span>
            <input type="number" min={1} max={64} value={vcpu} onChange={(e) => setVcpu(e.target.value)} />
            <span>vCPU</span>
            <input type="number" min={1} max={512} value={mem} onChange={(e) => setMem(e.target.value)} />
            <span>GiB</span>
            <button
              disabled={busy || !vcpu || !mem}
              onClick={() => act(() => api.resize(hash, Number(vcpu), Number(mem)))}
            >
              Resize
            </button>
          </div>
          <div className="row">
            <span className="label">Power</span>
            <button disabled={busy} onClick={() => act(() => api.power(hash, lc!.power !== "ON"))}>
              {lc!.power === "ON" ? "Power off" : "Power on"}
            </button>
          </div>
          <div className="row">
            <span className="label">Snapshot</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} />
            <button disabled={busy} onClick={() => act(() => api.snapshot(hash, label))}>
              Take snapshot
            </button>
          </div>
          <div className="row">
            <span className="label">Remove</span>
            {!sure ? (
              <button className="danger" disabled={busy} onClick={() => setSure(true)}>
                Remove this VM…
              </button>
            ) : (
              <>
                <span>This deletes the VM. Sure?</span>
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() => act(() => api.decommission(hash, "Removed from the web app"))}
                >
                  Yes, remove it
                </button>
                <button onClick={() => setSure(false)}>No</button>
              </>
            )}
          </div>
        </div>
      )}
      {lc && lc.history.length > 0 && (
        <details>
          <summary>Lifecycle events ({lc.history.length})</summary>
          <ul className="history">
            {lc.history.map((h, i) => (
              <li key={i}>{h}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Recent requests, filtered with Temporal search attributes. */
function RequestsList({ onOpen }: { onOpen: (id: string) => void }) {
  const [filter, setFilter] = useState("all");
  const [rows, setRows] = useState<RequestSummary[]>([]);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const f: Record<string, string> =
      filter === "mine"
        ? { requester: "me" }
        : filter === "waiting"
          ? { state: "AWAITING_CONFIRMATION" }
          : filter === "failed"
            ? { state: "FAILED" }
            : {};
    const load = () =>
      api
        .requests(f)
        .then((r) => {
          setRows(r);
          setNote(null);
        })
        .catch((e) => setNote(e instanceof Error ? e.message : String(e)));
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [filter]);

  return (
    <section className="card">
      <div className="row between">
        <h2>Requests</h2>
        <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Which requests">
          <option value="all">All recent</option>
          <option value="mine">Mine</option>
          <option value="waiting">Waiting for confirmation</option>
          <option value="failed">Failed</option>
        </select>
      </div>
      {note && <p className="sub">{note}</p>}
      {!note && rows.length === 0 && <p className="sub">None.</p>}
      {rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th className="hide-narrow">Started</th>
              <th>By</th>
              <th>Platform</th>
              <th>State</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.requestId}>
                <td className="mono hide-narrow">{r.startedAt ? new Date(r.startedAt).toLocaleString() : ""}</td>
                <td>{r.requestedBy}</td>
                <td>
                  {r.provider} {r.env}
                </td>
                <td>{r.state && <span className={`badge s-${r.state}`}>{r.state.replace(/_/g, " ")}</span>}</td>
                <td>
                  <button onClick={() => onOpen(r.requestId)}>Open</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** The nightly inventory check: VMs that disappeared, and VMs nobody recorded. */
function InventoryCheckCard() {
  const [report, setReport] = useState<InventoryReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<string | null>(null);

  const load = () =>
    api
      .inventoryChecks()
      .then((r) => setReport(r[0] ?? null))
      .catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const runNow = async () => {
    setError(null);
    try {
      setStarted((await api.runInventoryCheck()).checkId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="card">
      <div className="row between">
        <h2>Inventory check</h2>
        <button onClick={runNow}>Run now</button>
      </div>
      <p className="sub">
        Runs every night on a Temporal Schedule: VMs that disappeared from their cloud are marked MISSING, and
        VMs nobody recorded are listed (never deleted).
      </p>
      {error && <div className="error">{error}</div>}
      {started && (!report || report.checkId !== started) && <p className="sub">Check {started} is running…</p>}
      {!report ? (
        <p className="sub">No check has run yet.</p>
      ) : (
        <>
          <p>
            Last check {new Date(report.finishedAt).toLocaleString()}: <b>{report.missingCount}</b> missing,{" "}
            <b>{report.orphanCount}</b> unrecorded.
          </p>
          <table>
            <thead>
              <tr>
                <th>Cloud</th>
                <th className="hide-narrow">Recorded</th>
                <th className="hide-narrow">In cloud</th>
                <th>Missing</th>
                <th>Unrecorded</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {report.findings.map((f) => (
                <tr key={f.provider}>
                  <td>{f.provider}</td>
                  <td className="hide-narrow">{f.recordedRunning}</td>
                  <td className="hide-narrow">{f.inCloud}</td>
                  <td>{f.missing.length}</td>
                  <td title={f.orphans.join(", ")}>{f.orphans.length}</td>
                  <td>{f.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function InterpretationView({ it, title }: { it: Interpretation; title: string }) {
  return (
    <div className="interp">
      <h3>{title}</h3>
      {it.question ? (
        <p className="question">{it.question}</p>
      ) : (
        <>
          <p className="summary">{it.summary}</p>
          <p className="sub">
            Spec hash <code>{it.specHash?.slice(0, 12)}</code> · interpreted by {it.extractor}
          </p>
          {it.assumptions.length > 0 && (
            <>
              <h4>Assumptions (platform defaults)</h4>
              <ul>
                {it.assumptions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </>
          )}
          <details>
            <summary>Canonical spec JSON</summary>
            <pre>{JSON.stringify(it.spec, null, 2)}</pre>
          </details>
        </>
      )}
    </div>
  );
}

/** The Temporal UI on the same machine as this page, so its links work from other devices too. */
function temporalUi() {
  return `${window.location.protocol}//${window.location.hostname}:8233`;
}

/** Help menu: the user guide, the API documentation and the Temporal UI. */
function HelpMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const items = [
    { href: "/user-guide.html", label: "User guide", note: "How to request and follow VMs" },
    { href: "/swagger-ui.html", label: "API documentation (Swagger)", note: "For other services" },
    { href: "/v3/api-docs.yaml", label: "OpenAPI YAML", note: "For client generators and gateways" },
    { href: temporalUi(), label: "Temporal UI", note: "Every workflow, step by step" },
  ];

  return (
    <div className="menu" ref={ref}>
      <button aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        Help ▾
      </button>
      {open && (
        <div className="menu-list" role="menu">
          {items.map((it) => (
            <a key={it.label} role="menuitem" href={it.href} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>
              <span>{it.label}</span>
              <small>{it.note}</small>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
