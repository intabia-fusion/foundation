# Sanity flaky tests — root causes and costs

## Diagnosing

Playwright mark test "flaky" when retry pass, so cause in *first* attempt. Read
`step-report.ndjson` (`node analyze_steps.js`) for step that burnt time, then
`test-results/<test>/error-context.md` for call log. Log separate two opposite bugs:
`waiting for <locator>` = control never there; `intercepts pointer events` = it covered.
`playwright-report.json` give per-test totals (`analyze_failures.js`).

## Recurring shapes

- **`locator.count()` never waits.** Any arithmetic on it need settled read first (`waitStable` in
  `retry.ts`). Two bugs from this: `iterateLocator` counted pre-filter rows, `deleteTimeSlot`
  asserted `toHaveCount(-1)`.
- **Control that only exist while hovered or just opened.** Hover/open and use it in two separate
  statements, re-render between them leave second waiting out whole test timeout. Retry pair:
  hover → assert visible → click. Hit `channel-page` message actions (5 call sites), ToDo dragbox,
  attachment tooltips, context submenu (MouseSpeedTracker need slow mouse movement),
  status popup, workflow aside.
- **Action with no timeout of its own inside `toPass`.** It block until test die and retry loop never
  get turn. Give inner actions short explicit timeout.
- **Click that not idempotent.** Rows toggle selection, rooms deselect. Retry *wait*, not
  click, or guard with early return when target state already hold.
- **Positional selectors** (`nth-child(2)`, `.nth(1)`, `first()`) shift when surrounding data change.
- **Filter that not selective.** `selectMenuItem` filter by first word, so parallel workers'
  objects stay in list. Match whole name when item carry it; `selectAssignee` delegate
  to it for that reason.
- **`hasText` match substring**, so strict locator throw on grouped copy — `.first()`.
- **Pointer stay where previous step dropped it.** Tooltip then cover next control
  (`tooltip right` over `btn-viewOptions` after Board click), and second `hover()` on
  element pointer already rest on fire no mousemove, so retried hover reopen nothing. Park
  pointer (`mouse.move(0, 0)`) before click.
- **Action that silently never start.** Chromium raise dragstart on first move after
  `mouse.down()`; anything between the two (scrolling, settle wait) mean `dragCard` never set
  and every drop no-op that only state check notice, minute later. Assert app saw it
  (card take `dragged`) before moving on.
- **Escape not close panel app opened through url**, and close it *did* start
  land beat later and tear down whatever opened after it. Wait for new panel's own content
  and re-check it (`workflow-page.openAside`).

## Product-side causes

| What | Where | Effect |
|---|---|---|
| Categories auto-fold past 20 items | `ListCategory.initCollapsed` | Rows absent from DOM (`CommonPage.expandCollapsedCategories`) |
| Async default-app navigation clobbers a click | `Workbench.svelte:syncLoc` | User navigation undone mid-load |
| Toasts cover `#profile-button` for 10s | `packages/ui/src/utils.ts` | Clicks wait toast out; suppressed at `0` |
| `TimeInputBox` dispatches per digit | `TimeInputBox.svelte` | One server write per keystroke |
| Tag saved before its category loads | `CreateTagElement.svelte` | Tag exists, `TagsPopup` renders empty |
| Live query assigns server values into an open editor | `EditToDo.svelte` | Un-round-tripped edit wiped |
| Estimation renders optimistically, falls back ~70ms later | `issues-details-page.setEstimation` | Write lost; need 500ms settle (200ms not enough) |
| Calendar keeps a stale event after a slot change | UBERF-4273 | Slot added right after delete never appears |
| Calendar block under 44px renders no body | `EventElement.svelte` (`empty`) | `hasText` find no title once ~6 events share hour |
| Tag popup renders 50 tags per category | `TagsPopup.svelte` (`slice(0, 50)`) | Fresh tag past cut invisible; search for it instead |
| `move()` returns silently when `dragCard` is unset | `packages/kanban/src/components/Kanban.svelte:210` | Drop with no dragstart change nothing, report nothing |
| Templates group by assignee, group stays collapsed and virtualised | Templates list | Fresh template absent from DOM (`expandCollapsedCategories` + scroll) |

