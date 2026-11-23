import { useRef, useState } from 'react';
import { PATHS } from '../../shared/paths.ts';
import { validatePackage, STATUS_LABEL } from '../../shared/rlf.ts';
import { useApp } from '../app/context.tsx';
import { fmtDate, useNotify } from '../app/helpers.tsx';
import { href, replace, type Route } from '../app/router.ts';
import { EntryCard } from '../components/EntryCard.tsx';
import { Icon } from '../components/Icon.tsx';
import { LibraryPreparing } from '../components/LibraryPreparing.tsx';
import { downloadText, importPackageText, rebuildLibrary, removeStored } from '../services/packages.ts';

const TABS = [['concepts', 'Concepts'], ['map', 'Learning map'], ['packages', 'Packages'], ['sources', 'Sources'], ['service', 'Service']];

export function Explorer({ route }: { route: Route }) {
  const tab = route.params.get('tab') || 'concepts';
  const { lib } = useApp();
  return (
    <>
      <div className="page-heading"><span className="eyebrow">EXPLORE THE KNOWLEDGE BASE</span><h1>Knowledge Explorer</h1><p>Browse concepts, see how lessons connect, and inspect the packages, sources and service that supply them. Everything shown here is read from the loaded library.</p></div>
      <div className="tabs" role="tablist">{TABS.map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => replace('/explorer', { tab: id })}>{label}</button>)}</div>
      {(tab === 'concepts' || tab === 'map') && lib.entries.length === 0 && <LibraryPreparing compact />}
      {tab === 'concepts' && lib.entries.length > 0 && <Concepts route={route} />}
      {tab === 'map' && lib.entries.length > 0 && <LearningMap route={route} />}
      {tab === 'packages' && <Packages />}
      {tab === 'sources' && <Sources />}
      {tab === 'service' && <Service />}
    </>
  );
}

