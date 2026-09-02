# calendar.class.BusySlot API tests

`ws-tests/api-tests/src/__tests__/calendar-busy.test.ts` covers the FUSIO-1308
BusySlot trigger (`server-plugins/calendar-resources/src/index.ts`
`syncBusySlot`/`removeBusySlot`, invoked from `OnEvent`).

## Fixtures reused
- `getWorkspaceToken`/`createRestClient`/`ensureEmployee` pattern from
  `love-invite-flow.test.ts` (workspace `api-tests`, accounts `user1`/`user2`,
  password `1234`).
- `eventually()` poll helper from `workflow.fixtures.ts` — used instead of a
  new sleep loop.
- System-token `RestClient` (`generateToken(systemAccountUuid, ...)`) to read
  Person/PersonSpace/BusySlot without space-security filtering, same as
  `love-invite-flow.test.ts`.

## Non-obvious facts
- `api-tests` workspace membership is fixed to `user1`+`user2` only
  (`dev/test-base/src/stands.ts`) — no third account available in this
  workspace. The isolation test does NOT need a third account: it creates an
  event where `participants: [user1Person._id]` only, so `user2` (a real
  workspace member, but not a participant) is the "non-participant" case.
- Default per-user Calendar id is deterministic: `` `${accountUuid}_calendar` ``
  (see `getPrimaryCalendar` in `plugins/calendar/src/utils.ts` and
  `createCalendar` in `server-plugins/calendar-resources/src/index.ts`) — no
  need to query for it, just build the ref.
- `calendar.space.Calendar` is a `core.class.SystemSpace`; `SpaceSecurityMiddleware`
  treats every `SystemSpace` as readable by any non-guest account regardless
  of `members`/`private` (`getAllAllowedSpaces`, `systemSpaces` bucket) — this
  is what makes `BusySlot` world-readable, not a BusySlot-specific rule.
  `contact.class.PersonSpace` is a plain private `Space` (`members: [account]`),
  so Event copies there get normal per-space filtering — a non-participant's
  `findAll` on `calendar.class.Event` silently returns `[]`, no error.
- `@hcengineering/calendar` was **not** a dependency of `ws-tests/api-tests` —
  added to `package.json` + a manual `node_modules/@hcengineering/calendar`
  symlink (pnpm workspace link), and `plugins/calendar` had to be built once
  (`rushx build`) because its `types/` dir didn't exist yet (needed for `tsc`
  to resolve `@hcengineering/calendar` types in the test package).
- `RestClient.addCollection`/`updateDoc`/`removeDoc` accept `calendar.class.Event`
  (an `AttachedDoc`) directly — server routes to the collection variant based
  on class hierarchy, matching the pattern in `CreateEvent.svelte`
  (`attachedTo: calendar.ids.NoAttached`, `attachedToClass: calendar.class.Event`,
  `collection: 'events'`).
