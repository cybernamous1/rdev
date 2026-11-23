import { PATHS } from '../../shared/paths.ts';
import { useApp } from '../app/context.tsx';
import { href, replace, type Route } from '../app/router.ts';
import { EntryCard } from '../components/EntryCard.tsx';
import { LibraryPreparing } from '../components/LibraryPreparing.tsx';

export function Docs({ route }: { route: Route }) {
  const { lib } = useApp();
  const kind = route.params.get('kind') || 'all';
  if (lib.entries.length === 0) return <><div className="page-heading"><span className="eyebrow">THE KNOWLEDGE LIBRARY</span><h1>Documentation</h1></div><LibraryPreparing /></>;
  const path = route.params.get('path') || '';
  const level = route.params.get('level') || '';
  const tag = route.params.get('tag') || '';
  const set = (k: string, v: string) => { const p = Object.fromEntries(route.params.entries()); if (v) p[k] = v; else delete p[k]; replace('/docs', p); };
  const list = lib.entries.filter((e) => (kind === 'all' || e.kind === kind) && (!path || e.path === path) && (!level || e.level === level) && (!tag || e.tags.includes(tag)))
    .sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind) || a.order - b.order);
  const groups = PATHS.map((p) => ({ p, items: list.filter((e) => e.path === p.name) })).filter((g) => g.items.length);
  return (
    <>
      <div className="page-heading"><span className="eyebrow">THE KNOWLEDGE LIBRARY</span><h1>Documentation</h1><p>Written lessons and quick references. Use the filters to narrow things down, or <a href={href('/search')}>search everything</a>.</p></div>
      <div className="filters" role="group" aria-label="Filters">
        <div className="segmented">{[['all', 'All'], ['lesson', 'Lessons'], ['reference', 'References']].map(([v, l]) => <button key={v} className={kind === v ? 'active' : ''} onClick={() => set('kind', v === 'all' ? '' : v)}>{l}</button>)}</div>
        <select aria-label="Learning path" value={path} onChange={(e) => set('path', e.target.value)}><option value="">All paths</option>{PATHS.map((p) => <option key={p.slug} value={p.name}>{p.name}</option>)}</select>
        <select aria-label="Level" value={level} onChange={(e) => set('level', e.target.value)}><option value="">All levels</option><option>Beginner</option><option>Intermediate</option><option>Advanced</option></select>
        {tag && <button className="chip chip-on" onClick={() => set('tag', '')}>Topic: {tag} ✕</button>}
      </div>
      <div className="results-caption">{list.length} item{list.length === 1 ? '' : 's'}</div>
      {groups.length === 0 && <div className="empty-state"><h3>Nothing matches these filters</h3><p>Try removing a filter.</p></div>}
      {groups.map(({ p, items }) => (
        <section key={p.slug} className="section-block tight"><h2 className="sub-h">{p.name}</h2><div className="lesson-grid">{items.map((e) => <EntryCard key={e.id} entry={e} />)}</div></section>
      ))}
    </>
  );
}