function Concepts({ route }: { route: Route }) {
  const { lib } = useApp();
  const tag = route.params.get('tag') || '';
  const tags = [...lib.tags.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const entries = tag ? lib.entries.filter((e) => e.tags.includes(tag)) : [];
  const co = new Map<string, number>(); for (const e of entries) for (const t of e.tags) if (t !== tag) co.set(t, (co.get(t) || 0) + 1);
  return (
    <>
      <div className="chip-row">{tags.map(([t, n]) => <button key={t} className={`chip ${t === tag ? 'chip-on' : ''}`} onClick={() => replace('/explorer', { tab: 'concepts', tag: t === tag ? undefined : t })}>{t} <small>{n}</small></button>)}</div>
      {!tag && <p className="muted">{tags.length} concepts, taken from the topic tags on each entry. Select one to see where it appears.</p>}
      {tag && <><div className="section-title"><div><span className="eyebrow">CONCEPT</span><h2>{tag}</h2></div><a className="text-action" href={href('/docs', { tag })}>Open in documentation <Icon name="chevR" size={15} /></a></div>
        {co.size > 0 && <p className="muted">Often appears with: {[...co.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => t).join(', ')}</p>}
        <div className="lesson-grid">{entries.map((e) => <EntryCard key={e.id} entry={e} />)}</div></>}
    </>
  );
}

function LearningMap({ route }: { route: Route }) {
  const { lib } = useApp();
  const sel = route.params.get('sel') || '';
  const lessons = lib.entries.filter((e) => e.kind === 'lesson');
  const COLW = 190, ROWH = 70, NW = 160, NH = 44, PADX = 14, PADY = 46;
  const pos = new Map<string, { x: number; y: number }>();
  PATHS.forEach((p, c) => lessons.filter((l) => l.path === p.name).sort((a, b) => a.order - b.order).forEach((l, r) => pos.set(l.id, { x: PADX + c * COLW, y: PADY + r * ROWH })));
  const maxRows = Math.max(...PATHS.map((p) => lessons.filter((l) => l.path === p.name).length));
  const W = PADX * 2 + PATHS.length * COLW - (COLW - NW), H = PADY + maxRows * ROWH;
  const prereqs = lib.relationships.filter((r) => r.type === 'prerequisite');
  const hl = (id: string) => sel && (id === sel || prereqs.some((r) => (r.from === sel && r.to === id) || (r.to === sel && r.from === id)));
  const chosen = sel ? lib.byId.get(sel) : undefined;
  return (
    <>
      <p className="muted">Each column is a learning path. Arrows point from a prerequisite to the lesson that builds on it. Select a lesson to highlight its connections.</p>
      <div className="map-scroll"><svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="group" aria-label="Learning map">
        <defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--accent)" /></marker></defs>
        {PATHS.map((p, c) => <text key={p.slug} className="map-col" x={PADX + c * COLW} y={22}>{p.name.length > 24 ? p.name.slice(0, 23) + '…' : p.name}</text>)}
        {prereqs.map((r) => {
          const a = pos.get(r.to), b = pos.get(r.from); if (!a || !b) return null; // a = prerequisite, b = dependent
          const same = Math.abs(a.x - b.x) < 1;
          const x1 = same ? a.x + NW / 2 : a.x < b.x ? a.x + NW : a.x, y1 = same ? (a.y < b.y ? a.y + NH : a.y) : a.y + NH / 2;
          const x2 = same ? b.x + NW / 2 : a.x < b.x ? b.x : b.x + NW, y2 = same ? (a.y < b.y ? b.y : b.y + NH) : b.y + NH / 2;
          const d = same ? `M${x1} ${y1}L${x2} ${y2}` : `M${x1} ${y1}C${(x1 + x2) / 2} ${y1},${(x1 + x2) / 2} ${y2},${x2} ${y2}`;
          const on = hl(r.from) && hl(r.to) && (r.from === sel || r.to === sel);
          return <path key={r.from + r.to} d={d} className={`map-edge ${on ? 'on' : sel ? 'dim' : ''}`} markerEnd="url(#arr)" />;
        })}
        {lessons.map((l) => { const p = pos.get(l.id)!; return (
          <g key={l.id} className={`map-node ${sel === l.id ? 'sel' : hl(l.id) ? 'rel' : sel ? 'dim' : ''}`} transform={`translate(${p.x},${p.y})`} tabIndex={0} role="button" aria-label={l.title} onClick={() => replace('/explorer', { tab: 'map', sel: sel === l.id ? undefined : l.id })} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); replace('/explorer', { tab: 'map', sel: l.id }); } }}>
            <rect width={NW} height={NH} rx="9" /><text x="10" y="27">{l.title.length > 23 ? l.title.slice(0, 22) + '…' : l.title}</text><title>{l.title}</title>
          </g>); })}
      </svg></div>
      {chosen && <div className="panel"><h2>{chosen.title}</h2><p>{chosen.summary}</p>
        <p className="muted small">Builds on: {chosen.prerequisites.length ? chosen.prerequisites.map((p) => lib.byId.get(p)?.title).filter(Boolean).join(', ') : 'nothing required'} · Leads to: {prereqs.filter((r) => r.to === chosen.id).map((r) => lib.byId.get(r.from)?.title).join(', ') || 'no listed follow-ups'}</p>
        <a className="primary-btn small" href={href('/lesson/' + chosen.id)}>Open lesson <Icon name="chevR" size={15} /></a></div>}
    </>
  );
}

function Packages() {
  const { lib, setLib, storage } = useApp();
  const notify = useNotify();
  const file = useRef<HTMLInputElement>(null);
  const [results, setResults] = useState<Record<string, string>>({});
  const [importMsg, setImportMsg] = useState<{ ok: boolean; lines: string[] } | null>(null);
  const verify = async (id: string) => {
    const p = lib.packages.find((x) => x.id === id)!; const r = await validatePackage(p.pkg);
    setResults((s) => ({ ...s, [id]: r.ok ? `Valid. Checksum matches. ${r.warnings.length} warning(s).` : `Invalid: ${r.errors[0]}` }));
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const r = await importPackageText(await f.text(), lib);
    setImportMsg({ ok: r.ok, lines: [r.message, ...r.report.errors, ...r.report.warnings.slice(0, 5).map((w) => 'Warning: ' + w)] });
    if (r.ok) { setLib(await rebuildLibrary()); notify('Package imported'); }
    if (file.current) file.current.value = '';
  };
  return (
    <>
      <p className="muted">Content ships as RLF (RDev Learning Format) packages: versioned JSON with entries, sources and relationships, protected by a SHA-256 checksum. The highest version of each package wins.</p>
      <div className="pkg-grid">{lib.packages.map((p) => (
        <section className="panel" key={p.id}>
          <div className="card-top"><b>{p.title}</b><span className={`badge ${p.origin === 'bundled' ? 'badge-muted' : 'badge-ok'}`}>{p.origin}</span></div>
          <p className="muted small">{p.id} · v{p.version} · {p.entries} entries<br />checksum {p.checksum.slice(0, 16)}…{p.superseded.length ? <><br />Replaced: {p.superseded.join(', ')}</> : null}</p>
          {results[p.id] && <p className="small" role="status">{results[p.id]}</p>}
          <div className="btn-row">
            <button className="tool-btn" onClick={() => verify(p.id)}><Icon name="shield" size={15} /> Verify</button>
            <button className="tool-btn" onClick={() => downloadText(`${p.id}-${p.version}.rlf.json`, JSON.stringify(p.pkg, null, 2))}><Icon name="download" size={15} /> Export</button>
            {p.origin !== 'bundled' && <button className="tool-btn" onClick={async () => { await removeStored(p.id); setLib(await rebuildLibrary()); notify('Removed stored package'); }}><Icon name="trash" size={15} /> Remove</button>}
          </div>
        </section>))}</div>
      <section className="panel"><h2>Import a package</h2><p className="muted">Add an RLF package file (.rlf.json). It is validated first and stored only in this browser.</p>
        <input ref={file} type="file" accept=".json,application/json" aria-label="RLF package file" disabled={storage !== 'indexeddb'} onChange={(e) => onFile(e.target.files?.[0])} />
        {storage !== 'indexeddb' && <p className="small muted">Importing needs IndexedDB, which is unavailable here.</p>}
        {importMsg && <ul className={`findings`}>{importMsg.lines.map((l, i) => <li key={i} className={i === 0 ? (importMsg.ok ? 'f-info' : 'f-error') : 'f-warning'}><span>{l}</span></li>)}</ul>}
      </section>
    </>
  );
}

