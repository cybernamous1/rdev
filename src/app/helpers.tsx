import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { useApp } from './context.tsx';
import { navigate } from './router.ts';
import type { Entry } from '../types.ts';

const NotifyCtx = createContext<(m: string) => void>(() => undefined);
export const useNotify = () => useContext(NotifyCtx);

export function NotifyProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const notify = useCallback((m: string) => { setMsg(m); setTimeout(() => setMsg((cur) => (cur === m ? null : cur)), 2200); }, []);
  return <NotifyCtx.Provider value={notify}>{children}{msg && <div className="toast" role="status">{msg}</div>}</NotifyCtx.Provider>;
}

export function useActions() {
  const { state, update, lib } = useApp();
  const notify = useNotify();
  const lessons = lib.entries.filter((e) => e.kind === 'lesson');
  return {
    isBookmarked: (id: string) => state.bookmarks.includes(id),
    isDone: (id: string) => id in state.completed,
    toggleBookmark: (id: string) => update((s) => ({ ...s, bookmarks: s.bookmarks.includes(id) ? s.bookmarks.filter((x) => x !== id) : [...s.bookmarks, id] })),
    setDone: (id: string, done: boolean) => update((s) => {
      const completed = { ...s.completed };
      if (done) completed[id] = new Date().toISOString(); else delete completed[id];
      return { ...s, completed };
    }),
    copy: async (text: string) => {
      try { await navigator.clipboard.writeText(text); notify('Copied to clipboard'); }
      catch { notify('Copy is not available here. Select the text and copy it manually.'); }
    },
    openInPlayground: (code: string) => { update((s) => ({ ...s, playgroundCode: code })); navigate('/playground'); },
    lessons,
    doneCount: lessons.filter((l) => l.id in state.completed).length
  };
}

export const kindLabel = (e: Entry) => (e.kind === 'lesson' ? 'Lesson' : 'Reference');
export const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);
export const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'unknown date');
