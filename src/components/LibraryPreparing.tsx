// Honest empty state shown while no approved content has been published. Styled with Tailwind CSS v4 utilities.
import { useApp } from '../app/context.tsx';
import { href } from '../app/router.ts';
import { Icon } from './Icon.tsx';

export function LibraryPreparing({ compact = false }: { compact?: boolean }) {
  const { platform, syncing, syncNow } = useApp();
  const checking = syncing || platform.state === 'checking';
  return (
    <section aria-labelledby="prep-title" className={`mx-auto w-full max-w-2xl rounded-2xl border border-dashed p-6 text-center sm:p-10 ${compact ? 'my-4' : 'my-8'}`} style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}>
      <div className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl" style={{ background: 'var(--soft)', color: 'var(--accent)' }}><Icon name="layers" size={28} /></div>
      <h2 id="prep-title" className="text-xl font-bold tracking-tight">The library is being prepared</h2>
      <p className="mx-auto mt-3 max-w-prose text-[0.95rem] leading-relaxed" style={{ color: 'var(--muted)' }}>
        Lessons and references appear here only after the project owner has reviewed and approved them. Nothing is shown until then, so what you read is what was signed off.
      </p>
      <ul className="mx-auto mt-5 grid max-w-sm gap-2 text-left text-sm" style={{ color: 'var(--muted)' }}>
        <li className="flex gap-2"><Icon name="checkCircle" size={16} className="mt-0.5 shrink-0" /><span>No account is needed, now or later.</span></li>
        <li className="flex gap-2"><Icon name="checkCircle" size={16} className="mt-0.5 shrink-0" /><span>Your settings, notes and progress stay in this browser.</span></li>
        <li className="flex gap-2"><Icon name="checkCircle" size={16} className="mt-0.5 shrink-0" /><span>The Code Playground and all settings already work.</span></li>
      </ul>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <a className="primary-btn" href={href('/playground')}><Icon name="code" size={16} /> Open the Code Playground</a>
        <button className="quiet-btn" onClick={() => void syncNow()} disabled={checking}><Icon name="refresh" size={16} /> {checking ? 'Checking…' : 'Check for published content'}</button>
      </div>
      <p className="mt-4 text-xs" role="status" style={{ color: 'var(--muted)' }}>
        {platform.state === 'online' ? platform.detail : platform.state === 'unavailable' ? 'The knowledge service could not be reached, so nothing new could be checked.' : 'Checking the knowledge service in the background…'}
      </p>
    </section>
  );
}
