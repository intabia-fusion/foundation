# Test stand setup in node (dev/test-base)

`tests/`, `ws-tests/` and `qms-tests/` no longer seed their stands from shell. `dev/test-base`
(`@hcengineering/test-base`) owns docker compose, health checks, seeding and verification; the
`prepare*.sh` scripts are thin shims around `dev/test-base/run.sh <stand> [prepare|restore]`.

Stands: `sanity` (tests/), `ws` (ws-tests/), `qms` (qms-tests/), `full` (= sanity + qms workspaces on
the tests/ compose). Definitions live in `dev/test-base/src/stands.ts`.

## Why the tool runs in-process

`dev/tool` used to be re-launched per command (`./tool-pg.sh create-account ...`). `devTool` was split:

- `buildToolProgram(prepareTools)` returns a **fresh** commander tree; `devTool` is a thin wrapper
  around it. Commander stores parsed options on the command objects, so concurrent runs need
  separate programs.
- `initToolRuntime` (adapters, server plugins, process handlers) is guarded and runs once.
- `src/setup.ts` holds `registerToolLocations`, `prepareTools` and `runToolCommand(args)`.
  `prepareTools` caches the built model (`builder().getTxes()`); `prepareToolsRaw` still clones the
  txes per call, and `DB_URL` is re-read every time so regions can be switched.

`@hcengineering/tool` cannot be required from `lib/` in plain node: model packages import
`@hcengineering/presentation/src/plugin`, which only resolves through esbuild. `dev/test-base` is
therefore bundled too, and `run.sh` rebuilds `bundle/bundle.js` when a source file is newer.

## Constraints found the hard way

- **Restores must be serial.** `fillAccountUuids` (models/contact migration) holds a `traverse`
  cursor while issuing further queries; three concurrent `backup-restore --upgrade` deadlock on
  pgbouncer (`pool_mode = transaction`) with no error - the process just stops at
  `filling account uuids...`. Everything else per workspace runs in parallel.
- **One env per phase.** The tool reads config from `process.env` at command time, so workspaces are
  grouped by region and `applyEnv` deletes keys the new env does not define (`REGION_INFO` would
  otherwise leak from the europe phase). Deleting via `Reflect.deleteProperty` - assigning
  `undefined` would set the string `'undefined'`.
- `docker compose up -d` blocks on container healthchecks in its own process, so the model warmup
  runs alongside it. Warmup itself turned out to be ~0.1s; the 5-10s before the first command is the
  account DB connect/migration.

## Timings (local, macOS)

Legacy `prepare-pg.sh`: 42s wall / 16s CPU. New: ~41s wall / 3.3s CPU. Wall clock is dominated by
`docker compose down+up` (~21s), not by seeding. `full` (4 workspaces, 6 accounts): ~56s.

## Merging stands

`mergeStands(base, ...others)` takes containers/env/regions from `base` and adds accounts,
workspaces, post steps and cleanup paths from the others. Paths that belong to another stand
(backups, `.auth` directories) are made absolute - they live next to the stand that defined them.

Two things that broke while merging tests/ with qms-tests/:

- **`.auth` must be cleaned per suite.** Leaving `qms-tests/sanity/.auth` from a previous stand sends
  every QMS test straight back to the login screen (the setup skips login when the storage file
  exists). That is why `cleanup` is merged, not taken from `base`.
- **An account's name is global, not per workspace.** `assign-workspace` materialises the Employee
  from the account's person, so a workspace backup does not override it. `user3` cannot be
  `Muffin Muram` for tests/ and `Cain Velasquez` for qms-tests/ at the same time; QMS now uses its
  own `user_cain` login (`PLATFORM_USER_THIRD` in `qms-tests/sanity/.env`).

ws-tests cannot join `full`: it needs a second (europe) region - `transactor-europe`,
`workspace_europe`, `fulltext-europe` - which the tests/ compose does not have. qms-tests can,
because its compose is a subset of the tests/ one (no payment/tbank/aibot/print/preview).

Verified on the merged `full` stand: QMS suite 55 passed / 2 flaky / 0 failed (1.8 min), sanity suite
385 passed / 30 skipped / 2 flaky / 0 failed (9.8 min). `ws` stand comes up in 48s with all eight
workspaces verified, `api-tests` 238 passed / 2 skipped, ws UI suite 18 passed.

`api-tests` needs a worker cap locally: `rushx api-test` lets jest use cpus-1, and 11 suites
connecting at once starve the transactor into 60s `connect()` timeouts. `-w 3` (what a CI runner
ends up with) is green. Unrelated to the stand.

The QMS suite is not idempotent - `TESTS-205` fails when run against a stand that has already had a
full suite run against it, and passes on a fresh one. Not a stand regression.
