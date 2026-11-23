import { PATHS } from '../../shared/paths.ts';
import { useApp } from '../app/context.tsx';
import { useActions, pct } from '../app/helpers.tsx';
import { href } from '../app/router.ts';
import { EntryCard } from '../components/EntryCard.tsx';
import { Icon } from '../components/Icon.tsx';
import { Logo } from '../components/Logo.tsx';
import { LibraryPreparing } from '../components/LibraryPreparing.tsx';

export function Home() {
  const { lib, state, platform } = useApp();
  const { lessons, doneCount, isDone } = useActions();
  const recent = state.recent.map((id) => lib.byId.get(id)).filter(Boolean) as typeof lessons;
  const resume = recent.find((e) => e.kind === 'lesson' && !isDone(e.id));
  // Next suggestions: lessons not completed whose prerequisites are all completed.
  const ready = lessons.filter((l) => !isDone(l.id) && l.prerequisites.every((p) => isDone(p) || !lib.byId.has(p)));
  const suggestions = ready.filter((l) => l.id !== resume?.id).slice(0, 3);
  const start = resume ?? suggestions[0] ?? lessons[0];
  const refs = lib.entries.filter((e) => e.kind === 'reference').length;
  const empty = lib.entries.length === 0;
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <span className="hero-pill"><Icon name="sparkles" size={13} /> YOUR DEVELOPMENT JOURNEY STARTS HERE</span>
          <h1>Build skills.<br /><em>Bring ideas to life.</em></h1>
          <p>A free, independent learning space for Roblox creators. Practical lessons, clear Luau, and references you can use while you build.</p>
          <div className="hero-actions">
            {start ? <a className="primary-btn" href={href('/lesson/' + start.id)}>{resume ? 'Continue learning' : doneCount ? 'Next lesson' : 'Start your first lesson'} <Icon name="chevR" size={17} /></a>
              : <a className="primary-btn" href={href('/playground')}>Open the Code Playground <Icon name="chevR" size={17} /></a>}
            {!empty && <a className="quiet-btn" href={href('/paths')}>Browse learning paths</a>}
          </div>
          <div className="hero-note"><Icon name="shield" size={15} /> No account. No paywall. Progress stays in this browser.</div>
        </div>
        <div className="hero-art" aria-hidden="true"><Logo size={190} animated /></div>
      </section>

      {empty ? <LibraryPreparing /> : <>
      <section className="quick-stats" aria-label="Library overview">
        <div><span className="stat-icon"><Icon name="book" /></span><strong>{lessons.length}</strong><small>Lessons</small></div>
        <div><span className="stat-icon"><Icon name="file" /></span><strong>{refs}</strong><small>Reference pages</small></div>
        <div><span className="stat-icon"><Icon name="checkCircle" /></span><strong>{doneCount}</strong><small>Completed by you</small></div>
        <div><span className="stat-icon"><Icon name="bookmark" /></span><strong>{state.bookmarks.length}</strong><small>Your bookmarks</small></div>
      </section>

      {(resume || suggestions.length > 0) && (
        <section className="section-block">
          <div className="section-title"><div><span className="eyebrow">{resume ? 'PICK UP WHERE YOU LEFT OFF' : 'RECOMMENDED NEXT'}</span><h2>{resume ? 'Continue' : 'Good next lessons'}</h2></div></div>
          <div className="lesson-grid">{(resume ? [resume, ...suggestions.slice(0, 2)] : suggestions).map((e) => <EntryCard key={e.id} entry={e} />)}</div>
        </section>
      )}

      <section className="section-block">
        <div className="section-title"><div><span className="eyebrow">YOUR ROADMAP</span><h2>Learning paths</h2></div><a className="text-action" href={href('/paths')}>All paths <Icon name="chevR" size={15} /></a></div>
        <div className="path-grid">
          {PATHS.map((p, i) => {
            const items = lessons.filter((l) => l.path === p.name); const done = items.filter((l) => isDone(l.id)).length;
            return (
              <a className="path-card" key={p.slug} href={href('/paths/' + p.slug)}>
                <span className={`path-icon tone-${i % 4}`}><Icon name={p.icon} size={22} /></span>
                <span className="path-card-body"><b>{p.name}</b><small>{done} of {items.length} lessons done</small><span className="mini-bar"><i style={{ width: pct(done, items.length) + '%' }} /></span></span>
                <Icon name="chevR" size={17} />
              </a>
            );
          })}
        </div>
      </section>

      {recent.length > 0 && (
        <section className="section-block">
          <div className="section-title"><div><span className="eyebrow">RECENTLY OPENED</span><h2>Recent</h2></div></div>
          <div className="chip-row">{recent.slice(0, 6).map((e) => <a key={e.id} className="chip" href={href('/lesson/' + e.id)}>{e.title}</a>)}</div>
        </section>
      )}

      </>}

      <section className="bottom-banner">
        <div className="banner-icon"><Icon name={platform.state === 'online' ? 'wifi' : 'wifiOff'} size={22} /></div>
        <div><b>{lib.packages.length ? `${lib.packages.length} knowledge package${lib.packages.length === 1 ? '' : 's'} loaded` : 'Knowledge library'}</b><p>{platform.state === 'online' || platform.state === 'checking' ? platform.detail : platform.state === 'unavailable' ? 'The knowledge service could not be reached. Everything you see comes from content already on this device, and learning does not depend on the service.' : 'Checking the knowledge service in the background…'}</p></div>
        <a className="quiet-btn" href={href('/explorer', { tab: 'packages' })}>Details <Icon name="chevR" size={15} /></a>
      </section>
    </>
  );
}

