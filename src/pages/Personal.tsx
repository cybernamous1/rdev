import { useRef, useState, type CSSProperties } from 'react';
import { PATHS } from '../../shared/paths.ts';
import { useApp } from '../app/context.tsx';
import { fmtDate, pct, useActions, useNotify } from '../app/helpers.tsx';
import { href, navigate, type Route } from '../app/router.ts';
import { EntryCard } from '../components/EntryCard.tsx';
import { Icon } from '../components/Icon.tsx';
import { LibraryPreparing } from '../components/LibraryPreparing.tsx';
import { POLICIES, NOTE } from '../data/policies.ts';
import { normalizeState, clearAllLocalData, defaultState } from '../services/localData.ts';
import { downloadText, rebuildLibrary } from '../services/packages.ts';
import { NotFound } from './Paths.tsx';

export function Bookmarks() {
  const { lib, state } = useApp();
  const list = state.bookmarks.map((id) => lib.byId.get(id)).filter(Boolean) as typeof lib.entries;
  if (lib.entries.length === 0) return <><div className="page-heading"><span className="eyebrow">YOUR LIBRARY</span><h1>Bookmarks</h1></div><LibraryPreparing /></>;
  return (
    <>
      <div className="page-heading"><span className="eyebrow">YOUR LIBRARY</span><h1>Bookmarks</h1><p>Lessons and references you saved in this browser.</p></div>
      {list.length === 0 ? <div className="empty-state"><Icon name="bookmark" size={30} /><h3>No bookmarks yet</h3><p>Tap the bookmark icon on any lesson to keep it close.</p><a className="primary-btn" href={href('/docs')}>Explore documentation</a></div>
        : <div className="lesson-grid">{list.map((e) => <EntryCard key={e.id} entry={e} />)}</div>}
    </>
  );
}

export function Progress() {
  const { lib, state } = useApp();
  const { lessons, doneCount, isDone } = useActions();
  const p = pct(doneCount, lessons.length);
  const done = lessons.filter((l) => isDone(l.id)).sort((a, b) => (state.completed[b.id] || '').localeCompare(state.completed[a.id] || ''));
  const withNotes = Object.keys(state.notes).map((id) => lib.byId.get(id)).filter(Boolean) as typeof lib.entries;
  if (lib.entries.length === 0) return <><div className="page-heading"><span className="eyebrow">YOUR JOURNEY</span><h1>Learning progress</h1></div><LibraryPreparing /></>;
  return (
    <>
      <div className="page-heading"><span className="eyebrow">YOUR JOURNEY</span><h1>Learning progress</h1><p>An overview of what you have marked complete on this device.</p></div>
      <div className="progress-overview"><div><span className="eyebrow">ALL LESSONS</span><strong>{p}%</strong><p>{doneCount} of {lessons.length} lessons completed</p><div className="progress-line wide"><i style={{ width: p + '%' }} /></div></div><div className="progress-ring" style={{ '--p': p + '%' } as CSSProperties}><span>{doneCount}<small>/ {lessons.length}</small></span></div></div>
      <h2 className="sub-h">By path</h2>
      <div className="progress-list">{PATHS.map((path) => { const ls = lessons.filter((l) => l.path === path.name); const d = ls.filter((l) => isDone(l.id)).length; return (
        <a key={path.slug} href={href('/paths/' + path.slug)}><span className="check-circle"><Icon name={path.icon} size={18} /></span><span className="grow"><b>{path.name}</b><span className="mini-bar"><i style={{ width: pct(d, ls.length) + '%' }} /></span></span><span className="count">{d}/{ls.length}</span></a>); })}</div>
      {done.length > 0 && <><h2 className="sub-h">Completed</h2><div className="progress-list">{done.map((l) => <a key={l.id} href={href('/lesson/' + l.id)}><span className="check-circle"><Icon name="checkCircle" size={18} /></span><span className="grow"><b>{l.title}</b><small>{l.path}</small></span><span className="count">{state.completed[l.id] ? fmtDate(state.completed[l.id]) : ''}</span></a>)}</div></>}
      {withNotes.length > 0 && <><h2 className="sub-h">Lessons with your notes</h2><div className="chip-row">{withNotes.map((e) => <a key={e.id} className="chip" href={href('/lesson/' + e.id)}>{e.title}</a>)}</div></>}
      <p className="storage-note">Progress is stored in this browser only. It does not sync across devices and may be lost if browser data is cleared. Use Settings → Export to keep a backup.</p>
    </>
  );
}

