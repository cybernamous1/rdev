// Reference implementation of the RLF package checksum (same algorithm as shared/rlf.ts computeChecksum):
// SHA-256 over canonical JSON (recursively sorted keys, compact) of the package WITHOUT its `checksum` field.
// Usage: node tools/checksum.mjs package.json   -> prints the hex digest
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const canonical = (v) => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
  : JSON.stringify(v);
export const checksumOf = (pkg) => { const { checksum, ...rest } = pkg; return createHash('sha256').update(canonical(rest)).digest('hex'); };
if (process.argv[2]) console.log(checksumOf(JSON.parse(readFileSync(process.argv[2], 'utf8'))));
