// Owner console: knowledge discovery. Rendered inside Owner.tsx (same lazily loaded chunk, same authenticated API helper).
// Queue 1 (this panel): candidate SOURCES. Queue 2 (the existing Proposals tab): extracted knowledge PROPOSALS.
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../components/Icon.tsx';
import { PATHS } from '../../shared/paths.ts';

type Seed = { id: string; label: string; url: string; category: string; lastRun: { status: string; new_candidates: number; started_at: string; note: string | null } | null };
type Candidate = { id: number; url: string; title: string; publisher: string; category: string; suggested_path: string | null; relevance: number; discovered_via: string; status: string; first_seen_at: string; review_note: string | null; registered_source_id: string | null; license: string | null; last_extraction: string | null; last_extraction_at: string | null };
type Changes = { sources: { candidate_id: number; source_id: string; title: string; last_status: string | null }[]; staleProposals: { id: number; title: string; status: string; source_id: string }[]; outdatedPublished: { entryId: string; others: string[]; detail: string }[] };
type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
type Props = { api: Api; busy: boolean; run: (fn: () => Promise<void>) => Promise<void>; setNotice: (s: string) => void; refreshOwner: () => Promise<void>; goToProposals: () => void };
const when = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(); };
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
const EXTRACT_LABEL: Record<string, string> = { new: 'proposal queued', changed: 'changed · update queued', unchanged: 'unchanged', duplicate: 'duplicate', unclassified: 'needs a path', failed: 'failed' };

