// Real startup sequence. Progress reflects work actually completed; nothing is simulated.
import bundled from '../generated/packages.json';
import { validatePackage, type RlfPackage } from '../../shared/rlf.ts';
import { loadState, loadStoredPackages, type LearnerState, type StorageKind } from './localData.ts';
import { buildLibrary, type Library, type PackageOrigin } from './library.ts';
import { initialPlatform, type PlatformStatus } from './platform.ts';

export type StageStatus = 'pending' | 'active' | 'done' | 'warn' | 'error' | 'skipped';
export type StageView = { id: string; label: string; status: StageStatus };
export type Progress = { value: number; message: string; stages: StageView[]; notices: string[] };
export type InitResult = { state: LearnerState; storage: StorageKind; library: Library; platform: PlatformStatus; notices: string[] };

export class CriticalInitError extends Error {
  details: string[];
  constructor(message: string, details: string[] = []) { super(message); this.name = 'CriticalInitError'; this.details = details; }
}

const STAGES = [
  { id: 'storage', label: 'Local storage' },
  { id: 'prefs', label: 'Preferences and progress' },
  { id: 'library', label: 'Learning library' },
  { id: 'local', label: 'Stored packages' },
  { id: 'index', label: 'Search index' }
] as const;

export const applyPreferences = (s: Pick<LearnerState, 'theme' | 'density' | 'reducedMotion' | 'fontScale'>) => {
  const r = document.documentElement;
  r.dataset.theme = s.theme; r.dataset.density = s.density; r.dataset.motion = s.reducedMotion ? 'reduced' : 'full';
  r.style.setProperty('--font-scale', String(s.fontScale));
};

export async function initialize(onProgress: (p: Progress) => void): Promise<InitResult> {
  const notices: string[] = [];
  const status: StageStatus[] = STAGES.map(() => 'pending');
  let message = 'Starting…'; let frac = 0;
  const emit = (i: number, within = 0) => {
    frac = (i + within) / STAGES.length;
    onProgress({ value: Math.min(frac, 1), message, stages: STAGES.map((s, k) => ({ id: s.id, label: s.label, status: status[k] })), notices: [...notices] });
  };
  const begin = (i: number, msg: string) => { status[i] = 'active'; message = msg; emit(i); };
  const finish = (i: number, st: StageStatus, msg: string) => { status[i] = st; message = msg; emit(i + 1); };

  // 1. Local storage
  begin(0, 'Opening local storage…');
  let storage: StorageKind = 'indexeddb';
  let state!: LearnerState;
  // 2. Preferences (loadState reports which backend answered)
  const loaded = await loadState();
  storage = loaded.storage; state = loaded.state;
  if (storage === 'indexeddb') finish(0, 'done', 'Local storage is ready.');
  else if (storage === 'localstorage') { notices.push('IndexedDB is unavailable, so progress is saved with the browser’s simpler localStorage instead.'); finish(0, 'warn', 'Using fallback storage.'); }
  else { notices.push('This browser blocked local storage. Progress and bookmarks will not be kept after you close the page.'); finish(0, 'warn', 'Storage unavailable; using memory only.'); }
  begin(1, 'Loading your preferences and progress…');
  applyPreferences(state);
  const done = Object.keys(state.completed).length;
  finish(1, 'done', done ? `Restored ${done} completed lesson${done === 1 ? '' : 's'} and ${state.bookmarks.length} bookmark${state.bookmarks.length === 1 ? '' : 's'}.` : 'Preferences loaded.');

  // 3. Bundled library verification
  const pkgs = bundled as unknown as RlfPackage[];
  begin(2, 'Verifying the learning library…');
  const hasCrypto = typeof crypto !== 'undefined' && !!crypto.subtle;
  if (!hasCrypto) notices.push('This page is not in a secure context, so package checksums could not be verified.');
  const inputs: { pkg: RlfPackage; origin: PackageOrigin }[] = [];
  const problems: string[] = [];
  for (let i = 0; i < pkgs.length; i++) {
    message = `Verifying package ${i + 1} of ${pkgs.length}: ${pkgs[i].title}`; emit(2, i / pkgs.length);
    const r = await validatePackage(pkgs[i], { checkChecksum: hasCrypto });
    if (!r.ok) problems.push(`${pkgs[i].id}: ${r.errors[0]}`); else inputs.push({ pkg: pkgs[i], origin: 'bundled' });
  }
  // An empty snapshot is normal until the owner publishes content. A NON-empty snapshot that fails entirely is a corrupt build.
  if (pkgs.length > 0 && !inputs.length) throw new CriticalInitError('The bundled learning library could not be verified.', problems);
  if (problems.length) { notices.push(`${problems.length} bundled package(s) failed verification and were skipped: ${problems.join('; ')}`); finish(2, 'warn', 'Library loaded with problems.'); }
  else finish(2, 'done', pkgs.length ? `Verified ${inputs.length} package${inputs.length === 1 ? '' : 's'}.` : 'No published lessons are bundled yet.');

  // 4. Locally stored (synced or imported) packages
  begin(3, 'Reading packages stored in this browser…');
  try {
    const stored = storage === 'indexeddb' ? await loadStoredPackages() : [];
    let used = 0;
    for (let i = 0; i < stored.length; i++) {
      message = `Checking stored package ${i + 1} of ${stored.length}: ${stored[i].id}`; emit(3, i / stored.length);
      const r = await validatePackage(stored[i].pkg, { checkChecksum: hasCrypto });
      if (r.ok) { inputs.push({ pkg: stored[i].pkg, origin: stored[i].origin }); used++; }
      else notices.push(`Stored package "${stored[i].id}" is invalid and was ignored: ${r.errors[0]}`);
    }
    finish(3, 'done', used ? `Loaded ${used} stored package${used === 1 ? '' : 's'}.` : 'No additional packages stored.');
  } catch (err) { notices.push(`Stored packages could not be read: ${(err as Error).message}`); finish(3, 'warn', 'Skipped stored packages.'); }

  // 5. Index
  begin(4, 'Building the search index…');
  const library = buildLibrary(inputs);
  notices.push(...library.notices);
  finish(4, 'done', `Indexed ${library.entries.length} entries (${library.index.terms.toLocaleString()} terms).`);

  message = 'Ready'; status.forEach((s, i) => { if (s === 'pending' || s === 'active') status[i] = 'skipped'; }); emit(STAGES.length);
  return { state, storage, library, platform: initialPlatform(), notices };
}
