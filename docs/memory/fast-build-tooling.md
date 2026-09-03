# fast-build tooling (platform-rig/bin)

Review + fixes, Aug 2026. Code: `foundations/utils/packages/platform-rig/bin/`.

## Measured baseline (469 packages, 16-core / 48 GB Mac)

Driver: `scratchpad/bench/bench.sh` (per-step wall clock + peak RSS of the whole process tree).

| Step | Before |
|---|---|
| cold validate (transpile+validate, 460) | 51 s / 5792 MB |
| cold lint (460) | 193 s / 6586 MB |
| cold svelte-check (55) | 157 s / 7478 MB |
| cold format (463) | 158 s / 9077 MB |
| warm no-op | 4 s / 707 MB |
| **1-line edit in `@hcengineering/core`** | **403 s / 8623 MB** |

The incremental number is the one that mattered: editing one line cost as much as a full
cold validate + lint + svelte-check combined (401 s).

## Root causes behind the incremental cost

- **transpile wiped the whole cache file.** `invalidatePhase` did not exist, so an upstream
  change called `invalidateCache()` and deleted `.fast-build-cache.json` entirely — killing
  the validate/lint/svelte-check/bundle/package/docker-build entries of every downstream
  package. The per-phase v2 cache format was effectively unused.
- **lint and svelte-check keyed on dependency *sources*.** Both phases only ever see a
  dependency through its emitted `.d.ts`, so keying the composite hash on the dependency's
  `src/` meant any edit anywhere upstream re-ran them for the entire downstream closure.
  Now in `libs/composite-hash.js`: own-source hash + each transitive dependency's `types/` hash
  + the phase's own config files (`.eslintrc.js`, `svelte.config.js`, ...).

## Correctness bugs found

- **Packages silently dropped from phases.** Phase scripts were matched by strict string
  equality, so `services/ai-bot/love-agent` (`rushx build:wasm && node esbuild.config.js`) was
  never transpiled and `dev/prod` (`rm -rf ./types && compile validate`) was never validated —
  with no warning. Now `libs/phase-select.js` returns an `unknown` list that `compile_all`
  prints. Unsupported scripts are still not executed; they are only reported.
- **Worker pool could hang the build forever.** `_failWorkerTask` set `workers[i] = null`
  permanently, and tasks submitted after the last worker died sat in `pending` unsettled — an
  OOM in a tsc worker hung the build with no output. Workers now respawn (capped by
  `maxRespawns`), and a pool with no live workers fails its queue instead of stalling.
- **Recycling silently shrank the pool.** `_recycleWorker` put a fresh worker in slot `i`
  while the old worker's `exit` event (non-zero after `terminate()`) then ran
  `_failWorkerTask(i)` and nulled the *new* one. With format's `recycleAfter: 2` this fired
  constantly. Fixed with a per-slot generation counter; events from a replaced worker are ignored.
- **`getWorkerPool` handed back terminated pools.** `compile_all` terminates the shared
  validate pool after its phase but the module-level singleton kept pointing at the dead
  instance. Both pool getters now rebuild when `terminated`.
- **validate deleted `types/*.svelte.d.ts`.** `syncDirectory` prunes `types/` against
  `.validate/emit`, and tsc emits no declaration for a `.d.ts` input, so the files
  `generateSvelteTypes` writes were deleted on every validate — dirtying the transpile output
  hash and forcing a regenerate/delete loop. `*.svelte.d.ts` is now excluded from the prune.
- **watch rebuilt everything on every keystroke.** `watch_all` called `runTranspilePhase`
  without `packageHashes`, so every dependent skipped its cache check *and* the transpile cache
  was never written — poisoning the next `compile_all` run too.
- **Memory probing was wrong on both platforms.** `utils.js` destructured `readFileSync` from
  `child_process` (it isn't there), so the Linux `/proc/meminfo` branch always threw and fell
  back to `os.freemem()`. On macOS the page size was hardcoded to 4096 while Apple Silicon
  reports 16384 — a 4x under-report (3666 MB instead of 16485 MB here). Parsers are now
  `parseDarwinVmStat` / `parseLinuxMemInfo`, both unit-tested.
- **The memory cap did not cap.** `getOptimalWorkerCount` had a `minWorkers` floor of
  `max(2, cpu/2)` that overrode `maxWorkersByMemory`, so a machine with 2 GB free still got 6
  TypeScript workers. `limitedByMemory: true` was returned while ignoring the limit.
- **`modelsAllPath` pointed outside the repo** (`bundle-phase.js`, one `../` too many), so
  `getModelHash()` always returned null and the model-change invalidation it implements was dead.
- **`compile_all.js` had no `require.main` guard**, so requiring it ran a build and called
  `process.exit` — its `module.exports` were unreachable. `compile.js` already had the guard.

## Things that looked like bugs and were not

- `_phase:build: "compile ui"` (69 packages) produces nothing on purpose — `compile.js` prints
  "Nothing to compile for UI". Those packages are validated but never transpiled, by design.
- A failing `cold-validate` run turned out to be an under-installed worktree (67 missing
  workspace symlinks), not a tooling regression. `rush install` fixed it. The remaining 38
  missing symlinks belong to packages absent from `rush.json` (`network-*`,
  `qms-doc-import-tool`, `storybook`) and never enter the graph.
- Package hashing is cheap: 620 ms for all 469 package hashes, 720 ms for a full `types/` pass,
  23 ms for all composite hashes. Hashing was never the bottleneck.

## Tests

`bin/__tests__/`, plain `node --test` — no jest/ts-jest for a package that has no build step.
`fixtures/mini-repo.js` builds a throwaway Rush-shaped repo; `rush list --json` is never invoked
because `graph.js` prefers `common/temp/.rush-list-cache.json` when its mtime key matches, so the
fixture pre-seeds that file. `compile_all` is driven as a child process (it calls `process.exit`).
