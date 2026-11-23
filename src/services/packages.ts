// RLF package management in the browser: import, remove, rebuild and sync. Everything stays local to this browser.
import bundled from '../generated/packages.json';
import { validatePackage, type RlfPackage, type ValidationReport } from '../../shared/rlf.ts';
import { buildLibrary, type Library, type PackageOrigin } from './library.ts';
import { deleteStoredPackage, loadStoredPackages, putStoredPackage } from './localData.ts';

const MAX_IMPORT_BYTES = 2_000_000;

export async function rebuildLibrary(): Promise<Library> {
  const inputs: { pkg: RlfPackage; origin: PackageOrigin }[] = (bundled as unknown as RlfPackage[]).map((pkg) => ({ pkg, origin: 'bundled' as const }));
  try {
    for (const s of await loadStoredPackages()) {
      const r = await validatePackage(s.pkg);
      if (r.ok) inputs.push({ pkg: s.pkg, origin: s.origin });
    }
  } catch { /* storage unavailable: bundled only */ }
  return buildLibrary(inputs);
}

export async function importPackageText(text: string, current: Library): Promise<{ ok: boolean; report: ValidationReport; message: string }> {
  const fail = (errors: string[], message: string, warnings: string[] = []) => ({ ok: false, report: { ok: false, errors, warnings }, message });
  if (text.length > MAX_IMPORT_BYTES) return fail(['File is larger than 2 MB.'], 'File is too large.');
  let data: unknown;
  try { data = JSON.parse(text); } catch { return fail(['The file is not valid JSON.'], 'The file is not valid JSON.'); }
  const report = await validatePackage(data);
  if (!report.ok) return { ok: false, report, message: 'The package did not pass validation.' };
  const pkg = data as RlfPackage;
  const same = current.packages.find((p) => p.id === pkg.id);
  if (same && same.origin !== 'local') return fail([`Package id "${pkg.id}" is already provided by the ${same.origin === 'platform' ? 'platform' : 'bundled library'}. Choose a different id for local packages.`], 'Package id is already in use.', report.warnings);
  const clashes = pkg.entries.filter((e) => current.packages.some((p) => p.id !== pkg.id && p.pkg.entries.some((x) => x.id === e.id))).map((e) => e.id);
  if (clashes.length) return fail([`Entry ids already used by another package: ${clashes.slice(0, 5).join(', ')}`], 'Entry ids clash with existing content.', report.warnings);
  await putStoredPackage({ id: pkg.id, origin: 'local', savedAt: new Date().toISOString(), pkg });
  return { ok: true, report, message: `Imported ${pkg.title} v${pkg.version} (${pkg.entries.length} entries).` };
}

export async function removeStored(id: string) { await deleteStoredPackage(id); }

export function downloadText(filename: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
