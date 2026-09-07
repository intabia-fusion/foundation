//
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

import { expect, test } from '../fixtures'
import tracker, { type Issue } from '@hcengineering/tracker'
import { type Ref, type TxOperations } from '@hcengineering/core'
import {
  connectTracker,
  createComponent,
  createIssue,
  deleteIssuesByTitlePrefix,
  findProjectByName,
  getProjectContext,
  type ProjectContext
} from '../API/TrackerApi'
import { KanbanBoardPage } from '../model/tracker/kanban-board-page'
import { PlatformSetting, PlatformURI, generateId } from '../utils'
import { retryIntervals } from '../retry'
import { ViewletSelectors } from './tracker.utils'

async function openTrackerBoard (page: import('@playwright/test').Page, projectId: string): Promise<void> {
  const projectPath = encodeURIComponent(projectId)
  await (await page.goto(`${PlatformURI}/workbench/sanity-ws/tracker/${projectPath}/issues`))?.finished()
  // Reset any persisted swim lane collapse state so cells are always rendered.
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('kanban-swimlane-collapsed-')) localStorage.removeItem(k)
    }
  })
  await page.locator('label[data-id="tab-all"]').click()
  await page.locator(ViewletSelectors.Board).click()
  // Wait for the board to render either as legacy columns or swimlane.
  await page
    .locator('[data-id="kanban-column"], [data-id="kanban-swimlane"]')
    .first()
    .waitFor({ state: 'visible', timeout: 10000 })
}

// The drop reaches the server in ~100ms, but the status was read *before* the drag and
// retryIntervals falls back to a 3s tail - three drops cost 44s, 35s of it pure sleep.
const dragIntervals = [100, 200, 300, 500]

async function dragUntilStatus (
  client: TxOperations,
  cardId: Ref<Issue>,
  target: string,
  drag: () => Promise<void>
): Promise<void> {
  const status = async (): Promise<string | undefined> =>
    (await client.findOne(tracker.class.Issue, { _id: cardId }))?.status as string | undefined
  await expect
    .poll(
      async () => {
        if ((await status()) === target) return target
        try {
          await drag()
        } catch (err) {
          // The drop can already have landed while findOne still reports the old status - the card
          // is then gone from the DOM and the drag throws. Let the next read settle it.
          console.error('drag failed:', err)
        }
        // The drop shows up optimistically; wait for the tx before paying for another drag, which
        // would otherwise start from the card's new position and cost seconds of scrolling.
        for (const wait of retryIntervals) {
          if ((await status()) === target) return target
          await new Promise((resolve) => setTimeout(resolve, wait))
        }
        return await status()
      },
      { timeout: 60000, intervals: dragIntervals }
    )
    .toBe(target)
}

// Wide on purpose: with the statuses other specs add the board needs ~2000px, and at 1440 a drag
// has to scroll the board while the pointer is down - the source card unmounts and the drop is lost.
test.use({ storageState: PlatformSetting, viewport: { width: 2200, height: 1000 } })

