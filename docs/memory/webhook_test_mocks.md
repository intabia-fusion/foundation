# Webhook test mocks (FUSIO-1151)

`services/webhook/pod-webhook/src/__tests__/`: `webhookSender.ts` (incoming - drives the pod's real
express app on a random port via fetch) + `mockReceiver.ts` (outgoing - plain `http` server capturing
raw request bytes, for when delivery ships). Kept in the pod's own `__tests__`, not a new package -
receiver has no other consumer yet; move it if a second package needs it.

- `server.test.ts` refactored to use `webhookSender.ts` instead of its own local `startServer`/
  `postAction`/`postPathKey` - avoids two near-identical helpers in one file.
- `internal_error` is NOT reachable through the public HTTP path in tests: it only fires when
  `producer.send()` throws, which requires mocking the producer to reject - not something an external
  caller can trigger through the API surface. Skipped, per task instruction not to force it.
- `no-confusing-void-expression` (standard-with-typescript) flags `server.close(() => resolve())` -
  `resolve()` returns void, arrow shorthand implicitly returning it is an error. Fix: braces,
  `() => { resolve() }`.
- `mockReceiver.close()` destroys tracked sockets before `server.close()` - otherwise a keep-alive
  connection (undici's default) leaves `close()`'s callback waiting and jest hangs.
