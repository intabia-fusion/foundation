# Intabia Platform is an evolution of hcengineering/platform - extended and improved, with a focus on stability and enhancements in Tracker and other components.

![GitHub License](https://img.shields.io/github/license/intabia-fusion/foundation?style=for-the-badge)

⭐️ Your star shines on us. Star us on GitHub!

## About

An evolution of hcengineering/platform - extended, improved, and maintained by a Intabia and ex-hcengineering primary owners and engineers.

## Overview
The Intabia Platform is a robust framework and a team platform designed to accelerate the development of business applications, such as CRM systems.
This repository includes several applications, such as Chat, Issue Tracking, Project Management and various other services.

## Differences
Intabia Platform evolves the hcengineering Platform. For a concise list of how this branch differs from the original repository, see the `features.md` file at the repository root. It lists the main changes: new packages for media and streaming (for example, `foundations/hulylake`, `packages/audio-dsp`), updates to Docker images and local build scripts, removal of some legacy plugins, and other improvements.

## Self-Hosting

If you're primarily interested in self-hosting Foundation or moving from hcengineering Platform without the intention to modify or contribute to its development, please wait, instructions will follow.


## API Client

Foundation ships a single npm bundle for programmatic access:
[`@intabia-fusion/api`](https://www.npmjs.com/package/@intabia-fusion/api).

- Connect to a workspace, read and write documents via REST, subscribe to
  reactive updates over WebSocket (LiveQuery).
- Flat subpath exports mirror source packages:
  `@intabia-fusion/api/api-client`, `@intabia-fusion/api/core`,
  `@intabia-fusion/api/tracker`, `@intabia-fusion/api/contact`,
  `@intabia-fusion/api/chunter`, `@intabia-fusion/api/query`, etc.

```bash
npm install @intabia-fusion/api ws
```

```ts
import { NodeWebSocketFactory, connect } from '@intabia-fusion/api/api-client'
import tracker from '@intabia-fusion/api/tracker'

const client = await connect('http://localhost:8087', {
  email: 'user1', password: '1234', workspace: 'ws1',
  socketFactory: NodeWebSocketFactory, connectionTimeout: 30000
})
const issues = await client.findAll(tracker.class.Issue, {})
await client.close()
```

Sources and build pipeline: [`dev/api`](./dev/api/README.md) (build with
`node scripts/build-bundle.js` + `tsc` + `npm pack`, configuration in
`dev/api/config.yml`).

Runnable examples:
[`intabia-fusion/platform-examples`](https://github.com/intabia-fusion/platform-examples/tree/main/platform-api)
(tracker, contact, chunter, documents, WebSocket live-query). API is mostly
compatible with upstream Platform and is kept stable between minor versions.

## Changelog

For detailed information about changes, improvements, and bug fixes in each version, see our [Changelog](./changelog.md).

## Versions

The Platform uses two types of version tags to distinguish between production-ready and development releases:

- **Production Versions (`v*`)** - Stable releases for end users
  - Example: `v0.7.310`, `v0.7.307`, `v0.6.501`
  - These versions are recommended for production deployments
  - Suitable for self-hosted installations
  - Published with release notes on [GitHub Releases](https://github.com/hcengineering/platform/releases)

- **Development Versions (`s*`)** - Pre-release builds for developers
  - Example: `s0.7.313`, `s0.7.292`, `s0.7.288`
  - Used for development and testing purposes
  - May contain experimental features or bug fixes
  - Not recommended for production use

## Architecture

For detailed information about the platform architecture, services, and their interactions, see our [Architecture Overview](./ARCHITECTURE_OVERVIEW.md).

## Table of Contents

- [Platform](#platform)
  - [About](#about)
  - [Self-Hosting](#self-hosting)
  - [API Client](#api-client)
  - [Changelog](#changelog)
  - [Versions](#versions)
  - [Architecture](#architecture)
  - [Differences](./features.md)
  - [Table of Contents](#table-of-contents)
  - [Pre-requisites](#pre-requisites)
  - [Verification](#verification)
  - [Branches \& Contributing](#branches--contributing)
  - [Setup dev environment](#setup-dev-environment)
  - [Fast start](#fast-start)
  - [Installation](#installation)
  - [Build and run](#build-and-run)
  - [Run in development mode](#run-in-development-mode)
  - [Update project structure and database](#update-project-structure-and-database)
  - [Troubleshooting](#troubleshooting)
  - [Build \& Watch](#build--watch)
  - [Tests](#tests)
    - [Unit tests](#unit-tests)
    - [UI tests](#ui-tests)
  - [Package publishing](#package-publishing)
  - [Additional testing](#additional-testing)
  - [WSL build guide](#wsl-build-guide)

## Pre-requisites

- Before proceeding, ensure that your system meets the following requirements:
  - [Node.js](https://nodejs.org/en/download/) (v20.11.0 is required)
  - [Docker](https://docs.docker.com/get-docker/)
  - [Docker Compose](https://docs.docker.com/compose/install/)

## Verification

To verify the installation, perform the following checks in your terminal:

- Ensure that the `docker` commands are available:

```bash
docker --version
docker compose version
```

## Branches & Contributing

- The `develop` branch is the default branch used for production deployments.
  Changes to this branch are made from the `staging` branch once a version is ready for community use.

## Fast start

```bash
sh ./scripts/fast-start.sh
```

## Installation

The repository is a [pnpm](https://pnpm.io) workspace.

1. Activate pnpm. Corepack ships with Node and pins the version from `packageManager`:

```bash
corepack enable pnpm
```

2. Navigate to the repository root and run:

```bash
pnpm install --frozen-lockfile
pnpm build
```

## Build and run

Development environment setup requires Docker to be installed on system.

Support is available for both amd64 and arm64 containers on Linux and macOS.

All commands are run from the repository root and accept `--to <package>` to scope the run
to a package and its dependencies.

```bash
pnpm build          # Compile every package: JS, .d.ts and sourcemaps in one tsc pass.
pnpm build --force  # Same, ignoring the build cache.
pnpm bundle         # Prepare bundles.
pnpm package        # Build all webpack packages.
pnpm svelte-check   # Optional. svelte files validation using svelte-check.
pnpm docker         # Build Docker containers for the local stand (curated pod list).
pnpm docker:build   # Same, for every package that defines a docker phase.
pnpm docker:up      # Set up all the containers
```

Type checking is part of `pnpm build` - there is no separate validate step.
`pnpm docker` and `pnpm docker:build` automatically run build, bundle and package.

Alternatively, you can just execute:

```bash
sh ./scripts/build.sh
```

By default, Docker volumes named dev_db, dev_elastic, and dev_files will be created for the MongoDB, Elasticsearch, and MinIO instances.

Accessing the URL <http://localhost:8087> will lead you to the app in development mode.

Limitations:

- Local installation does not support sending emails, thus disabling functionalities such as password recovery and email notifications.

## Run in development mode

Development mode allows for live reloading and a smoother development process.

```bash
pnpm build --to @hcengineering/prod
cd dev/prod
pnpm run dev-server
```

Then go to <http://localhost:8080>

Select "Sign up" on the right panel and click the "Sign up with password" link at the bottom. Enter the new user's credentials, then proceed to create a workspace for them.

## Update project structure and database

If the project's structure is updated, it may be necessary to relink and rebuild the projects.

```bash
pnpm install
pnpm build
```

## Troubleshooting

If a build fails, but the code is correct, retry ignoring the cache:

```bash
# from the project root
pnpm build --force
```

To also drop the TypeScript incremental state:

```bash
pnpm ts-clean
```

## Build & Watch

For development purpose `pnpm build:watch` could be used: it rebuilds and type checks
changed packages on save. `pnpm build:watch:lint` additionally runs ESLint.

## Tests

### Unit tests

```bash
pnpm test # To execute all tests

pnpm run test # For individual test execution inside a package directory
```

### UI tests

```bash
pnpm install --frozen-lockfile
pnpm docker
cd ./tests
## creates test Docker containers and sets up test database
./prepare-pg.sh
## runs UI tests
cd sanity && pnpm run uitest --workers 2
```

## Package publishing

```bash
node ./common/scripts/bump.js -p projectName
```

## Additional testing

This project is tested with BrowserStack.

## WSL build guide

This guide describes the nuances of building and running the application from source code located on your NTFS drive, which is accessible from both Windows and WSL.

### Prerequisites

#### Disk Space Requirements

Ensure you have sufficient disk space available:
- A fully deployed local application in clean Docker will consume slightly more than **35 GB** of WSL virtual disk space
- The application folder after build (sources + artifacts) will occupy **4.5 GB**

If there's insufficient space on your system drive (usually `C:\`), you can change the virtual disk location in Docker Settings → Resources → Advanced.

#### Docker WSL Integration

Make sure Docker is accessible from WSL:

1. Go to Docker Settings → Resources → Advanced → WSL Integration
2. Select the distribution where you'll be building and running the application
3. Verify integration works by running this command in WSL:
   ```bash
   docker run hello-world
   ```

### Common Issues and Solutions

#### Git Line Endings on Windows

Windows Git often automatically replaces line endings. Since most build scripts are `.sh` files, ensure your Windows checkout doesn't break them.

**Solution options:**
- Checkout from WSL instead of Windows
- Configure Git on Windows to disable auto-replacement:
  ```bash
  git config --global core.autocrlf false
  ```
  This disables auto-replacement for all repositories on your machine.

#### Elevated Privileges in WSL

Some commands in the instructions require elevated privileges when working in WSL. If you're using Ubuntu distribution, prefix commands with `sudo`:

```bash
sudo npm install -g pnpm
```

#### WSL Configuration

If the source code is located on a Windows NTFS drive, then edit the `/etc/wsl.conf` file in WSL (e.g., `sudo nano /etc/wsl.conf`) and add the following content if it doesn't exist:

```ini
[automount]
enabled = true
root = /mnt/
options = "metadata,umask=22,fmask=11"

[interop]
appendWindowsPath = false
```

However, we recommend storing the repository on a WSL disk, as this dramatically improves build and maintenance operations.

### Running the Application

After these preparations, the build instructions should work without issues.

#### Port Conflicts

When starting the application (`pnpm docker:up`), some network ports in Windows might be occupied. You can fix port mapping in the `\dev\docker-compose.yaml` file.

**Important:** Depending on which port you change, you'll need to:
1. Find what's using that port
2. Update the new address in the corresponding service configuration

<sub><sup>&copy; 2025 <a href="https://hardcoreeng.com">Hardcore Engineering Inc</a>.</sup></sub>
