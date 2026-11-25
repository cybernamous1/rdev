// L6 monitoring: content fingerprints. SHA-256 for exact identity; a 64-bit SimHash over word shingles for near-duplicates
// (mirrors, re-hosted copies, light edits). Web Crypto + BigInt only (Workers-safe).
const enc = new TextEncoder();
export async function sha256Hex(s: string): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join(''); }
export const normalizeText = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();

const MASK = (1n << 64n) - 1n;
function fnv64(s: string): bigint { let h = 0xcbf29ce484222325n; for (let i = 0; i < s.length; i++) { h ^= BigInt(s.charCodeAt(i)); h = (h * 0x100000001b3n) & MASK; } return h; }

/** 16 hex chars. Empty/very short text yields all-zero (callers treat it as "no fingerprint"). */
export function simhash(text: string, shingle = 3, maxWords = 3000): string {
  const words = normalizeText(text).split(' ').filter(Boolean).slice(0, maxWords);
  if (words.length < shingle + 5) return '0'.repeat(16);
  const v = new Array<number>(64).fill(0);
  for (let i = 0; i + shingle <= words.length; i++) { const h = fnv64(words.slice(i, i + shingle).join(' ')); for (let b = 0; b < 64; b++) v[b] += (h >> BigInt(b)) & 1n ? 1 : -1; }
  let out = 0n; for (let b = 0; b < 64; b++) if (v[b] > 0) out |= 1n << BigInt(b);
  return out.toString(16).padStart(16, '0');
}
export const hasFingerprint = (h: string) => /^[0-9a-f]{16}$/.test(h) && h !== '0'.repeat(16);
export function hamming(a: string, b: string): number { let x = BigInt('0x' + a) ^ BigInt('0x' + b); let n = 0; while (x) { n += Number(x & 1n); x >>= 1n; } return n; }
/** Four 16-bit bands. Two hashes within Hamming distance 3 share at least one identical band (pigeonhole), so a banded lookup finds every near-duplicate. */
export const bands = (h: string): [string, string, string, string] => [h.slice(0, 4), h.slice(4, 8), h.slice(8, 12), h.slice(12, 16)];
export const NEAR_DISTANCE = 3;
