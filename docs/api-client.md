# API client

[← README](../README.md)

Foundation ships a single npm bundle for programmatic access:
[`@intabia-fusion/api`](https://www.npmjs.com/package/@intabia-fusion/api).

- Connect to a workspace, read and write documents over REST, subscribe to reactive updates
  over WebSocket (LiveQuery).
- Flat subpath exports mirror the source packages:
  `@intabia-fusion/api/api-client`, `@intabia-fusion/api/core`,
  `@intabia-fusion/api/tracker`, `@intabia-fusion/api/contact`,
  `@intabia-fusion/api/chunter`, `@intabia-fusion/api/query`, etc.

## Install

```bash
npm install @intabia-fusion/api ws
```

## Connect and query

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

## Examples

Runnable examples covering tracker, contact, chunter, documents and WebSocket live-query:
[`intabia-fusion/platform-examples`](https://github.com/intabia-fusion/platform-examples/tree/main/platform-api).

The API is mostly compatible with upstream Platform and is kept stable between minor
versions.

## Building the bundle

Sources and build pipeline live in [`dev/api`](../dev/api/README.md): the bundle is produced
with `node scripts/build-bundle.js` + `tsc` + `npm pack`, and the exported surface is
configured in `dev/api/config.yml`.
