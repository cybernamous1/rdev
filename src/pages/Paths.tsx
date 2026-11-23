import { PATHS, pathBySlug } from '../../shared/paths.ts';
import { useApp } from '../app/context.tsx';
import { useActions, pct } from '../app/helpers.tsx';
import { href, type Route } from '../app/router.ts';
import { EntryCard } from '../components/EntryCard.tsx';
import { Icon } from '../components/Icon.tsx';
import { LibraryPreparing } from '../components/LibraryPreparing.tsx';

export function Paths() {
  const { lib } = useApp();
  const { isDone } = useActions();
  if (lib.entries.length === 0) return <><div className="page-heading"><span className="eyebrow">YOUR ROADMAP</span><h1>Learning paths</h1></div><LibraryPreparing /></>;
  return (
    <>
      <div className="page-heading"><span className="eyebrow">YOUR ROADMAP</span><h1>Learning paths</h1><p>Each path is an ordered set of lessons plus quick references. Move between paths whenever you like.</p></div>
      <div className="path-list">
        {PATHS.map((p, i) => {
          const lessons = lib.entries.filter((e) => e.path === p.name && e.kind === 'lesson'); const done = lessons.filter((l) => isDone(l.id)).length;
          return (
            <a className="path-row" key={p.slug} href={href('/paths/' + p.slug)}>
              <div className={`path-icon tone-${i % 4}`}><Icon name={p.icon} size={22} /></div>
              <div className="path-info"><h3>{p.name}</h3><p>{p.blurb}</p><span className="mini-bar"><i style={{ width: pct(done, lessons.length) + '%' }} /></span></div>
              <span className="path-count">{done}/{lessons.length}</span><Icon name="chevR" size={18} />
            </a>
          );
        })}
      </div>
    </>
  );
}

export function PathDetail({ route }: { route: Route }) {
  const { lib } = useApp();
  const { isDone } = useActions();
  const info = pathBySlug(route.segments[1]);
  if (lib.entries.length === 0) return <LibraryPreparing />;
  if (!info) return <NotFound what="learning path" />;
  const all = lib.entries.filter((e) => e.path === info.name);
  const lessons = all.filter((e) => e.kind === 'lesson').sort((a, b) => a.order - b.order);
  const refs = all.filter((e) => e.kind === 'reference');
  const done = lessons.filter((l) => isDone(l.id)).length;
  return (
    <>
      <a className="back-link" href={href('/paths')}>← All paths</a>
      <div className="page-heading"><span className="eyebrow">LEARNING PATH</span><h1>{info.name}</h1><p>{info.blurb}</p>
        <div className="progress-line wide"><i style={{ width: pct(done, lessons.length) + '%' }} /></div><small className="muted">{done} of {lessons.length} lessons completed</small></div>
      <ol className="lesson-steps">
        {lessons.map((l, i) => {
          const missing = l.prerequisites.filter((p) => lib.byId.has(p) && !isDone(p));
          return (
            <li key={l.id} className={isDone(l.id) ? 'done' : ''}>
              <span className="step-num">{isDone(l.id) ? <Icon name="check" size={15} /> : i + 1}</span>
              <div><a href={href('/lesson/' + l.id)}><b>{l.title}</b></a><p>{l.summary}</p>
                <small className="muted">{l.level} · {l.minutes} min{missing.length ? ` · Suggested first: ${missing.map((m) => lib.byId.get(m)!.title).join(', ')}` : ''}</small></div>
            </li>
          );
        })}
      </ol>
      {refs.length > 0 && <><h2 className="sub-h">Quick references for this path</h2><div className="lesson-grid">{refs.map((e) => <EntryCard key={e.id} entry={e} />)}</div></>}
    </>
  );
}

export function NotFound({ what = 'page' }: { what?: string }) {
  return <div className="empty-state"><Icon name="search" size={30} /><h3>That {what} was not found</h3><p>The link may be outdated, or the content may not be in this library version.</p><a className="primary-btn" href={href('/home')}>Go home</a></div>;
}
