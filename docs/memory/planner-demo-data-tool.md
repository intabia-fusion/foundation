# `generate-planner-data` tool command (FUSIO-1308)

`dev/tool/src/plannerData.ts` + `generate-planner-data <workspace>` command in
`dev/tool/src/index.ts`. Populates a workspace with tracker projects/issues, personal
todos, work slots and calendar events for eyeballing Team Planner/calendar. Run:

```bash
cd tests && ./tool-pg.sh generate-planner-data <workspace> [--accounts user1,user2,user3] [--password 1234] [--url http://localhost:8083]
```

Needs `rushx bundle` in `dev/tool` first (or run through `tests/tool-pg.sh`, which falls
back to the pre-built `dev/tool/bundle/bundle.js`).

## `@hcengineering/time` was not a dependency of `dev/tool`

Same gap as `ws-tests/api-tests` (see `planner-spaces-api-tests.md`). Added
`"@hcengineering/time": "workspace:^0.7.0"` to `dev/tool/package.json` + `rush update`.

## No custom ProjectType needed

Every workspace's model migration (`models/tracker/src/migration.ts` `createDefaultProject`)
already seeds a well-known classic project type and default task type:
`tracker.ids.ClassingProjectType`, `tracker.taskTypes.Issue`, and fixed status ids
`tracker.status.Todo` / `tracker.status.InProgress` (category ToDo/Active - required by
`createIssueHandler` in `server-plugins/time-resources/src/index.ts` for the `ProjectToDo`
auto-creation trigger to fire). A new `tracker.class.Project` can be created directly with
`type: tracker.ids.ClassingProjectType` - no `createProjectType`/`createProjectTypeWith`,
no per-project `createMixin` (that's only needed for genuinely custom project types).

## `create-workspace <name> <owner>` does NOT add the owner as a member

Confirmed the hard way (workspace created, owner login got `platform:status:Forbidden` on
`selectWorkspace`). The `owner_social_id` arg is just who the DB record is attributed to.
Every account, owner included, needs an explicit `assign-workspace <email> <workspace>`
(+ `set-user-role <email> <workspace> OWNER` for the owner) before it can log in. Also
needs `set-workspace-plan <workspace> business` (fresh workspaces have no plan -> same
Forbidden on login). Matches `billing-limits-enforcement.md`'s note, confirmed again here.

## Verifying created data

No REST endpoint shortcut - `getWorkspaceToken(url, {email, password, workspace}, config)`
resolves the actual transactor endpoint (`token.endpoint`); the base platform URL
(`http://localhost:8083`) is NOT a valid REST client endpoint on its own (`findAll` returns
the index.html shell, `JSON.parse` blows up on `<!doctype`).

## Test run (2026-09-02)

Fresh workspace `planner-demo-ws`, accounts user1/user2/user3 (already existing sanity-stand
logins, password `1234`). Two consecutive `generate-planner-data` runs (different suffixes,
no rerun errors): 3 projects (private-solo/private-shared/public, distinct membership) ->
6 issues -> 6 auto `ProjectToDo` (space `time:space:ToDos`, correct `attachedSpace`) -> 6
WorkSlots in the project's own space; 6 personal `ToDo` -> 6 WorkSlots in the owner's
`PersonSpace` (`space` field matched exactly); 4 events (3 plain + 1 `ReccuringEvent`,
`blockTime: true`) -> 24 `BusySlot` mirrors confirmed via REST.
