# Foundation Platform

TypeScript/Svelte 4 monorepo. Rush.js (pnpm), Node 24 (`.nvmrc`; rush.json accepts >=20 <25), Webpack 5, Electron, Jest.

## Repository Structure

- `models/*` - Shared types/models. New components go to api/resources/model package
- `server/*`, `server-*`, `server-plugins/*` - Server packages
- `plugins/*` - Client plugins
- `packages/*` - Reusable utilities
- `pods/*` - Deployable service bundles
- `services/*` - Standalone services
- `desktop/`, `desktop-package/` - Electron app
- `dev/` - Dev-server, docker-compose, local tooling
- `tests/`, `ws-tests/`, `qms-tests/` - Integration/e2e (Playwright, Docker)
- `common/` - Shared Rush config, scripts
- `docs/` - Project documentation (per-topic files)

Projects sit 2-3 levels deep, each with its own `package.json`.

## UI Components

Before writing a new `.svelte` component, check [`docs/ui-components/`](docs/ui-components/README.md): catalogs of
`@hcengineering/ui`, `@hcengineering/presentation` and `plugins/view-resources` (purpose + key props per component,
"which of the similar ones" guide, `view.component.*` registry) and the two ways to reuse a component across plugins
without a dependency cycle.

The catalog is maintained with the code, in the same PR: adding, renaming or removing an exported component (or its
key props, or a `view.component.*` id) in those three packages updates the matching table row; a new component that
overlaps an existing one gets a bullet in "Выбор между похожими". Rules in the catalog README.

## Build & Validation

Use `rush fast-build:*`. All accept `--to PKG` to scope to a package + dependencies.

```bash
rush update                       # Install/update deps
rush fast-build:validate          # Compile + validate
rush fast-build:bundle            # Compile + bundle
rush fast-build:package           # Compile + bundle + package
rush fast-build:docker-build      # Compile + bundle + docker build
rush svelte-check                 # Compile + validate + svelte-check
rush fast-build:watch:validate    # Watch + validate
rush add -p PKG                   # Add dependency
```

Flags: `--to PKG`, `--list`, `-v/--verbose`, `--force` (disable cache).

### Scoped validation after edits

```bash
# Strict: compile + typecheck + eslint. Default check.
rush fast-build:lint --to @hcengineering/<pkg>

# Lighter: compile + typecheck only.
rush fast-build:validate --to @hcengineering/<pkg>
```

`fast-build:lint` is a superset of `fast-build:validate`. Cache is content-hashed; add `--force` to bypass.

Per-package direct (fastest inside one package):

```bash
cd <package-dir>
rushx _phase:validate
rushx build
```

Not every package defines `lint`. On "command not defined", use `rushx _phase:validate` or `rush fast-build:lint --to <pkg>`.

Do NOT:
- Run `rush fast-build:validate` without `--to` (hits unrelated broken packages).
- Run `rush build` for error checking.
- Run `rushx format` (user handles it).

### Docker Workflow

Changes under `services/` or `pods/` require Docker rebuild:

```bash
rush fast-build:docker-build --to @hcengineering/pod-ai-bot
docker compose -f dev/docker-compose.yaml up -d aibot --force-recreate
```

UI via `rush dev` auto-picks changes, no container restart needed.

## Changelog

```bash
git log --pretty=format:'- %h %s' <range> | grep -v -F 'Merge remote-tracking' | sed -E 's/\s*Signed-off-by:.*$//'
```

Full workflow: `docs/changelog.update.task.md`.

## License Headers

**Existing files**: NEVER replace or rewrite the existing license header. Only ADD a `Copyright © <year> Intabia Fusion.` line alongside the original copyright (keep original Hardcore Engineering / other copyrights intact). Do not touch the license terms block.

**New files only**: use the full header below.

**TypeScript** (new files):
```ts
//
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//
```

**TypeScript** (modified files with prior copyright):
```ts
//
// Copyright © 2025 Hardcore Engineering Inc.
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// ...
```
Keep existing copyright lines, add `Intabia Fusion` line if missing.

**Svelte** (HTML comment, `//` prefix):
```svelte
<!--
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
-->
```

**Existing file example** (add Intabia line, keep original):
```ts
//
// Copyright © 2023 Hardcore Engineering Inc.
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// ... (rest unchanged)
//
```

