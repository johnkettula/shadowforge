import { useEffect, useState } from "react";
import {
  api,
  ArchiveRow,
  Classification,
  Decision,
  DefinitionEntry,
  DefinitionView,
  InputDef,
  ReplayResult,
  RunRow,
  RunStatus,
} from "./api";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : "");
const ENDED = ["COMPLETED", "TORN_DOWN", "TEARDOWN_INCOMPLETE"];

/** The catalog: operator-written definitions, and runs of them that stop and wait when a step fails. */
export function CatalogCard() {
  const [defs, setDefs] = useState<DefinitionEntry[]>([]);
  const [classes, setClasses] = useState<Classification[]>([]);
  const [name, setName] = useState("");
  const [view, setView] = useState<DefinitionView | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [classification, setClassification] = useState("");
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.definitions().then((d) => {
      const p = d.filter((x) => x.kind === "Provisioning" && !x.retired);
      setDefs(p);
      if (p.length && !name) setName(p.find((x) => x.name === "web-server")?.name ?? p[0].name);
    }).catch((e) => setError(message(e)));
    api.classifications().then((c) => setClasses(c.classifications)).catch(() => {});
    const load = () => api.runs().then(setRuns).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!name) return;
    api.definition(name).then((v) => {
      setView(v);
      const init: Record<string, string> = {};
      v.definition?.inputs.forEach((i) => (init[i.name] = i.defaultValue == null ? "" : String(i.defaultValue)));
      setValues(init);
      setClassification("");
    }).catch((e) => setError(message(e)));
  }, [name]);

  const start = async () => {
    if (!view?.definition) return;
    setError(null);
    setBusy(true);
    try {
      const params: Record<string, unknown> = {};
      for (const i of view.definition.inputs) {
        const v = values[i.name] ?? "";
        if (v === "") continue;
        params[i.name] = i.type === "list" ? v.split(",").map((x) => x.trim()).filter(Boolean)
          : i.type === "bool" ? v === "true" : v;
      }
      const r = await api.startRun(view.definition.name, params, classification);
      setOpen(r.runId);
      if (r.existing) setError("A run with the same inputs is already going: opened it instead of starting another.");
      setRuns(await api.runs());
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const d = view?.definition;
  const own = classes.find((c) => c.code === d?.classification);
  return (
    <section className="card">
      <div className="row between">
        <h2>Catalog</h2>
        <select value={name} onChange={(e) => setName(e.target.value)} aria-label="Definition">
          {defs.map((x) => (
            <option key={x.name} value={x.name}>
              {x.name} v{x.version}
            </option>
          ))}
        </select>
      </div>
      <p className="sub">
        Definitions written in YAML by operators. A run that hits a failed step stops and waits: resume it (the step
        picks up its own partial work) or tear it down. Nobody deciding means it tears itself down.
      </p>
      {d && (
        <>
          <p>{d.description}</p>
          <p className="sub">
            {d.steps.length} steps: {d.steps.map((s) => s.id).join(" → ")} · classification {d.classification ?? "default"}
            {own && ` (${own.label})`} · waits {d.recoveryWaitHours} h after a failure
            {d.blueprint && <> · blueprint {d.blueprint}</>}
          </p>
          <div className="inputs">
            {d.inputs.map((i) => (
              <InputField key={i.name} def={i} value={values[i.name] ?? ""} onChange={(v) => setValues({ ...values, [i.name]: v })} />
            ))}
            <label className="field">
              <span>classification</span>
              <select value={classification} onChange={(e) => setClassification(e.target.value)}>
                <option value="">{d.classification ?? "default"} (the definition's)</option>
                {classes
                  .filter((c) => !own || c.retentionYears > own.retentionYears)
                  .map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code}: {c.label}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <div className="row">
            <button className="primary" onClick={start} disabled={busy}>
              Start run
            </button>
          </div>
          <details>
            <summary>Definition YAML</summary>
            <pre>{view?.yaml}</pre>
          </details>
        </>
      )}
      {error && <div className="error">{error}</div>}

      <h3>Runs</h3>
      {runs.length === 0 ? (
        <p className="sub">None yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th className="hide-narrow">Started</th>
              <th>Definition</th>
              <th>By</th>
              <th>State</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.runId + r.startedAt} className={open === r.runId ? "selected" : ""}>
                <td className="mono hide-narrow">{when(r.startedAt)}</td>
                <td>
                  {r.definition} v{r.version} <span className="badge">{r.classification}</span>
                </td>
                <td>{r.requestedBy}</td>
                <td>
                  <span className={`badge s-${r.state}`}>{r.state.replace(/_/g, " ")}</span>
                </td>
                <td>
                  <button onClick={() => setOpen(open === r.runId ? null : r.runId)}>{open === r.runId ? "Close" : "Open"}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && <RunPanel key={open} id={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

function InputField({ def, value, onChange }: { def: InputDef; value: string; onChange: (v: string) => void }) {
  const label = (
    <span>
      {def.name}
      {def.required && " *"}
    </span>
  );
  if (def.allowed && def.allowed.length) {
    return (
      <label className="field">
        {label}
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {!def.required && def.defaultValue == null && <option value=""></option>}
          {def.allowed.map((a) => (
            <option key={String(a)} value={String(a)}>
              {String(a)}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (def.type === "bool") {
    return (
      <label className="field">
        {label}
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      </label>
    );
  }
  return (
    <label className="field">
      {label}
      <input
        value={value}
        inputMode={def.type === "int" ? "numeric" : undefined}
        placeholder={def.type === "list" ? "a, b, c" : def.description ?? ""}
        title={def.description}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function RunPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const [run, setRun] = useState<RunStatus | null>(null);
  const [note, setNote] = useState("");
  const [confirmTeardown, setConfirmTeardown] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const load = () => api.run(id).then((r) => !stop && setRun(r)).catch((e) => !stop && setError(message(e)));
    load();
    const t = setInterval(load, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [id]);

  const act = async (f: () => Promise<RunStatus>) => {
    setError(null);
    try {
      setRun(await f());
      setNote("");
      setConfirmTeardown(false);
    } catch (e) {
      setError(message(e));
    }
  };

  if (!run) return <div className="vm-panel">{error ?? "Loading…"}</div>;
  const stopped = run.state === "AWAITING_RECOVERY";
  const approving = run.state === "AWAITING_APPROVAL";
  return (
    <div className="vm-panel">
      <div className="row between">
        <h3>
          {run.definition} v{run.version} <span className={`badge s-${run.state}`}>{run.state.replace(/_/g, " ")}</span>
        </h3>
        <button onClick={onClose}>Close</button>
      </div>
      <p className={stopped ? "question" : ""}>{run.message}</p>
      <dl className="grid">
        <dt>Run</dt>
        <dd className="mono">{run.runId}</dd>
        <dt>By</dt>
        <dd>{run.requestedBy}</dd>
        <dt>Classification</dt>
        <dd>
          {run.classification.code}: {run.classification.label}
        </dd>
        <dt>Kept</dt>
        <dd>{run.classification.retentionYears} years after it ends</dd>
        <dt>Inputs</dt>
        <dd className="mono">{JSON.stringify(run.params)}</dd>
        {run.recoveryDeadline && (
          <>
            <dt>Decide by</dt>
            <dd className="warn">{when(run.recoveryDeadline)} (then it tears itself down)</dd>
          </>
        )}
      </dl>
      <table>
        <thead>
          <tr>
            <th>Step</th>
            <th>State</th>
            <th className="hide-narrow">Tries</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {run.steps.map((s) => (
            <tr key={s.id}>
              <td>
                <b>{s.id}</b> <span className="sub hide-narrow">{s.title}</span>
              </td>
              <td>
                <span className={`badge s-${s.state}`}>{s.state}</span>
              </td>
              <td className="hide-narrow">{s.attempts || ""}</td>
              <td className={s.error ? "warn" : "mono"}>{s.error ?? summary(s.output)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {(stopped || approving) && (
        <div className="actions">
          {approving && run.approval && (
            <p>
              <b>Approval:</b> {run.approval.message}
              {run.approval.approvers.length > 0 && ` (approvers: ${run.approval.approvers.join(", ")})`}. Anyone but{" "}
              {run.requestedBy} can answer.
            </p>
          )}
          <div className="row">
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={approving ? "Note, e.g. a change ticket" : "Note: what was fixed, or why"} />
            {stopped && (
              <button className="primary" onClick={() => act(() => api.resume(id, note))}>
                Resume step {run.failedStep}
              </button>
            )}
            {approving && (
              <>
                <button className="primary" onClick={() => act(() => api.approve(id, true, note))}>
                  Approve
                </button>
                <button onClick={() => act(() => api.approve(id, false, note))}>Reject</button>
              </>
            )}
            {!confirmTeardown ? (
              <button className="danger" onClick={() => setConfirmTeardown(true)}>
                Tear down…
              </button>
            ) : (
              <button className="danger" onClick={() => act(() => api.teardown(id, note))}>
                Yes, undo everything it did
              </button>
            )}
          </div>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      <details>
        <summary>History</summary>
        <ol className="history">
          {run.history.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ol>
      </details>
      {ENDED.includes(run.state) && <p className="sub">This run has ended. Its history is archived for its classification's retention.</p>}
    </div>
  );
}

function summary(out?: Record<string, unknown>) {
  if (!out) return "";
  if (out.skipped) return "skipped";
  if (out.vmId) return `${out.name ?? ""} ${out.vmId} ${out.ipAddress ?? ""}`.trim();
  if (out.copied !== undefined) return `${out.copied} copied, ${out.alreadyThere} already there`;
  if (out.bundle) return `${out.bundle} ${out.version}`;
  if (Array.isArray(out.changed)) return out.changed.length ? `set ${(out.changed as string[]).join(", ")}` : "already set";
  if (out.checks !== undefined) return `true after ${out.checks} check(s)`;
  if (out.approvedBy) return `approved by ${out.approvedBy}`;
  return "";
}

/** For auditors: the decision log, the archive and audit replays. */
export function ComplianceCard() {
  const [tab, setTab] = useState<"decisions" | "archive">("decisions");
  const [resource, setResource] = useState("");
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [archive, setArchive] = useState<ArchiveRow[]>([]);
  const [replays, setReplays] = useState<Record<string, ReplayResult | string>>({});
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const load = () => {
      if (tab === "decisions") api.decisions(resource).then(setDecisions).catch((e) => setNote(message(e)));
      else api.archive().then(setArchive).catch((e) => setNote(message(e)));
    };
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [tab, resource]);

  const replay = async (a: ArchiveRow) => {
    const k = a.workflowId + a.runId;
    setReplays({ ...replays, [k]: "replaying…" });
    try {
      const r = await api.replay(a.workflowId, a.runId);
      setReplays((x) => ({ ...x, [k]: r }));
    } catch (e) {
      setReplays((x) => ({ ...x, [k]: message(e) }));
    }
  };

  return (
    <section className="card">
      <div className="row between">
        <h2>Compliance</h2>
        <div className="tabs" style={{ marginTop: 0 }}>
          <button className={tab === "decisions" ? "on" : ""} onClick={() => setTab("decisions")}>
            Decision log
          </button>
          <button className={tab === "archive" ? "on" : ""} onClick={() => setTab("archive")}>
            Archive
          </button>
        </div>
      </div>
      <p className="sub">
        Every authorization decision is logged, and closed workflow histories are archived write-once, kept 1–5
        years by data classification. A replay re-runs a recorded workflow against today's code without doing
        anything again.
      </p>
      {note && <p className="sub">{note}</p>}
      {tab === "decisions" ? (
        <>
          <input value={resource} onChange={(e) => setResource(e.target.value)} placeholder="Filter by run ID or path" />
          <table>
            <thead>
              <tr>
                <th className="hide-narrow">When</th>
                <th>Who</th>
                <th>Action</th>
                <th>Decision</th>
                <th className="hide-narrow">Rule</th>
              </tr>
            </thead>
            <tbody>
              {decisions.map((x) => (
                <tr key={x.id} title={`${x.reason ?? ""} · ${x.classification}, kept until ${x.keepUntil}`}>
                  <td className="mono hide-narrow">{when(x.at)}</td>
                  <td>{x.actor}</td>
                  <td className="mono">{x.action}</td>
                  <td>
                    <span className={`badge s-${x.decision}`}>{x.decision}</span>
                  </td>
                  <td className="hide-narrow">{x.policy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <>
          <div className="row">
            <button onClick={() => api.sweep().then((s) => setNote(`Sweep ${s.workflowId} started.`)).catch((e) => setNote(message(e)))}>
              Archive now
            </button>
          </div>
          {archive.length === 0 ? (
            <p className="sub">Nothing archived yet. The sweep runs every hour.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Workflow</th>
                  <th>Kept</th>
                  <th className="hide-narrow">Events</th>
                  <th>Replay</th>
                </tr>
              </thead>
              <tbody>
                {archive.map((a) => {
                  const r = replays[a.workflowId + a.runId];
                  return (
                    <tr key={a.workflowId + a.runId}>
                      <td>
                        <span className="mono">{a.workflowId.length > 34 ? a.workflowId.slice(0, 34) + "…" : a.workflowId}</span>
                        <div className="sub">{a.workflowType}</div>
                      </td>
                      <td>
                        {a.classification}, {a.retentionYears} y
                        <div className="sub">until {new Date(a.keepUntil).toLocaleDateString()}</div>
                      </td>
                      <td className="hide-narrow">{a.events}</td>
                      <td>
                        {!r && <button onClick={() => replay(a)}>Replay</button>}
                        {typeof r === "string" && <span className="sub">{r}</span>}
                        {r && typeof r !== "string" && (
                          <span className={`badge s-${r.matches ? "ALLOW" : "DENY"}`} title={r.problem}>
                            {r.matches ? "matches" : "differs"}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
