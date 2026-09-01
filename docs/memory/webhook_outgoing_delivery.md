# pod-webhook: outgoing delivery

TSK-2026-09-01-023..028,058,060,061. Same pod as the incoming side (`services/webhook/pod-webhook`),
a second consumer (`src/delivery.ts`) on `QueueTopic.WebhookDelivery`.

## Model - `plugins/setting`/`models/setting`, not account-client

`setting.class.WebhookEndpoint` (`TWebhookEndpoint`, `DOMAIN_SETTING`, space `core.space.Workspace` -
same convention as `Integration`). Workspace-scoped config (url/events/secrets/enabled/failureCount),
unlike API keys (`IntegrationSecret` in account DB) which are control-plane identity, not workspace
data. `models/all` already wires `models/setting`'s `createModel` into every workspace - no migration
needed, verified by building `@hcengineering/model-all` clean.

## Input contract for the (separate) tx-translator

`WebhookDeliveryMessage` (`src/types.ts`): `{deliveryId, workspace, endpointId, event, attempt}`.
`event` is opaque - whatever TSK-059/062 assembles (Linear-shaped body). `webhookId`/`webhookTimestamp`
are added by the delivery worker right before signing, not by the producer - a retry needs a fresh
timestamp (receiver's 5-minute replay window) but the same id (idempotency), and only the worker knows
which attempt it's on. One message = one (recipient, event) pair; fan-out across subscribed recipients
is the translator's job.

## Signing (`src/signature.ts`)

- Secret format: `whsec_<base64(32 bytes)>` for real Standard Webhooks compatibility (HMAC key =
  base64-decoded payload after the prefix) - the plan's stated reason for picking that scheme.
- `slack`/`github` schemes HMAC the raw secret string bytes instead (they don't know the whsec_
  convention); slack also needs `X-Slack-Request-Timestamp` alongside `X-Slack-Signature` to verify -
  added even though the plan snippet only named the signature header.
- Rotation: `secrets: WebhookSecretEntry[]`, up to 2. Standard scheme signs with every active secret,
  space-separated `v1,<sig>` values in one `webhook-signature` header (Standard Webhooks' own rotation
  mechanism). Slack/github can only carry one signature - sign with the newest secret during rotation.
- `X-Webhook-Delivery-Id`/`X-Webhook-Attempt` sent regardless of scheme (TSK-060), since Slack/GitHub
  schemes have no id/retry header of their own.

## SSRF (`src/ssrf.ts`)

Blocklist is the exact plan list, nothing wider: `127/8, 10/8, 172.16/12, 192.168/16, 169.254/16,
::1, fc00::/7`. IPv4-mapped IPv6 (`::ffff:a.b.c.d`) resolves through the IPv4 check too - otherwise a
literal `https://[::ffff:127.0.0.1]/` bypasses it. `fe80::/10` (IPv6 link-local) is deliberately NOT
blocked - the plan's list doesn't include it.

Two checks: `resolveAll`+`assertAllowed` before building the request (fail fast), and a custom `lookup`
option on `http(s).request` that re-resolves and re-checks right before the socket opens (defends DNS
rebinding - the two lookups can answer differently). Both route through `ssrfPolicy.assertAllowed`, a
mutable indirection that exists only so tests can stub the connect-time check to isolate HTTP mechanics
(timeout/redirect/size-cap tests need a real local server, which is always 127.0.0.1 - and that address
is unconditionally blocked by the real policy, so those tests can't exercise it unmocked).

No redirect-following code needed - `http.request`/`https.request` never do it on their own, unlike
`fetch`. A 3xx response is returned to the caller like any other status.

## Retry / disable policy

- Retryable: `408/409/425/429` + any `5xx`. Everything else (other 4xx, 3xx, `SsrfError`) is permanent.
- Backoff extracted to `src/retry.ts` (`scheduleRetry`/`backoffDelayMs`, `MAX_ATTEMPTS=5`) and shared
  with the incoming consumer, which used to inline the same schedule - same 30s/1m/2m/4m/8m.
- `failureCount` is NOT the per-job attempt counter (that's `job.attempt`, resets per delivery)- it's
  consecutive **final** failures across different deliveries, resets on any 2xx. Disables past
  `Config.WebhookDisableAfterFailures` (default 3). Chosen over "disable after one event's retries are
  exhausted" so one bad event (e.g. a receiver bug on one payload shape) doesn't take out an otherwise
  healthy endpoint - closer to how GitHub/Stripe do it.

## Owner notification - had to route around account-service, not through it

Traced the two account-client calls that could answer "who owns this workspace":
`getWorkspaceMembersInfo` is `checkAdminRead`-gated (admin only); `getAccountInfo` only allows services
`workspace`/`tool` (`server/account/src/operations.ts`/`serviceOperations.ts`). Neither takes `webhook`,
and adding it means editing `server/account`, out of bounds for this task. `getWorkspaceMembers()` (the
token-scoped one) requires the caller to already hold a role in that workspace - a system token doesn't.

Fix: resolve the endpoint's `modifiedBy` (`PersonId`, always present, unlike optional `createdBy`)
through the workspace's own `contact.class.SocialIdentity` via the transactor REST client the delivery
worker already has - `findOne({_id: modifiedBy})`, then if it's not an email identity, a second
`findOne({attachedTo, type: EMAIL})`. No account-service change needed.

Email itself goes out through `QueueTopic.NotificationQueue` with `{type:'email', data:{to,subject,
text,html}}` - the same ad-hoc producer pattern billing/crm/gmail-resources each use (no shared package
exists for this; `services/mail`'s consumer only cares about the wire shape).

## `getSystemTransactorTarget` (`src/workspaceClient.ts`)

Refactored `getTransactorTarget` to share its endpoint cache and REST-client construction with a new
system-token variant: `generateToken(systemAccountUuid, workspace, {service:'webhook'})`. Acts as the
platform (full read/write on its own `WebhookEndpoint` docs), not as any integration - there's no API
key behind a delivery, so there's nothing to impersonate.

## Tx-to-event source (TSK-059/062/064/065)

New files: `src/eventTable.ts` (mapping table) + `src/txTranslator.ts` (batch consumer, collapsing,
dispatch), `WebhookEvent` type added to `src/types.ts` (`WebhookDeliveryMessage.event` tightened from
`Record<string, unknown>` to it).

**Mapping table location.** `src/eventTable.ts`, next to `src/operations.ts` (the incoming side's
`isKnownOperation`/`markdownFields`) - both describe the same six domain concepts (issue create/update/
comment, chat post, doc create/update). The real *executor* registry lives in `pods/server/src/opsApi.ts`
now (post-FUSIO-1151 move) but that's read-only here and structurally wrong anyway: it's a deployable,
webhook can't depend on it as a library. pod-webhook is the only place that already speaks both
vocabularies (validates incoming actions against account-client's `apiKeyOperations`, reads the raw tx
stream here), so it's the only place the table could live.

**`updatedFrom` without "before" in the Tx message.** Confirmed by reading `TxUpdateDoc.operations:
DocumentUpdate<T>` (`tx.ts:295-308`) and how `QueueMiddleware` (`foundations/server/packages/middleware/
src/queue.ts`) publishes to `QueueTopic.Tx`: only new values ever travel (`Partial<Data<T>>`-shaped for
plain field writes), never old ones - true for every consumer of that topic (fulltext, activity,
notifications, ai-bot, love, ...), not a webhook-specific gap. `services/activity/src/cache.ts`
(`WsCache`) hits the identical problem building "changed status from X to Y" activity messages and
solves it with an in-process `Map<objectId, Doc>` seeded by `TxProcessor.createDoc2Doc`/kept current by
`updateDoc2Doc`, falling back to a REST `findOne` on a cold miss.

Mirrored the same idea but smaller: `ObjectCache = Map<"workspace:objectId", Record<field, value>>` in
txTranslator.ts, storing only the handful of fields any rule tracks (not a full Doc - our tracked fields
are always plain `Partial<Data<T>>` writes, so `operations[field]` already *is* the new value, no
`TxProcessor` replay needed). Seeded on `create`, read-then-overwritten on `update`, dropped on `remove`.
**Price, stated plainly:** no REST fallback (unlike WsCache) - a pod restart, a consumer-group rebalance
moving an object to a different replica, or the first update this pod ever sees for an object created
before it started, all mean that field's `updatedFrom` comes back as an empty `{}` (omitted key, not a
guessed value) for one update, then is accurate from then on. A true fix needs either a persistent
snapshot store or a per-field history read API - neither exists, and building one is a materially larger
feature than this task. Capped at 50k entries (soft, insertion-order eviction, not real LRU) so a
long-lived pod doesn't grow it forever.

**Batching.** `queue.createBatchConsumer<Tx>(QueueTopic.Tx, ...)` (same primitive `pods/fulltext/src/
manager.ts` already uses for the same topic), `batchSize: 200`. Grouped workspace -> space -> objectId
via nested `Map`s in first-occurrence order (`Map` iterates in insertion order) - that ordering is what
"different objects aren't collapsed, order within a space is preserved" rests on, no separate index
needed. `TxMixin` is excluded at the grouping filter (only Create/Update/Remove pass) - none of our
rules touch mixins, and a mixin has no `operations` field, so letting one reach the update-collapse path
would throw. `core.space.DerivedTx` txs (trigger side-effects) are dropped too, same one-line filter
`services/activity/src/worker.ts` uses.

**Collapsing, resolved per (object, matched rule) not per object.** The plan's table ("несколько update
-> один update") reads at the object level, but the six named events include two different update facts
on the same class (`issue.status_changed`, `issue.assigned`) - collapsing "assignee changed then status
changed" into a single event would silently drop one of them for a receiver subscribed to only one type.
Implemented instead: group touched fields within an update-only run, one output event per distinct field
touched (repeat writes to the *same* field still collapse to one, last write wins for `data`, cache
value from before the run's first touch for `updatedFrom`) - documented as a deliberate reading of an
ambiguous spec, not a deviation. create-then-update still collapses to a single `create` regardless of
how many fields changed (there's no "before" to speak of - the object didn't exist). A run ending in
`remove` collapses to `remove` regardless of what came before it in the same batch (generalizes
"update+remove -> remove" to also swallow a leading create) - tested with a synthetic remove rule since
none of the six named events is remove-flavoured; a real one is a one-line table addition.

**Recipients.** One `findAll(setting.class.WebhookEndpoint, {enabled:true})` per workspace per batch
(not per event) via `getSystemTransactorTarget`, filtered in-process by `endpoint.events.includes(type)`
- `enabled` is checked again client-side too (defense in depth, doesn't rely solely on the query filter).
One `WebhookDeliveryMessage` per (event, matching endpoint), `attempt: 0`, batched into one
`producer.send` per workspace.

**Not built:** `url` on `WebhookEvent` - kept in the wire shape (optional) but never populated. A real
deep link needs per-class knowledge this pod doesn't have cheaply: an issue's human-identifier
(`FUSIO-42`) lives on its `Project`, not the issue, and requires a lookup this pod doesn't otherwise
need (`server-plugins/tracker-resources/src/index.ts`'s `issueUrlPresenter`/`getIssueId` do this inside
the transactor's `TriggerControl`, which this pod deliberately doesn't hold - `RestClientAdapter`/model
caching were removed from pod-webhook for the same "no per-workspace model" reason, see the note above
in this file); a document's link needs a title slug (`server-plugins/document-resources`'s
`getDocumentId`, needs a `slugify` dependency this pod doesn't have). Scoped out rather than adding a
`FrontUrl` config + a hierarchy/model dependency for one field with no other use in this task.
Rule matching for `objectClass` is now hierarchy-derived (see below) - an `Issue` under a custom task
type's `targetClass` is picked up like a plain `tracker.class.Issue`. `attachedToClass` (the
create-rule attachment narrowing, e.g. comment-on-Issue vs comment-on-Channel) is still exact-match
only - a comment on a custom-typed issue won't produce `issue.commented`. Not fixed here (out of the
task's stated scope), same shape of gap, one-line-ish follow-up using the same class cache.

## Hierarchy-derived rule matching (FUSIO-1151 follow-up)

`domainRules` (`eventTable.ts`) stays written against base classes only. `txTranslator.ts` resolves
each tx's `objectClass` to whichever ancestor is in the rule table before matching, via
`resolveClassesForBatch` (async, I/O) called once per batch **before** `buildEventsForBatch` (kept
pure/sync - tests still call it with no mocking). The resolved-or-negative outcome is written into
`ClassResolutionCache` (`Map<"workspace:classRef", Ref<Class<Doc>> | null>`), which `buildEventsForBatch`
then only reads.

**Why `findAll(core.class.Class, {}, {projection:{_id:1,extends:1}})` over `getModel()`.** Class/mixin
docs live in `DOMAIN_MODEL` ('model' domain, `models/core/src/core.ts:214` `@Model(core.class.Class,
core.class.Doc, DOMAIN_MODEL)`) and are queryable through the same `/api/v1/find-all` route as any other
domain - no special-casing in `pods/server/src/rpc.ts`/`client.ts`. `getModel()` instead replays the
workspace's entire tx history client-side to rebuild a `Hierarchy`/`ModelDb` - exactly the per-workspace
model load this pod was built to avoid (see the "no model held" note above). Whole-platform class+mixin
count is ~450 (`grep -c '^@Model('/'^@Mixin(' across `models/*/src`) - a custom task type's `targetClass`
is a real `core.class.Class` doc (`plugins/task/src/utils.ts` `client.createDoc(core.class.Class,
core.space.Model, {extends: data.ofClass, ...}, targetClassId)`, then mixed with
`task.mixin.TaskTypeClass` - the mixin is metadata on top, not a different `_class`), so the bulk fetch
sees it directly.

**Cache is pure memoization, no TTL.** A class ref is never reused (task-type target classes are
`${taskId}:type:mixin`, taskId itself unique), and class creation strictly precedes any tx for a doc of
that class - so the first time an unresolved class is seen, the model already contains it. Once resolved
(positive *or* negative), never re-resolved. Capped at 20k entries (same insertion-order eviction as
`ObjectCache`, `capCache` generalized to take the cache+max instead of hardcoding `ObjectCache`).
Fetches the whole per-workspace class table once per still-unresolved batch (not once per class) -
misses within one batch share one fetch.

**Failure mode matches `dispatch`**: a transactor-unreachable error during `resolveClassesForBatch` logs
and rethrows (not swallowed), so `createBatchConsumer` redelivers the batch instead of losing events.

## Settings UI (TSK-2026-09-01-029/030) - delivery history + test send

**`setting.class.WebhookDelivery`** (`plugins/setting`, `models/setting`, `DOMAIN_SETTING`) - new class,
one doc per *finished* delivery (2xx success, or gave-up-retrying failure), not per retry attempt: written
right next to `delivery.ts`'s existing `onSuccess`/`finalizeFailure` calls, which already do one
`updateDoc` per terminal outcome - `recordDeliveryOutcome` (exported from `delivery.ts`) adds one more
`createDoc` there, not a write per attempt. Capped at 20 per endpoint: `findAll` sorted `createdOn` desc
limit 21, remove the 21st if present - at most one extra `removeDoc` per write, never a separate sweep.
Deliberately NOT the source of truth for endpoint health (`failureCount`/`lastError`/`enabled` on
`WebhookEndpoint` still own that) - a test send (below) writes history too but never touches those fields.

**Test send - new pod route, not the queue.** `POST /api/v1/webhook/:workspace/test/:endpointId` in
`server.ts`, session-token authenticated (`decodeToken` from `@hcengineering/server-token`, checking
`decoded.workspace === params.workspace` - same trust level as `Backup.svelte`'s direct-to-pod calls,
no server-side role check, the settings category is already Owner-gated in the model). Synchronous: calls
`buildDeliveryHeaders`/`safeFetch` directly (the exact functions `processDelivery` uses) and returns the
HTTP result in the response body instead of going through `QueueTopic.WebhookDelivery` - a test has to
show its own result, and a queued/polled round trip would be needless complexity for one-shot feedback.
No retry, no failureCount/enabled effect, but the attempt is still recorded via `recordDeliveryOutcome`
(distinguishable by its `test_`-prefixed `deliveryId` if that's ever needed).

**`generateWebhookSecret` moved to `@hcengineering/setting`** (`plugins/setting/src/webhookSecret.ts`) -
the browser (secret creation/rotation) can't import this pod, a deployable. `signature.ts` now re-exports
it instead of keeping a second copy. Rewritten on Web Crypto (`crypto.getRandomValues`+`btoa`) instead of
`crypto.randomBytes`/`Buffer` - the old impl was Node-only and would not have bundled for the browser.
Same `whsec_<base64>` output format, same security level (both are OS/browser CSPRNGs) - existing
`signature.test.ts` (format + uniqueness only, no byte-exact fixture) needed no change.

**`webhookEventTypes`/`WebhookEventType`** (`plugins/setting`) - the six domain event names, shared
between the UI's checkboxes and `eventTable.ts`'s `domainRules`. `DomainRule.type` (all three rule kinds)
is typed as `WebhookEventType`, not `string` - a 7th event name added to `eventTable.ts` without a
matching entry in the shared list fails to compile, so the two genuinely cannot drift apart. Cost: one
pre-existing test (`txTranslator.test.ts`) used a synthetic `'issue.removed'` rule type to test the
remove-collapsing logic generically (no real rule is remove-flavoured yet) - needed an explicit
`as WebhookEventType` cast at its two call sites, a deliberate opt-out for a test exploring behavior
outside the real vocabulary, not a loosening of the production type.

**`WebhookServiceUrl` config wiring** - mirrors `BackupUrl`'s pattern exactly (`setting.metadata.*` +
`getMetadata(presentation.metadata.Token)` bearer, browser calls the pod directly, no transactor hop).
Wired through the same 6 files `BackupUrl` touches: `pods/front/src/__start.ts`,
`dev/prod/src/platform.ts` (+types inline), `desktop/src/ui/platform.ts`/`types.ts`,
`dev/prod/public/config-dev.json`. `dev/nginx.conf` already had a `/_webhook` location (built for the
webhook-mock dev setup) proxying to the same pod, so dev config just points at
`http://localhost:8087/_webhook` - no nginx change needed. `docker-compose.yaml`'s `front` service gets
`WEBHOOK_SERVICE_URL=...` (distinct name from the *unrelated* pre-existing `WEBHOOK_URL` used by
love's own webhook feature and by webhook-mock's own env - reusing that name would have been confusing
even though the two are different service blocks).

## Delivery/ingest counters - `WebhookStat` (FUSIO-1151)

One satellite doc per `(direction, target, type)` (`setting.class.WebhookStat`, DOMAIN_SETTING), not a
`Record<type, number>` field on `WebhookEndpoint`/the API key - `$inc` (`operator.ts`) only writes flat
top-level numeric properties, a map field would need read-modify-write and lose increments under
concurrent deliveries. `_id` is deterministic (`${direction}:${target}:${type}` -
`services/webhook/pod-webhook/src/stats.ts`'s `bumpWebhookStat`): direction/target never contain `:`
(target is a `randomUUID()` keyId or a `generateId()` endpoint ref, both colon-free), so the join is
collision-free even though `type` can be (an `ApiKeyOperation` like `issue:create`). A plain SQL UPDATE
on a missing row is a silent no-op (postgres adapter's `txUpdateDoc`), so existence is checked with
`findOne` first rather than by catching a failed update; the concurrent-first-write race is handled by
catching the loser's `createDoc` duplicate-key error and falling back to the same `$inc`. Outgoing
(`delivery.ts`) bumps `(out, endpoint._id, event.type)` once per terminal outcome (success or
gave-up-retrying) from `onSuccess`/`finalizeFailure`, never from `retryOrFinalize` - one bump per
delivery, not per attempt. `bumpWebhookStat` never throws (logs and swallows) - a counter must not
break a delivery. Incoming side (`consumer.ts`) bumps `(in, keyId, action)` only after the transactor
call actually succeeds - see `docs/memory/webhook_ingest_pod.md`.

**Settings category + components** - `setting.ids.Webhooks`/`component.Webhooks` in `plugins/setting`
(needed by `models/setting`'s category doc, `role: AccountRole.Owner`, next to `apiKeys`); everything else
UI-local lives in `plugins/setting-resources/src/plugin.ts` (same merged `setting` plugin id as ApiKeys'
strings - one lang-file namespace). Two components, not three like ApiKeys: `WebhooksSettings.svelte`
(list, `createQuery` on `WebhookEndpoint`) + `WebhookEndpointPopup.svelte` (create AND edit AND secrets
AND history AND test-send in one `Modal` - `okAction` doesn't auto-close in this codebase's `Modal`, so
create-then-immediately-show-secret is just "swap `endpoint` from undefined to the created doc, stay
open," no second popup needed). Differs from ApiKeys deliberately: a webhook secret must stay retrievable
after creation (the receiver may need it again), unlike a one-time-shown API key - masked by default,
per-secret reveal toggle, not a "shown once" dialog.
