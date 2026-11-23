// Strict semantic versions for package versions: exactly MAJOR.MINOR.PATCH, no leading zeros, no suffixes.
// Mirrors the database CHECK constraint (well-formedness) and adds what SQL cannot: numeric limits and ordering.
export const MAX_PART = 999_999_999;
const RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

export const isValidVersion = (v: unknown): v is string => typeof v === 'string' && RE.test(v);

export function parseVersion(v: string): [number, number, number] {
  const m = RE.exec(v);
  if (!m) throw new Error(`Invalid version "${v}". Expected MAJOR.MINOR.PATCH without leading zeros.`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Numeric comparison (1.0.10 > 1.0.9). Throws on malformed input. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** Next patch version above every existing version (after a rollback the highest ever published still wins). */
export function nextVersion(existing: string[], bump: 'major' | 'minor' | 'patch' = 'patch'): string {
  if (existing.length === 0) return '1.0.0';
  const top = existing.reduce((m, v) => (compareVersions(v, m) > 0 ? v : m));
  const [a, b, c] = parseVersion(top);
  const next: [number, number, number] = bump === 'major' ? [a + 1, 0, 0] : bump === 'minor' ? [a, b + 1, 0] : [a, b, c + 1];
  if (next.some((n) => n > MAX_PART)) throw new Error('Version part exceeds the supported maximum.');
  return next.join('.');
}
