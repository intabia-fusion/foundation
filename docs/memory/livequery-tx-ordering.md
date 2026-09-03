# LiveQuery tx ordering vs ClientImpl.tx

`query.test.ts` (`limit and sorting`, `remove`) asserts one callback per tx. Delivery is a
microtask race: the connection calls `notify` -> `liveQuery.tx(...)` and never awaits it, so the
next `createDoc` can start before the previous tx flushed its callbacks, and `queriesToUpdate`
coalesces them (callback lost).

Making `ClientImpl.tx` apply the model synchronously (`model.addTxes` instead of
`await model.tx`) removed the only await in that path and flipped the race. Fix: `client.tx`
yields one turn after `conn.tx` before returning to the caller.

Rejected alternatives:
- Reverting `ClientImpl.tx`/`updateFromRemote` to `hierarchy.tx` + `await model.tx`. Breaks
  `client.test.ts` "renames an attribute of the loaded model" - the rename needs hierarchy and
  ModelDb to share one doc instance, which only `addTxes` gives.
- Serializing `LiveQuery.tx` through a promise queue. Fixed those two tests but broke
  `lookup reverse query remove doc` and `test clone ops`: strict serialization falls behind the
  create loop, and `test clone ops` checks `data.length` before awaiting the final callback.

Production UI is not affected either way: `packages/presentation/src/utils.ts` wraps notify in
`reduceCalls`. Unserialized consumers are `api-client` (`createLiveQuery`) and
`services/github/pod-github`.

A deterministic variant exists if the 1-turn yield ever proves too thin: widen `Client.notify` to
`(...tx) => void | Promise<void>`, keep the returned promise in `ClientImpl`, and await it in
`tx()`. Needs every notify handler to return its promise (the query tests' harness does not).

## Test gotcha

`foundations/core/packages/query/jest.config.js` has no `moduleNameMapper`, so tests run against
the **built** `foundations/core/packages/core/lib`, not `src`. Editing core sources without
`rushx build` changes nothing (stack traces still point at `core/src/*.ts` via source maps).