function Sources() {
  const { lib } = useApp();
  const list = [...lib.sources.values()].sort((a, b) => a.label.localeCompare(b.label));
  const counts = { retrieved: list.filter((s) => s.status === 'retrieved').length, unchecked: list.filter((s) => s.status === 'unchecked').length, failed: list.filter((s) => s.status === 'failed').length };
  return (
    <>
      <div className="info-strip"><Icon name="info" size={18} /><p>{counts.retrieved} retrieved, {counts.unchecked} not machine-checked, {counts.failed} failed. “Not machine-checked” means the platform has not yet fetched the page and recorded a content hash. It does not mean the link is broken, and no source is claimed as verified.</p></div>
      <ul className="source-table">{list.map((s) => (
        <li key={s.id}><a href={s.url} target="_blank" rel="noreferrer noopener" className="reference-link">{s.label}<Icon name="external" size={14} /></a>
          <small className="muted">{s.publisher} · {s.status === 'retrieved' ? `Retrieved ${fmtDate(s.retrievedAt)}` : s.status === 'failed' ? 'Retrieval failed' : 'Not machine-checked'} · {s.license ?? 'License not determined'} · used by {lib.entries.filter((e) => e.sourceIds.includes(s.id)).length} entries</small></li>))}</ul>
      <p className="muted small">Status labels used in this library: {Object.values(STATUS_LABEL).join(', ')}.</p>
    </>
  );
}

function Service() {
  const { platform, syncing, syncNow } = useApp();
  return (
    <div className="panel">
      <h2><Icon name={platform.state === 'online' ? 'wifi' : 'wifiOff'} size={20} /> {platform.state === 'online' ? 'Service reachable' : platform.state === 'unavailable' ? 'Service not reachable' : platform.state === 'checking' ? 'Checking…' : 'Not checked yet'}</h2>
      <p>{platform.detail}</p>
      <dl className="facts"><dt>Knowledge database configured</dt><dd>{platform.databaseConfigured ? 'Yes' : 'No'}</dd><dt>Database initialized</dt><dd>{platform.databaseReady ? 'Yes' : 'No'}</dd><dt>API version</dt><dd>{platform.apiVersion ?? 'unknown'}</dd><dt>Published packages on the service</dt><dd>{platform.published ?? 'unknown'}</dd><dt>Last checked</dt><dd>{platform.checkedAt ? new Date(platform.checkedAt).toLocaleString() : 'never'}</dd><dt>Updates applied</dt><dd>{platform.updated.length ? platform.updated.join(', ') : 'none'}</dd></dl>
      <p className="muted small">The service is optional and is checked in the background. It only provides content the owner has approved and published. Nothing about your learning activity is sent to it.</p>
      <div className="btn-row"><button className="primary-btn small" disabled={syncing} onClick={() => void syncNow()}><Icon name="refresh" size={15} /> {syncing ? 'Checking…' : 'Check for updates'}</button></div>
    </div>
  );
}
