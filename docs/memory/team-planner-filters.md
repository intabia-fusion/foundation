# Team Planner: FilterBar/FilterButton project filter (FUSIO-1308)

## Own ClassFilters mixin on time.class.ToDo

`FilterBar`/`FilterButton` (`plugins/view-resources/src/components/filter/`) only render options
for a class that has `view.mixin.ClassFilters` registered (`FilterTypePopup.getOwnTypes`:
`hierarchy.classHierarchyMixin(_class, view.mixin.ClassFilters) === undefined` -> returns `[]`,
and `FilterBar` hides its row entirely on the same check). Mounting them on a class without the
mixin compiles but is inert - an empty "+" popup.

`models/time/src/index.ts:224` registers the mixin for `time.class.ToDo`:

```ts
builder.mixin(time.class.ToDo, core.class.Class, view.mixin.ClassFilters, {
  filters: ['attachedSpace', 'user'],
  strict: true
})
```

`strict: true` limits the popup to exactly these two - project and person are the only things
the team views can act on, and anything else offered there would silently do nothing.

`attachedSpace` is declared `@Prop(TypeRef(task.class.Project), ...)` (`models/time/src/index.ts:112`)
even though its type is `Ref<Space>`: the filter enumerates the referenced class, so typing it as
`Space` would offer every space in the workspace. `user` is `Ref<Employee>` and needs nothing extra.

An earlier attempt scoped the filters to `tracker.class.Issue` to reuse its ready-made
`space`/`assignee` filters. Dropped: its popup also offers Kind/Status/Priority/CreatedBy/
Component/Milestone, all inert in the team view.

`plugins/time-resources/src/components/team/TeamContent.svelte` mounts one `FilterButton`/
`FilterBar` pair on `time.class.ToDo` and pulls `attachedSpace`/`user` out of the resulting
`DocumentQuery<ToDo>` into `spaces: Ref<Project>[]` / `filterPersons: Ref<Person>[]`, threaded
down into `Calendar`/`Agenda`/`YearCalendar` -> `WithTeamData`. Its `toRefs` handles only the
`$in` mode - `$nin` ("not in") is silently ignored, still a real gap.

## `WithTeamData` generalized from single `space` to `spaces: Ref<Project>[]`

FilterBar's default filter mode is multi-select (`$in`), so `WithTeamData`/`TeamCalendar`/
`TeamCalendarDay`/`Agenda` all take `spaces`/`projects` (arrays) now instead of a single
`space`/`project`. `TeamCalendarDay` (day-by-hour) still only makes sense for exactly one
project - `Calendar.svelte` gates the "day" mode option on `spaces.length === 1`.

## `PersonCalendar.svelte`'s day-offset math is symmetric around `startDate`, not 1..N

`values`/`getDay(startDate, offset)` always builds a window of `offset ∈ [-sideDays, +sideDays]`
around `startDate` (the `currentDate` prop is a red herring - it cancels out of the arithmetic).
For "Month" mode this means `startDate` must be the *middle* of the month (day ~16), not day 1 -
`Calendar.svelte` computes `monthPivot = new Date(y, m, 16)` and passes `maxDays =
daysInMonth(currentDate)`. Because `sideDays = Math.round((maxDays-1)/2)` rounds up for even
`maxDays`, a 28/29/30-day month renders one extra trailing column that bleeds into the next
month - pre-existing component limitation, not fixed (would need touching PersonCalendar's shared
offset formula, risking the week view).

## Year view is its own component, BusySlot-only

`team/calendar/YearCalendar.svelte` queries `calendar.class.BusySlot` directly (not through
`WithTeamData`) for the whole year, once, only while mounted (i.e. only when "Year" mode is
selected) - a full-year all-employee query is too heavy to run eagerly. Per-month aggregation
calls `getBusyIntervals` (`plugins/calendar/src/utils.ts`) once per month bucket over the same
fetched slice (12 in-memory calls, cheap). Self's own events are *not* special-cased (unlike
`WithTeamData`, which excludes `me` from the BusySlot query and sources self's events from
`calendar.class.Event`/`WorkSlot` instead) - `syncBusySlot`
(`server-plugins/calendar-resources/src/index.ts`) mirrors *every* participant of a blocking
event into `BusySlot`, self included, so a uniform BusySlot-only query is accurate for all rows.
