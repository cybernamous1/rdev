import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../components/Icon.tsx';
import { Logo } from '../components/Logo.tsx';
import { href, navigate, type Route } from './router.ts';
import { useApp } from './context.tsx';

const NAV = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'paths', label: 'Learning Paths', icon: 'compass' },
  { id: 'docs', label: 'Documentation', icon: 'book' },
  { id: 'search', label: 'Search', icon: 'search' },
  { id: 'playground', label: 'Code Playground', icon: 'code' },
  { id: 'explorer', label: 'Knowledge Explorer', icon: 'database' },
  { id: 'bookmarks', label: 'Bookmarks', icon: 'bookmark' },
  { id: 'progress', label: 'Learning Progress', icon: 'checkCircle' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
  { id: 'about', label: 'About & Policies', icon: 'info' }
];
const BOTTOM = ['home', 'paths', 'search', 'playground'];

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const { state, lib, platform, storage, saveError } = useApp();
  const [open, setOpen] = useState(false);
  const main = useRef<HTMLElement>(null);
  const current = route.segments[0] === 'lesson' ? 'docs' : route.segments[0] || 'home';

  useEffect(() => { setOpen(false); main.current?.focus({ preventScroll: true }); window.scrollTo(0, 0); }, [route.raw.split('?')[0]]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(t.tagName) && !t.isContentEditable) { e.preventDefault(); navigate('/search'); }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, []);

  const svc = platform.state === 'online' ? (platform.databaseReady ? 'Knowledge service connected' : 'Service online, database not set up') : platform.state === 'unavailable' ? 'Offline · using content on this device' : 'Checking for updates…';
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">Skip to content</a>
      <aside className={`sidebar ${open ? 'show' : ''}`} aria-label="Primary">
        <div className="brand">
          <Logo size={38} />
          <div><strong>RDev <span>Academy</span></strong><small>Create. Learn. Develop.</small></div>
          <button className="icon-btn close-mobile" onClick={() => setOpen(false)} aria-label="Close navigation"><Icon name="x" /></button>
        </div>
        <nav>
          {NAV.map((n) => (
            <a key={n.id} href={href('/' + n.id)} className={`nav-item ${current === n.id ? 'selected' : ''}`} aria-current={current === n.id ? 'page' : undefined}>
              <Icon name={n.icon} /><span>{n.label}</span>
              {n.id === 'bookmarks' && state.bookmarks.length > 0 && <small>{state.bookmarks.length}</small>}
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="mini-status"><span className={`status-dot ${platform.state === 'online' ? '' : 'off'}`} /><span>{svc}</span></div>
          <p>{lib.entries.length ? `${lib.entries.length} entries · ${lib.packages.length} packages` : 'Library being prepared'} · Free, no account</p>
        </div>
      </aside>
      {open && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setOpen(false)} />}
      <div className="main-area">
        <header className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setOpen(true)} aria-label="Open navigation"><Icon name="menu" size={22} /></button>
          <a className="top-brand" href={href('/home')}><Logo size={28} /><b>RDev Academy</b></a>
          <a className="search-trigger" href={href('/search')}><Icon name="search" size={17} /><span>Search lessons and docs</span><kbd>/</kbd></a>
          <a className="icon-btn search-icon" href={href('/search')} aria-label="Search"><Icon name="search" size={21} /></a>
        </header>
        {(saveError || storage !== 'indexeddb') && (
          <div className="banner-warn" role="alert"><Icon name="alert" size={16} /> {saveError ? 'Your browser is blocking storage, so progress will be lost when you close this page.' : 'Using simplified browser storage; progress is still saved on this device.'}</div>
        )}
        <main id="main" className="content" tabIndex={-1} ref={main}>{children}</main>
      </div>
      <nav className="bottom-nav" aria-label="Quick navigation">
        {BOTTOM.map((id) => { const n = NAV.find((x) => x.id === id)!; return (
          <a key={id} href={href('/' + id)} className={current === id ? 'selected' : ''} aria-current={current === id ? 'page' : undefined}><Icon name={n.icon} size={22} /><span>{id === 'paths' ? 'Paths' : id === 'playground' ? 'Code' : n.label}</span></a>
        ); })}
        <button onClick={() => setOpen(true)} className={!BOTTOM.includes(current) ? 'selected' : ''}><Icon name="menu" size={22} /><span>More</span></button>
      </nav>
    </div>
  );
}
