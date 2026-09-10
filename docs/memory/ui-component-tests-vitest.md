# Component tests in packages/ui (vitest)

`packages/ui` runs **vitest**, not jest (`vitest.config.mts`, `pnpm test` -> `vitest run --silent`).
The rig's test phase sees a non-jest `test` script and runs the package isolated via `pnpm run test`,
so no rig change was needed.

Non-obvious pieces, all of them required to make a `.svelte` component mount in jsdom:

- `resolve.conditions: ['browser']` — without it svelte resolves to its SSR runtime and **`onMount`
  never fires**. The component still renders DOM, so the failure looks like "the component is mounted
  but half its state is missing" (`parentElement` stays undefined, drags do nothing).
- `workspaceSources()` plugin in the config — workspace packages point `main` at raw `.ts`, which vite
  refuses as a package entry ("Failed to resolve entry for package @hcengineering/theme").
- `src/__test__/setup.ts` — jsdom ships neither `window.matchMedia` (pulled in by plyr via the ui index)
  nor `PointerEvent`.
- jsdom does no layout: every `getBoundingClientRect` is zero. `Separator.test.ts` installs a fake
  layout that derives widths from the inline styles the component writes and hands the remainder to
  the auto panels.
- `deviceOptionsStore.fontSize` defaults to 0, so rem-to-px maths collapses unless the test sets it.

Separator's own layout maths lives in `src/separatorLayout.ts` (`buildLayout` / `distribute` /
`toSeparators`) — pure functions over plain data, covered by ~124 generated combinations in
`separatorLayout.test.ts`. The component keeps only DOM reading and style writing.

## Coverage today

`Separator.test.ts` covers horizontal drag, vertical drag, the layout switch regression, a hidden
(float-configured but absent) panel, float mode and the window-resize crop. `separatorLayout.test.ts`
covers the pure maths over ~125 generated combinations plus a coarse O(n^2) guard.

Two things surfaced while writing them:

- `direction` used to be a `const` inside the component, so the vertical branches were dead code.
  It is now `export let direction` (default `'horizontal'`), which makes them reachable and testable.
- Float mode can only ever **shrink** a panel: `floatMouseMove` clamps the pointer to the panel being
  resized (`parentCoord` is capped at `parentSize.size - separatorSize`), so a floating panel never
  grows past its current width. `Separator.test.ts` pins that as current behaviour with a comment,
  not as a desired one.

## Benchmarks

`pnpm bench` (`vitest bench --run`) in `packages/ui`:
- `separatorLayout.bench.ts` — buildLayout / distribute / full drag step at 3, 10 and 50 panels.
  A full drag step is ~0.6us at 3 panels, ~5.6us at 50.
- `Separator.bench.ts` — 60 pointermove events through the mounted component in jsdom (~0.5ms best case).
Benchmarks are excluded from `pnpm test` (`test.include` only matches `*.test.ts`).

## Separator: panel swap without a config change

The planner keeps `separatorName = 'time'` for both Schedule and Team (`showToDos` is true in both),
so switching between them replaces only the **panel node** next to the separator - no prop of the
separator changes. `afterUpdate` called `checkSibling()` without `start`, which refreshed
`prevElement`/`nextElement` only when they were `null`; they pointed at detached nodes instead, so the
replacement panel never got `data-size`/`data-auto` and collapsed to min-content (2px in the wild).

`checkSibling` now compares against the separator's actual siblings, returns whether they changed, and
`afterUpdate` re-runs `checkSizes()` on a change. Covered by "sizes a panel swapped in without a
config change" in `Separator.test.ts`.

## Separator: in-memory config went stale after a drag

`finalSeparation` wrote the new sizes to `localStorage` but left the component's own `separators` /
`prevElSize` / `nextElSize` untouched - they still held the sizes from the last `fetchSeparators`
(which only runs when `name` or `float` changes). Nothing read them right after a drag, so it stayed
invisible until `afterUpdate` started re-running `checkSizes()` on a panel swap: the swapped-in panel
was then sized from the pre-drag config (the planner's calendar snapped back to the default 41.25rem
after the user had dragged it to 53.75rem).

`finalSeparation` now assigns the freshly computed config back. Covered by "applies the dragged size
to a panel swapped in afterwards".

Diagnosis trick worth reusing: patching `Storage.prototype.getItem/setItem` from an MCP `initScript`
showed **no** reads at all during the mode switch, which is what pinned the bug on in-memory state
rather than on the store.

## Review follow-ups (same session)

- `separatorsRevision` (in `resize.ts`) is bumped by `saveSeparator`. Several `Separator` components
  share one config - the planner has one per gap - and each kept its own copy from mount time, so a
  drag on one left the other stale. Each separator now re-reads the config when the revision for its
  name moves.
- `direction` reacts to a change: both axes are cleared (`clearContainer` now wipes width **and**
  height) and sizes re-applied, otherwise the panels keep min/max from the previous axis.
- `installFakeLayout` stores the native `getBoundingClientRect` unbound (a `.bind(Element.prototype)`
  would restore a function whose `this` is the prototype) and refuses a second install, so the fake
  can never become the restore target.
- `distribute` behaviour pinned by two tests: the auto panel next to the separator takes the whole
  growth; with a sized panel in between the growth skips it and is split between the auto panels
  further out.
