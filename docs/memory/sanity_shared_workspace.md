# Shared workspace per worker in sanity tests

`tests/fixtures.ts` exposes a worker-scoped `sharedWorkspace(invites?)` fixture: one account and
workspace per Playwright worker instead of one per test. Creating a workspace costs ~1.9s (account
service plus model building for every plugin), and in the 20260907-163654 profile the
`setup: account and workspace` step alone was 145.2s of a 1429s run, 58.1s of it in
`chat/chat.spec.ts` (27 tests).

## Why it needs seats accounting

`tests/plan-config.yaml` gives a fresh workspace the free tier: `usersLimit: 5`. Tests that invite a
guest through `getSecondPageByInvite` spend a seat permanently, so the fixture recycles the
workspace after `SEATS_PER_WORKSPACE` (3) invites. Callers declare the need with the `@invite` tag
on the test and `sharedWorkspace(testInfo.tags.includes('@invite') ? 1 : 0)` in `beforeEach`.

## What a shared workspace breaks, and what it does not

- `general` and `random` keep every message a worker's earlier tests sent there. Any assertion on a
  message - especially a negative one, like the delete test - needs text unique per test *and per
  retry*: `${testInfo.testId}${testInfo.retry}`.
- Channel names must carry the same suffix. `generateTestData()` builds them from `faker.lorem.word`,
  whose word list repeats often enough that two channels in one workspace collided; the navigator
  matches by accessible name, so `Aonforto` also matched `Aonforto 1` (an unread badge).
- The channels table lists every channel of the workspace, so a lookup by the owner's name matched
  several rows. `ChannelPage.clickOnUser` now takes the channel and scopes the row.
- Sidebar layout is **not** a problem: it lives in localStorage under
  `workbench.<workspace>.<account>.sidebar.state.` (plugins/workbench-resources/src/sidebar.ts) and
  every test gets a fresh browser context.

## Not converted

`chat/ai-bot-scenarios.spec.ts` asserts on a workspace with exactly one tracker project (the
proposal card hides its project selector then), and one of its tests creates a second project. That
assumption dies with a shared workspace, so it still creates one per test.

## Effect

`chat/chat.spec.ts` alone: 28.2s -> 22.2s wall for the file at 5 workers, 27 workspace creations
down to one per worker (plus a recycle when invites run out). `chat/image-reservation.spec.ts`
converted as well (5 -> 1). Verified with `--repeat-each 3` (81 tests, 0 flaky).