## Stand state

**Not restored between local runs** — `dotest.sh` run no `restore-pg.sh`. Consequences:

- Tests that mutate seed data work exactly once.
- `plan.spec.ts` assert absolute counts on seeded todos: leftover slot make it unpassable, not
  flaky (`Expected: 0, Received: 1`, then 2, then 3). Both slot tests call `clearTimeSlots()` first.
- **Planner tests still need clean stand.** Each run leave own `ToDo to change duration-*`;
  once day crowded, freshly added slot never reach calendar. Clean: 11 passed in 17s.
  Repeat without restore: 3 failed, every time.
- love tests share rooms in `meetings-ws`. `waitForActiveMeetingsToFinish` give up after 20s and now
  log what was left; next test used to fail 15s later on unrelated locator.

- **Accumulated data cross product render limits.** Measured 2026-09-03 on stand nobody had
  restored: 431 issues, 91 tags, 48 components, 62 todos, 28 templates. That past `TagsPopup`'s
  50 and enough to bury fresh template below fold - tests that passed for months start failing
  with no code change. `plan.spec.ts` and `template.spec.ts` now drop own leftovers in
  `beforeAll`; real fix is running `tests/restore-pg.sh` on schedule.

**Recreating one container breaks nginx** — it resolve upstreams at startup. `docker restart
sanity-nginx-1` after any `--force-recreate`.

## Fixed flakes

