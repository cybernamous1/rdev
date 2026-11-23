import { useEffect, useRef, useState } from 'react';
import { useApp } from '../app/context.tsx';
import { fmtDate, useActions } from '../app/helpers.tsx';
import { href, type Route } from '../app/router.ts';
import { Blocks } from '../components/Rich.tsx';
import { Icon } from '../components/Icon.tsx';
import { StatusBadges, EntryCard } from '../components/EntryCard.tsx';
import { relatedTo } from '../services/library.ts';
import { LibraryPreparing } from '../components/LibraryPreparing.tsx';
import { NotFound } from './Paths.tsx';

export function Lesson({ route }: { route: Route }) {
  const { lib, state, update } = useApp();
  const act = useActions();
  const id = route.segments[1];
  const entry = lib.byId.get(id);
  const [note, setNote] = useState(state.notes[id] || '');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => { setNote(state.notes[id] || ''); }, [id]);
  useEffect(() => {
    if (!entry) return;
    update((s) => ({ ...s, recent: [id, ...s.recent.filter((x) => x !== id)].slice(0, 8) }));
  }, [id, !!entry]);
  useEffect(() => () => clearTimeout(timer.current), []);

  if (!entry) return lib.entries.length === 0 ? <LibraryPreparing /> : <NotFound what="lesson" />;
  const onNote = (v: string) => {
    setNote(v); clearTimeout(timer.current);
    timer.current = setTimeout(() => update((s) => { const notes = { ...s.notes }; if (v.trim()) notes[id] = v; else delete notes[id]; return { ...s, notes }; }), 400);
  };
  const prereqs = entry.prerequisites.map((p) => lib.byId.get(p)).filter(Boolean) as typeof lib.entries;
  const next = relatedTo(lib, id, 'next')[0]; const prev = relatedTo(lib, id, 'next', 'in')[0];
  const related = relatedTo(lib, id, 'related').slice(0, 3);
  const unlocks = relatedTo(lib, id, 'prerequisite', 'in');
  const toc = entry.blocks.filter((b) => b.type === 'h' && b.level === 2) as { type: 'h'; text: string }[];
  const done = act.isDone(id); const marked = act.isBookmarked(id);
  return (
    <>
      <a className="back-link" href={href('/docs')}>← Documentation</a>
      <div className="lesson-layout">
        <article className="lesson-article">
          <div className="lesson-labels"><span className="eyebrow">{entry.kind === 'reference' ? 'REFERENCE' : 'LESSON'} · {entry.category.toUpperCase()}</span><span className="level">{entry.level}</span><span><Icon name="clock" size={14} /> {entry.minutes} min</span></div>
          <h1>{entry.title}</h1>
          <p className="lesson-lead">{entry.summary}</p>
          <StatusBadges entry={entry} />
          {entry.objectives.length > 0 && <div className="objectives"><b>What you’ll learn</b>{entry.objectives.map((o) => <span key={o}><Icon name="checkCircle" size={15} />{o}</span>)}</div>}
          {prereqs.length > 0 && <p className="prereq">Helpful first: {prereqs.map((p, i) => <span key={p.id}>{i > 0 && ', '}<a href={href('/lesson/' + p.id)}>{p.title}</a>{act.isDone(p.id) ? ' ✓' : ''}</span>)}</p>}
          <Blocks blocks={entry.blocks} onCopy={act.copy} onOpen={act.openInPlayground} />

          <section className="notes-box"><h3>Your notes</h3><p className="muted">Saved only in this browser.</p>
            <textarea aria-label="Your notes for this lesson" value={note} onChange={(e) => onNote(e.target.value)} placeholder="Write down questions, tips or things to try…" rows={4} /></section>

          <h3>Sources</h3>
          <ul className="source-list">{entry.sourceIds.map((sid) => {
            const s = lib.sources.get(sid); if (!s) return null;
            return <li key={sid}><a className="reference-link" href={s.url} target="_blank" rel="noreferrer noopener">{s.label}<Icon name="external" size={14} /></a>
              <small className="muted">{s.publisher} · {s.status === 'retrieved' ? `Retrieved ${fmtDate(s.retrievedAt)}` : s.status === 'failed' ? 'Last retrieval failed' : 'Link not machine-checked'} · {s.license ? `License: ${s.license}` : 'License not determined'}</small></li>;
          })}</ul>
          <p className="muted small">Explanations are written for RDev Academy. Linked sources belong to their owners. Check current official documentation before relying on a detail in production.</p>

          <div className="lesson-footer">
            <span>Content v{entry.version} · updated {fmtDate(entry.updatedAt)}</span>
            <button className={done ? 'quiet-btn done' : 'primary-btn'} onClick={() => act.setDone(id, !done)}>{done ? <><Icon name="check" size={16} /> Completed · undo</> : 'Mark as completed'}</button>
          </div>
          <div className="pager">
            {prev ? <a href={href('/lesson/' + prev.id)}><small>Previous</small><b>← {prev.title}</b></a> : <span />}
            {next ? <a className="next" href={href('/lesson/' + next.id)}><small>Next</small><b>{next.title} →</b></a> : <span />}
          </div>
        </article>
        <aside className="lesson-aside">
          <div className="aside-card">
            <button onClick={() => act.toggleBookmark(id)} className={marked ? 'on' : ''}><Icon name="bookmark" size={16} /> {marked ? 'Saved to bookmarks' : 'Save lesson'}</button>
            <div className="aside-divider" />
            <span className="muted">Progress</span>
            <div className="progress-line"><i style={{ width: done ? '100%' : '0%' }} /></div>
            <small>{done ? `Completed ${fmtDate(state.completed[id])}` : 'Not completed yet'}</small>
          </div>
          {toc.length > 1 && <div className="aside-card"><b>On this page</b><ul className="toc">{toc.map((t) => <li key={t.text}><a href={'#/lesson/' + id + '?s=' + encodeURIComponent(t.text)} onClick={(e) => { e.preventDefault(); document.getElementById(t.text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))?.scrollIntoView({ behavior: 'smooth' }); }}>{t.text}</a></li>)}</ul></div>}
          {unlocks.length > 0 && <div className="aside-card"><b>Leads to</b><ul className="toc">{unlocks.map((u) => <li key={u.id}><a href={href('/lesson/' + u.id)}>{u.title}</a></li>)}</ul></div>}
        </aside>
      </div>
      {related.length > 0 && <section className="section-block"><h2 className="sub-h">Related</h2><div className="lesson-grid">{related.map((e) => <EntryCard key={e.id} entry={e} />)}</div></section>}
    </>
  );
}
