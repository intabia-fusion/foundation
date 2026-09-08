# Getting started

[← README](../README.md)

## Pre-requisites

- [Node.js](https://nodejs.org/en/download/) 24.x - pinned in [`.nvmrc`](../.nvmrc),
  `package.json` requires `>=24.0.0 <25.0.0`
- [pnpm](https://pnpm.io) 12.x - activated through Corepack, no global install needed
- [Docker](https://docs.docker.com/get-docker/) and
  [Docker Compose](https://docs.docker.com/compose/install/)

Verify Docker is available:

```bash
docker --version
docker compose version
```

Both amd64 and arm64 containers are supported on Linux and macOS.

## Installation

The repository is a [pnpm](https://pnpm.io) workspace: projects are listed in
`pnpm-workspace.yaml`, with a single `pnpm-lock.yaml` at the root. Rush is gone -
`rush` / `rushx` no longer exist, and `pnpm check-versions` replaces `rush check`.

1. Activate pnpm. Corepack ships with Node and pins the version from `packageManager`:

```bash
corepack enable pnpm
```

2. From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build
```

## Fast start

Builds everything and brings the local stand up in one go:

```bash
sh ./scripts/fast-start.sh
```

Then open <http://localhost:8087>.

## Build and run

All commands run from the repository root and accept `--to <package>` to scope the run to a
package and its dependencies.

```bash
pnpm build          # Compile every package: JS, .d.ts and sourcemaps in one tsc pass
pnpm build --force  # Same, ignoring the build cache
pnpm bundle         # Prepare bundles
pnpm package        # Build all webpack packages
pnpm svelte-check   # Optional. Validate .svelte files with svelte-check
pnpm docker         # Build Docker images for the local stand (curated pod list)
pnpm docker:build   # Same, for every package that defines a docker phase
pnpm docker:up      # Start all containers
pnpm boot           # pnpm docker && pnpm docker:up
```

Type checking is part of `pnpm build` - one native `tsc` (TypeScript 7) pass per package
emits `lib/` and `types/` together. There is no separate validate step. `pnpm docker` and
`pnpm docker:build` run build, bundle and package automatically.

Alternatively:

```bash
sh ./scripts/build.sh
```

Docker volumes named `dev_db`, `dev_elastic` and `dev_files` are created for the database,
Elasticsearch and MinIO instances. <http://localhost:8087> then serves the app.

Partial stands are available when you only need part of the system:

```bash
pnpm docker:up:server   # transactor + account only
pnpm docker:up:love     # meetings, AI bot, billing, payment, nginx
pnpm docker:up:backup   # main stand + backup service
```

**Limitation:** a local installation does not send emails, so password recovery and email
notifications are unavailable.

## Run in development mode

Development mode gives live reloading and a faster edit-check cycle. It talks to the
services from the local Docker stand, so start the stand first (`pnpm docker:up` or
`pnpm boot`).

```bash
pnpm build --to @hcengineering/prod
cd dev/prod
pnpm run dev-server
```

Then go to <http://localhost:8080>.

Select "Sign up" on the right panel, click "Sign up with password" at the bottom, enter the
new user's credentials and create a workspace for them.

The desktop (Electron) app:

```bash
pnpm desktop        # dev build + start
pnpm desktop:dist   # distributable package
```

## Common commands

```bash
pnpm build:watch        # Rebuild and type check changed packages on save
pnpm build:watch:lint   # Same, plus ESLint
pnpm build:lint         # One-shot build with ESLint
pnpm build:check        # Build + ESLint + svelte-check
pnpm format             # Format sources with prettier
pnpm format:branch      # Format only what changed against a base branch
pnpm check-versions     # Verify a single version of each dependency across packages
pnpm check-layers       # Verify package layering rules
pnpm model-version      # Show the current model version
pnpm ts-clean           # Drop TypeScript incremental state (*.tsbuildinfo)
```

`pnpm run` only sees the nearest `package.json`. From inside a package use
`pnpm -w run <script>` to reach the root scripts, and `pnpm --filter <pkg> add <dep>` to add
a dependency.

## Repository structure

Projects sit 2-3 levels deep, each with its own `package.json`.

| Path | Contents |
| --- | --- |
| `models/*` | Shared types and models. New components go to the api/resources/model package |
| `plugins/*` | Client plugins (UI + resources) |
| `packages/*` | Reusable utilities |
| `server/*`, `server-*`, `server-plugins/*` | Server packages |
| `foundations/*` | Core building blocks: `core`, `net`, `server`, `communication`, `stream`, `hulylake`, `utils` |
| `pods/*` | Deployable service bundles (`account`, `front`, `server`, `workspace`, `fulltext`, ...) |
| `services/*` | Standalone services (`ai-bot`, `love`, `billing`, `payment`, `github`, `telegram`, ...) |
| `desktop/`, `desktop-package/` | Electron app |
| `dev/` | Dev-server, docker-compose, local tooling |
| `tests/`, `ws-tests/`, `qms-tests/` | Integration and e2e tests (Playwright, Docker) |
| `common/` | Shared config and scripts |
| `docs/` | Project documentation, one file per topic |

Before writing a new `.svelte` component, check
[`docs/ui-components/`](./ui-components/README.md) - it catalogs the existing components of
`@hcengineering/ui`, `@hcengineering/presentation` and `plugins/view-resources`.

## Update project structure and database

If the project structure changes, relink and rebuild:

```bash
pnpm install
pnpm build
```

## Troubleshooting

If a build fails but the code is correct, retry ignoring the cache:

```bash
pnpm build --force
```

To also drop the TypeScript incremental state:

```bash
pnpm ts-clean
```

After adding a dependency by hand, run `pnpm check-versions` - nothing enforces a single
version across packages on its own.

Building on Windows: see the [WSL build guide](./wsl.md).

## Package publishing

```bash
node ./common/scripts/bump.js -p projectName
```