| Test | Cause | Fix |
|---|---|---|
| `tracker.spec` report-time | Editor still showed previous issue's total | `submitted` flag |
| `layout.spec` grouping / ordering | Board pages at 20; `modifiedOn` bumped by a later update | "Show more" until found; sort by transactor `modifiedOn` |
| `filter.spec` Priority | Rows captured before the retry loop | Re-read per attempt |
| `filter.spec` Component / Label | `iterateLocator` counted pre-filter rows | `waitStable` on the count |
| `filter.spec` Modified by | Row left the live list mid-test | Skip a gone row, bound the click, assert ≥1 checked |
| `chat.spec` copy message / public channel | Workspace url gets a random suffix; `faker` returned `a` | Read the segment from `page.url()`; ≥5-char word |
| `chat.spec` thread in sidebar | Hover-revealed reply button | `clickMessageAction` retries hover+click |
| `documents-content.spec` styles | Editor unfocused after `goToByTOC` | `selectLine` clicks the line first |
| `documents.spec` | Hover-only "+"; second user's page closed mid-flush; `selectMenuItem` picked another worker's teamspace; shared clipboard | Hover inside `toPass`; wait for the first user; whole-name match; clear the clipboard |
| `kanban.spec` swim lanes / drag | `__swim_unassigned__` only exists sometimes; target card never revealed; box read while the board still scrolled, so the drop landed on the neighbouring column | Pick a real lane; reveal both cards, 5s bound; settle the target box with `waitStable` |
| `plan.spec` drag/resize | Hover outside the loop; "changed" is not "landed right" | Hover inside; compare the edge to the target cell |
| `todos.spec` slot row / counters | Forced click added nothing; two reads disagreed | Retry until the row count grows; one `page.evaluate` snapshot |
| `todos.spec` Delete a ToDo | Hover-only dragbox | Retry hover + visible + right-click |
| `attachments.spec` | `hoverAttachmentButton` had no retry in the delete path | Retry both delete helpers |
| `issues.spec` Edit an issue | Estimation settle cut to 200ms | Back to 500ms |
| `issues.spec` submenu | MouseSpeedTracker submenu never opened | Retry, assert the second-level item |
| `settings.spec` customize-task-types | State list rebuilt while the popup was clicked | Retry the open+pick |
| `workflow-settings.spec` | A leftover aside from the previous step is indistinguishable by its footer - both carry `Create`, so the name was filled into the screen aside | `openAside` closes whatever is open and reopens from scratch |
| `workflow-tracker.spec` | `CreateProject` reads `workflowsMapping` once at mount | Reopen the dialog |
| `labels.spec`, `template.spec` | Tag submitted before its category query resolved | Resolve inside `createTagElement` |
| `component.spec` | 1s for a cascading delete to close | 10s bound |
| `public-link.spec` | Revoke returned before the round trip | Wait for the form to close |
| `inbox.spec` | Invite chain inlined in 7 tests | All call `getInviteLink` |
| `indexer.spec` cross-workspace | `/workbench/` url ≠ workspace built | `createWorkspace` waits out "Creation in progress" |
| `applications.spec` | 1000ms `toBeVisible` for a panel | Default 15s |
| `chat.spec` privacy toggle | Value comes back from the server | Retry the whole select, early return when already set |
| `documents-print-preview.spec` | Retrying the *fetch* — the blob never changes | Retry the print action |
| `mentions.spec` | Mention popup fills categories one by one; its overlay blocks `g#Send` | Settle the item count, assert the popup closed |
| `component.spec` Edit a component | Description typed into ProseMirror overwritten by the panel's query callback | Verify each field inside `editComponent` - retrying the whole edit reopens the lead popup and fails there instead |
| `kanban.spec` drag sequences | `expect.poll` read the status *before* the drag and returned it, so every successful drop still cost one more interval; `retryIntervals` then fell back to its 3s tail. A drop that lands while findOne still reports the old status also leaves the card out of the DOM, and the throw from `ensureVisible` killed the whole poll | `dragUntilStatus` reads after the drag, swallows its error, and polls at `[100, 200, 300, 500]` - 45.9s to 3.0s |
| `todos.spec` Edit a ToDo | The todo list re-orders while another worker adds slots, so the click opened a neighbouring row and every check read that card | `openToDoByName` asserts the panel title and retries the click |
| `meetings.scenarios` knock / re-entry | `sendKnockRequest` silently no-ops; ParticipantInfo outlives the drain | Retry the click; drain again on seeing Knock |
| `kanban.spec` drag between columns | Six status columns (workflow specs add one) need ~2000px; at 1440 the drag had to scroll the board with the pointer down and the source card unmounted | `test.use({ viewport: { width: 2200, height: 1000 } })` |
| `kanban.spec` drags, all | dragstart lost while the helper scrolled and settled the target box before its first move | Nudge 8px right after `mouse.down()`, assert the `dragged` class, pause a frame before release |
| `kanban.spec` swim lanes ×3 | Board-button tooltip covered `btn-viewOptions` | `openViewOptions()` parks the pointer first |
| `kanban.spec` multi-column drag | `revealCard` always clicked the *first* Show more, expanding the leftmost column forever | Round-robin over all Show more buttons |
| `issues.spec` context submenu | Hover nudge landed before the menu listened; `selectMenuItem`'s `fill` has no timeout and burnt the 30s action timeout | `openSubmenuOnIssue` retries right-click + hover and asserts `selectPopup`. A generic "one more popup" check breaks chat's Change icon, where the palette *replaces* the menu |
| `issues.spec` Delete an issue, `component.spec` | Row detached mid-click; create form still settling on submit | Retry with a 5s bound instead of one 30s action |
| `issues-duplicate.spec` | The panel binds the document after the input mounts, so an early `fill` is overwritten by the stored title | `IssuesDetailsPage.setTitle` waits for the value to settle |
| `inbox.spec` assign someone else | `selectMenuItem` fell back to the first row and picked another employee sharing the faker surname | Wait up to 5s for the exact row when the list has more than one item |
| `plan.spec` drag ToDo | Six runs' worth of blocks in one slot pushed each under 44px, so the title was not rendered and each retry added another block | `beforeAll` drops stale `time:class:ToDo` + `WorkSlot` |
| `template.spec` | Fresh template below the fold of a collapsed, virtualised assignee group | `expandCollapsedCategories` + scroll inside a retry; `beforeAll` drops old templates |
| `template-details` labels | New tag past `TagsPopup`'s 50-item cut | Type it into the popup search |
| `billing-ui.spec` seats / packages | Bank webhook is fire-and-forget and lands late on a loaded stand | 20/30s waits raised to 45/60s |
| `workflow-settings.spec` second workflow | The close Escape started tore down the aside opened right after it - the first `fill` landed, then the input was gone | `openAside` waits for the name input and re-checks it after 200ms |

