// Owner console v0.5.0: adaptive discovery jobs and per-candidate licensing intelligence. Rendered inside OwnerDiscovery.tsx.
// Three decisions stay separate and manual: approve a SOURCE (existing form), approve a PROPOSAL (Proposals tab), record LICENSING clearance (here).
import { useCallback, useEffect, useState } from 'react';

type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
type Run = (fn: () => Promise<void>) => Promise<void>;
type Job = { id: number; label: string; root_url: string; status: string; open_items: number; total_items: number; stats: Record<string, number>; note: string | null; updated_at: string };
type Evidence = { id: number; kind: string; identifier: string | null; label: string; evidenceUrl: string; licenseUrl: string | null; excerpt: string; method: string; scope: string; confidence: number; restrictions: string[]; indicates: string; detectedAt: string; notes: string[] };
type Assessment = { access: { note: string }; reuse: { status: string; summary: string }; restrictions: string[]; confidence: number; conflicts: string[]; reasons: string[] };
type Insight = { meta: { resource_type: string; language: string; change_state: string; last_checked_at: string | null } | null; evidence: Evidence[]; assessment: Assessment;
  reviews: { id: number; decision: string; basis: string; scope: string; note: string; reviewed_at: string; conditions: string | null }[];
  explanation: { headline: string; whySuggested: string[]; licensing: string[]; restrictions: string[]; nextSteps: string[]; discoveryConfidence: string | null; licensingConfidence: number } };