## Sanity tests (Playwright)

Run from `tests/sanity/`. Stand must be up at `localhost:8083`. Always use `rushx uitest` - it
wires `LOCAL_URL`, `DEV_URL` and the config.

```bash
cd tests/sanity

rushx uitest                                   # full suite
rushx uitest -g "<title>"                      # one test
rushx uitest tests/tracker/kanban.spec.ts      # one file
rushx uitest --workers=1                       # serial; sanity tests share workspace state
```

Flags:
- `--workers=1` - serial. Use for love/meeting tests, they share workspace state.
- `-g "<name>"` or append `:LINE` to the spec path to run a single test.
- Extra playwright flags pass through `rushx uitest` unchanged.

Do not run bare `npx playwright test` - without `rushx uitest`'s env wiring and
`-c ./tests/playwright.config.ts` neither dotenv nor `storageState` load, and every test fails on
login with `BadRequest`.

### Tracing and retries

`on-first-retry` everywhere, local and CI alike. A green run then pays nothing, and a failure that
reproduces is traced by its own retry. Override with `TRACE_MODE` (`retain-on-failure`, `on`,
`off`, `on-all-retries`); an unknown value warns and falls back to the default.

**Turn tracing up when hunting a flake.** `on-first-retry` traces the retry, which for a flake is
the attempt that *passed* — the trace shows a green run and says nothing about why the first one
failed. `TRACE_MODE=retain-on-failure` keeps the failing attempt's trace instead, at the cost of
recording every test: a full trace (`snapshots` + `screenshots` + `sources`, ~18MB per test) is
written for all of them and thrown away on pass. That is the whole reason it is not the default —
it roughly doubles a local run. Turn it on for the run where you are chasing the flake, off again
after.

`--retries=0` is no longer needed to keep runs fast either way. The same default and the same
`TRACE_MODE` override apply to `qms-tests/sanity` and `ws-tests/sanity`.

`html` is configured with `open: 'never'`; without it the reporter parks a server on failure and
hangs the terminal.

Reports after a run: `playwright-report/index.html`, `playwright-report.json` (machine-readable
twin), `allure-results/`, traces under `test-results/`.

### Reading a failed run

Do not dig through the html report by hand:

```bash
cd tests/sanity && node analyze_failures.js     # real failures vs flakes, grouped by error
node analyze_failures.js --all                  # every test, not just the top ones
```

A test that passed on a retry is a flake; one still red after its retries is a real failure. The
tool groups both by error class and by file, prints ready-to-paste `show-trace` commands and the
slowest tests. Locally the suite runs at roughly 7% first-attempt flakiness, so a large flake
count is normal - what matters is the real-failure number. Local-only failures around
love/meetings usually mean LiveKit, not a regression; CI is the reference.

The evidence of a run is destroyed by the next one. `test-results/` is wiped when a run starts,
and *any* invocation through this config rewrites `playwright-report.json` and
`playwright-report/` - including `playwright test --list`, which leaves a report of 416 skipped
tests behind. Copy what you need before rerunning:

```bash
cp -r test-results /tmp/run-$(date +%s)      # error-context.md, screenshots, traces
cp playwright-report.json /tmp/
```

### Whole-run profiling

`tests/do-test.sh` brings the stand up, runs the suite and reports hot paths across every pod:

```bash
cd tests
./do-test.sh                       # prepare stand, run tests
./do-test.sh --profile             # + CPU-profile every Node pod, print a hot-path report
./do-test.sh --profile --heap      # sample allocations instead
./do-test.sh --no-prepare -g "X"   # reuse a running stand
./do-test.sh --report-only         # re-report from ./profiles
```

The service list is generated from the running compose project by `gen-profile-overlay.js`, so a
branch that adds or drops a pod needs no edit. Profiles land in `tests/profiles/<service>/`; `./profile-report.sh` resolves frames back to source
through each bundle's source map and refuses to resolve when the bundle on disk no longer matches
the one the container ran. Collect only via `./profile-collect.sh` or `docker compose stop` - a
SIGKILL loses the profile. Details in `tests/readme.md`.

For everything love/meetings (model, protocols, defects, test setup with LiveKit and `meetings-ws`), see [`docs/love.md`](docs/love.md).