## Open, do not retry these

**`subissues.spec.ts:153`.** Moving issue close panel; reopening from list render
identifier as breadcrumb instead of `div.title.not-active` — 4 failures in 20 versus 1 flake in
full run. Reverted. Need locator matching both renderings.

## Wall time is packing, not just work

`meetings.all.spec.ts` import all 17 `love/*.tests.ts`, so with `fullyParallel: false` love is one
sequential ~178s job - twice next file. It used to start ~82s in and finish at 276s while
other four workers idled from 190s. Giving it own project (`Love` declared **before** `Platform`,
`testMatch: /love\//` vs `testIgnore: /love\//`, `use` shared through `platformUse`) put it at
head of queue: love now run 0.1s -> 162.9s and **wall went 276s -> 238s**. Packing near
ceiling now (1114s of worker busy over 238s = 4.68 effective workers), so further wall cuts have to
come out of work itself.

**Do not try to parallelise inside love.** `waitForActiveMeetingsToFinish` not just clean up
after itself - it force-finish every `MeetingMinutes` and delete every `ParticipantInfo` /
`UserMeetingInvite` in workspace (no room filter), then *wait until none left*. Two love
files in parallel kill each other's meetings. 12 of 17 reach it via `closeMeetingContexts`;
`session` and `bidirectional-loop` also call it mid-test. Only `access`, `migration`, `privacy` and
`meetings.tests` safe to split out (13.2s of 178s) - and after project split love no
longer critical path, so that buy nothing.

`meetings.start.tests.ts` create real meetings and has **no cleanup at all** - it only work because
aggregator run it before files whose `beforeEach` drains. Any reordering leave live meeting.

## Where the time goes

Clean run, 5 workers, 391 tests: **1054s of step time over ~250s wall** — bound by total work, not by
packing (5 workers already give 4.2x). Cutting wall time mean cutting work.

| block | cost |
|---|---|
| UI login (form + workspace picker) | 87.9s over 80 tests, 1.10s each |
| in-app switch clicks (Chunter 44s, Documents 28s, love 27s, all-issues 17s, Tracker 14s) | ~131s, 51.7s of it the *opening* navigation |
| `page.waitForTimeout` | 56.6s in 118 calls |
| `tab-all` (`clickModelSelectorAll`) | 40.2s in 122 |
| love widget waits (`meeting-widget` 35s, `floorGrid` 25s) | 60s |
| context + page creation | 31s |

**Click on icon of app already open toggle navigator shut**, and every later
lookup in it wait out its timeout on panel that not there. `LeftSideMenuPage.openApp` return
early when `pathname.split('/')[3]` already name app, so all eight `click<App>` helpers
idempotent. Same shape one level down: navigator group render moment after app, and
`isVisible()` read in that gap make caller press hamburger and hide panel it wanted
(`ai-bot-scenarios.openDefaultProject`).

