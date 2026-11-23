// Learner data lives only in this browser: IndexedDB first, localStorage as a fallback.
import type { RlfPackage } from '../../shared/rlf.ts';

export type Snippet = { id: string; name: string; code: string; updatedAt: string };
export type LearnerState = {
  version: 2;
  bookmarks: string[];
  completed: Record<string, string>; // lesson id -> ISO date
  notes: Record<string, string>;
  recent: string[];
  theme: string;
  density: 'comfortable' | 'compact';
  reducedMotion: boolean;
  fontScale: number; // 1 = default
  snippets: Snippet[];
  playgroundCode: string;
};
export type StoredPackage = { id: string; origin: 'platform' | 'local'; savedAt: string; pkg: RlfPackage };
export type StorageKind = 'indexeddb' | 'localstorage' | 'memory';

export const STARTER_CODE = `local function greetPlayer(playerName: string)
    print(\`Welcome to RDev Academy, {playerName}\`)
end

greetPlayer("Developer")
`;

export const defaultState = (): LearnerState => ({
  version: 2, bookmarks: [], completed: {}, notes: {}, recent: [], theme: 'sovereign', density: 'comfortable',
  reducedMotion: false, fontScale: 1, snippets: [], playgroundCode: STARTER_CODE
});

const DB_NAME = 'rdev-academy-local';
const STATE_STORE = 'learner-state';
const PKG_STORE = 'packages';
const FALLBACK_KEY = 'rdev-fallback';
const PREFS_KEY = 'rdev-prefs';

let dbPromise: Promise<IDBDatabase> | null = null;
export function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB is not available in this browser.'));
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STATE_STORE)) db.createObjectStore(STATE_STORE);
        if (!db.objectStoreNames.contains(PKG_STORE)) db.createObjectStore(PKG_STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Could not open local storage.'));
      req.onblocked = () => reject(new Error('Local storage is blocked by another tab.'));
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

const tx = <T,>(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => { const r = fn(db.transaction(store, mode).objectStore(store)); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

/** Accepts old (version 0.1.0) saved data and normalizes it. */
export function normalizeState(raw: unknown): LearnerState {
  const d = defaultState();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, any>;
  const completed: Record<string, string> = Array.isArray(r.completed) ? Object.fromEntries(r.completed.filter((x: unknown) => typeof x === 'string').map((id: string) => [id, ''])) : (r.completed && typeof r.completed === 'object' ? r.completed : {});
  return {
    ...d,
    bookmarks: Array.isArray(r.bookmarks) ? r.bookmarks.filter((x: unknown) => typeof x === 'string') : [],
    completed, notes: r.notes && typeof r.notes === 'object' ? r.notes : {},
    recent: Array.isArray(r.recent) ? r.recent.filter((x: unknown) => typeof x === 'string').slice(0, 8) : [],
    theme: typeof r.theme === 'string' ? r.theme : d.theme,
    density: r.density === 'compact' ? 'compact' : 'comfortable',
    reducedMotion: Boolean(r.reducedMotion),
    fontScale: [0.9, 1, 1.15, 1.3].includes(r.fontScale) ? r.fontScale : 1,
    snippets: Array.isArray(r.snippets) ? r.snippets.filter((s: any) => s && typeof s.id === 'string' && typeof s.code === 'string') : [],
    playgroundCode: typeof r.playgroundCode === 'string' ? r.playgroundCode : d.playgroundCode
  };
}

export async function loadState(): Promise<{ state: LearnerState; storage: StorageKind }> {
  try {
    const db = await openDb();
    const raw = await tx(db, STATE_STORE, 'readonly', (s) => s.get('main'));
    return { state: normalizeState(raw), storage: 'indexeddb' };
  } catch {
    try { return { state: normalizeState(JSON.parse(localStorage.getItem(FALLBACK_KEY) || 'null')), storage: 'localstorage' }; }
    catch { return { state: defaultState(), storage: 'memory' }; }
  }
}

export async function saveState(state: LearnerState): Promise<StorageKind> {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: state.theme, density: state.density, reducedMotion: state.reducedMotion, fontScale: state.fontScale })); } catch { /* ignore */ }
  try { const db = await openDb(); await tx(db, STATE_STORE, 'readwrite', (s) => s.put(state, 'main')); return 'indexeddb'; }
  catch {
    try { localStorage.setItem(FALLBACK_KEY, JSON.stringify(state)); return 'localstorage'; } catch { return 'memory'; }
  }
}

export async function loadStoredPackages(): Promise<StoredPackage[]> {
  const db = await openDb();
  return tx(db, PKG_STORE, 'readonly', (s) => s.getAll() as IDBRequest<StoredPackage[]>);
}
export async function putStoredPackage(p: StoredPackage): Promise<void> { const db = await openDb(); await tx(db, PKG_STORE, 'readwrite', (s) => s.put(p)); }
export async function deleteStoredPackage(id: string): Promise<void> { const db = await openDb(); await tx(db, PKG_STORE, 'readwrite', (s) => s.delete(id)); }
export async function clearAllLocalData(): Promise<void> {
  try { const db = await openDb(); await tx(db, STATE_STORE, 'readwrite', (s) => s.clear()); await tx(db, PKG_STORE, 'readwrite', (s) => s.clear()); } catch { /* ignore */ }
  try { localStorage.removeItem(FALLBACK_KEY); localStorage.removeItem(PREFS_KEY); } catch { /* ignore */ }
}