export function OwnerDiscovery({ api, busy, run, setNotice, refreshOwner, goToProposals }: Props) {
  const [seeds, setSeeds] = useState<Seed[]>([]); const [counts, setCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState('pending'); const [items, setItems] = useState<Candidate[]>([]); const [changes, setChanges] = useState<Changes | null>(null);
  const [notes, setNotes] = useState<Record<number, string>>({}); const [licenses, setLicenses] = useState<Record<number, string>>({}); const [paths, setPaths] = useState<Record<number, string>>({});
  const [approving, setApproving] = useState<number | null>(null);

  const load = useCallback(async () => {
    const [o, c, ch] = await Promise.all([
      api<{ seeds: Seed[]; counts: Record<string, number> }>('/api/admin/discovery/overview'),
      api<{ candidates: Candidate[] }>(`/api/admin/discovery/candidates?status=${encodeURIComponent(filter)}`),
      api<Changes>('/api/admin/discovery/changes')
    ]);
    setSeeds(o.seeds); setCounts(o.counts); setItems(c.candidates); setChanges(ch);
  }, [api, filter]);
  useEffect(() => { void run(load); }, [run, load]);

  const discover = (seed: Seed) => run(async () => { const r = await api<{ newCandidates: number; relevant: number; alreadyQueued: number }>('/api/admin/discovery/run', post({ seedId: seed.id })); setNotice(`${r.newCandidates} new candidate source(s) queued for your review (${r.relevant} relevant link(s) found, ${r.alreadyQueued} already queued). None is trusted yet.`); await load(); });
  const decide = (c: Candidate, decision: 'approve' | 'reject') => run(async () => {
    await api(`/api/admin/discovery/candidates/${c.id}/review`, post({ decision, note: notes[c.id] || '', license: licenses[c.id] || '' }));
    setApproving(null); setNotice(decision === 'approve' ? 'Source approved and registered in the source ledger. Nothing has been extracted or published.' : 'Source rejected. It will not be suggested again.'); await load(); await refreshOwner();
  });
  const extract = (c: Candidate) => run(async () => {
    const r = await api<{ status: string; note?: string; proposalId?: number; kind?: string }>(`/api/admin/discovery/candidates/${c.id}/extract`, post({ path: paths[c.id] || undefined }));
    setNotice(r.proposalId ? `Pending ${r.kind} proposal #${r.proposalId} queued. Review it in the Proposals tab; it is not public.` : (r.note || r.status)); await load(); await refreshOwner();
  });
  const saveLicense = (c: Candidate) => run(async () => { await api(`/api/admin/discovery/candidates/${c.id}/license`, post({ license: licenses[c.id] || '' })); setNotice('License recorded for the source.'); await load(); });

  return <>
    <section className="owner-panel">
      <div className="owner-section-head"><div><h2>Discover sources</h2><p className="muted">Reads a few official discovery pages and suggests candidate sources. <strong>Discovery is not approval:</strong> candidates stay untrusted until you approve them below.</p></div></div>
      {seeds.map((s) => <div className="owner-row" key={s.id}><div><strong>{s.label}</strong><small>{s.url}</small><small>{s.lastRun ? `Last run ${when(s.lastRun.started_at)} · ${s.lastRun.status}${s.lastRun.status === 'completed' ? ` · ${s.lastRun.new_candidates} new` : ''}` : 'Never run'}</small></div><button className="quiet-btn" disabled={busy} onClick={() => void discover(s)}><Icon name="refresh" /> Find sources</button></div>)}
    </section>

    {changes && (changes.outdatedPublished.length > 0 || changes.staleProposals.length > 0) && <section className="owner-panel owner-warn">
      <h2>Changed sources</h2><p className="muted">Approved sources whose content changed after extraction. Nothing is altered automatically.</p>
      {changes.outdatedPublished.map((f) => <div className="owner-row" key={f.entryId}><div><strong>Published entry may be outdated: {f.entryId}</strong><small>{f.detail}</small></div></div>)}
      {changes.staleProposals.map((p) => <div className="owner-row" key={p.id}><div><strong>Stale {p.status} proposal #{p.id}: {p.title}</strong><small>Its source changed after extraction. It cannot be published; re-extract the source and review the new proposal.</small></div><button className="quiet-btn" onClick={goToProposals}>Open proposals</button></div>)}
    </section>}

    <section className="owner-panel">
      <div className="owner-section-head"><div><h2>Candidate sources</h2><p className="muted">Pending {counts.pending || 0} · approved {counts.approved || 0} · rejected {counts.rejected || 0}. Extracted content is reviewed separately in the Proposals tab.</p></div>
        <select aria-label="Candidate status" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="all">All</option></select></div>
      {items.length === 0 ? <p className="muted">No candidate sources in this view. Use “Find sources” above.</p> : items.map((c) => <article className="proposal-card" key={c.id}>
        <div className="proposal-meta"><span>#{c.id} · {c.category} · relevance {c.relevance}</span><span>{c.status}</span></div>
        <h3>{c.title}</h3>
        <p className="muted"><a href={c.url} target="_blank" rel="noreferrer noopener">{c.url}</a><br />{c.publisher} · suggested path: {c.suggested_path || 'none'} · found via {c.discovered_via} · {when(c.first_seen_at)}</p>
        {c.status === 'pending' && (approving === c.id
          ? <form className="verify-form" onSubmit={(e) => { e.preventDefault(); void decide(c, 'approve'); }}>
              <p className="muted">Approving registers this URL in the source ledger as a trusted source. It does not extract or publish anything.</p>
              <input aria-label="License" maxLength={300} placeholder="License of the source content (e.g. CC BY 4.0) — required before its content can be published" value={licenses[c.id] || ''} onChange={(e) => setLicenses((v) => ({ ...v, [c.id]: e.target.value }))} />
              <textarea aria-label="Approval note" placeholder="Optional note" value={notes[c.id] || ''} onChange={(e) => setNotes((v) => ({ ...v, [c.id]: e.target.value }))} />
              <div className="proposal-actions"><button className="primary-btn" disabled={busy}>Approve source</button><button type="button" className="quiet-btn" onClick={() => setApproving(null)}>Cancel</button></div>
            </form>
          : <>
              <textarea aria-label={`Rejection reason for candidate ${c.id}`} placeholder="Reason (required to reject)" value={notes[c.id] || ''} onChange={(e) => setNotes((v) => ({ ...v, [c.id]: e.target.value }))} />
              <div className="proposal-actions"><button className="primary-btn" disabled={busy} onClick={() => setApproving(c.id)}>Approve source…</button><button className="danger-btn" disabled={busy || !(notes[c.id] || '').trim()} onClick={() => void decide(c, 'reject')}>Reject</button></div>
            </>)}
        {c.status === 'rejected' && <p className="muted">Reason: {c.review_note}</p>}
        {c.status === 'approved' && <>
          <p className="muted">Registered as <code>{c.registered_source_id}</code> · {c.license || 'No license recorded'}{c.last_extraction ? ` · last extraction: ${EXTRACT_LABEL[c.last_extraction] || c.last_extraction}${c.last_extraction_at ? ` (${when(c.last_extraction_at)})` : ''}` : ' · not extracted yet'}</p>
          {!c.license && <div className="proposal-actions"><input aria-label="Record license" maxLength={300} placeholder="Record the source license" value={licenses[c.id] || ''} onChange={(e) => setLicenses((v) => ({ ...v, [c.id]: e.target.value }))} /><button className="quiet-btn" disabled={busy || !(licenses[c.id] || '').trim()} onClick={() => void saveLicense(c)}>Save license</button></div>}
          <div className="proposal-actions">
            <select aria-label="Learning path override" value={paths[c.id] || ''} onChange={(e) => setPaths((v) => ({ ...v, [c.id]: e.target.value }))}><option value="">Classify automatically</option>{PATHS.map((p) => <option key={p.slug} value={p.name}>{p.name}</option>)}</select>
            <button className="primary-btn" disabled={busy} onClick={() => void extract(c)}>{c.last_extraction ? 'Re-check & extract' : 'Retrieve & extract'}</button>
          </div></>}
      </article>)}
    </section>
  </>;
}
