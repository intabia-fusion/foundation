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

import { expect, type Locator } from '@playwright/test'
import { CommonTrackerPage } from './common-tracker-page'
import { retryIntervals, waitStable } from '../../retry'

export class KanbanBoardPage extends CommonTrackerPage {
  column (state: string): Locator {
    return this.page.locator(`[data-id="kanban-column"][data-state="${state}"]`)
  }

  swimLane (laneId: string): Locator {
    return this.page.locator(`[data-id="kanban-swimlane"][data-swimlane-id="${laneId}"]`)
  }

  swimLaneHeader (laneId: string): Locator {
    return this.swimLane(laneId).locator('[data-id="kanban-swimlane-header"]')
  }

  swimLaneCell (laneId: string, state: string): Locator {
    return this.page.locator(`[data-id="kanban-swimlane-cell"][data-swimlane-id="${laneId}"][data-state="${state}"]`)
  }

  card (cardId: string): Locator {
    return this.page.locator(`[data-id="kanban-card"][data-card-id="${cardId}"]`)
  }

  async expectCardInColumn (cardId: string, state: string): Promise<void> {
    await expect(this.column(state).locator(`[data-id="kanban-card"][data-card-id="${cardId}"]`)).toBeVisible()
  }

  async expectCardInSwimLaneCell (cardId: string, laneId: string, state: string): Promise<void> {
    await expect(
      this.swimLaneCell(laneId, state).locator(`[data-id="kanban-card"][data-card-id="${cardId}"]`)
    ).toBeVisible()
  }

  async toggleSwimLane (laneId: string): Promise<void> {
    await this.swimLaneHeader(laneId).click()
  }

  async isSwimLaneCollapsed (laneId: string): Promise<boolean> {
    const v = await this.swimLaneHeader(laneId).getAttribute('data-swimlane-collapsed')
    return v === 'true'
  }

  async expectSwimLaneCollapsed (laneId: string, collapsed: boolean): Promise<void> {
    await expect(this.swimLaneHeader(laneId)).toHaveAttribute('data-swimlane-collapsed', collapsed ? 'true' : 'false')
  }

  async dragCardToColumn (cardId: string, targetState: string): Promise<void> {
    // Works in both legacy column and swim-lane modes by picking whichever drop target exists.
    const legacy = this.column(targetState)
    let target
    if ((await legacy.count()) > 0) {
      target = legacy
    } else {
      const cell = this.page.locator(`[data-id="kanban-swimlane-cell"][data-state="${targetState}"]`).first()
      // Prefer dropping onto a card inside the cell — drop handler is more reliable on cards.
      const cardInCell = cell.locator('[data-id="kanban-card"]').first()
      target =
        (await cardInCell.count()) > 0 && (await cardInCell.getAttribute('data-card-id')) !== cardId ? cardInCell : cell
    }
    await this.ensureVisible(this.card(cardId))
    await this.dragPointer(this.card(cardId), target)
  }

  async dragCardToSwimLaneCell (cardId: string, laneId: string, targetState: string): Promise<void> {
    const cell = this.swimLaneCell(laneId, targetState)
    await this.ensureVisible(this.card(cardId))
    // Prefer dropping onto an existing card inside the cell — Svelte's drop handler
    // fires reliably on card-container, while empty cells sometimes miss CDP drag.
    const cardInCell = cell.locator('[data-id="kanban-card"]').first()
    const target =
      (await cardInCell.count()) > 0 && (await cardInCell.getAttribute('data-card-id')) !== cardId ? cardInCell : cell
    await this.dragPointer(this.card(cardId), target)
  }

  /** Scrolling can race the board re-rendering, which detaches the node mid-action. */
  private async ensureVisible (locator: Locator): Promise<void> {
    await expect(async () => {
      await locator.scrollIntoViewIfNeeded({ timeout: 5000 })
    }).toPass({ intervals: retryIntervals, timeout: 15000 })
  }

  /**
   * dragTo() moves to the target in one hop, and a single dragover is often not enough for the
   * board to register the drop target - the drag then ends with no status change and no error.
   * Walk the pointer across in steps and jiggle on the target so dragover fires repeatedly.
   */
  private async dragPointer (source: Locator, target: Locator): Promise<void> {
    // Bounded wait for the drop target: a card can page out of a column while other tests keep
    // modifying issues, and then evaluate/boundingBox below block until the whole test times out,
    // leaving the caller's retry loop no turn at all.
    await target.waitFor({ state: 'attached', timeout: 5000 })
    await source.hover()
    await this.page.mouse.down()
    try {
      // The board scrolls horizontally and does not fit five columns, so bring the target into view
      // only after the card is grabbed: hovering the source scrolls it back and a box measured
      // before that points outside the viewport. Scroll through the DOM - scrollIntoViewIfNeeded
      // waits for the element to be stable, and the board animates for as long as a card is held.
      await target.evaluate((el) => {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      })
      // The board keeps scrolling for a frame or two after scrollIntoView, so a box read right away
      // points where the target no longer is - and the drop then lands on the neighbouring column.
      const raw = await waitStable(async () => JSON.stringify(await target.boundingBox()), {
        stableFor: 200,
        interval: 50,
        timeout: 5000
      })
      const box = JSON.parse(raw)
      if (box === null) throw new Error('Drop target has no bounding box')
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2

      await this.page.mouse.move(x, y, { steps: 10 })
      await this.page.mouse.move(x + 2, y + 2)
      await this.page.mouse.move(x, y)
    } finally {
      await this.page.mouse.up()
    }
  }

