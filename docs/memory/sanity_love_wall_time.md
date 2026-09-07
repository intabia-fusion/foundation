# Sanity run: where the love lane spends its time

Measured 2026-09-02 on the local stand (5 workers for the full suite, 1 worker for the love-only runs).

## The suite is capped by two lanes

Full run: wall 331.9s, 1583s of test work.
- `love/meetings.all.spec.ts` is a single serial job of 289s - it pulls in all 25 love files and the
  Love project is `fullyParallel: false`.
- Everything else, 1294s over the remaining 4 workers, is ~323s.

Both lanes land at ~320s, so the floor without touching love is ~300s. Cutting Platform-lane work
alone buys nothing until the love job gets shorter.

## The 15s wait after an office owner leaves

`meetings.bidirectional-loop` spent 30.9s of its 36.5s waiting for the *other* participant's meeting
widget to disappear - 15.4s twice, stable to the millisecond.

Chain: the owner's leave reaches love only as a LiveKit `participant_left` webhook, which does not
close the room - it stamps `ownerLeftAt` into the room metadata
(`services/love/src/webhook.ts:220`). `LiveKitPollingService.closeRoomIfOwnerGone`
(`services/love/src/polling.ts:407`) closes it once `Date.now() - ownerLeftAt` passes
`OWNER_REJOIN_GRACE_SEC` (default 15), and `scheduleNext` pulls the next poll forward to exactly
that deadline - hence the deterministic 15.0s. Only then does `deleteRoom` disconnect the peer, and
the client's widget closes on the LiveKit `Disconnected` event.

The stand now sets `OWNER_REJOIN_GRACE_SEC=8` and `POLLING_INTERVAL_MS=3000`
(`tests/docker-compose.yaml`). The grace has to stay above the time an owner needs to reload the
page, or `host refresh does not disconnect the other participant` starts failing under load; 8s
leaves room for that. That test's own wait must in turn stay *above* the grace, or it proves
nothing - it is 10s.

Loop test: 36.5s -> 24.2s. Whole love project on an idle stand: ~3.5m, 63 passed.

## Closing the LiveKit room instead of waiting for the grace

The grace exists for a real user's refresh; a test does not have to sit through it. `listRooms` +
`deleteRoom` through `livekit-server-sdk` is the same call the poller makes, so the peer gets a real
`Disconnected` rather than a half-state, and `waitForActiveMeetingsToFinish` now does it alongside
the document cleanup (`tests/sanity/tests/love/meeting-helpers.ts`). Keys and URL come from env with
the stand's defaults (`http://localhost:7890`, `testkey`).

In `bidirectional-loop` the cleanup had to move *before* the `waitDisconnected` it was written after
- that reorder is where its saving comes from: 36.5s -> 6.0s.

Love project, idle stand, 60 tests: work 173.7s -> 138.6s, wall 3.2m -> 2.6m. Biggest movers:
`bidirectional-loop` 21.9s -> 2.6s and `session :: activity feed shows "Joined meeting"` 21.6s ->
3.7s.

## The outage tests run on demand

`meetings.network.tests.ts` is tagged `@network` - 58s of the love lane spent probing LiveKit
reconnects rather than the product. `rushx uitest` excludes `@llm|@network`; `rushx uitest-network`
runs them. Nothing in CI runs them today.

## The 3s poll interval evicted live participants

`POLLING_INTERVAL_MS=3000` looked free - the grace deadline is pulled forward by `scheduleNext`
either way - and it cost a flake in most runs. `LiveKitPollingService` drops a "ghost seat" when the
`ParticipantInfo.sessionId` is missing from its LiveKit snapshot (`services/love/src/polling.ts`
around the `Removing ParticipantInfo with stale sessionId` log). The snapshot is a moment old, so a
participant who just (re)joined can be evicted: the client loses `currentRoom`, the widget closes,
the session drops, and the meeting-anchor reconnect brings it back - a join/leave loop every ~3s,
seen in the logs as the same person joining and leaving while another test waits to connect.

At the default 10s this is rare, at 3s it hit `workspace-owner :: self-join` in 4 of 7 runs and cost
~50s each time. The stand is back to `POLLING_INTERVAL_MS=10000`. The product-side fix - skip rows
younger than one poll interval - is not written.

