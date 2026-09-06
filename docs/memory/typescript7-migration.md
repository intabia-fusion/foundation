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

## Experiments 2026-09-06 (TS 7.0.2 GA + pnpm)

### Versions
`typescript@7.0.2` is npm `latest` (GA). Use it, not `@typescript/native-preview` (stuck at 7.0.0-dev.20260707.2).
Ships only `bin/tsc` + `./unstable/*`. No `ts.createProgram` -> `validate-worker.js` cannot survive.

### Branch is already TS5-incompatible
`compile validate` on this branch: `error TS5095: Option 'bundler' can only be used when 'module' is set to 'preserve' or to 'es2015' or later`.
`moduleResolution: bundler` + `module: commonjs` is legal in TS7, rejected by TS5. No way back; engine swap is mandatory.
TS5-based tooling is unaffected (it does not run tsc option validation): jest/ts-jest, eslint + @typescript-eslint 6 both clean.

### Never use `typescript/bin/tsc`
That bin is a node ESM shim that re-execs the Go binary: 0.12s vs 0.03s. Resolve
`@typescript/typescript-${process.platform}-${process.arch}/lib/tsc` directly.
Repo-wide flat bench: 14.0s via shim vs **8.0s** native. 43% of wall was node startup.

### tsbuildinfo trap (cost hours)
UI packages have no `tsBuildInfoFile` in their tsconfig -> tsc defaults it to `<pkg>/tsconfig.tsbuildinfo`.
tsgo does NOT invalidate on deleted output dirs: with a stale tsbuildinfo present it exits 0 and emits nothing.
Putting `tsBuildInfoFile` into a rig profile does NOT work: relative paths resolve against the config that
declares them, i.e. into the shared `node_modules/@hcengineering/platform-rig/profiles/ui/` folder -> all
UI packages collide on one file. Fix: orchestrator passes `--tsBuildInfoFile .build/build.tsbuildinfo` on the CLI.

### Measurements (M-series, 16 workers, 460 packages)
| scenario | wall |
|---|---|
| flat typecheck `--noEmit` (types present) | 13.8s (shim) |
| flat full emit JS+d.ts (types present) | 14.0s shim / **8.0s native** |
| clean full build, topological, custom ready-queue scheduler | **18.2s** |
| same, warm rerun | 8.9s |
| `pnpm -r --workspace-concurrency=16 run _phase:build` | **186s** |
| sum of per-package tsc time | 164s |
| dependency critical path (36 levels deep) | 16.1s |

`pnpm -r` topological scheduler is 10x off optimal - it batches generations instead of using a ready-queue.
A custom scheduler lands within 13% of the critical-path floor. **Keep our own orchestrator; `pnpm -r` is not a substitute.**

### Output equivalence
tsc emit vs esbuild emit: identical file sets; total `lib/` 51.6MB -> 43.2MB (no esbuild `keepNames` helpers).
`rush model-version` works off tsc-built lib (decorators + `emitDecoratorMetadata` verified in `models/tracker/lib/types.js`).
No `constructor.name` reliance in models/core/server, so dropping esbuild `keepNames` is safe.
esbuild bundle of `pods/account` off tsc lib: OK, 9.57MB -> 8.9MB.
Jest sweep, 395 packages: 6 real failures, all infra-dependent (elastic, postgres/cockroach, kafka, pod-fulltext).
`converter-resources` failed only under 8-way parallel jest, passes standalone.

### esbuild is NOT removable
Only the *transpile* use disappears. Still needed for `_phase:bundle` (47 packages, real bundling
`--bundle=true` + externals -> single-file pod output) and webpack for front/desktop/storybook.

### Pure pnpm migration is nearly mechanical
Verified in a throwaway worktree: `pnpm install --frozen-lockfile` accepted the Rush lockfile as-is,
471 workspace projects, 24.5s, `resolved 2544, reused 2517, downloaded 0` - zero re-resolution.
Steps needed:
- `pnpm-workspace.yaml` with all `projectFolder` values from rush.json (470 entries, or globs).
- deps already use `workspace:^x.y.z` -> no `linkWorkspacePackages` gymnastics needed.
- lockfile: copy `common/config/rush/pnpm-lock.yaml` to root, rewrite importer keys `  ../../X:` -> `  X:`
  and `  ../scripts:` -> `  common/scripts:`. `link:` targets need NO change (relative to importer dir).
  Drop the `pnpmfileChecksum:` line.
- `patchedDependencies: kafkajs@2.2.4: common/pnpm-patches/kafkajs@2.2.4.patch` in pnpm-workspace.yaml.
- pnpm 10 blocks postinstall by default -> `onlyBuiltDependencies` must list: @ffmpeg-installer/darwin-arm64,
  @livekit/local-inference, @parcel/watcher, bufferutil, core-js, electron, es5-ext, esbuild,
  msgpackr-extract, protobufjs, puppeteer, sharp, svelte-preprocess, utf-8-validate.
- `typescript7` as `npm:typescript@7.0.2` alias in platform-rig: verified that plain `typescript`
  still resolves to 5.9.3 everywhere; the alias does not hijack peer resolution.

