# TypeScript 7 (tsgo) migration

Branch `typescript7`. Goal: replace fast-build custom validate engine + separate validate phase with a single tsc-emit pass (JS + .d.ts), leveraging TS7 (Go compiler) ~5x speed.

## State (done, committed)

All 468 packages green under tsgo (`@typescript/native-preview` / typescript@7.0.2). Non-UI 398 + UI 70.
Type-check full repo: non-UI ~11-17s, UI ~4s (16 workers) vs fast-build:validate 56.9s. ~5x.

### Profile changes (platform-rig/profiles/*)
`moduleResolution: node` (=node10, REMOVED in TS7) -> `bundler` in: default, node, model, package (added), ui, assets. Also desktop/tsconfig.json (standalone).
Rig is symlinked into every package -> edits propagate without reinstall.

### Ambient decls (profiles/ui/svelte/index.d.ts)
Added `declare module "*.css"` and `"*.scss"` (node10 ignored CSS side-effect imports, bundler needs types). Also added rig package.json exports entry `./profiles/ui/svelte` -> index.d.ts (bundler won't auto-append /index.d.ts to a dir).

### Code fixes (~30 across 16 files)
- Subpath imports (`/src`,`/types/*`) -> public entry: bundler respects `exports`, node10 didn't.
- telegraf `/typings/*` -> `telegraf/types`.
- `isUpdateTx` type-guard does NOT narrow unions in TS7 -> explicit casts at call sites (process/main, process-resources x2, middleware). Guard is `is TxUpdateDoc<Doc>` now (was hardcoded `<Card>`).
- core/memdb `resultSort(result as T[], ...)` generic variance.
- implicit any (`this: any`, `(error as Error)`, param annotations).
- prosemirror dup type: `as unknown as Plugin[]`.
- desktop test fs mocks: `(filePath: any)`.

### rush update
Restored missing symlinks (retry pkg, rig in db-migrator) — pre-existing broken working copy, NOT TS7-related. Did not touch pnpm-lock.

## Key constraints for engine swap (step 4, NOT done)

- typescript@7.0.2 npm has NO classic Compiler API (`ts.createProgram`/`getPreEmitDiagnostics` gone). Only `./unstable/*` RPC + tsgo CLI. So validate-worker.js (uses ts.createProgram) CANNOT run on 7.0.2 as-is.
- tsgo does NOT compile `.svelte`. UI packages (`_phase:build: compile ui`) MUST keep esbuild-svelte for JS. Only node packages can move JS emit to tsgo.
- tsgo full emit verified: CJS, sourcemap, declarationMap, legacy-decorators+metadata all correct.

## Current rush build wiring
- `rush build` = phase `_phase:build` = `compile transpile src` = esbuild JS only (no .d.ts).
- `rush validate` = phase `_phase:validate` = `compile validate` = tsc (ts.createProgram) .d.ts + typecheck.
- `compile` bare (default) = esbuild + validateTSC together (Promise.all).
- fast-build = separate parallel duplicate orchestrator (compile_all.js + validate-worker.js worker pool).

## Proposed step 4 (per-package tsc, user-chosen)
Node pkgs: `_phase:build` -> tsgo full emit (JS+.d.ts one pass), drop `_phase:validate`.
UI pkgs: keep esbuild-svelte JS + tsgo/svelte-check for .d.ts/typecheck.
Requires typescript@7 available to compile.js (add tsgo dep to platform-rig), rewrite validateTSC/compile paths, update command-line.json phases.
