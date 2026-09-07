# Sanity flaky tests — root causes and costs

## Diagnosing

Playwright marks a test "flaky" when a retry passes, so the cause is in the *first* attempt. Read
`step-report.ndjson` (`node analyze_steps.js`) for the step that burnt the time, then
`test-results/<test>/error-context.md` for the call log. That log separates two opposite bugs:
`waiting for <locator>` means the control was never there; `intercepts pointer events` means it was
covered. `playwright-report.json` gives per-test totals (`analyze_failures.js`).

## Recurring shapes

- **`locator.count()` never waits.** Any arithmetic on it needs a settled read first (`waitStable` in
  `retry.ts`). Two bugs came from this: `iterateLocator` counted pre-filter rows, and `deleteTimeSlot`
  asserted `toHaveCount(-1)`.
- **A control that only exists while hovered or just opened.** Hover/open and use it in two separate
  statements and a re-render between them leaves the second waiting out the whole test timeout. Retry
  the pair: hover → assert visible → click. Hit `channel-page` message actions (5 call sites), the
  ToDo dragbox, attachment tooltips, the context submenu (MouseSpeedTracker needs slow mouse movement),
  the status popup, the workflow aside.
- **An action with no timeout of its own inside a `toPass`.** It blocks until the test dies and the
  retry loop never gets a turn. Give inner actions a short explicit timeout.
- **A click that is not idempotent.** Rows toggle selection, rooms deselect. Retry the *wait*, not the
  click, or guard with an early return when the target state already holds.
- **Positional selectors** (`nth-child(2)`, `.nth(1)`, `first()`) shift when surrounding data changes.
- **A filter that is not selective.** `selectMenuItem` filters by the first word, so parallel workers'
  objects stay in the list. Match the whole name when an item carries it; `selectAssignee` delegates
  to it for that reason.
- **`hasText` matches a substring**, so a strict locator throws on a grouped copy — `.first()`.
- **The pointer stays where the previous step dropped it.** A tooltip then covers the next control
  (`tooltip right` over `btn-viewOptions` after the Board click), and a second `hover()` on the
  element the pointer already rests on fires no mousemove, so a retried hover reopens nothing. Park
  the pointer (`mouse.move(0, 0)`) before the click.
- **An action that silently never starts.** Chromium raises dragstart on the first move after
  `mouse.down()`; anything between the two (scrolling, a settle wait) means `dragCard` is never set
  and every drop is a no-op that only the state check notices, a minute later. Assert the app saw it
  (the card takes `dragged`) before moving on.
- **Escape does not close a panel the app opened through the url**, and the close it *did* start
  lands a beat later and tears down whatever opened after it. Wait for the new panel's own content
  and re-check it (`workflow-page.openAside`).

## Product-side causes

| What | Where | Effect |
|---|---|---|
| Categories auto-fold past 20 items | `ListCategory.initCollapsed` | Rows absent from DOM (`CommonPage.expandCollapsedCategories`) |
| Async default-app navigation clobbers a click | `Workbench.svelte:syncLoc` | User navigation undone mid-load |
| Toasts cover `#profile-button` for 10s | `packages/ui/src/utils.ts` | Clicks wait the toast out; suppressed at `0` |
| `TimeInputBox` dispatches per digit | `TimeInputBox.svelte` | One server write per keystroke |
| Tag saved before its category loads | `CreateTagElement.svelte` | Tag exists, `TagsPopup` renders empty |
| Live query assigns server values into an open editor | `EditToDo.svelte` | Un-round-tripped edit is wiped |
| Estimation renders optimistically, falls back ~70ms later | `issues-details-page.setEstimation` | Write lost; needs the 500ms settle (200ms is not enough) |
| Calendar keeps a stale event after a slot change | UBERF-4273 | Slot added right after a delete never appears |
| Calendar block under 44px renders no body | `EventElement.svelte` (`empty`) | `hasText` finds no title once ~6 events share an hour |
| Tag popup renders 50 tags per category | `TagsPopup.svelte` (`slice(0, 50)`) | A fresh tag past the cut is invisible; search for it instead |
| `move()` returns silently when `dragCard` is unset | `packages/kanban/src/components/Kanban.svelte:210` | A drop with no dragstart changes nothing and reports nothing |
| Templates group by assignee, group stays collapsed and virtualised | Templates list | A fresh template is absent from the DOM (`expandCollapsedCategories` + scroll) |

