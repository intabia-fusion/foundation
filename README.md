<h1 align="center">
  <img src="./docs/images/logo.png" alt="Intabia Platform" height="72"><br>
  Intabia Platform
</h1>

<p align="center">
  An open-source platform for team work: issue tracking, chat, documents, virtual office and AI.<br>
  An evolution of <a href="https://github.com/hcengineering/platform">hcengineering/platform</a>, maintained by Intabia
  together with ex-hcengineering primary owners and engineers.
</p>

<p align="center">
  <a href="./README.ru.md">Русский</a> ·
  <a href="https://platform.intabia.ru">Website</a> ·
  <a href="./docs/getting-started.md">Getting started</a> ·
  <a href="./features.md">What is different</a> ·
  <a href="./changelog.md">Changelog</a>
</p>

<p align="center">
  <img alt="License" src="https://img.shields.io/github/license/intabia-fusion/platform?style=flat-square">
  <img alt="Node" src="https://img.shields.io/badge/node-24.x-success?style=flat-square">
  <img alt="pnpm" src="https://img.shields.io/badge/pnpm-12.x-orange?style=flat-square">
</p>

<p align="center">
  <img src="./docs/images/tracker.png" alt="Tracker" width="860">
</p>

⭐️ Your star shines on us. Star us on GitHub!

## What is inside

One repository, one build, a set of applications on a shared framework:

| | |
| --- | --- |
| **Tracker** | Issues, sub-issues, estimations, time reports, Kanban with swim-lanes |
| **Chat** | Channels and DMs, threads, replies and forwards, read receipts, web push |
| **Documents / QMS** | Collaborative editing, controlled documentation, markdown export |
| **Meetings** | Virtual office and video on LiveKit, including self-hosted installations |
| **AI Bot** | Kafka-backed assistant with persistent memory, meeting summaries |
| **Planner, Drive, HR, Contacts** | Personal planning, files, org structure, CRM-style contacts |
| **Integrations** | Telegram, Gmail, GitHub, calendars, Stripe billing, REST + WebSocket API |

<table>
  <tr>
    <td><img src="./docs/images/chat.png" alt="Chat"></td>
    <td><img src="./docs/images/meetings.png" alt="Meetings"></td>
  </tr>
  <tr>
    <td><img src="./docs/images/documents.png" alt="Documents"></td>
    <td><img src="./docs/images/planner.png" alt="Planner"></td>
  </tr>
</table>

## Quick start

Requires [Node.js 24](https://nodejs.org/en/download/), [Docker](https://docs.docker.com/get-docker/)
and Docker Compose.

```bash
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm boot            # build + build Docker images + start the local stand
```

Then open <http://localhost:8087>, select "Sign up" and create a workspace.

Even shorter, from a clean checkout:

```bash
sh ./scripts/fast-start.sh
```

Details, dev-server mode, watch builds and troubleshooting:
[**Getting started**](./docs/getting-started.md).

## Documentation

| Document | Contents |
| --- | --- |
| [Getting started](./docs/getting-started.md) | Pre-requisites, install, build, dev mode, common commands, troubleshooting |
| [Testing](./docs/testing.md) | Unit tests, Playwright UI tests, integration stands |
| [API client](./docs/api-client.md) | `@intabia-fusion/api` npm bundle, REST and LiveQuery examples |
| [WSL build guide](./docs/wsl.md) | Building on Windows through WSL |
| [Features](./features.md) | What this fork changes relative to upstream Platform |
| [AGENTS.md](./AGENTS.md) | Repository layout, code style, build workflow, conventions |
| [docs/](./docs) | Per-topic engineering notes (LLM, meetings, billing, regions, ...) |
| [Changelog](./changelog.md) | Changes per version |

## Versions

Two tag families:

- **`v*`** - production releases (`v0.7.310`, `v0.6.501`). Recommended for deployments,
  published with notes on [GitHub Releases](https://github.com/intabia-fusion/platform/releases).
- **`s*`** - development builds (`s0.7.313`, `s0.7.292`). Testing only, may contain
  experimental features.

## Self-hosting

If you are interested in self-hosting, or in moving over from the hcengineering Platform
without contributing to development, please wait - instructions will follow.

## Contributing

`develop` is the default branch used for production deployments. Changes land there from
`staging` once a version is ready for community use. Read [AGENTS.md](./AGENTS.md) before
your first pull request.

## License

[Eclipse Public License 2.0](./LICENSE).

<sub><sup>&copy; 2025 <a href="https://hardcoreeng.com">Hardcore Engineering Inc</a>. &copy; 2026 Intabia Fusion.</sup></sub>
