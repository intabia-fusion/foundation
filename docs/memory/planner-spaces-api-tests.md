# Planner space-ownership API tests (FUSIO-1308)

`ws-tests/api-tests/src/__tests__/planner.fixtures.ts` (reusable helpers) +
`planner-spaces.test.ts` cover where `time.class.WorkSlot` / `time.class.ProjectToDo`
actually live now that a project todo's slot moved into the project's own space
(`plugins/time-resources/src/utils.ts` `getWorkSlotSpace`, synced server-side by
`changeIssueDataHandler` in `server-plugins/time-resources/src/index.ts`).

## `tracker.class.Project` must be `private: true` to test membership at all

`SpaceSecurityMiddleware` itself does **not** filter `findAll` results (see its own
comment at `foundations/server/packages/middleware/src/spaceSecurity.ts:756`) — the real
filter is SQL, `PostgresAdapter.addSecurity` (`foundations/server/packages/postgres/src/storage.ts:625-667`):

```sql
EXISTS (SELECT 1 FROM space sec WHERE sec._id = <domain>.<key> AND (
  sec._id = 'core.space.Space' OR sec._class = 'core.class.SystemSpace'
  OR sec.members @> ARRAY[<accountUuid>]
  [OR sec.private = false]   -- only when the query itself filters by space/_id/attachedTo,
                              -- or the domain is DOMAIN_SPACE
) AND sec.archived = false)
```

`workflow.fixtures.ts`'s `createProject` makes a **public** project (`private: false,
members: [], owners: []`) — fine for workflow tests (nobody there checks isolation), but
it means **any** workspace account can read Issues/WorkSlots in it regardless of
`members`, because the `OR sec.private = false` branch always wins once the query
filters by `space`/`attachedTo`/`_id` (which every realistic lookup does). A membership
test against that default project silently passes for the wrong reason.

Fix: create the project normally (reusing `createProjectTypeWith`/`createProject`), then
one follow-up `updateDoc` flips `{ private: true, owners: [ownerAccountUuid], members:
[...] }`. That single update is unrestricted because the space's *previous* known state
(`private: false`) makes `checkSpacePermissions` return early for non-owners/non-admins
(`space.owners.size === 0 && !space.private` branch). Creating it private from the start
also works but must include the creator's account uuid in `owners` or `members` right
away, or the create tx itself is rejected ("Cannot create private space without being a
member or owner").

`Space.members`/`owners` are **`AccountUuid[]`**, not `Ref<Employee>[]` — use
`WorkspaceToken.info.account`, not a Person/Employee ref.

## `api-tests` workspace has exactly 2 accounts

Same constraint as `calendar-busy.test.ts`: only `user1`/`user2` are members of the
`api-tests` workspace (`dev/test-base/src/stands.ts`). Every "non-member can't see it"
assertion here uses the other of these two, not a third account — there isn't one in
this workspace.

## Two system spaces are unconditionally public

`calendar.space.Calendar` (BusySlot) and `time.space.ToDos` (ToDo/ProjectToDo) are both
created via `createDefaultSpace(...)` without a `_class` override, so they default to
`core.class.SystemSpace` (`models/calendar/src/migration.ts`, `models/time/src/migration.ts`).
`addSecurity` grants unconditional read access to any `SystemSpace` regardless of
`private`/`members`. Consequence for these tests:

- `ProjectToDo`'s own `.space` is always `time.space.ToDos` — readable by anyone,
  `.attachedSpace` (the project ref) is just a plain field on it, not a security
  boundary. The membership boundary lives on `WorkSlot.space`, which the
  `changeIssueDataHandler` trigger keeps in sync with the todo's `attachedSpace`
  (falls back to the owner's `PersonSpace` for a personal, non-project todo).
- `BusySlot` is world-readable the same way `calendar-busy-slot-api-tests.md` already
  documents for Event's busy mirror — true here too for a `WorkSlot`-sourced one, since
  `OnEvent`'s `syncBusySlot` doesn't care whether the source Event subclass is a plain
  Event or a `WorkSlot`.

## Trigger path exercised by "move issue to another project"

Moving an issue is just `client.updateDoc(tracker.class.Issue, issue.space, issue._id,
{ space: targetProjectId })` — `TxUpdateDoc.objectSpace` is set from the `space` argument
you pass (the issue's *current* space), matching what `moveIssueToSpace` in
`plugins/tracker-resources/src/utils.ts` does via `client.update(doc, {space, ...})`
(`doc.space` = old space). The trigger chain is `OnTask` (server-plugins/time-resources)
→ the `serverTime.mixin.ToDoFactory` on `tracker.class.Issue` → `IssueToDoFactory` →
`updateIssueHandler`, which calls `changeIssueDataHandler` whenever
`tx.operations.space !== undefined` and updates both the `ProjectToDo.attachedSpace` and
every `WorkSlot.space` for that todo.

## `@hcengineering/time` was not a dependency of `ws-tests/api-tests`

Added to `package.json` (`workspace:^0.7.0`) + `rush update` (creates the pnpm symlink).
It was already built (`plugins/time/lib`, `plugins/time/types` present), so no `rushx
build` needed, unlike `@hcengineering/calendar` in the sibling BusySlot test.
