import { useEffect, useMemo, useRef, useState } from 'react';
import { PATHS } from '../../shared/paths.ts';
import { search } from '../../shared/search.ts';
import { useApp } from '../app/context.tsx';
import { replace, type Route } from '../app/router.ts';
import { EntryCard } from '../components/EntryCard.tsx';
import { Icon } from '../components/Icon.tsx';
import { LibraryPreparing } from '../components/LibraryPreparing.tsx';

export function Search({ route }: { route: Route }) {
  const { lib } = useApp();
  const q = route.params.get('q') || '';
  const kind = route.params.get('kind') || '';
  const path = route.params.get('path') || '';
  const [text, setText] = useState(q);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { const t = setTimeout(() => { if (text !== q) replace('/search', { q: text || undefined, kind: kind || undefined, path: path || undefined }); }, 200); return () => clearTimeout(t); }, [text]);
  const hits = useMemo(() => search(lib.index, q, 60).filter((h) => (!kind || h.entry.kind === kind) && (!path || h.entry.path === path)), [lib, q, kind, path]);
  const topTags = useMemo(() => [...lib.tags.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 14), [lib]);
  const set = (k: string, v: string) => replace('/search', { q: q || undefined, kind, path, [k]: v || undefined });
  if (lib.entries.length === 0) return <><div className="page-heading"><span className="eyebrow">FIND A TOPIC</span><h1>Search the academy</h1></div><LibraryPreparing /></>;
  return (
    <>
      <div className="page-heading"><span className="eyebrow">FIND A TOPIC</span><h1>Search the academy</h1><p>Searches titles, topics, headings, explanations and code across every loaded package. It runs on your device.</p></div>
      <div className="search-field large"><Icon name="search" size={19} /><input ref={input} value={text} onChange={(e) => setText(e.target.value)} placeholder="Try: remote event, tween, datastore, UIListLayout…" aria-label="Search" type="search" enterKeyHint="search" autoComplete="off" />{text && <button aria-label="Clear search" onClick={() => setText('')}><Icon name="x" size={16} /></button>}</div>
      <div className="filters">
        <select aria-label="Type" value={kind} onChange={(e) => set('kind', e.target.value)}><option value="">Lessons and references</option><option value="lesson">Lessons only</option><option value="reference">References only</option></select>
        <select aria-label="Learning path" value={path} onChange={(e) => set('path', e.target.value)}><option value="">All paths</option>{PATHS.map((p) => <option key={p.slug} value={p.name}>{p.name}</option>)}</select>
      </div>
      {!q && <><div className="results-caption">Popular topics</div><div className="chip-row">{topTags.map(([t, n]) => <button key={t} className="chip" onClick={() => setText(t)}>{t} <small>{n}</small></button>)}</div></>}
      {q && <div className="results-caption" aria-live="polite">{hits.length} result{hits.length === 1 ? '' : 's'} for “{q}”</div>}
      {q && hits.length === 0 && <div className="empty-state"><Icon name="search" size={28} /><h3>No matches</h3><p>Try fewer or different words, for example a service or class name such as “TweenService”.</p></div>}
      <div className="lesson-grid">{hits.map((h) => <EntryCard key={h.entry.id} entry={h.entry} snippet={h.snippet} />)}</div>
    </>
  );
}