const THEMES = [['sovereign', 'Sovereign', 'Navy · emerald'], ['obsidian', 'Obsidian', 'Charcoal · violet'], ['oceanic', 'Oceanic', 'Midnight · blue'], ['nebula', 'Nebula', 'Cosmic · magenta'], ['arctic', 'Arctic', 'Light · teal'], ['heritage', 'Heritage', 'Cream · bronze']];

export function Settings() {
  const { state, update, storage, notices, platform, lib, setLib } = useApp();
  const notify = useNotify();
  const file = useRef<HTMLInputElement>(null);
  const [persist, setPersist] = useState<string>('');
  const set = <K extends keyof typeof state>(k: K, v: (typeof state)[K]) => update((s) => ({ ...s, [k]: v }));
  const exportData = () => downloadText('rdev-academy-backup.json', JSON.stringify({ app: 'rdev-academy', exportedAt: new Date().toISOString(), data: state }, null, 2));
  const importData = async (f?: File) => {
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      if (j?.app !== 'rdev-academy' || !j.data) throw new Error('Not an RDev Academy backup file.');
      update(() => normalizeState(j.data)); notify('Backup restored');
    } catch (e) { notify((e as Error).message); }
    if (file.current) file.current.value = '';
  };
  const askPersist = async () => {
    if (!navigator.storage?.persist) return setPersist('This browser does not support requesting persistent storage.');
    setPersist((await navigator.storage.persist()) ? 'Persistent storage granted. The browser is less likely to clear your data.' : 'The browser did not grant persistent storage. Export a backup to be safe.');
  };
  return (
    <>
      <div className="page-heading"><span className="eyebrow">MAKE IT YOURS</span><h1>Settings</h1><p>Appearance and local data for this device.</p></div>
      <section className="settings-section"><h2>Theme</h2><p>Six themes. Your choice is saved in this browser.</p>
        <div className="theme-grid">{THEMES.map(([id, name, desc]) => <button key={id} className={`theme-card ${state.theme === id ? 'active' : ''}`} aria-pressed={state.theme === id} onClick={() => set('theme', id)}><span className={`theme-swatch ${id}`}><i /><i /><i /></span><b>{name}</b><small>{desc}</small>{state.theme === id && <Icon name="checkCircle" size={16} />}</button>)}</div></section>
      <section className="settings-section"><h2>Text size</h2><div className="segmented">{[[0.9, 'Small'], [1, 'Default'], [1.15, 'Large'], [1.3, 'Largest']].map(([v, l]) => <button key={String(v)} className={state.fontScale === v ? 'active' : ''} onClick={() => set('fontScale', v as number)}>{l}</button>)}</div></section>
      <section className="settings-section"><h2>Layout density</h2><div className="segmented">{(['comfortable', 'compact'] as const).map((d) => <button key={d} className={state.density === d ? 'active' : ''} onClick={() => set('density', d)}>{d === 'comfortable' ? 'Comfortable' : 'Compact'}</button>)}</div></section>
      <section className="settings-section"><h2>Motion</h2><label className="toggle-row"><span>Reduce animation<small>Also follows your device’s reduced-motion setting automatically.</small></span><input type="checkbox" checked={state.reducedMotion} onChange={(e) => set('reducedMotion', e.target.checked)} /></label></section>
      <section className="settings-section"><h2>Your data</h2><p>Stored in this browser ({storage === 'indexeddb' ? 'IndexedDB' : storage === 'localstorage' ? 'localStorage fallback' : 'memory only — not saved'}): {Object.keys(state.completed).length} completed, {state.bookmarks.length} bookmarks, {Object.keys(state.notes).length} notes, {state.snippets.length} snippets.</p>
        <div className="btn-row"><button className="tool-btn" onClick={exportData}><Icon name="download" size={15} /> Export backup</button><label className="tool-btn file-btn"><Icon name="upload" size={15} /> Restore backup<input ref={file} type="file" accept=".json,application/json" onChange={(e) => importData(e.target.files?.[0])} /></label><button className="tool-btn" onClick={askPersist}><Icon name="lock" size={15} /> Request persistent storage</button></div>
        {persist && <p className="small" role="status">{persist}</p>}
        <div className="btn-row danger-row"><button className="danger-quiet" onClick={() => { if (confirm('Clear bookmarks, progress, notes and snippets? This cannot be undone.')) update((s) => ({ ...defaultState(), theme: s.theme, density: s.density, reducedMotion: s.reducedMotion, fontScale: s.fontScale })); }}>Clear progress and notes</button>
          <button className="danger-quiet" onClick={async () => { if (confirm('Delete ALL data stored by RDev Academy in this browser, including downloaded packages?')) { await clearAllLocalData(); update(() => defaultState()); setLib(await rebuildLibrary()); notify('All local data deleted'); } }}>Delete all local data</button></div></section>
      <section className="settings-section"><h2>Diagnostics</h2>
        <dl className="facts"><dt>App version</dt><dd>0.3.0</dd><dt>Library</dt><dd>{lib.entries.length} entries in {lib.packages.length} packages</dd><dt>Knowledge service</dt><dd>{platform.state}</dd><dt>Storage</dt><dd>{storage}</dd></dl>
        {notices.length > 0 ? <><b className="small">Startup notes</b><ul className="findings">{notices.map((n, i) => <li key={i} className="f-warning"><span>{n}</span></li>)}</ul></> : <p className="muted small">No startup problems were reported.</p>}</section>
    </>
  );
}