## A dropped client kept its meeting anchor

`rememberActiveMeeting` writes `love.activeMeeting` into sessionStorage on every connect
(`plugins/love-resources/src/meetings.ts`). `LiveKitClient.onDisconnected` never cleared it, so a
client the server dropped still looked like someone who wants to be in a meeting: the next store
tick ran `reconnectToCurrentMeeting`, which calls `connectToMeeting`, whose *first* step is
`navigateToOfficeDoc(mm)`. The window left the floor for a finished meeting's MeetingMinutes page -
which carries its own Connect button, so a test clicking Connect there waits out its whole timeout
against a button that connects to nothing.

`onDisconnected` now takes the `DisconnectReason` and bumps `lkSessionEnded` for `ROOM_DELETED`,
`ROOM_CLOSED` and `PARTICIPANT_REMOVED`; `meetings.ts` clears `currentMeeting` and the anchor on it.
A refresh or a network drop arrives with a different reason, so auto-reconnect is untouched.

The subscription lives inside `onClient(...)`: `liveKitClient.ts` and `meetings.ts` import each
other, and reading the store at module scope threw during evaluation - the whole love plugin failed
to initialise and the office rendered blank.

## Tests that picked up the previous test's meeting

`waitRoomMeeting` matched any Active/Pending meeting in the room, and a meeting finished a moment
earlier still reads as Active over REST for a few hundred ms. `recording :: transcription toggle`
then drove a dead meeting - love answered "Audio recording already in progress", no new
PendingRecording appeared, and the poll burned 60s. It now takes a `since` timestamp captured before
joining and filters on `createdOn`.

`joinRoom` retries the room click, the Connect click and the connected check as one block, for the
same reason the workspace-owner test does: a navigation landing between the clicks otherwise costs a
full timeout.

## Result

Full suite, same machine: love 270.2s -> 191.6s of work (-29%), wall 331.9s -> 328.9s. Wall barely
moves because love is no longer the critical path - the Platform lane (~1300s over 4 workers) is.

## What is left in love, and it is mostly real

From `analyze_steps.js` on a love-only run: LiveKit connects (`poll toBeGreaterThan`) 38s over 65
calls, deliberate outage simulations in `meetings.network` ~24s, the remaining grace waits ~18s.
There is no other large artificial wait left - the next real gain needs love to run in more than one
lane, which needs a second meetings workspace: `forceFinishAllMeetings` wipes every meeting in the
workspace, so two lanes sharing `meetings-ws` would kill each other's meetings.

## Page reuse pays in love, not in tracker

Sharing one window per user across the love suite paid because a love context cost a full floor boot
(~1s) and love is the critical path. Tracker is a different profile: hooks are 0.3s/test, 99
contexts cost 5.4s in total, and a warm context saves only ~180ms (measured: cold context + goto +
navPanel 550ms, warm context with a fresh page 370ms, reload of the same page 256-302ms).

A shared window for `tracker/kanban.spec.ts` was measured and reverted: 1.2m with it against 1.2m
without, and `dragstart marks the card as dragged` failed twice on the shared window and passed on a
fresh one. Every kanban test re-enters the board through `openTrackerBoard`, which does a full
`goto` anyway, so there was nothing left to save.

## Room picked as "available" was occupied (2026-09-03)

Five love specs flaked with `[data-id="room-panel"] [data-id="meeting-connect"]` never appearing.
The panel does open: `EditRoom.svelte` renders Knock instead of Connect when
`isLockedByPrivateMeeting` - the room still holds ParticipantInfo rows from a meeting we are not in.
`firstAvailableRoom` only checked that the card was rendered, so it always returned Meeting Room 1
and `joinRoom` spent its 45s on a button that could not appear. It now skips rooms with occupied
cells, and `joinRoom` throws a named error on seeing Knock.

`clickRoomByName` closes any `div.panel-instance`, not just `[data-id="room-panel"]`: the minutes
page a previous test left open swallows the click through its table cells, and Escape misses a panel
opened through the url (`ensureOffice` skips the navigation because the url still reads as the
floor), so it falls back to `openLove`.