### What Rush actually still does here
CI (`.github/workflows/main.yml`) only uses `rush install`, `rush check`, `rush model-version` and the
`fast-build:*` global shell commands. `rush build`/`rush validate` phases and the Rush build cache are
NOT used in CI. Unused: publish, change files, version policies (empty), subspaces, cobuild, plugins,
autoinstallers, preferredVersions (empty). `pnpm-config.json` is empty except the kafkajs patch.

## Слияние build+validate (сделано 2026-09-06)

`_phase:validate` больше нет. `_phase:build` = `compile build` (JS+d.ts) или `compile build-ui`
(только d.ts, UI-пакеты отдают исходники бандлеру). `fast-build:validate`, `rush validate`,
`--validate` оставлены алиасами. Замеры: чистая сборка 460 пакетов 13.2s напрямую / 17.8s
через `rush fast-build`, повтор из кэша 0.95s.

### Алиас typescript7 протекает в peer-резолюцию
`typescript7: npm:typescript@7.0.2` разрешается в пакет с именем `typescript`, поэтому у пакетов,
которые сами не объявляют `typescript`, peer у `ts-jest`/`@typescript-eslint` уезжает на 7.0.2.
Это фатально: `require('typescript')` из 7.0.2 отдаёт только `{version, versionMajorMinor}`.
Лечится явным `"typescript": "^5.9.3"` - понадобилось в `ui-test`, `measurements`,
`measurements-otlp`, `postgres-base`, `pods/external`, `common/scripts`.

### Экосистема под TS7 не готова (на 2026-09-06)
`@typescript-eslint` 8.69 `>=4.8.4 <6.1.0`, `ts-jest` 29.4.12 `>=4.3 <7`, `svelte-check` 4.7.6
`^5||^6`, `svelte2tsx` 0.7.61 `^4.9.4||^5||^6` - все отрезают 7. `ts-loader`,
`fork-ts-checker-webpack-plugin`, `ts-node` формально пускают, но зовут классический
Compiler API. Поэтому typescript@5.9.3 остаётся рядом.

### outputHash в кэше должен считаться по тем же папкам
`markPhaseCompleted` считает `outputHash` по `outputDirs`; если проверка сравнивает его с хэшем
других папок, кэш не срабатывает никогда. Был симптом: 70 попаданий из 460 (совпадали только
UI-пакеты, у которых `outputDirs` = `['types']`).

### Что удалено из platform-rig/bin
`validate-worker.js`, `phases/transpile.js`, `profile-detailed.js`, `profile-memory.js`,
`__tests__/validate-worker.test.js`, `getWorkerPool`/`ValidateWorkerPool` из `libs/workers.js`,
поле `phaseValidate` из `libs/graph.js`. `getNamedWorkerPool` остался - им пользуются lint и format.

### Ready-queue вместо волн
Старые фазы шли "поколениями" через `Promise.all` по волне, причём ограничение параллелизма
в validate было сломано (`.map(async...)` стартует всё сразу, чанки резали уже запущенные
промисы). Новая `phases/build.js` держит ready-queue с реальным лимитом.

### Параллелизм: больше воркеров не помогает

Нативный tsc сам многопоточный. Один процесс на самом тяжёлом пакете:
`0.50s user, 0.41s system, 539% cpu, 0.170s total`. То есть один tsc уже занимает ~5 ядер.

Чистая сборка 460 пакетов, 16 ядер, при разном числе одновременных процессов:

| воркеров | wall |
|---|---|
| 1 | 36.2s |
| 2 | 21.3s |
| 3 | 16.8s |
| **4** | **14.0s** |
| 6 | 14.1s |
| 8 | 14.0s |
| 12 | 14.1s |
| 16 | 14.6s |
| 24 | 15.3s |
| 32 | 15.7s |

Плато с 4 до 12, дальше деградация от конкуренции за ядра. Пиковый RSS одного процесса:
158MB на `core`, 407MB на `controlled-documents-resources`, 420MB на `dev/tool` - против
1536-2048MB, которые бюджетировались на V8-воркер валидации.

Поэтому в `PHASE_MEMORY` заведён отдельный профиль `tsc` с `cpuPerWorker: 4, minWorkers: 2,
maxWorkers: 8` вместо `maxWorkers: 6` от старого V8-пула. На 16 ядрах даёт 4 процесса,
на 32 - 8, на 2-8 ядрах - 2. Явный обход - `--force-workers --parallel N`.

Старый профиль `typescript` (1536/2048MB, максимум 6) остался для lint/format/svelte-check -
они всё ещё worker_threads с V8-кучей.

### rush build против fast-build

Чистая полная сборка, то же железо, тот же результат на диске:

| | wall | CPU |
|---|---|---|
| `compile_all.js` (fast-build) | **15.3s** | ~1200% |
| `rush build --parallelism 16` | **124s** | 218% |

Восьмикратная разница - не в компиляторе. Rush на каждый пакет поднимает отдельный
`rushx _phase:build`: шелл, node, свой раннер операций, хэширование и копирование в build cache.
Сам rush показывает 1.4-5.7s на пакет там, где tsc отрабатывает за 0.1-0.4s. CPU при этом 218%:
операции упираются в однопоточный старт node, а не в компиляцию.

Ускорить фазовый движок нечем - это его устройство. Ещё один довод к этапу 2: в CI он и так
не используется.
