# The test phase runs one jest, not one per package

Every package used to get its own `pnpm run test`, so the phase paid jest's ~2s bootstrap 155
times. It now runs almost everything as `projects` of a single jest invocation, and only the
packages that cannot share a run go one by one.

Numbers on a 16-core M-series against the local stand:

| | |
|---|---|
| per package (`--no-test-group`) | 286s, and it hangs (see below) |
| one jest, 149 packages | 37.7s |
| whole phase, cold | 84.6s |
| whole phase, warm cache | 7ms |

The phase is 84.6s rather than 37.7s because `@hcengineering/kafka` (19.7s) and `pod-fulltext`
(15.9s) run alone, one after the other.

## Who runs alone, and why

`libs/test-groups.js` decides. A package leaves the shared run when it has no `jest.config.js`, its
`test` script is not plain jest, its config already uses `projects` (jest does not nest), its script
carries a flag that cannot apply to everyone (`--verbose`, `--detectOpenHandles`), or its
`package.json` sets `"testIsolated": true`.

`testIsolated` is set on `@hcengineering/kafka` and `pod-fulltext`. Both create their own
postfixed topics, and together they exhaust the partition budget of the test stand's redpanda
(`--smp 1 --memory 1G`): the run dies with `KafkaJSNonRetriableError: Number of partitions is
invalid`. Raising the container's memory would let them join the shared run and take the phase to
roughly 40s — untried.

`--coverage` is dropped in the shared run: coverage is per-run, not per-project. No package sets a
`coverageThreshold` and CI does not read the reports, so nothing checks it; `pnpm test
--no-test-group` still collects it per package.

## Leftover kafka topics wedge the next run

When a fulltext suite fails in `beforeAll`, `afterAll` never runs and its topics stay. They
accumulate across runs until topic creation fails for everyone, which then looks like an unrelated
timeout. Clearing them:

```bash
docker exec sanity-redpanda-1 sh -c "rpk topic list | awk 'NR>1{print \$1}' | grep -E -- '-(batch-rm|testing|test)-[A-Za-z0-9]' | xargs -r rpk topic delete"
```

65 leftovers (239 partitions) were enough to fail fulltext on its own.

## Project configs are built, not pointed at

`projects` entries are inline objects, not package directories. jest validates a project against the
*project* schema, and a package's `coverageReporters`, `collectCoverage`, `forceExit` and
`testTimeout` belong to the run as a whole — left in place they printed ~130 "Unknown option"
warnings per run and were ignored anyway. `buildSharedConfig()` strips those keys, sets an explicit
`rootDir`, and adds `displayName` so jest's output names the package (`PASS @hcengineering/query
...`). The largest `testTimeout` among the projects is lifted to the run via `--testTimeout`;
without that, `@hcengineering/client` and `client-resources` silently dropped from 10s to jest's 5s
default.

## The live test counter overcounts

During a run jest's progress line climbs to about twice the real number (12200 for 6166 tests) and
snaps back at the end. The final summary is correct; only the live aggregate is wrong, and it
double-counts passed tests while counting skipped ones once.

This is jest, not the shared config: it reproduces on a vanilla two-project config pointing at plain
directories, where the counter peaks at 58 for a run whose real total is 44 (the two packages have
29 and 15 tests). Nothing to fix on our side.

## Running jest directly

`jest.config.js` at the repo root builds its `projects` from `pnpm-workspace.yaml` through the same
planner, so a new package needs no edit. `pnpm jest` runs it with jest's own reporter and accepts
jest's flags (`pnpm jest -t 'name'`) — note that a `testIsolated` package is not in that config, so
filtering for one of its tests matches nothing.

jest is a dependency of the packages, not of the root, and adding it to the root does not work:
pnpm 12 writes `node_modules/jest -> .pnpm/jest@29.7.0` while only the peer-suffixed
`jest@29.7.0_@types+node@..._ts-node@..._typescript@...` exists, leaving a dangling link that
survives `pnpm install --force`. `bin/jest.js` resolves the binary from a workspace package instead.

## Two bugs this surfaced

`pod-payment` leaked a handle: 151 tests passed in 0.8s and jest then never exited. Its script had
no `--forceExit`, unlike its 22 siblings, so the per-package phase hung on it for as long as it was
allowed to. The shared run hid this, because `--forceExit` is unioned across the group. `--forceExit`
added.

Three tests read files relative to `process.cwd()` — `pods/server` (`./bundle/model.json`) and
`services/rekoni` (`./demo/*.pdf`). In a shared run the cwd is the repo root, not the package. They
now resolve from `__dirname`.
