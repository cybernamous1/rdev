// Private owner console. Rendered outside the learner shell and loaded lazily (see App.tsx).
// All authority lives in the Worker: this UI only calls /api/admin/* with a same-origin HttpOnly session cookie.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Icon } from '../components/Icon.tsx';
import { OwnerDiscovery } from './OwnerDiscovery.tsx';

type Proposal = { id: number; kind: string; target_entry_id: string; title: string; rationale: string | null; status: string; origin: string; created_at: string; review_note: string | null; payload: any; analysis: any; provenance?: { sourceId: string; sourceUrl: string; contentHash: string; sourceChanged: boolean } | null };
type Pkg = { id: string; title: string; current_version: string | null };
type Publication = { id: number; package_id: string; version: string; previous_version?: string | null; action: string; note?: string | null; published_at: string };
type Overview = { counts: { pending: number; approved: number; published: number }; packages: Pkg[]; sources: { id: string; label: string; url: string; publisher: string; license: string | null; status: string; retrieved_at: string | null }[]; publications: Publication[] };
type Auth = 'checking' | 'signed-out' | 'signed-in' | 'unavailable';

class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
  return data as T;
}
const emptySource = { id: '', label: '', url: '', publisher: '', license: '' };
const when = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(); };

export function Owner() {
  const [auth, setAuth] = useState<Auth>('checking');
  const [token, setToken] = useState(''); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [overview, setOverview] = useState<Overview | null>(null); const [proposals, setProposals] = useState<Proposal[]>([]); const [publications, setPublications] = useState<Publication[]>([]);
  const [filter, setFilter] = useState('pending'); const [originFilter, setOriginFilter] = useState('all'); const [tab, setTab] = useState('overview');
  const [notes, setNotes] = useState<Record<number, string>>({}); const [sourceDraft, setSourceDraft] = useState(emptySource);
  const [verify, setVerify] = useState<{ id: number; reviewer: string; notes: string; confirmed: boolean } | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<Publication | null>(null);

  // A 401 anywhere means the session ended: return to the sign-in form instead of showing a broken dashboard.
  const fail = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) { setAuth('signed-out'); setOverview(null); setError('Your owner session ended. Please sign in again.'); return; }
    setError((e as Error).message || 'Something went wrong.');
  }, []);
  const refresh = useCallback(async () => {
    const [o, p, h] = await Promise.all([
      api<Overview>('/api/admin/overview'),
      api<{ proposals: Proposal[] }>(`/api/admin/proposals?status=${encodeURIComponent(filter)}`),
      api<{ publications: Publication[] }>('/api/admin/publications')
    ]);
    setOverview(o); setProposals(p.proposals); setPublications(h.publications);
  }, [filter]);

  useEffect(() => {
    let live = true;
    api('/api/admin/session')
      .then(() => live && setAuth('signed-in'))
      .catch((e: unknown) => { if (live) setAuth(e instanceof ApiError && (e.status === 503 || e.status === 500) ? 'unavailable' : 'signed-out'); if (live && e instanceof ApiError && e.status !== 401) setError(e.message); });
    return () => { live = false; };
  }, []);
  useEffect(() => { if (auth === 'signed-in') refresh().catch(fail); }, [auth, refresh, fail]);

  const run = useCallback(async (fn: () => Promise<void>) => { setBusy(true); setError(''); setNotice(''); try { await fn(); } catch (e) { fail(e); } finally { setBusy(false); } }, [fail]);
  const login = (e: FormEvent) => { e.preventDefault(); void run(async () => { await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ token }) }); setToken(''); setAuth('signed-in'); }); };
  const logout = () => run(async () => { await api('/api/admin/logout', { method: 'POST', body: '{}' }); setAuth('signed-out'); setOverview(null); });
  const review = (id: number, decision: 'approve' | 'reject') => run(async () => { await api(`/api/admin/proposals/${id}/review`, { method: 'POST', body: JSON.stringify({ decision, note: notes[id] || '' }) }); setNotice(decision === 'approve' ? 'Proposal approved. It is not public until you verify and publish it.' : 'Proposal rejected.'); await refresh(); });
  const addSource = (e: FormEvent) => { e.preventDefault(); void run(async () => { await api('/api/admin/sources', { method: 'POST', body: JSON.stringify(sourceDraft) }); setSourceDraft(emptySource); setNotice('Source registered.'); await refresh(); }); };
  const fetchSource = (id: string) => run(async () => { const r = await api<{ note: string }>(`/api/admin/sources/${id}/fetch`, { method: 'POST', body: '{}' }); setNotice(r.note); await refresh(); });
  const publish = (p: Proposal) => {
    const pkg = overview?.packages.find((x) => x.title === p.payload?.path);
    if (!pkg || !verify) { setError('No package matches this proposal learning path.'); return; }
    void run(async () => {
      await api(`/api/admin/publish/${pkg.id}`, { method: 'POST', body: JSON.stringify({ proposalId: p.id, verification: { confirmed: verify.confirmed, reviewer: verify.reviewer, notes: verify.notes } }) });
      setVerify(null); setNotice(`Published to ${pkg.title}. Learners receive it after their next sync (cache lifetime is at most a few minutes).`); await refresh();
    });
  };
  const rollback = () => {
    const target = rollbackTarget; if (!target) return;
    void run(async () => { await api(`/api/admin/rollback/${target.package_id}`, { method: 'POST', body: JSON.stringify({ version: target.version, note: 'Owner requested restore from dashboard' }) }); setRollbackTarget(null); setNotice(`${target.package_id} now serves version ${target.version}.`); await refresh(); });
  };
  const visible = proposals.filter((p) => originFilter === 'all' || p.origin === originFilter);
  const currentOf = (id: string) => overview?.packages.find((p) => p.id === id)?.current_version ?? null;

  if (auth === 'checking') return <main className="owner-wrap"><div className="owner-panel" role="status">Checking owner session…</div></main>;
  if (auth === 'unavailable') return <main className="owner-wrap"><div className="owner-panel"><h2>Owner console unavailable</h2><p className="muted">{error || 'The owner API is not configured on this deployment.'}</p><a href="#/home" className="owner-link">← Return to learner website</a></div></main>;
  if (auth === 'signed-out') return (
    <main className="owner-wrap"><form className="owner-login" onSubmit={login}>
      <div className="owner-mark"><Icon name="shield" size={28} /></div><p className="eyebrow">PRIVATE ADMINISTRATION</p><h1>RDev Academy Owner</h1>
      <p className="muted">Sign in with the owner credential configured as a Cloudflare Worker secret.</p>
      <label htmlFor="owner-token">Owner token</label>
      <input id="owner-token" type="password" autoComplete="current-password" value={token} onChange={(e) => setToken(e.target.value)} required minLength={32} placeholder="Enter owner token" />
      <button className="primary-btn" disabled={busy || token.length < 32}>{busy ? 'Signing in…' : 'Sign in securely'}</button>
      {error && <p className="owner-error" role="alert">{error}</p>}
      <a href="#/home" className="owner-back">← Return to learner website</a>
    </form></main>
  );

  return (
    <main className="owner-wrap">
      <header className="owner-header">
        <div><p className="eyebrow">RDEV ACADEMY · PRIVATE CONSOLE</p><h1>Owner Dashboard</h1><p className="muted">Discover sources, review extracted knowledge and distribute approved learning content.</p></div>
        <div className="owner-header-actions"><a href="#/home" className="owner-link">Public website ↗</a><button className="quiet-btn" onClick={logout} disabled={busy}>Sign out</button></div>
      </header>
      {error && <div className="owner-error owner-alert" role="alert">{error}</div>}
      {notice && <div className="owner-notice" role="status">{notice}</div>}
      <nav className="owner-tabs" aria-label="Owner sections">{[['overview', 'Overview'], ['discovery', 'Discovery'], ['proposals', 'Proposals'], ['sources', 'Sources'], ['publications', 'Publications']].map(([id, label]) => <button key={id} className={tab === id ? 'active' : ''} aria-current={tab === id} onClick={() => setTab(id)}>{label}</button>)}</nav>

      {tab === 'overview' && overview && <>
        <section className="owner-stats">
          <article><strong>{overview.counts.pending}</strong><span>Pending review</span></article>
          <article><strong>{overview.counts.approved}</strong><span>Approved, unpublished</span></article>
          <article><strong>{overview.counts.published}</strong><span>Published proposals</span></article>
          <article><strong>{overview.packages.filter((p) => p.current_version).length}/{overview.packages.length}</strong><span>Published packages</span></article>
        </section>
        <section className="owner-panel">
          <div className="owner-section-head"><div><h2>Central knowledge distribution</h2><p className="muted">D1 is authoritative. Learners receive only the current published package versions.</p></div><button className="quiet-btn" onClick={() => void run(refresh)} disabled={busy}><Icon name="refresh" /> Refresh</button></div>
          {overview.packages.map((p) => <div className="owner-row" key={p.id}><div><strong>{p.title}</strong><small>{p.id}</small></div><span className={p.current_version ? 'state-good' : 'state-muted'}>{p.current_version ? `v${p.current_version}` : 'Not published'}</span></div>)}
        </section>
        <section className="owner-panel"><h2>Recent publications</h2>{overview.publications.length ? overview.publications.slice(0, 5).map((p) => <div className="owner-row" key={p.id}><div><strong>{p.package_id}</strong><small>{when(p.published_at)}</small></div><span>{p.action} · {p.version}</span></div>) : <p className="muted">No publications yet.</p>}</section>
      </>}

      {tab === 'discovery' && <OwnerDiscovery api={api} busy={busy} run={run} setNotice={setNotice} refreshOwner={refresh} goToProposals={() => setTab('proposals')} />}

      {tab === 'proposals' && <section className="owner-panel">
        <div className="owner-section-head"><div><h2>Knowledge proposals</h2><p className="muted">Nothing is visible to learners until a proposal is approved and then separately verified and published.</p></div>
          <select aria-label="Proposal status" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="pending">Pending</option><option value="approved">Approved</option><option value="published">Published</option><option value="rejected">Rejected</option><option value="all">All</option></select>
          <select aria-label="Proposal origin" value={originFilter} onChange={(e) => setOriginFilter(e.target.value)}><option value="all">All origins</option><option value="pipeline">Extracted from sources</option><option value="bootstrap">Bootstrap</option><option value="owner">Owner</option></select></div>
        {visible.length === 0 ? <p className="muted">No proposals in this view.</p> : visible.map((p) => <article className="proposal-card" key={p.id}>
          <div className="proposal-meta"><span>#{p.id} · {p.kind} · {p.origin}</span><span>{p.status}</span></div>
          <h3>{p.title}</h3><p className="muted">{p.rationale || 'No rationale supplied.'}</p>
          {p.provenance && <p className="muted">Source: <a href={p.provenance.sourceUrl} target="_blank" rel="noreferrer noopener">{p.provenance.sourceUrl}</a> · extracted content hash {p.provenance.contentHash.slice(0, 12)}…</p>}
          {p.provenance?.sourceChanged && p.status !== 'rejected' && p.status !== 'published' && <p className="owner-error" role="alert">The source changed after this was extracted. This proposal is stale and cannot be published; re-extract the source and review the new proposal.</p>}
          {Array.isArray(p.analysis?.findings) && p.analysis.findings.length > 0 && <p className="muted">Findings: {p.analysis.findings.map((f: { severity: string; type: string }) => `${f.severity}: ${f.type}`).join(' · ')}</p>}
          {p.analysis?.validation?.warnings?.some((w: string) => /license/i.test(w)) && <p className="owner-error">Source license is not recorded; this content cannot be published until it is.</p>}
          {p.analysis?.licensing && <p className={p.analysis.licensing.clearance ? 'muted' : 'owner-error'}>Licensing: {p.analysis.licensing.assessment?.reuse?.status} · {p.analysis.licensing.clearance ? `owner decision: ${p.analysis.licensing.clearance.decision}` : 'no licensing clearance recorded'}{p.analysis.licensing.assessment?.restrictions?.length ? ` · restrictions: ${p.analysis.licensing.assessment.restrictions.join(', ')}` : ''}</p>}
          <details><summary>Inspect proposed content and validation findings</summary><pre>{JSON.stringify({ entry: p.payload, analysis: p.analysis }, null, 2)}</pre></details>
          {p.status === 'pending' && <>
            <textarea aria-label={`Review note for proposal ${p.id}`} placeholder="Optional approval note; required when rejecting" value={notes[p.id] || ''} onChange={(e) => setNotes((v) => ({ ...v, [p.id]: e.target.value }))} />
            <div className="proposal-actions"><button className="primary-btn" disabled={busy} onClick={() => void review(p.id, 'approve')}>Approve proposal</button><button className="danger-btn" disabled={busy || !(notes[p.id] || '').trim()} onClick={() => void review(p.id, 'reject')}>Reject</button></div></>}
          {p.status === 'approved' && (verify?.id === p.id
            ? <form className="verify-form" onSubmit={(e) => { e.preventDefault(); publish(p); }}>
                <p className="muted">Confirm you inspected the content, code examples, sources and licensing for “{p.title}”. Publication makes it visible to every learner.</p>
                <input aria-label="Reviewer name" placeholder="Reviewer name" required minLength={2} maxLength={120} value={verify.reviewer} onChange={(e) => setVerify({ ...verify, reviewer: e.target.value })} />
                <textarea aria-label="Verification notes" placeholder="What did you check? (at least 10 characters)" required minLength={10} maxLength={2000} value={verify.notes} onChange={(e) => setVerify({ ...verify, notes: e.target.value })} />
                <label className="verify-check"><input type="checkbox" checked={verify.confirmed} onChange={(e) => setVerify({ ...verify, confirmed: e.target.checked })} /> I reviewed this content and it is ready for public learners.</label>
                <div className="proposal-actions"><button className="primary-btn" disabled={busy || !verify.confirmed || verify.reviewer.trim().length < 2 || verify.notes.trim().length < 10}>Publish</button><button type="button" className="quiet-btn" onClick={() => setVerify(null)}>Cancel</button></div>
              </form>
            : <div className="proposal-actions"><button className="primary-btn" disabled={busy} onClick={() => setVerify({ id: p.id, reviewer: '', notes: '', confirmed: false })}>Verify &amp; publish</button></div>)}
          {p.status === 'rejected' && <p className="muted">Reason: {p.review_note}</p>}
        </article>)}
      </section>}

      {tab === 'sources' && <>
        <section className="owner-panel"><h2>Register a knowledge source</h2><p className="muted">Only HTTPS sources on the approved Roblox/Luau/GitHub host list are accepted.</p>
          <form className="source-form" onSubmit={addSource}>
            <input required aria-label="Source id" pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={48} placeholder="source-id" value={sourceDraft.id} onChange={(e) => setSourceDraft((v) => ({ ...v, id: e.target.value }))} />
            <input required aria-label="Source label" maxLength={160} placeholder="Source label" value={sourceDraft.label} onChange={(e) => setSourceDraft((v) => ({ ...v, label: e.target.value }))} />
            <input required aria-label="Source URL" type="url" placeholder="https://…" value={sourceDraft.url} onChange={(e) => setSourceDraft((v) => ({ ...v, url: e.target.value }))} />
            <input required aria-label="Publisher" maxLength={160} placeholder="Publisher" value={sourceDraft.publisher} onChange={(e) => setSourceDraft((v) => ({ ...v, publisher: e.target.value }))} />
            <input aria-label="License" maxLength={300} placeholder="License (leave blank if unknown)" value={sourceDraft.license} onChange={(e) => setSourceDraft((v) => ({ ...v, license: e.target.value }))} />
            <button className="primary-btn" disabled={busy}>Register source</button>
          </form></section>
        <section className="owner-panel"><h2>Central source registry</h2><p className="muted">Retrieval records store status and a content hash, not third-party source text.</p>
          {overview?.sources.map((s) => <div className="owner-row" key={s.id}><div><strong>{s.label}</strong><small>{s.publisher} · {s.id}</small><small><a href={s.url} target="_blank" rel="noreferrer noopener">{s.url}</a></small><small>Latest retrieval: {s.status}{s.retrieved_at ? ` · ${when(s.retrieved_at)}` : ''} · {s.license || 'License undetermined'}</small></div><button className="quiet-btn" disabled={busy} onClick={() => void fetchSource(s.id)}>Check source</button></div>)}
        </section></>}

      {tab === 'publications' && <section className="owner-panel">
        <h2>Publication history</h2><p className="muted">Restoring an earlier version appends a rollback record and moves the package pointer; history is never rewritten.</p>
        {publications.length === 0 && <p className="muted">No publications yet.</p>}
        {publications.map((p) => { const isCurrent = currentOf(p.package_id) === p.version; return <div className="owner-row" key={p.id}>
          <div><strong>{p.package_id} · {p.version}</strong><small>{when(p.published_at)}{p.note ? ` · ${p.note}` : ''}</small></div>
          <div className="proposal-actions"><span className={isCurrent ? 'state-good' : ''}>{isCurrent ? 'current' : p.action}</span>
            {p.action === 'publish' && !isCurrent && currentOf(p.package_id) && (rollbackTarget?.id === p.id
              ? <><button className="danger-btn" disabled={busy} onClick={rollback}>Confirm restore</button><button className="quiet-btn" onClick={() => setRollbackTarget(null)}>Cancel</button></>
              : <button className="quiet-btn" disabled={busy} onClick={() => setRollbackTarget(p)}>Restore this version</button>)}</div>
        </div>; })}
        {rollbackTarget && <p className="muted">Learners will receive {rollbackTarget.package_id} {rollbackTarget.version} after cache revalidation (up to a few minutes).</p>}
      </section>}
      <footer className="owner-footer">Owner operations are server-validated. Learner data remains local to each learner's browser.</footer>
    </main>
  );
}