const post = (body?: unknown): RequestInit => ({ method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const when = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(); };
const NEEDS_ACK = ['no-evidence', 'ambiguous', 'conflicting', 'restricted'];

export function AdaptivePanel({ api, busy, run, setNotice }: { api: Api; busy: boolean; run: Run; setNotice: (s: string) => void }) {
  const [jobs, setJobs] = useState<Job[] | null>(null); const [caps, setCaps] = useState<{ id: string; language: string; operations: string[]; compat: { status: string }; selectable: boolean }[]>([]);
  const [missing, setMissing] = useState(false); const [root, setRoot] = useState('');
  const load = useCallback(async () => {
    try { const o = await api<{ jobs: Job[]; capabilities: typeof caps }>('/api/admin/discovery/v5/overview'); setJobs(o.jobs); setCaps(o.capabilities); setMissing(false); }
    catch (e) { setMissing(/v0\.5\.0 tables are missing/i.test((e as Error).message)); setJobs([]); }
  }, [api]);
  useEffect(() => { void load(); }, [load]);
  const start = () => run(async () => { const r = await api<{ jobId: number }>('/api/admin/discovery/v5/jobs', post({ rootUrl: root.trim() })); setRoot(''); setNotice(`Job #${r.jobId} created. Run steps until it finishes; nothing is approved.`); await load(); });
  const step = (j: Job) => run(async () => { const r = await api<{ fetched: number; newCandidates: number; open: number; done: boolean; waitMs: number | null }>(`/api/admin/discovery/v5/jobs/${j.id}/step`, post()); setNotice(`${r.fetched} page(s) read, ${r.newCandidates} new pending candidate(s), ${r.open} left${r.done ? ' - job finished' : r.waitMs ? ` - next step in about ${Math.ceil(r.waitMs / 1000)}s` : ''}.`); await load(); });
  const cancel = (j: Job) => run(async () => { await api(`/api/admin/discovery/v5/jobs/${j.id}/cancel`, post()); await load(); });
  if (missing) return <section className="owner-panel"><h2>Adaptive discovery</h2><p className="muted">The v0.5.0 tables are not installed in this database. Apply <code>database/upgrade-0.5.0.sql</code> (after a backup) when you decide to; the v0.4.0 discovery below keeps working.</p></section>;
  return <section className="owner-panel">
    <div className="owner-section-head"><div><h2>Adaptive discovery</h2><p className="muted">Start from any public page, sitemap, feed or repository. The engine follows links, feeds and sitemaps it finds, respects robots.txt and never goes past a few pages per step. <strong>It only adds pending candidates and evidence.</strong></p></div></div>
    <form className="verify-form" onSubmit={(e) => { e.preventDefault(); void start(); }}>
      <input aria-label="Starting point" type="url" placeholder="https://… any public https page, sitemap, feed or GitHub repository" value={root} onChange={(e) => setRoot(e.target.value)} required />
      <div className="proposal-actions"><button className="primary-btn" disabled={busy || !root}>Start discovery job</button></div>
    </form>
    {(jobs ?? []).map((j) => <div className="owner-row" key={j.id}>
      <div><strong>#{j.id} {j.label}</strong><small>{j.root_url}</small><small>{j.status} · {j.open_items} left of {j.total_items} · {j.stats.candidates ?? 0} candidate(s), {j.stats.duplicates ?? 0} duplicate(s), {j.stats.nonEnglish ?? 0} non-English, {j.stats.blocked ?? 0} blocked{j.note ? ` · ${j.note}` : ''}</small></div>
      {(j.status === 'queued' || j.status === 'running') && <div className="proposal-actions"><button className="primary-btn" disabled={busy} onClick={() => void step(j)}>Run next step</button><button className="quiet-btn" disabled={busy} onClick={() => void cancel(j)}>Cancel</button></div>}
    </div>)}
    {caps.length > 0 && <details><summary>Processing modules ({caps.length})</summary>{caps.map((m) => <p className="muted small" key={m.id}><code>{m.id}</code> · {m.language} · {m.operations.join(', ')} · compatibility: {m.compat.status}{m.selectable ? '' : ' (not used)'}</p>)}<p className="muted small">“verified-local” means a static Workers-API check and local tests, not a run on Cloudflare.</p></details>}
  </section>;
}

export function CandidateInsight({ api, busy, run, setNotice, id, refresh }: { api: Api; busy: boolean; run: Run; setNotice: (s: string) => void; id: number; refresh: () => Promise<void> }) {
  const [data, setData] = useState<Insight | null>(null); const [open, setOpen] = useState(false); const [err, setErr] = useState('');
  const [f, setF] = useState({ decision: 'cleared', basis: 'detected-evidence', scope: '', note: '', conditions: '', attribution: '', ack: false, display: true, modify: false, redistribute: false, commercial: false });
  const [picked, setPicked] = useState<number[]>([]);
  const load = useCallback(async () => { try { setData(await api<Insight>(`/api/admin/discovery/v5/candidates/${id}/insight`)); setErr(''); } catch (e) { setErr((e as Error).message); } }, [api, id]);
  const base = `/api/admin/discovery/v5/candidates/${id}`;
  const scan = () => run(async () => { const r = await api<{ newEvidence: number; notes: string[] }>(`${base}/license/scan`, post()); setNotice(`Licence scan finished: ${r.newEvidence} evidence item(s) seen. ${r.notes.join(' ')}`); await load(); });
  const recheck = () => run(async () => { const r = await api<{ state: string; reason: string }>(`${base}/recheck`, post()); setNotice(`Source ${r.state}: ${r.reason}`); await load(); await refresh(); });
  const review = () => run(async () => {
    await api(`${base}/license/review`, post({ decision: f.decision, basis: f.basis, scope: f.scope, note: f.note, conditions: f.conditions, attributionText: f.attribution, acknowledgeAmbiguity: f.ack, evidenceIds: picked,
      permitsDisplay: f.display, permitsModification: f.modify, permitsRedistribution: f.redistribute, permitsCommercial: f.commercial }));
    setNotice('Licensing decision recorded. It does not approve the source or any proposal.'); setF((v) => ({ ...v, note: '', conditions: '', ack: false })); await load();
  });
  const a = data?.assessment; const needsAck = !!a && NEEDS_ACK.includes(a.reuse.status);
  return <details onToggle={(e) => { const o = (e.currentTarget as HTMLDetailsElement).open; setOpen(o); if (o && !data) void load(); }}>
    <summary>Why suggested · licensing evidence</summary>
    {open && err && <p className="owner-error">{err}</p>}
    {open && data && a && <div>
      <p><strong>{data.explanation.headline}</strong></p>
      <p className="muted small">Why suggested{data.explanation.discoveryConfidence ? ` (confidence: ${data.explanation.discoveryConfidence})` : ''}: {data.explanation.whySuggested.join(' · ')}</p>
      <p className={a.reuse.status === 'indicated-permissive' ? 'muted' : 'owner-error'}>{a.reuse.summary}</p>
      <p className="muted small">{a.access.note}</p>
      {a.conflicts.map((c, i) => <p className="owner-error small" key={i}>Conflict: {c}</p>)}
      {a.reasons.length > 0 && <p className="muted small">{a.reasons.join('; ')}.</p>}
      {data.explanation.restrictions.length > 0 && <p className="small"><strong>Restrictions:</strong> {data.explanation.restrictions.join(' · ')}</p>}
      <p className="muted small">Licensing confidence {Math.round(a.confidence * 100)}%. The engine can never mark anything cleared.</p>
      {data.evidence.map((e) => <div className="owner-row" key={e.id}><div><strong>{e.identifier || e.label}</strong><small>{e.label} · {e.method} · scope {e.scope} · {Math.round(e.confidence * 100)}% · indicates {e.indicates}</small>
        <small>“{e.excerpt}”</small><small><a href={e.evidenceUrl} target="_blank" rel="noreferrer noopener">evidence page</a>{e.licenseUrl && <> · <a href={e.licenseUrl} target="_blank" rel="noreferrer noopener">licence document</a></>} · detected {when(e.detectedAt)}</small>{e.notes.map((n, i) => <small key={i}>{n}</small>)}</div>
        <label className="small"><input type="checkbox" checked={picked.includes(e.id)} onChange={(ev) => setPicked((p) => ev.target.checked ? [...p, e.id] : p.filter((x) => x !== e.id))} /> cite</label></div>)}
      <div className="proposal-actions"><button className="quiet-btn" disabled={busy} onClick={() => void scan()}>Scan for licence evidence</button><button className="quiet-btn" disabled={busy} onClick={() => void recheck()}>Re-check source ({data.meta?.change_state ?? 'unknown'})</button></div>
      {data.reviews.length > 0 && <div><h4>Licensing decisions (newest first)</h4>{data.reviews.map((r) => <p className="muted small" key={r.id}>{when(r.reviewed_at)} · <strong>{r.decision}</strong> ({r.basis}; {r.scope}) · {r.note}{r.conditions ? ` · conditions: ${r.conditions}` : ''}</p>)}</div>}
      <form className="verify-form" onSubmit={(e) => { e.preventDefault(); void review(); }}>
        <h4>Record a licensing decision</h4><p className="muted small">Separate from approving the source and from approving proposals. Recorded decisions cannot be edited; record a new one to change it.</p>
        <select aria-label="Decision" value={f.decision} onChange={(e) => setF({ ...f, decision: e.target.value })}><option value="cleared">Cleared for reuse</option><option value="cleared-with-conditions">Cleared with conditions</option><option value="denied">Denied</option></select>
        <select aria-label="Basis" value={f.basis} onChange={(e) => setF({ ...f, basis: e.target.value })}><option value="detected-evidence">Detected evidence (tick “cite” above)</option><option value="owner-written-permission">Written permission I hold</option><option value="owner-judgement">My own judgement</option></select>
        <input aria-label="What this covers" maxLength={300} placeholder="What it covers, e.g. “text of this page, not images”" value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })} required />
        <textarea aria-label="Reason" placeholder="Why (at least 10 characters)" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} required />
        {f.decision === 'cleared-with-conditions' && <input aria-label="Conditions" placeholder="Conditions that must be met (required)" value={f.conditions} onChange={(e) => setF({ ...f, conditions: e.target.value })} />}
        {f.decision !== 'denied' && <><input aria-label="Attribution text" placeholder="Attribution text, if required" value={f.attribution} onChange={(e) => setF({ ...f, attribution: e.target.value })} />
          <p className="small">{([['modify', 'adaptation allowed'], ['redistribute', 'redistribution allowed'], ['commercial', 'commercial use allowed']] as const).map(([k, l]) => <label key={k}><input type="checkbox" checked={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.checked })} /> {l}{'  '}</label>)}</p></>}
        {f.decision !== 'denied' && needsAck && <label className="owner-error small"><input type="checkbox" checked={f.ack} onChange={(e) => setF({ ...f, ack: e.target.checked })} /> I understand the assessment is “{a.reuse.status}” and I am deciding on my own responsibility.</label>}
        <div className="proposal-actions"><button className="primary-btn" disabled={busy || (f.decision !== 'denied' && needsAck && !f.ack)}>Record decision</button></div>
      </form>
    </div>}
  </details>;
}