export function About({ route }: { route: Route }) {
  const slug = route.segments[1];
  const policy = POLICIES.find((p) => p.slug === slug);
  return (
    <>
      <div className="page-heading"><span className="eyebrow">ABOUT THE PROJECT</span><h1>Create. Learn. Develop.</h1><p>RDev Academy is an independent, free learning hub for people exploring Roblox development.</p></div>
      <div className="about-panel"><h2>Learning should be open to everyone.</h2><p>Written lessons, code examples, practical exercises and references to help creators build skills at their own pace.</p>
        <div className="about-points"><span><Icon name="checkCircle" size={14} /> Free public learning</span><span><Icon name="checkCircle" size={14} /> No account, ever</span><span><Icon name="checkCircle" size={14} /> Progress stays in your browser</span><span><Icon name="checkCircle" size={14} /> No external AI services</span></div></div>
      <div className="legal-list"><h2>Project information</h2>
        <p>RDev Academy is an independent project. It is not affiliated with, endorsed by, or operated by Roblox Corporation. Roblox and related marks belong to their respective owners.</p>
        <div className="repo-placeholder">Repository link will be added when the project repository is available.</div>
        <h2>Legal & policies</h2>
        {POLICIES.map((p) => <a key={p.slug} className="legal-item" href={href('/about/' + p.slug)}>{p.title}<Icon name="chevR" size={16} /></a>)}</div>
      {slug && !policy && <NotFound what="policy" />}
      {policy && <div className="modal-backdrop" onClick={() => navigate('/about')}><section className="policy-modal" role="dialog" aria-modal="true" aria-labelledby="pol-t" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn modal-close" aria-label="Close" onClick={() => navigate('/about')} autoFocus><Icon name="x" /></button>
        <span className="eyebrow">POLICY CENTER</span><h2 id="pol-t">{policy.title}</h2>{policy.body.map((b, i) => <p key={i}>{b}</p>)}<p className="policy-note">{NOTE}</p></section></div>}
    </>
  );
}