  async dragCardToCard (cardId: string, targetCardId: string): Promise<void> {
    const source = this.card(cardId)
    const target = this.card(targetCardId)
    // Both cards can be beyond the loaded page of their column - the target no less than the source.
    await this.revealCard(cardId)
    await this.revealCard(targetCardId)
    await this.ensureVisible(source)
    await this.dragPointer(source, target)
  }

  async getScrollTop (): Promise<number> {
    return await this.page.evaluate(() => {
      const el = document.querySelector('.kanban-container .scroll, .kanban-content')
      return el != null ? (el as HTMLElement).scrollTop : window.scrollY
    })
  }

  async setSwimLane (
    option: 'None' | 'Assignee' | 'Priority' | 'Component' | 'Milestone' | 'Parent' | 'Project'
  ): Promise<void> {
    await this.page.locator('button[data-id="btn-viewOptions"]').click()
    const swimRow = this.page.locator('.antiCard-menu__item', { hasText: 'Swim lane' })
    await swimRow.waitFor({ state: 'visible', timeout: 5000 })
    await swimRow.locator('button').click()
    const menuItem = this.page.locator('.menu-item').filter({ hasText: new RegExp(`^\\s*${option}\\s*$`) })
    await menuItem.first().click()
    // Close any remaining popups (sub-menu + view-options card).
    await this.page.keyboard.press('Escape')
    await this.page.keyboard.press('Escape')
    if (option === 'None') {
      await this.page.locator('[data-id="kanban-column"]').first().waitFor({ state: 'visible', timeout: 10000 })
    } else {
      await this.page.locator('[data-id="kanban-swimlane"]').first().waitFor({ state: 'visible', timeout: 10000 })
      // Lanes from the previous grouping stay in the DOM while the board
      // re-renders, so a bare visibility wait returns stale lane ids. Wait for
      // the id list to stop changing before the caller reads it.
      let previous = ''
      await expect
        .poll(
          async () => {
            const ids = (
              await this.page
                .locator('[data-id="kanban-swimlane"]')
                .evaluateAll((els) => els.map((el) => el.getAttribute('data-swimlane-id') ?? ''))
            ).join(',')
            const stable = ids !== '' && ids === previous
            previous = ids
            return stable
          },
          { timeout: 10000, intervals: retryIntervals }
        )
        .toBe(true)
    }
  }

  async expectSwimLaneVisible (laneId: string): Promise<void> {
    await expect(this.swimLane(laneId)).toBeVisible()
  }

  // Click "Show more" in any cell on the board until the requested card is in DOM.
  // Cards beyond the initial limit (3 in swimlane mode) are not rendered until
  // the user expands the cell. Tests that rely on a freshly-created card in a
  // populated lane must reveal it before asserting visibility.
  async revealCard (cardId: string, attempts: number = 30): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      if ((await this.card(cardId).count()) > 0) return
      const showMore = this.page.locator('button[data-id="btn-kanban-show-more"]').first()
      if ((await showMore.count()) === 0) {
        // No more "Show more" buttons left. Wait briefly for live-query to land
        // and check again.
        await this.page.waitForTimeout(300)
        continue
      }
      await showMore.click().catch(() => {})
      await this.page.waitForTimeout(150)
    }
  }

  // Click every "Show more" button on the board until no truncated cells remain.
  // Use this in tests that read all cards in a cell via DOM — initialLimit can
  // truncate the list and produce stale assertions.
  async expandAllCells (maxClicks: number = 50): Promise<void> {
    for (let i = 0; i < maxClicks; i++) {
      const buttons = this.page.locator('button[data-id="btn-kanban-show-more"]')
      const count = await buttons.count()
      if (count === 0) return
      await buttons
        .first()
        .click()
        .catch(() => {})
      await this.page.waitForTimeout(120)
    }
  }

  async swimLanes (): Promise<string[]> {
    return await this.page
      .locator('[data-id="kanban-swimlane"]')
      .evaluateAll((nodes) =>
        nodes.map((n) => (n as HTMLElement).getAttribute('data-swimlane-id') ?? '').filter((v) => v !== '')
      )
  }
}
