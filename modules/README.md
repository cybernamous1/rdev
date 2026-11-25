# Optional language modules

**v0.5.0 ships no non-TypeScript module.** No Rust/Go/C/C++/Kotlin toolchain was available when v0.5.0 was built, and no TypeScript
implementation was shown to be too slow, so adding another language would have been experimentation, which the project forbids.
The registry (`knowledge/engine/runtime/registry.ts`), the WebAssembly adapter (`wasm-adapter.ts`) and the manifest validator
(`manifest.ts`, `scripts/verify-modules.ts`) are in place and tested, so a module can be added later without touching the engine.

## What a module must contain (`modules/<id>/`)

| File | Purpose |
| --- | --- |
| `module.json` | Manifest, validated by `npm run modules:verify` (fields below) |
| own dependency manifest + **own lockfile** | e.g. `Cargo.toml` + `Cargo.lock`, `go.mod` + `go.sum` |
| own build configuration | e.g. `.cargo/config.toml`, `Makefile`, `tinygo` flags |
| `BUILD.md` | reproducible build instructions (pinned toolchain version, exact commands, expected artifact sha256) |
| entry point | single source file exporting the `rdev-module/1` interface |
| compiled `.wasm` | imported by the Worker as a `WebAssembly.Module` (Workers cannot compile wasm from bytes at runtime) |
| `workers-report.md` | output of running the module under `wrangler dev`/workerd. **Required**: a Node-only test is not Workers verification |
| `benchmark.md` | measurements showing a technical advantage over the TypeScript implementation |

`module.json` keys: `id, language, version, interface ("rdev-module/1"), entry, operations[], artifact{path,sha256}, dependencies{manifest,lockfile},
build{config,instructions}, workers{status:"verified-workers",report}, advantage{summary,benchmark}, limits{maxInputBytes}`.

## Interface `rdev-module/1`

Exports `memory`, `alloc(len)->ptr`, `process(ptr,len)->outLen`, `output_ptr()->ptr`. Input is UTF-8 JSON `{"op","input"}`, output UTF-8 JSON.
The module receives **no imports**: no network, files, clock or randomness. A fresh instance is created per call. Failures (traps, bad
pointers, oversize output, timeouts) are caught by the registry, counted by a circuit breaker, and the TypeScript implementation is used instead.
Discovered or downloaded code is never executed: modules are reviewed source compiled by the owner at build time.
