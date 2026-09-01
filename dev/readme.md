# Docker Compose dev image

## Running platform inside docker compose

```bash
pnpm build
pnpm bundle
pnpm docker:build
docker compose up -d --force-recreate
```

## Running ElasticVUE to check elastic intance

```bash
docker run -p 8082:8080 -d cars10/elasticvue
```

## Time-machine + webhook

`time-machine` (`@hcengineering/pod-worker`) is the delayed-event scheduler: a message on
`QueueTopic.TimeMachine` is stored in Postgres (`time_machine.delayed_events`, schema/table
created by the service itself on start) and re-emitted to its target topic once `target_date`
elapses. `webhook` (`@hcengineering/pod-webhook`) is the inbound webhook API; it reuses
time-machine for retry scheduling.

```bash
rush fast-build:docker-build --to @hcengineering/pod-worker --to @hcengineering/pod-webhook
docker compose up -d time-machine webhook --force-recreate
```

Check it's alive:

```bash
docker compose logs time-machine | grep 'Time Machine worker started'
curl http://localhost:8087/_webhook/health   # {"status":"ok"}
```

Inspect the delayed-events table:

```bash
docker compose exec postgres psql -U postgres -c 'select * from time_machine.delayed_events;'
```

## Webhook mock (dev-only)

`webhook-mock` (`@hcengineering/pod-webhook-mock`) is a small standalone tool for exercising
`webhook` manually - a static HTML page, no build step, served by the pod itself. It does not talk
to Kafka/Postgres/account and needs no secret of its own.

```bash
rush fast-build:docker-build --to @hcengineering/pod-webhook-mock
docker compose up -d webhook-mock --force-recreate
```

Open the UI: <http://localhost:8087/_webhook-mock/>

**Sending an incoming webhook.** In the workspace, issue an API key with the `ops` you want to try
(Settings -> API keys, or whatever the current UI location is - see `docs/memory/webhook_api_keys.md`
for the key format `fus_<ws>_<hex>`). Paste the key into the left column - the workspace isn't asked
for, the key alone identifies it - pick one of the six action presets (`issue:create`, `issue:update`,
`issue:comment`, `chat:post`, `doc:create`, `doc:update`), edit the JSON body if needed, and press Send
- the mock's backend calls `POST /api/v1/webhook/action` (or `/k/:key` with the "key in path" option)
on the real `webhook` pod and shows the raw response, including `jobId`. Use "Poll job" to call
`GET /api/v1/webhook/job/:id` and see how the job resolved.

**Receiving an outgoing webhook.** The right column shows the address to paste into a workspace's
`WebhookEndpoint.url` - use the internal one (`http://webhook-mock:4044/receive`), since delivery is
sent pod-to-pod inside the compose network. Every delivery that arrives is listed with its time,
headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`, `X-Webhook-Delivery-Id`,
`X-Webhook-Attempt`) and raw body. Paste the endpoint's secret (`whsec_...`) into the "Receiver
secret" field to check the Standard Webhooks signature against each delivery - the mock recomputes it
with the real `signStandard` function from `pod-webhook`, not a second implementation, so a mismatch
here is a genuine signal. The response-mode radio (`200`/`500`/`429`) controls what the mock answers
incoming deliveries with, to watch `webhook`'s retry/backoff and endpoint-disable behavior.

**Known gap:** `webhook`'s outgoing-delivery SSRF guard (`services/webhook/pod-webhook/src/ssrf.ts`)
unconditionally blocks the private IP ranges `127/8, 10/8, 172.16/12, 192.168/16, 169.254/16` - which
covers a default docker-compose bridge network's own subnet (usually inside `172.16.0.0/12`) and
Docker Desktop's `host.docker.internal` gateway (usually inside `192.168.0.0/16`). So a
`WebhookEndpoint.url` pointing at `webhook-mock` (or at any other dev-reachable address) makes real
deliveries fail with `SsrfError` before they leave the `webhook` pod - the live
`webhook` -> `webhook-mock` round trip cannot be exercised as-is on this stand. The receiving side and
signature check above still work when hit directly (e.g. `curl -X POST .../receive` with hand-built
Standard Webhooks headers). A real fix needs a dev-only bypass in `ssrf.ts` (out of scope here - that
file was left untouched).
