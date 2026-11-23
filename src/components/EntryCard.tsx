import type { Entry } from '../types.ts';
import { STATUS_LABEL } from '../../shared/rlf.ts';
import { useActions } from '../app/helpers.tsx';
import { href } from '../app/router.ts';
import { Icon } from './Icon.tsx';

export function StatusBadges({ entry }: { entry: Entry }) {
  return (
    <span className="badges">
      <span className={`badge st-${entry.status}`}>{STATUS_LABEL[entry.status]}</span>
      {entry.origin === 'ai-assisted' && !entry.review && <span className="badge badge-muted" title="Written with AI assistance and not yet independently reviewed">AI-assisted · unreviewed</span>}
      {entry.status === 'verified' && entry.review && <span className="badge badge-ok">Reviewed by {entry.review.reviewer}</span>}
    </span>
  );
}

export function EntryCard({ entry, snippet }: { entry: Entry; snippet?: string }) {
  const { isBookmarked, toggleBookmark, isDone } = useActions();
  const marked = isBookmarked(entry.id);
  return (
    <article className="lesson-card">
      <div className="card-top">
        <span className="eyebrow">{entry.kind === 'reference' ? 'REFERENCE · ' : ''}{entry.category.toUpperCase()}</span>
        <button className={`icon-btn ${marked ? 'on' : ''}`} aria-pressed={marked} aria-label={marked ? `Remove bookmark: ${entry.title}` : `Bookmark: ${entry.title}`} onClick={() => toggleBookmark(entry.id)}><Icon name="bookmark" size={19} /></button>
      </div>
      <h3><a href={href('/lesson/' + entry.id)}>{entry.title}</a></h3>
      <p>{snippet ?? entry.summary}</p>
      <div className="card-meta">
        <span><Icon name="clock" size={14} /> {entry.minutes} min</span>
        <span className="level">{entry.level}</span>
        {isDone(entry.id) && <span className="done-tag"><Icon name="checkCircle" size={14} /> Done</span>}
      </div>
    </article>
  );
}