## Stand state

**Not restored between local runs** — `dotest.sh` runs no `restore-pg.sh`. Consequences:

- Tests that mutate seed data work exactly once.
- `plan.spec.ts` asserts absolute counts on seeded todos: a leftover slot makes it unpassable, not
  flaky (`Expected: 0, Received: 1`, then 2, then 3). Both slot tests call `clearTimeSlots()` first.
- **Planner tests still need a clean stand.** Each run leaves its own `ToDo to change duration-*`;
  once the day is crowded a freshly added slot never reaches the calendar. Clean: 11 passed in 17s.
  Repeat without restore: 3 failed, every time.
- love tests share rooms in `meetings-ws`. `waitForActiveMeetingsToFinish` gives up after 20s and now
  logs what was left; the next test used to fail 15s later on an unrelated locator.

- **Accumulated data crosses product render limits.** Measured 2026-09-03 on a stand nobody had
  restored: 431 issues, 91 tags, 48 components, 62 todos, 28 templates. That is past `TagsPopup`'s
  50 and enough to bury a fresh template below the fold - tests that passed for months start failing
  with no code change. `plan.spec.ts` and `template.spec.ts` now drop their own leftovers in
  `beforeAll`; the real fix is running `tests/restore-pg.sh` on a schedule.

**Recreating one container breaks nginx** — it resolves upstreams at startup. `docker restart
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

**`subissues.spec.ts:153`.** Moving the issue closes the panel; reopening from the list renders the
identifier as a breadcrumb instead of `div.title.not-active` — 4 failures in 20 versus 1 flake in a
full run. Reverted. Needs a locator matching both renderings.

## Wall time is packing, not just work

`meetings.all.spec.ts` imports all 17 `love/*.tests.ts`, so with `fullyParallel: false` love is one
sequential ~178s job - twice the next file. It used to start ~82s in and finish at 276s while the
other four workers idled from 190s. Giving it its own project (`Love` declared **before** `Platform`,
`testMatch: /love\//` vs `testIgnore: /love\//`, `use` shared through `platformUse`) puts it at the
head of the queue: love now runs 0.1s -> 162.9s and **wall went 276s -> 238s**. Packing is near the
ceiling now (1114s of worker busy over 238s = 4.68 effective workers), so further wall cuts have to
come out of the work itself.

**Do not try to parallelise inside love.** `waitForActiveMeetingsToFinish` does not just clean up
after itself - it force-finishes every `MeetingMinutes` and deletes every `ParticipantInfo` /
`UserMeetingInvite` in the workspace (no room filter), then *waits until none are left*. Two love
files in parallel kill each other's meetings. 12 of 17 reach it via `closeMeetingContexts`;
`session` and `bidirectional-loop` also call it mid-test. Only `access`, `migration`, `privacy` and
`meetings.tests` are safe to split out (13.2s of 178s) - and after the project split love is no
longer the critical path, so that buys nothing.

`meetings.start.tests.ts` creates real meetings and has **no cleanup at all** - it only works because
the aggregator runs it before files whose `beforeEach` drains. Any reordering leaves a live meeting.

## Where the time goes

Clean run, 5 workers, 391 tests: **1054s of step time over ~250s wall** — bound by total work, not by
packing (5 workers already give 4.2x). Cutting wall time means cutting work.

| block | cost |
|---|---|
| UI login (form + workspace picker) | 87.9s over 80 tests, 1.10s each |
| in-app switch clicks (Chunter 44s, Documents 28s, love 27s, all-issues 17s, Tracker 14s) | ~131s, 51.7s of it the *opening* navigation |
| `page.waitForTimeout` | 56.6s in 118 calls |
| `tab-all` (`clickModelSelectorAll`) | 40.2s in 122 |
| love widget waits (`meeting-widget` 35s, `floorGrid` 25s) | 60s |
| context + page creation | 31s |

**A click on the icon of the app that is already open toggles the navigator shut**, and every later
lookup in it waits out its timeout on a panel that is not there. `LeftSideMenuPage.openApp` returns
early when `pathname.split('/')[3]` already names the app, so all eight `click<App>` helpers are
idempotent. Same shape one level down: a navigator group renders a moment after the app, and a
`isVisible()` read in that gap makes a caller press the hamburger and hide the panel it wanted
(`ai-bot-scenarios.openDefaultProject`).

**Open the app from the url, not from the sidebar.** `loginByToken` / `createAccountAndWorkspace`
take an optional app alias (`chunter`, `tracker`, `document`, `contact`, `notification`, `time`,
`love`); specs on `PlatformSetting` just extend their own `goto`. Measured: the opening click costs
~913ms, the app segment in the url ~55ms - 141 such clicks were 128.8s of the run. Converted: all of
`chat/*`, `documents/*`, `love/*` (already had `navigateToOffice`'s early return), `tracker/filter`,
`inbox` (also moved off the login form). Pick the alias the *first* step needs, not the one the file
is named after - `dynamic-issues-chats` opens the tracker first and only then the chat.

**Token login instead of the form.** `loginByToken` / `createAccountAndWorkspace` in `utils.ts`.
Measured: form + picker ~1.1s, token + `goto /workbench/<ws>` **490ms**, and
`goto /workbench/<ws>/<app>` only ~55ms more — it also swallows the 810ms app-switch click. Eleven
specs converted: login-form steps **160 → 56**, `chat.spec` 110.6 → 88.9s, `image-reservation`
48.2 → 31.3s. Still slow: 63 opening app-switch clicks (`goto` + click ~1000ms vs direct URL 483ms).

**Tracing every attempt roughly doubles a local run** (17.9MB per kept trace). Default is
`on-first-retry` in all three sanity configs; `TRACE_MODE=retain-on-failure` only when chasing a flake,
because `on-first-retry` traces the attempt that *passed*.

**Browser cache is per BrowserContext.** Server hits for `bundle*`: fresh context 6, reload 0, new
page in it 0, new context 6. Headers are already `max-age=31536000` + etag. A full run serves 34 800
static requests / 1.9 GB out of 128 unique files, ~89 per test.

**Context reuse was tried twice and removed — do not reach for it again.** A single shared context
gives half the suite the wrong logged-in user (53 specs declare their own `storageState`). A pool
keyed by context options with the snapshot restored is correct on two specs (896 → 130 requests) and
gives **exactly the same wall time**; the full suite then went 363 passed / 23 failed in 8.3m against
386 passed in 4.9m. What leaks is not storage — the page kept open to write localStorage is a live
websocket session the notification and workspace tests see as an extra participant. The saving is
bytes, not CPU: the bundle is already minified (`optimization.minimize: prod`).

**4 workers on `ubuntu-latest` buy exactly nothing.** Same suite, work went 3159s → 5899s and every
action's p50 doubled (`Create context` 102→210ms, `Close context` 10→19ms, `beforeEach` 714→1465ms);
wall stayed at 1744s vs 1813s. `Close context` is not app work, so it is the runner: 4 vCPU with the
whole 34-container stand is saturated at 2 workers. `workers` left unset (cores/2). The remaining CI
levers are a bigger runner or splitting across runners.

**`Promise.race` of two `waitFor`s bills the loser** — 98.8s over 9 sign-ups in `confirmOtpIfNeeded`.
Use `expect.poll` over both conditions. **`step-reporter.ts` is not a cost** (18836 rows / 4MB).

## Tooling traps

- `rush fast-build:lint` can report `errors 0` for a package it served from
  `.fast-build-cache.json` and never linted. The real check is `npx eslint "tests/**/*.ts"` from
  inside `tests/sanity` — the glob is required, a plain `tests/` path is rejected.
- `--reporter=line` **replaces** the reporter list: no `step-report.ndjson`, no `playwright-report.json`.
- love files are `*.tests.ts`; a path argument gives `No tests found`, select with
  `rushx uitest -g "<part of the title>"`.
- `workflow-settings.spec.ts` is a serial describe — one flake re-runs the whole block, so every test
  in the file gets a `-retry1` folder while only one is reported flaky.
- `--repeat-each` on `kanban.spec.ts` gives false failures: `setSwimLane` stores view options per
  user and the storage state is shared, so parallel copies fight over the board layout.
- `love/*` timings swing by tens of seconds run to run (LiveKit on the Mac host); compare per-file
  deltas, not totals.
