import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { saveState, type LearnerState, type StorageKind } from '../services/localData.ts';
import { applyPreferences, type InitResult } from '../services/initialize.ts';
import type { Library } from '../services/library.ts';
import { checkPlatform, syncPackages, type PlatformStatus } from '../services/platform.ts';
import { rebuildLibrary } from '../services/packages.ts';

export type Ctx = {
  lib: Library; setLib: (l: Library) => void;
  state: LearnerState; update: (fn: (s: LearnerState) => LearnerState) => void;
  storage: StorageKind; platform: PlatformStatus; notices: string[];
  syncing: boolean; syncNow: () => Promise<void>;
  saveError: boolean;
};
const AppContext = createContext<Ctx | null>(null);
export const useApp = () => { const c = useContext(AppContext); if (!c) throw new Error('useApp outside provider'); return c; };

export function AppProvider({ init, children }: { init: InitResult; children: ReactNode }) {
  const [lib, setLib] = useState(init.library);
  const [state, setState] = useState(init.state);
  const [platform, setPlatform] = useState(init.platform);
  const [storage, setStorage] = useState(init.storage);
  const [notices, setNotices] = useState(init.notices);
  const [syncing, setSyncing] = useState(false);
  const [saveError, setSaveError] = useState(init.storage === 'memory');
  const first = useRef(true);
  const busy = useRef(false);
  const libRef = useRef(lib); libRef.current = lib;
  const update = useCallback((fn: (s: LearnerState) => LearnerState) => setState((s) => fn(s)), []);

  useEffect(() => {
    applyPreferences(state);
    if (first.current) { first.current = false; return; }
    const t = setTimeout(() => { saveState(state).then((k) => { setStorage(k); setSaveError(k === 'memory'); }); }, 250);
    return () => clearTimeout(t);
  }, [state]);

  /** Background synchronization. Never blocks the UI; every failure is reported and otherwise ignored. */
  const syncNow = useCallback(async () => {
    if (busy.current) return; busy.current = true; setSyncing(true);
    setPlatform((p) => ({ ...p, state: 'checking', detail: 'Checking the knowledge service in the background…' }));
    try {
      const status = await checkPlatform();
      if (status.state === 'online' && status.databaseReady && storage === 'indexeddb') {
        const have = new Map(libRef.current.packages.map((p) => [p.id, { version: p.version, checksum: p.checksum, origin: p.origin }]));
        const res = await syncPackages(have);
        status.updated = res.updated; status.published = res.serverPackages;
        if (res.updated.length || res.removed.length) setLib(await rebuildLibrary());
        if (res.problems.length) setNotices((n) => [...n, ...res.problems.map((p) => `Update skipped: ${p}`)]);
        status.detail = res.updated.length ? `Applied ${res.updated.length} update${res.updated.length === 1 ? '' : 's'}.` : res.serverPackages ? 'Library is up to date.' : 'Service is available. Nothing has been published yet.';
      }
      setPlatform(status);
    } catch (err) {
      setNotices((n) => [...n, `Background update failed: ${(err as Error).message}`]);
      setPlatform((p) => ({ ...p, state: 'unavailable', detail: `Update check failed (${(err as Error).message}).` }));
    } finally { busy.current = false; setSyncing(false); }
  }, [storage]);

  // Start after the first render (never during startup) and again whenever the device comes back online.
  useEffect(() => {
    const t = setTimeout(() => { void syncNow(); }, 300);
    const on = () => { void syncNow(); };
    window.addEventListener('online', on);
    return () => { clearTimeout(t); window.removeEventListener('online', on); };
  }, [syncNow]);

  const value = useMemo(() => ({ lib, setLib, state, update, storage, platform, notices, syncing, syncNow, saveError }), [lib, state, update, storage, platform, notices, syncing, syncNow, saveError]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