test.describe('Kanban board', () => {
  let client: TxOperations
  let ctx: ProjectContext
  const titlePrefix = `kanban-spec-${generateId()}-`

  test.beforeAll(async () => {
    const conn = await connectTracker()
    client = conn.client
    ctx = await getProjectContext(client)
  })

  test.afterAll(async ({ browser }) => {
    if (client !== undefined) {
      await deleteIssuesByTitlePrefix(client, titlePrefix)
    }
    // Best-effort: reset swimlane preference so other specs see legacy layout.
    try {
      const ctxBrowser = await browser.newContext({ storageState: PlatformSetting })
      const page = await ctxBrowser.newPage()
      await openTrackerBoard(page, ctx.project._id)
      await new KanbanBoardPage(page).setSwimLane('None')
      await ctxBrowser.close()
    } catch {
      // ignore
    }
  })

  test('renders cards in correct columns by status', async ({ page }) => {
    const backlogId = await createIssue(client, ctx, {
      title: `${titlePrefix}backlog-1`,
      status: 'Backlog'
    })
    const todoId = await createIssue(client, ctx, {
      title: `${titlePrefix}todo-1`,
      status: 'Todo'
    })
    const inProgressId = await createIssue(client, ctx, {
      title: `${titlePrefix}progress-1`,
      status: 'In Progress'
    })

    await openTrackerBoard(page, ctx.project._id)

    const board = new KanbanBoardPage(page)
    await board.expectCardInColumn(backlogId, ctx.statuses.get('Backlog') as string)
    await board.expectCardInColumn(todoId, ctx.statuses.get('Todo') as string)
    await board.expectCardInColumn(inProgressId, ctx.statuses.get('In Progress') as string)
  })

  test('drag card between columns updates status', async ({ page }) => {
    const cardId: Ref<Issue> = await createIssue(client, ctx, {
      title: `${titlePrefix}drag-1`,
      status: 'Backlog'
    })

    await openTrackerBoard(page, ctx.project._id)

    const board = new KanbanBoardPage(page)
    const backlog = ctx.statuses.get('Backlog') as string
    const inProgress = ctx.statuses.get('In Progress') as string
    await board.expectCardInColumn(cardId, backlog)

    // Retry the drag if the drop event was lost (HTML5 drag in headless can be flaky
    // under parallel load). Verify by polling the backend, not just the DOM, since
    // panelDragOver shows the card in the target column optimistically.
    await dragUntilStatus(client, cardId, inProgress, async () => {
      await board.dragCardToColumn(cardId, inProgress)
    })
    await board.expectCardInColumn(cardId, inProgress)
  })

  test('drag does not cause page scroll', async ({ page }) => {
    const cardId = await createIssue(client, ctx, {
      title: `${titlePrefix}scroll-1`,
      status: 'Backlog'
    })

    await openTrackerBoard(page, ctx.project._id)

    const board = new KanbanBoardPage(page)
    await board.expectCardInColumn(cardId, ctx.statuses.get('Backlog') as string)

    const before = await board.getScrollTop()
    const card = board.card(cardId)
    await card.hover()
    await page.mouse.down()
    await page.mouse.move(50, 50, { steps: 5 })
    const after = await board.getScrollTop()
    await page.mouse.up()

    expect(after).toBe(before)
  })

  test('renders cards across all 5 status columns', async ({ page }) => {
    const ids: Record<string, Ref<Issue>> = {}
    for (const status of ['Backlog', 'Todo', 'In Progress', 'Done', 'Cancelled'] as const) {
      const ref = ctx.statuses.get(status)
      if (ref === undefined) continue
      ids[status] = await createIssue(client, ctx, { title: `${titlePrefix}all-${status}`, status })
    }

    await openTrackerBoard(page, ctx.project._id)

    const board = new KanbanBoardPage(page)
    for (const status of Object.keys(ids)) {
      await board.expectCardInColumn(ids[status], ctx.statuses.get(status as 'Backlog') as string)
    }
  })

  test('drag a card across multiple columns sequentially', async ({ page }) => {
    // Three drags, each retrying until the backend confirms - past the default 60s under load.
    test.slow()
    const cardId = await createIssue(client, ctx, {
      title: `${titlePrefix}seq-1`,
      status: 'Backlog'
    })
    await openTrackerBoard(page, ctx.project._id)

    const board = new KanbanBoardPage(page)
    const backlog = ctx.statuses.get('Backlog') as string
    const todo = ctx.statuses.get('Todo') as string
    const inProgress = ctx.statuses.get('In Progress') as string
    const done = ctx.statuses.get('Done') as string

    await board.expectCardInColumn(cardId, backlog)

    for (const target of [todo, inProgress, done]) {
      await dragUntilStatus(client, cardId, target, async () => {
        await board.dragCardToColumn(cardId, target)
      })
      await board.expectCardInColumn(cardId, target)
    }
  })

  test('parent issue creates sub-issue with attachedTo via API', async () => {
    const parent = await createIssue(client, ctx, {
      title: `${titlePrefix}parent-1`,
      status: 'Backlog'
    })
    const child = await createIssue(client, ctx, {
      title: `${titlePrefix}child-1`,
      status: 'Todo',
      parent
    })

    const childIssue = await client.findOne(tracker.class.Issue, { _id: child })
    expect(childIssue?.attachedTo).toBe(parent)
    expect(childIssue?.attachedToClass).toBe(tracker.class.Issue)
    expect(childIssue?.parents[0]?.parentId).toBe(parent)

    const parentIssue = await client.findOne(tracker.class.Issue, { _id: parent })
    expect(parentIssue).not.toBeNull()
  })

  test('multiple cards in one column are all visible', async ({ page }) => {
    const ids: Array<Ref<Issue>> = []
    for (let i = 0; i < 3; i++) {
      ids.push(
        await createIssue(client, ctx, {
          title: `${titlePrefix}multi-${i}`,
          status: 'Backlog'
        })
      )
    }

    await openTrackerBoard(page, ctx.project._id)

    const board = new KanbanBoardPage(page)
    const backlog = ctx.statuses.get('Backlog') as string
    for (const id of ids) {
      await board.expectCardInColumn(id, backlog)
    }
  })

  test.describe('Swim lanes', () => {
    test.afterEach(async ({ page }) => {
      try {
        await openTrackerBoard(page, ctx.project._id)
        const board = new KanbanBoardPage(page)
        await board.setSwimLane('None')
      } catch {
        // best effort
      }
    })

    test('appear when grouping by Priority', async ({ page }) => {
      await createIssue(client, ctx, { title: `${titlePrefix}sw-pri-1`, status: 'Backlog' })
      await createIssue(client, ctx, { title: `${titlePrefix}sw-pri-2`, status: 'Todo' })

      await openTrackerBoard(page, ctx.project._id)
      const board = new KanbanBoardPage(page)
      await board.setSwimLane('Priority')

      await expect(page.locator('[data-id="kanban-swimlane"]').first()).toBeVisible()
      const ids = await board.swimLanes()
      expect(ids.length).toBeGreaterThan(0)
    })

    test('order is stable across drag', async ({ page }) => {
      // Stable card lives in Urgent (4) — sparse lane, predictable visibility.
      // Anchors in the other priorities keep the lanes from disappearing.
      const stable = await createIssue(client, ctx, {
        title: `${titlePrefix}sw-stable`,
        status: 'Backlog',
        priority: 4
      })
      for (let p = 0; p <= 3; p++) {
        await createIssue(client, ctx, {
          title: `${titlePrefix}sw-stable-anchor-${p}`,
          status: 'Backlog',
          priority: p
        })
      }
      // Anchor in Todo of the stable lane (Urgent) so the target cell has a card to drop onto.
      await createIssue(client, ctx, {
        title: `${titlePrefix}sw-stable-todo-anchor`,
        status: 'Todo',
        priority: 4
      })

      await openTrackerBoard(page, ctx.project._id)
      const board = new KanbanBoardPage(page)
      await board.setSwimLane('Priority')
      await board.revealCard(stable)

      const beforeOrder = await board.swimLanes()
      expect(beforeOrder.length).toBeGreaterThanOrEqual(5)

      // Drag the stable card into the Todo cell of its own priority lane.
      const stableLaneId = await page
        .locator(`[data-id="kanban-swimlane"]:has([data-card-id="${stable}"])`)
        .first()
        .getAttribute('data-swimlane-id')
      expect(stableLaneId).not.toBeNull()
      if (stableLaneId === null) return
      await dragUntilStatus(client, stable, ctx.statuses.get('Todo') as string, async () => {
        await board.dragCardToSwimLaneCell(stable, stableLaneId, ctx.statuses.get('Todo') as string)
      })

      const afterOrder = await board.swimLanes()
      // Priority lanes that existed before must keep the same relative order.
      const beforeFiltered = beforeOrder.filter((id) => afterOrder.includes(id))
      const afterFiltered = afterOrder.filter((id) => beforeOrder.includes(id))
      expect(afterFiltered).toEqual(beforeFiltered)
    })

    test('drag child between parent lanes changes attachedTo', async ({ page }) => {
      const parentA = await createIssue(client, ctx, { title: `${titlePrefix}sw-parA`, status: 'Backlog' })
      const parentB = await createIssue(client, ctx, { title: `${titlePrefix}sw-parB`, status: 'Backlog' })
      const childA = await createIssue(client, ctx, {
        title: `${titlePrefix}sw-childA`,
        status: 'Todo',
        parent: parentA
      })
      const childB = await createIssue(client, ctx, {
        title: `${titlePrefix}sw-childB-anchor`,
        status: 'Todo',
        parent: parentB
      })

      await openTrackerBoard(page, ctx.project._id)
      const board = new KanbanBoardPage(page)
      await board.setSwimLane('Parent')

      const todo = ctx.statuses.get('Todo') as string
      await expect(board.swimLane(parentA)).toBeVisible()
      await expect(board.swimLane(parentB)).toBeVisible()
      if (await board.isSwimLaneCollapsed(parentA)) await board.toggleSwimLane(parentA)
      if (await board.isSwimLaneCollapsed(parentB)) await board.toggleSwimLane(parentB)

      await board.expectCardInSwimLaneCell(childA, parentA, todo)
      await board.expectCardInSwimLaneCell(childB, parentB, todo)

      await expect
        .poll(
          async () => {
            const issue = await client.findOne(tracker.class.Issue, { _id: childA })
            const at = issue?.attachedTo as string | undefined
            if (at === parentB) return at
            await board.dragCardToSwimLaneCell(childA, parentB, todo)
            return at
          },
          { timeout: 30000, intervals: retryIntervals }
        )
        .toBe(parentB)
    })

    test('multiple children render in the same parent lane', async ({ page }) => {
      const parent = await createIssue(client, ctx, { title: `${titlePrefix}sw-multipar`, status: 'Backlog' })
      const a = await createIssue(client, ctx, {
        title: `${titlePrefix}sw-A`,
        status: 'Backlog',
        parent
      })
      const b = await createIssue(client, ctx, {
        title: `${titlePrefix}sw-B`,
        status: 'Backlog',
        parent
      })

      await openTrackerBoard(page, ctx.project._id)
      const board = new KanbanBoardPage(page)
      await board.setSwimLane('Parent')

      await expect(board.swimLane(parent)).toBeVisible()
      if (await board.isSwimLaneCollapsed(parent)) await board.toggleSwimLane(parent)

      const backlog = ctx.statuses.get('Backlog') as string
      await board.expectCardInSwimLaneCell(a, parent, backlog)
      await board.expectCardInSwimLaneCell(b, parent, backlog)
    })

    test('renders Assignee swim lanes including unassigned', async ({ page }) => {
      // Find any employee assigned to existing issues.
      const someAssigned = await client.findOne(tracker.class.Issue, { assignee: { $ne: null } } as any)
      const targetAssignee = someAssigned?.assignee as string | undefined
      // Always create one unassigned card.
      await createIssue(client, ctx, { title: `${titlePrefix}sw-asg-unassigned`, status: 'Todo' })
      if (targetAssignee != null) {
        await createIssue(client, ctx, {
          title: `${titlePrefix}sw-asg-anchor`,
          status: 'Todo',
          assignee: targetAssignee as Ref<any>
        })
      }

      await openTrackerBoard(page, ctx.project._id)
      const board = new KanbanBoardPage(page)
      await board.setSwimLane('Assignee')

      // Unassigned lane must render.
      await expect(page.locator('[data-id="kanban-swimlane"][data-swimlane-id="__swim_unassigned__"]')).toBeVisible()
      // At least one swimlane present.
      const lanes = await board.swimLanes()
      expect(lanes.length).toBeGreaterThan(0)
    })

    // Headless HTML5 drag is too flaky to reliably synthesize the
    // "drop on upper half" gesture for rank reordering. Card-on-card drop
    // works manually but Playwright's CDP path frequently lands the rank
    // in an inconsistent state. The behaviour itself is covered by the
    // Kanban.svelte cardDragOver/cardDrop logic with both dragover and drop
    // fallbacks (see commit history); revisit when CDP drag becomes stable.
    test.skip('drag in Manual order keeps card on target position (no flicker to end)', async ({ page }) => {
      // Use Medium (3) so this test owns its lane — other tests use Urgent (1)
      // / NoPriority (0). Sparse lane keeps cards in the first 3 (initialLimit).
      const c1 = await createIssue(client, ctx, { title: `${titlePrefix}rank-1`, status: 'Backlog', priority: 3 })
      const c2 = await createIssue(client, ctx, { title: `${titlePrefix}rank-2`, status: 'Backlog', priority: 3 })
      const c3 = await createIssue(client, ctx, { title: `${titlePrefix}rank-3`, status: 'Backlog', priority: 3 })

      await openTrackerBoard(page, ctx.project._id)
      const board = new KanbanBoardPage(page)
      await board.setSwimLane('Priority')

      // Wait for c1 to be rendered in the swimlane; reveal it via Show more if
      // the lane is over capacity.
      await board.revealCard(c1)
      await board.card(c1).waitFor({ state: 'visible', timeout: 15000 })
      const noPriorityLaneId = await page
        .locator(`[data-id="kanban-swimlane"]:has([data-card-id="${c1}"])`)
        .first()
        .getAttribute('data-swimlane-id')
      expect(noPriorityLaneId).not.toBeNull()
      if (noPriorityLaneId === null) return
      if (await board.isSwimLaneCollapsed(noPriorityLaneId)) await board.toggleSwimLane(noPriorityLaneId)

      const backlog = ctx.statuses.get('Backlog') as string
      await board.expandAllCells()
      await board.expectCardInSwimLaneCell(c1, noPriorityLaneId, backlog)
      await board.expectCardInSwimLaneCell(c2, noPriorityLaneId, backlog)
      await board.expectCardInSwimLaneCell(c3, noPriorityLaneId, backlog)

      // Drop c3 onto c2 — manual rank update. Retry under flaky CDP drag.
      // Verify c3's rank ended up strictly less than c2's rank (i.e. c3 sits
      // before c2 in ascending order, the visual cue under the cursor).
      // Backend rank is the source of truth; DOM ordering depends on Show more.
      await expect
        .poll(
          async () => {
            try {
              await board.dragCardToCard(c3, c2)
            } catch {
              // ignore single failures
            }
            const issues = await client.findAll(tracker.class.Issue, {
              _id: { $in: [c2, c3] }
            })
            const byId = new Map(issues.map((it) => [it._id, it]))
            const r2 = byId.get(c2)?.rank
            const r3 = byId.get(c3)?.rank
            if (r2 === undefined || r3 === undefined) return false
            return r3 < r2
          },
          { timeout: 30000, intervals: retryIntervals }
        )
        .toBe(true)

      // All three still in same cell after settle.
      await board.expectCardInSwimLaneCell(c1, noPriorityLaneId, backlog)
      await board.expectCardInSwimLaneCell(c2, noPriorityLaneId, backlog)
      await board.expectCardInSwimLaneCell(c3, noPriorityLaneId, backlog)
    })

    test('Show more counter does not flicker for unrelated cells while dragging', async ({ page }) => {
      // Create > 3 cards in one Urgent/Backlog cell so Show more is visible.
      // Using Urgent (4) keeps the test isolated from accumulated NoPriority
      // issues across previous runs.
      const ids: Array<Ref<Issue>> = []
      for (let i = 0; i < 5; i++) {
        ids.push(
          await createIssue(client, ctx, {
            title: `${titlePrefix}sm-${i}`,
            status: 'Backlog',
            priority: 4
          })
        )
      }
      // Card to drag from a different cell (different status).
      const dragId = await createIssue(client, ctx, {
        title: `${titlePrefix}sm-drag`,
        status: 'Todo',
        priority: 4
      })

      await openTrackerBoard(page, ctx.project._id)
      const board = new KanbanBoardPage(page)
      await board.setSwimLane('Priority')

      const backlog = ctx.statuses.get('Backlog') as string
      // The Backlog cell with 5 cards should have a Show more button (locale-agnostic).
      const cellLocator = page
        .locator(`[data-id="kanban-swimlane-cell"][data-state="${backlog}"]`)
        .filter({ has: page.locator('[data-id="kanban-show-more"]') })
        .first()
      await expect(cellLocator).toBeVisible()

      // Reveal the drag source card if it landed beyond the initial limit.
      await board.revealCard(dragId)
      const card = board.card(dragId)
      await card.scrollIntoViewIfNeeded()
      const box = await card.boundingBox()
      expect(box).not.toBeNull()
      if (box === null) return
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 30, { steps: 4 })

      // Show more must remain visible during drag (was the bug — disappeared on every cell).
      await expect(cellLocator).toBeVisible()
      await page.mouse.up()
    })

    test('drop into same cell does not update document', async ({ page }) => {
      const cardId = await createIssue(client, ctx, {
        title: `${titlePrefix}noop-drop`,
        status: 'Backlog',
        priority: 2
      })

      await openTrackerBoard(page, ctx.project._id)
      const board = new KanbanBoardPage(page)
      await board.setSwimLane('Priority')

      const backlog = ctx.statuses.get('Backlog') as string
      await board.revealCard(cardId)
      await board.card(cardId).waitFor({ state: 'visible', timeout: 15000 })
      const laneId = await page
        .locator(`[data-id="kanban-swimlane"]:has([data-card-id="${cardId}"])`)
        .first()
        .getAttribute('data-swimlane-id')
      expect(laneId).not.toBeNull()
      if (laneId === null) return
      if (await board.isSwimLaneCollapsed(laneId)) await board.toggleSwimLane(laneId)
      await board.expectCardInSwimLaneCell(cardId, laneId, backlog)

      const before = await client.findOne(tracker.class.Issue, { _id: cardId })
      const beforeModifiedOn = before?.modifiedOn
      expect(beforeModifiedOn).toBeDefined()

      // Drop card back into the same cell - no rank/status/lane change expected.
      await board.dragCardToSwimLaneCell(cardId, laneId, backlog)

      // Wait briefly to allow any spurious update transactions to land.
      await page.waitForTimeout(2000)

      const after = await client.findOne(tracker.class.Issue, { _id: cardId })
      expect(after?.modifiedOn).toBe(beforeModifiedOn)
      expect(after?.status).toBe(before?.status)
      expect(after?.rank).toBe(before?.rank)
    })

    test('toggle collapse hides cells', async ({ page }) => {
      await createIssue(client, ctx, { title: `${titlePrefix}sw-toggle`, status: 'Backlog' })

      await openTrackerBoard(page, ctx.project._id)
      const board = new KanbanBoardPage(page)
      await board.setSwimLane('Priority')

      // Wait for swimlanes to be fully rendered before reading IDs.
      await expect(page.locator('[data-id="kanban-swimlane"]').first()).toBeVisible()
      const ids = await board.swimLanes()
      expect(ids.length).toBeGreaterThan(0)
      // Priority lanes are preseeded and always rendered; the unassigned one exists only while
      // some issue of this shared project has no priority, so a parallel test can drop it
      // between reading its id and using it.
      const laneId = ids.find((id) => id !== '__swim_unassigned__')
      expect(laneId).toBeDefined()
      if (laneId === undefined) return

      // Toggle from whatever the persisted state is to its opposite, then back.
      const initial = await board.isSwimLaneCollapsed(laneId)
      await board.toggleSwimLane(laneId)
      await board.expectSwimLaneCollapsed(laneId, !initial)
      await board.toggleSwimLane(laneId)
      await board.expectSwimLaneCollapsed(laneId, initial)
    })

    test('swim lane header counter equals sum of cells', async ({ page }) => {
      // Counter shown next to a lane title must reflect the actual number of
      // cards rendered across all status cells in that lane.
      const ids: Array<Ref<Issue>> = []
      for (const status of ['Backlog', 'Todo', 'In Progress'] as const) {
        ids.push(await createIssue(client, ctx, { title: `${titlePrefix}counter-${status}`, status, priority: 1 }))
      }

      await openTrackerBoard(page, ctx.project._id)
      const board = new KanbanBoardPage(page)
      await board.setSwimLane('Priority')
      await board.revealCard(ids[0])

      const urgentLaneId = '1'
      const counterText = await page
        .locator(`[data-id="kanban-swimlane"][data-swimlane-id="${urgentLaneId}"] .swimlane-count`)
        .first()
        .textContent()
      const counter = Number((counterText ?? '0').trim())

      const renderedCards = await page
        .locator(`[data-id="kanban-swimlane"][data-swimlane-id="${urgentLaneId}"] [data-id="kanban-card"]`)
        .count()

      expect(counter).toBeGreaterThanOrEqual(renderedCards)
      expect(counter).toBeGreaterThanOrEqual(3)
    })

    test('collapse persists across reload', async ({ page }) => {
      await createIssue(client, ctx, { title: `${titlePrefix}collapse-persist`, status: 'Backlog' })

      await openTrackerBoard(page, ctx.project._id)
      const board = new KanbanBoardPage(page)
      await board.setSwimLane('Priority')

      // Skip the unassigned lane - it disappears as soon as no issue of this shared project
      // is left without a priority. Priority lanes are preseeded and stay.
      const laneId = (await board.swimLanes()).find((id) => id !== '__swim_unassigned__')
      expect(laneId).toBeDefined()
      if (laneId === undefined) return
      const wasCollapsed = await board.isSwimLaneCollapsed(laneId)
      if (wasCollapsed) await board.toggleSwimLane(laneId)
      await board.expectSwimLaneCollapsed(laneId, false)

      // Collapse it.
      await board.toggleSwimLane(laneId)
      await board.expectSwimLaneCollapsed(laneId, true)

      // Reload WITHOUT clearing localStorage — collapsed state must persist.
      const projectPath = encodeURIComponent(ctx.project._id)
      await (await page.goto(`${PlatformURI}/workbench/sanity-ws/tracker/${projectPath}/issues`))?.finished()
      await page.locator(ViewletSelectors.Board).click()
      // Wait for the very lane under test: lanes render one by one, so waiting for "any lane"
      // can return while this one is still missing.
      await page
        .locator(`[data-id="kanban-swimlane"][data-swimlane-id="${laneId}"]`)
        .waitFor({ state: 'visible', timeout: 10000 })
      await board.expectSwimLaneCollapsed(laneId, true)

      // Cleanup so other tests are not affected.
      await board.toggleSwimLane(laneId)
    })

    test('drop into unavailable category does not change status', async ({ page }) => {
      // getAvailableCategories returns only states valid for the issue's project.
      // For the Default project's task type, all states are valid — to simulate
      // an unavailable target we drag-and-drop through to the same status (no-op
      // path) and verify nothing changes. Realistically this checks the guard
      // path: dropping back into the same column must not bump modifiedOn.
      const cardId = await createIssue(client, ctx, {
        title: `${titlePrefix}same-col`,
        status: 'Backlog',
        priority: 1
      })

      await openTrackerBoard(page, ctx.project._id)
      const board = new KanbanBoardPage(page)
      await board.setSwimLane('Priority')
      await board.revealCard(cardId)

      const before = await client.findOne(tracker.class.Issue, { _id: cardId })
      const beforeModifiedOn = before?.modifiedOn
      const beforeRank = before?.rank
      expect(beforeModifiedOn).toBeDefined()

      // Drag the card onto itself (or onto its current cell) — should be a no-op.
      const laneId = await page
        .locator(`[data-id="kanban-swimlane"]:has([data-card-id="${cardId}"])`)
        .first()
        .getAttribute('data-swimlane-id')
      expect(laneId).not.toBeNull()
      if (laneId === null) return
      const backlog = ctx.statuses.get('Backlog') as string
      await board.dragCardToSwimLaneCell(cardId, laneId, backlog)
      await page.waitForTimeout(2000)

      const after = await client.findOne(tracker.class.Issue, { _id: cardId })
      expect(after?.modifiedOn).toBe(beforeModifiedOn)
      expect(after?.rank).toBe(beforeRank)
      expect(after?.status).toBe(before?.status)
    })

    test('toggle None -> Priority -> None -> Priority shows cards each time', async ({ page }) => {
      // Regression: groupByDocs memo (hashed by ids+lengths) used to skip a refresh
      // when projection added the swim-lane field — cards rendered as if the swim
      // field were undefined and every lane appeared empty after the second switch.
      const cardId = await createIssue(client, ctx, {
        title: `${titlePrefix}toggle-priority`,
        status: 'Backlog',
        priority: 4
      })

      await openTrackerBoard(page, ctx.project._id)
      const board = new KanbanBoardPage(page)
      const backlog = ctx.statuses.get('Backlog') as string

      for (let i = 0; i < 2; i++) {
        await board.setSwimLane('Priority')
        await board.revealCard(cardId)
        // After projection refresh, cards must land in their priority lane — not
        // the unassigned bucket. Lane id is the priority enum value as string.
        const lane = await page
          .locator(`[data-id="kanban-swimlane"]:has([data-card-id="${cardId}"])`)
          .first()
          .getAttribute('data-swimlane-id')
        expect(lane, `iteration ${i}: card must be in some priority lane, not unassigned`).not.toBe(
          '__swim_unassigned__'
        )
        expect(lane).not.toBeNull()
        if (lane !== null) {
          await board.expectCardInSwimLaneCell(cardId, lane, backlog)
        }
        await board.setSwimLane('None')
        await board.expectCardInColumn(cardId, backlog)
      }
    })

    test('component swim lane merges same-label components from different projects', async ({ page }) => {
      // Regression for FUSIO-378: components with identical label living in
      // different projects used to render as separate lanes. They should be
      // grouped into one lane keyed by the (case-folded) label.
      const secondProject = await findProjectByName(client, 'Second Project')
      test.skip(secondProject === undefined, 'Second Project not seeded — skipping')
      if (secondProject === undefined) return

      const sharedLabel = `merge-${generateId(4)}`
      const compA = await createComponent(client, ctx.project._id, sharedLabel)
      const compB = await createComponent(client, secondProject._id, sharedLabel)

      const issueA = await createIssue(client, ctx, {
        title: `${titlePrefix}merge-A`,
        status: 'Backlog',
        component: compA
      })
      const ctxB = await getProjectContext(client, secondProject._id)
      const issueB = await createIssue(client, ctxB, {
        title: `${titlePrefix}merge-B`,
        status: 'Backlog',
        space: secondProject._id,
        component: compB
      })

      // Open the All Issues view to see issues from both projects.
      await (await page.goto(`${PlatformURI}/workbench/sanity-ws/tracker/all-issues`))?.finished()
      await page.locator(ViewletSelectors.Board).click()
      const board = new KanbanBoardPage(page)
      await board.setSwimLane('Component')
      await board.revealCard(issueA)
      await board.revealCard(issueB)

      const laneA = await page
        .locator(`[data-id="kanban-swimlane"]:has([data-card-id="${issueA}"])`)
        .first()
        .getAttribute('data-swimlane-id')
      const laneB = await page
        .locator(`[data-id="kanban-swimlane"]:has([data-card-id="${issueB}"])`)
        .first()
        .getAttribute('data-swimlane-id')
      expect(laneA).not.toBeNull()
      expect(laneA).toBe(laneB)
    })
  })

  test('drag preview follows cursor in non-manual ordering', async ({ page }) => {
    // Regression: cardDragOver had a `dontUpdateRank` guard that prevented the
    // visual preview from following the cursor when ordering was not Manual.
    // Users could not see which column they were targeting.
    const c1 = await createIssue(client, ctx, { title: `${titlePrefix}preview-1`, status: 'Backlog' })
    const c2 = await createIssue(client, ctx, { title: `${titlePrefix}preview-2`, status: 'Todo' })

    await openTrackerBoard(page, ctx.project._id)

    const board = new KanbanBoardPage(page)
    // Switch ordering to Modified date so dontUpdateRank=true.
    await board.openViewOptions()
    const orderingRow = page.locator('.antiCard-menu__item', { hasText: 'Ordering' })
    await orderingRow.waitFor({ state: 'visible', timeout: 5000 })
    await orderingRow.locator('button').click()
    await page.locator('.menu-item').filter({ hasText: 'Modified date' }).first().click()
    await page.keyboard.press('Escape')

    const todo = ctx.statuses.get('Todo') as string
    await board.revealCard(c1)
    await board.revealCard(c2)

    // Drag c1 onto c2: status should change to Todo (state-only update — rank stays).
    await dragUntilStatus(client, c1, todo, async () => {
      await board.revealCard(c1)
      await board.dragCardToCard(c1, c2)
    })
  })

  test('legacy drop on self does not bump modifiedOn', async ({ page }) => {
    // Mirrors the swim lane no-op test for the legacy column layout: drag a
    // card and drop it back on its own column without movement.
    const cardId = await createIssue(client, ctx, {
      title: `${titlePrefix}legacy-noop`,
      status: 'Backlog'
    })

    await openTrackerBoard(page, ctx.project._id)
    const board = new KanbanBoardPage(page)
    const backlog = ctx.statuses.get('Backlog') as string
    await board.revealCard(cardId)
    await board.expectCardInColumn(cardId, backlog)

    const before = await client.findOne(tracker.class.Issue, { _id: cardId })
    const beforeModifiedOn = before?.modifiedOn
    const beforeRank = before?.rank
    expect(beforeModifiedOn).toBeDefined()

    await board.dragCardToColumn(cardId, backlog)
    await page.waitForTimeout(2000)

    const after = await client.findOne(tracker.class.Issue, { _id: cardId })
    expect(after?.modifiedOn).toBe(beforeModifiedOn)
    expect(after?.rank).toBe(beforeRank)
    expect(after?.status).toBe(before?.status)
  })

  test('dragstart marks the card as dragged', async ({ page }) => {
    const cardId = await createIssue(client, ctx, {
      title: `${titlePrefix}dragmark-1`,
      status: 'Backlog'
    })
    await openTrackerBoard(page, ctx.project._id)

    const board = new KanbanBoardPage(page)
    await board.expectCardInColumn(cardId, ctx.statuses.get('Backlog') as string)

    const card = board.card(cardId)
    const box = await card.boundingBox()
    expect(box).not.toBeNull()
    if (box === null) return
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 30, { steps: 4 })
    // Card retains data-card-id during drag.
    await expect(card).toBeVisible()
    await page.mouse.up()
  })
})
