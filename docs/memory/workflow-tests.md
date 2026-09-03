# Workflow feature: import/export API and API tests

## Portable config API

`plugins/workflow/src/transfer.ts` adds `exportWorkflowConfig` / `importWorkflowConfig` /
`clearWorkflowConfig`. The config is plain JSON in which every workspace-specific reference is
written by name, so a config exported from one project type can be imported into another:

- statuses, task types and screens are addressed by name;
- inside rule `props` the same refs appear as tokens `$status:<name>`, `$taskType:<name>`,
  `$screen:<name>` and are remapped by a recursive walk that also rewrites object **keys** -
  `SubtaskStatuses.statuses` is keyed by task type ref;
- attribute refs (`Field.attribute`) are model ids and stay as they are.

Import reuses screens and workflows whose name already exists instead of duplicating them, so a
repeated import is a no-op for them but still re-applies the project mapping.

## Where the tests live

`ws-tests/api-tests/src/__tests__/workflow.*.test.ts` - jest against a live stand, not Playwright.
162 tests, ~27 s. `workflow.fixtures.ts` builds project types, projects, issues and status changes
over `TxOperations`.

Two things that are easy to get wrong there:

- `createRestTxOperations` must be called with `fullModel: true`. `createProjectType` resolves
  descriptors out of the model and a trimmed model has none ("category is not found in model").
- statuses are deduplicated workspace-wide by `(name, ofAttribute, category)`, so different project
  types share status docs. That is harmless: transitions are per workflow and a workflow is bound to
  a project through the `ProjectWorkflow` mixin.

## Defect found by these tests

`server-plugins/workflow/src/middleware.ts` matched transitions with
`t.from == null || t.from.includes(fromStatus)`, so a transition saved with an empty `from` array
blocked everything. Every other site - `PostFunctions.ts`, the client middleware, `StatusEditor` and
`findTransitionConflict` - treats an empty array as "any status"; the very next line of the same
function did too, which made the branch dead. Fixed by adding `t.from.length === 0`.

## Playwright UI tests

`ws-tests/sanity/tests/workflow/` - 33 tests over two serial suites sharing one page and one
workspace each (`workflow-settings.spec.ts`, `workflow-tracker.spec.ts`), page objects in
`tests/model/workflow-page.ts`. They reuse `SettingsPage`, `NewProjectPage`, `IssuesPage` and
`IssuesDetailsPage` from `@hcengineering/tests-sanity`, which now exports the first two.

Things the workflow UI does that a test has to know:

- The status dropdown of a transition is a multiselect that stays open after a pick, and its overlay
  swallows every other click. Escape closes the surrounding modal as well, so dismiss it by clicking
  `.modal-overlay` instead - `WorkflowPage.closeDropdown`.
- "Any status" is preselected in the From dropdown of a new transition. Clicking it toggles it off
  and leaves the selection empty, which disables Create; for a wildcard transition just leave it be.
- A fresh Tracker task type comes with `Backlog / Todo / New state / Won / Lost`, not the statuses
  of the default project.
- Confirmations are `MessageBox`, i.e. `div.msgbox-container div.footer button`, not a form with a
  submit button.
- Issue status options are `div.selectPopup div.list-item span.overflow-label`.

## Statuses are shared workspace-wide

`createState` deduplicates by `(name, ofAttribute, category)` across the whole workspace, so the same
status name can resolve to a doc created by another project type. On a fresh workspace two jest
workers creating project types at the same time can interleave: one task type of a project type ends
up with the doc it created, the sibling task type with the doc the other worker created, and the same
name then has two refs inside one project type. That is what made only the `InProgress` tests fail on
CI while passing locally, where the statuses already existed and every lookup hit the same doc.

Both `buildResolver` in `transfer.ts` and the api-test fixture therefore resolve a name to the
smallest ref instead of to whichever the query happened to return first.