**Open app from url, not from sidebar.** `loginByToken` / `createAccountAndWorkspace`
take optional app alias (`chunter`, `tracker`, `document`, `contact`, `notification`, `time`,
`love`); specs on `PlatformSetting` just extend own `goto`. Measured: opening click cost
~913ms, app segment in url ~55ms - 141 such clicks were 128.8s of run. Converted: all of
`chat/*`, `documents/*`, `love/*` (already had `navigateToOffice`'s early return), `tracker/filter`,
`inbox` (also moved off login form). Pick alias *first* step need, not one file
named after - `dynamic-issues-chats` open tracker first and only then chat.

**Token login instead of form.** `loginByToken` / `createAccountAndWorkspace` in `utils.ts`.
Measured: form + picker ~1.1s, token + `goto /workbench/<ws>` **490ms**, and
`goto /workbench/<ws>/<app>` only ~55ms more — it also swallow 810ms app-switch click. Eleven
specs converted: login-form steps **160 → 56**, `chat.spec` 110.6 → 88.9s, `image-reservation`
48.2 → 31.3s. Still slow: 63 opening app-switch clicks (`goto` + click ~1000ms vs direct URL 483ms).

**Tracing every attempt roughly double local run** (17.9MB per kept trace). Default is
`on-first-retry` in all three sanity configs; `TRACE_MODE=retain-on-failure` only when chasing flake,
because `on-first-retry` trace attempt that *passed*.

**Browser cache is per BrowserContext.** Server hits for `bundle*`: fresh context 6, reload 0, new
page in it 0, new context 6. Headers already `max-age=31536000` + etag. Full run serve 34 800
static requests / 1.9 GB out of 128 unique files, ~89 per test.

**Context reuse tried twice and removed — do not reach for it again.** Single shared context
give half suite wrong logged-in user (53 specs declare own `storageState`). Pool
keyed by context options with snapshot restored is correct on two specs (896 → 130 requests) and
give **exactly same wall time**; full suite then went 363 passed / 23 failed in 8.3m against
386 passed in 4.9m. What leak not storage — page kept open to write localStorage is live
websocket session notification and workspace tests see as extra participant. Saving is
bytes, not CPU: bundle already minified (`optimization.minimize: prod`).

**4 workers on `ubuntu-latest` buy exactly nothing.** Same suite, work went 3159s → 5899s and every
action's p50 doubled (`Create context` 102→210ms, `Close context` 10→19ms, `beforeEach` 714→1465ms);
wall stayed at 1744s vs 1813s. `Close context` not app work, so it runner: 4 vCPU with
whole 34-container stand saturated at 2 workers. `workers` left unset (cores/2). Remaining CI
levers are bigger runner or splitting across runners.

**`Promise.race` of two `waitFor`s bill loser** — 98.8s over 9 sign-ups in `confirmOtpIfNeeded`.
Use `expect.poll` over both conditions. **`step-reporter.ts` not a cost** (18836 rows / 4MB).

## Kanban drag: what the drop checks must compare (2026-09-07)

`dragPointer` (tests/sanity/tests/model/tracker/kanban-board-page.ts) verified drop target by
`data-state` alone. With swim lanes on, every lane carry cell per status, so drop that landed
one lane off matched `wanted`, passed both pre-release hit test and `__dropSeen` check, and
test failed later as "attachedTo never changed" - exactly flake seen in run 20260907-185152.
Zone key now `data-swimlane-id|data-state` in all three places (`wanted`, capture-phase
`drop` listener, `elementFromPoint`).

Two more things drag got wrong:

- Pointer aimed at centre of target's bounding box. Swim lane cell taller than
  900px viewport, so its centre sat below fold and `elementFromPoint` returned nothing. It now
  aim at centre of intersection with viewport (`visiblePointOf`).
- Taking card out of own cell rearrange board, so target move after it was
  measured. Measure-move-verify now run up to 4 times inside same held drag instead of failing
  caller's attempt.

`expectCardInColumn` / `expectCardInSwimLaneCell` call `revealCard` first: past column's limit
card not in DOM at all, and assertion reported it as missing.

## Tooling traps

- `pnpm build:lint` can report `errors 0` for package it served from
  `.fast-build-cache.json` and never linted. Real check is `npx eslint "tests/**/*.ts"` from
  inside `tests/sanity` — glob required, plain `tests/` path rejected.
- `--reporter=line` **replaces** reporter list: no `step-report.ndjson`, no `playwright-report.json`.
- love files are `*.tests.ts`; path argument give `No tests found`, select with
  `pnpm run uitest -g "<part of the title>"`.
- `workflow-settings.spec.ts` is serial describe — one flake re-run whole block, so every test
  in file get `-retry1` folder while only one reported flaky.
- `--repeat-each` on `kanban.spec.ts` give false failures: `setSwimLane` store view options per
  user and storage state shared, so parallel copies fight over board layout.
- `love/*` timings swing by tens of seconds run to run (LiveKit on Mac host); compare per-file
  deltas, not totals.

## love multitab: second tab left the meeting it just joined (2026-09-08)

`meetings.multitab.tests.ts` "joining from a second tab evicts the first tab" failed on
`connectedMarker(tabB)` in run 20260908-125454. Not test defect: trace show tab B connect, then
disconnect itself 49ms later (`[LiveKitClient.connect] Connection established successfully` 58.811 ->
`[LiveKitClient.disconnect] Disconnecting...` 58.860); love service logs matching `participant_left`
in room B 0.5s after `Evicted a session in another meeting`.

Root cause in `plugins/love-resources/src/components/meeting/ControlExt.svelte`: "was I moved out
of my room" guard in `checkActiveMeeting` read outer `myRoomAttached`, which not dependency of
reactive statement (Svelte track call arguments only), so it ran one tick before that
assignment. When tab B own ParticipantInfo landed, `$currentRoom` already room B while
`myRoomAttached` still pointed at room A from tab A row, and `$myInfo.sessionId === mySid` now
matched because row was tab B own - guard fired, called `leaveMeeting()`. Fix: pass value as
parameter, so it tracked and recomputed first.

Reproduce under load only: idle, tab B ParticipantInfo webhook land while `myConnectingSessionId`
still set and guard return early. 8 isolated repeats passed; with full Platform run
alongside, 4 of 8 failed before fix, 8 of 8 passed after (Love project 66 passed).

Reproducing love flakes: `--project=Love -g "<title>" --repeat-each 8 --workers 1 --retries 0
--trace on` while `--project=Platform --workers 5` load machine. Trace console entries identify
client-side disconnect; JSON reporter carry no steps, `error-context.md` no page snapshot.
## Kanban drop lost to a late dragover (2026-09-08)

Run 20260908-135958: `drag child between parent lanes` failed with `drop was not delivered ...
(landed on "null")` - `null`, not `outside`, so no `drop` event fired at all. Geometry was right;
`elementFromPoint` had the wanted cell. Chromium turns a synthesized mousemove into `dragover` a
tick later, and `mouse.up()` issued right after the move ends the drag with no drop. `panelDragOver`
always calls `preventDefault()`, so a cell that saw a dragover always accepts. `dragPointer` now
records the cell each `dragover` reaches (capture phase) and nudges up to 10 x 50ms until the wanted
cell has seen one, then releases.

## Popup that ignores Escape (2026-09-08)

Run 20260908-143050: `Add comment by popup` spent 30s in `locator('.modal-overlay').hover()` -
"intercepts pointer events", then "element was detached from the DOM": the attachment landing in the
popup replaces the overlay under the pointer. The hover bought nothing, the click after it did the
work. `closePopups()` alone does not help - the comment popup keeps its editor focused and ignores
Escape, the overlay survives all 15s. It now falls back to a capped click on the overlay when Escape
leaves it standing, and the test calls the helper instead of hover + click.

## Account API answered HTML mid-poll (2026-09-08)

Run 20260908-145911: `dynamic-issues-chats` died in `beforeEach` after 1.5s with `SyntaxError:
Unexpected token '<', "<html>..."` from `Api.waitWorkspaceReady` - the `getWorkspaceInfo` poll got
an HTML body. nginx logged no 5xx on `/_account` that second, so what served the page stays unknown;
`json()` named neither the method nor the status.

`Api.ts` now posts through one private `post()` that reads the body as text and throws
`<method> answered <status> with <first 120 chars>`. `selectWorkspace` and the `getWorkspaceInfo`
poll are retried (both are reads, 15s / 60s bounded), so one bad answer costs a poll instead of the
test; the poll also has a deadline now instead of `while (true)`.
