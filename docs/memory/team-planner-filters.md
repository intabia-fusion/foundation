# Team Planner: FilterBar/FilterButton project filter (FUSIO-1308)

## No ClassFilters mixin for task.class.Project or time.class.WorkSlot

`FilterBar`/`FilterButton` (`plugins/view-resources/src/components/filter/`) only render
options for a class that has `view.mixin.ClassFilters` registered
(`FilterTypePopup.getOwnTypes`: `hierarchy.classHierarchyMixin(_class, view.mixin.ClassFilters)
=== undefined` -> returns `[]`, and `FilterBar` itself hides its row entirely:
`visible = hierarchy.classHierarchyMixin(_class, view.mixin.ClassFilters) !== undefined`).
Neither `models/task` nor `models/time` nor `models/calendar` register this mixin for any of
their classes - confirmed by grep, none exists. Mounting `FilterButton`/`FilterBar` directly on
`task.class.Project`, `time.class.WorkSlot`, `time.class.ToDo`/`ProjectToDo`, or
`calendar.class.BusySlot` compiles but is inert (empty "+" popup).

## Fix used: reuse tracker.class.Issue's ready-made filters, not a surrogate

`tracker.class.Issue` already has `view.mixin.ClassFilters` with `'space'` (project) and
`'assignee'` (person) among its filters (`models/tracker/src/index.ts` `defineFilters`), each
backed by a real `view.mixin.AttributeFilter` on the target class
(`tracker.class.Project`/nothing extra needed for `Ref<Person>`). This is not a hack: every
`ProjectToDo`/`WorkSlot.space` in this codebase *is* a `tracker.class.Project`, because
`tracker.class.Issue` is the only class registering `serverTime.mixin.ToDoFactory`
(`models/server-time/src/index.ts` - grepped, no other class registers it). So Issue's `space`
filter enumerates exactly the right project set.

`plugins/time-resources/src/components/team/TeamContent.svelte` mounts one
`FilterButton`/`FilterBar` pair scoped to `tracker.class.Issue`, and extracts `.space`/.assignee`
from the resulting `DocumentQuery<Issue>` (only the `$in` mode is handled; `$nin` - "not in" - is
a real gap, silently ignored) into `spaces: Ref<Project>[]` / `filterPersons: Ref<Person>[]`,
threaded down into `Calendar`/`Agenda`/`YearCalendar` → `WithTeamData`.

Known cost of *not* doing this "for real": the Issue-scoped popup also offers Kind/Status/
Priority/CreatedBy/Component/Milestone - filters that are inert here (silently have no effect on
the team view). The proper fix is a dedicated `ClassFilters` mixin for `task.class.Project`
(`filters: ['space']`-style using `_id`) or `time.class.WorkSlot` directly, a few lines in
`models/task/src/index.ts` or `models/time/src/index.ts` - out of scope for FUSIO-1308 (`models/**`
excluded).

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
