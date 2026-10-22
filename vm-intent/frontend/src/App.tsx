import { useEffect, useRef, useState } from "react";
import { api, AuditEvent, Interpretation, RequestStatus, VmRecord } from "./api";

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

const FINAL_STATES = ["COMPLETED", "FAILED", "CANCELLED", "DUPLICATE"];

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
              <button className="primary" onClick={() => run(() => api.confirm(status.requestId))}>
                Looks right, build it
              </button>
              <button onClick={() => run(() => api.cancel(status.requestId))}>Cancel</button>
            </div>
          )}

          {status.vm && (
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

      <section className="card">
        <h2>Inventory</h2>
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
                <th>Spec hash</th>
              </tr>
            </thead>
            <tbody>
              {vms.map((v) => (
                <tr key={v.specHash}>
                  <td>{v.spec.name}</td>
                  <td>
                    {v.spec.provider} {v.spec.region}
                  </td>
                  <td>
                    {v.spec.vcpu} vCPU / {v.spec.memoryGiB} GiB
                  </td>
                  <td>
                    <span className={`badge s-${v.state}`}>{v.state}</span>
                  </td>
                  <td className="mono">{v.specHash.slice(0, 12)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
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
