// Adapter for optional compiled modules (Rust, Go/TinyGo, C/C++, ... compiled to WebAssembly) under the "rdev-module/1" contract.
// Workers cannot compile WebAssembly from bytes at runtime, so the Worker bundle must IMPORT the .wasm (giving a WebAssembly.Module);
// this adapter only instantiates it. The module gets NO imports (pure computation: no network, no files, no clock) and a fresh
// instance per call (no shared state). Any trap, bad pointer or oversize output becomes an ordinary error that the registry isolates.
//
// Contract - the module exports:  memory,  alloc(len:i32)->i32,  process(ptr:i32,len:i32)->i32 (output length),  output_ptr()->i32
// Input is UTF-8 JSON {"op": "...", "input": ...}; output is UTF-8 JSON.
import type { Operation } from '../contracts.ts';
import type { CompatStatus, RuntimeModule } from './registry.ts';

export type WasmDescriptor = { id: string; language: string; version: string; operations: Operation[]; formats?: string[]; maxInputBytes: number; priority?: number; advantage: string; compat: { status: CompatStatus; method: string; evidence: string | null } };
const MAX_OUT = 4_000_000;

export function wasmRuntimeModule(d: WasmDescriptor, compiled: WebAssembly.Module): RuntimeModule {
  return { id: d.id, language: d.language, version: d.version, operations: d.operations, formats: d.formats ?? [], cost: 'medium', maxInputBytes: d.maxInputBytes, priority: d.priority ?? 90, compat: d.compat, advantage: d.advantage,
    invoke(op, input) {
      const inst = new WebAssembly.Instance(compiled, {});
      const ex = inst.exports as Record<string, unknown>;
      const memory = ex.memory as WebAssembly.Memory; const alloc = ex.alloc as (n: number) => number; const proc = ex.process as (p: number, n: number) => number; const outPtr = ex.output_ptr as () => number;
      if (!(memory instanceof WebAssembly.Memory) || typeof alloc !== 'function' || typeof proc !== 'function' || typeof outPtr !== 'function') throw new Error('module does not export the rdev-module/1 interface');
      const bytes = new TextEncoder().encode(JSON.stringify({ op, input })); if (bytes.length > d.maxInputBytes) throw new Error('input exceeds the module limit');
      const p = alloc(bytes.length); if (p < 0 || p + bytes.length > memory.buffer.byteLength) throw new Error('module allocator returned an invalid pointer');
      new Uint8Array(memory.buffer, p, bytes.length).set(bytes);
      const n = proc(p, bytes.length); const o = outPtr();
      if (n < 0 || n > MAX_OUT || o < 0 || o + n > memory.buffer.byteLength) throw new Error('module returned an invalid output range');
      return JSON.parse(new TextDecoder().decode(new Uint8Array(memory.buffer, o, n)));
    } };
}
