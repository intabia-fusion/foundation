import { expect, test, type Page } from '../fixtures'
import { generateId, getSecondPage, PlatformSetting, PlatformURI } from '../utils'
import { LeftSideMenuPage } from '../model/left-side-menu-page'
import { TeamPage } from '../model/team-page'
import { PlanningPage } from '../model/planning/planning-page'
import { PlanningNavigationMenuPage } from '../model/planning/planning-navigation-menu-page'
import { NewToDo } from '../model/planning/types'
import { IssuesPage } from '../model/tracker/issues-page'
import { CalendarPage } from '../model/calendar-page'
import { SidebarPage } from '../model/sidebar-page'

test.use({
  storageState: PlatformSetting
})

// The stand's second account, as rendered by person presenters: "Last First".
const SECOND_USER = 'Dirak Kainin'

async function openCalendarWidget (page: Page): Promise<CalendarPage> {
  await (await page.goto(`${PlatformURI}/workbench/sanity-ws`))?.finished()
  const sidebarPage = new SidebarPage(page)
  await sidebarPage.clickSidebarPageButton('calendar')
  await sidebarPage.checkIfPlanerSidebarTabIsOpen(true)
  return new CalendarPage(page)
}

test.describe('Team Planner tests', () => {
  test.beforeEach(async ({ page }) => {
    await (await page.goto(`${PlatformURI}/workbench/sanity-ws/time`))?.finished()
    // The planner remembers its last mode and panel layout in localStorage - clear them so
    // every test starts from the default state.
    await page.evaluate(() => {
      localStorage.removeItem('todos_last_mode')
      localStorage.removeItem('planner_calendar_mode')
      localStorage.removeItem('planner_show_todos_personal')
      localStorage.removeItem('planner_show_todos_team-calendar')
      localStorage.removeItem('planner_show_todos_team')
      localStorage.removeItem('planner_extra_persons')
    })
  })

  test('Team Planner opens without a project and shows employees in Calendar mode', async ({ page }) => {
    const leftSideMenuPage = new LeftSideMenuPage(page)
    const teamPage = new TeamPage(page)

    await leftSideMenuPage.clickPlanner()
    await teamPage.checkTeamPageIsOpened()
    await teamPage.openTeamCalendar()

    await expect(teamPage.employeeRow().first()).toBeVisible()
  })

  test('Switching between Calendar and Occupancy modes', async ({ page }) => {
    const leftSideMenuPage = new LeftSideMenuPage(page)
    const teamPage = new TeamPage(page)

    await leftSideMenuPage.clickPlanner()
    await teamPage.checkTeamPageIsOpened()

    await teamPage.openTeamOccupancy()
    await expect(teamPage.occupancyColumn('Yesterday')).toBeVisible()
    await expect(teamPage.occupancyColumn('Today')).toBeVisible()
    await expect(teamPage.occupancyColumn('Tomorrow')).toBeVisible()

    await teamPage.openTeamCalendar()
    await expect(teamPage.employeeRow().first()).toBeVisible()
  })

  test('Clearing the filter resets the selected project', async ({ page }) => {
    const leftSideMenuPage = new LeftSideMenuPage(page)
    const teamPage = new TeamPage(page)

    await leftSideMenuPage.clickPlanner()
    await teamPage.checkTeamPageIsOpened()

    await teamPage.openTeamOccupancy()
    await teamPage.selectTeam('Default')
    // The object filter shows a count ("1 state"), not the project name, so assert the
    // attribute and the condition only - the value is checked by the view reacting to it.
    await teamPage.checkFilter('Space', 'is')
    await expect(teamPage.buttonClearFilters()).toBeVisible()

    await teamPage.clearFilters()
    await expect(teamPage.buttonClearFilters()).toBeHidden()
  })

  test('Colleague busy time is anonymized in Occupancy mode', async ({ page, browser }) => {
    const busyTitle = `Busy ToDo ${generateId()}`
    // Today, not tomorrow: with the todo list open the schedule panel is narrow enough that
    // DayCalendar collapses to a single day, and tomorrow would be off screen.
    const today = new Date()
    const busyToDo: NewToDo = {
      title: busyTitle,
      slots: [
        {
          dateStart: `${today.getDate()}`,
          timeStart: '1000',
          dateEnd: {
            day: today.getDate().toString(),
            month: (today.getMonth() + 1).toString(),
            year: today.getFullYear().toString()
          },
          timeEnd: '1100'
        }
      ]
    }

    // The stand already has a second account in sanity-ws - signing up a new one
    // and creating a workspace does not fit the default test timeout.
    using _page2 = await getSecondPage(browser)
    const page2 = _page2.page
    await (await page2.goto(`${PlatformURI}/workbench/sanity-ws/time`))?.finished()

    await test.step('Second user books a plain, project-less tomorrow slot in Planner', async () => {
      const leftSideMenuPageSecond = new LeftSideMenuPage(page2)
      const planningPageSecond = new PlanningPage(page2)
      const planningNavigationMenuPageSecond = new PlanningNavigationMenuPage(page2)

      await leftSideMenuPageSecond.clickPlanner()
      await planningNavigationMenuPageSecond.clickOnButtonToDoAll()
      await planningPageSecond.createNewToDo({ title: busyToDo.title })
      await planningPageSecond.checkToDoExist(busyToDo.title)
      await planningPageSecond.openToDoByName(busyToDo.title)
      if (busyToDo.slots != null) {
        await planningPageSecond.clickButtonCreateAddSlot()
        await planningPageSecond.setTimeSlot(0, busyToDo.slots[0])
      }
      await planningPageSecond.clickButtonCardClose()
    })

    await test.step('First user sees an anonymous Busy block, never the todo title', async () => {
      const leftSideMenuPage = new LeftSideMenuPage(page)
      const teamPage = new TeamPage(page)

      await leftSideMenuPage.clickPlanner()
      await teamPage.checkTeamPageIsOpened()
      await teamPage.openTeamOccupancy()

      await expect(teamPage.busyBlock('Tomorrow')).toBeVisible()
      await expect(teamPage.getItemByText('Tomorrow', busyTitle)).not.toBeVisible()
    })
  })

  test('Colleague project todo shows its issue title in Occupancy mode', async ({ page, browser }) => {
    const issueTitle = `Project ToDo ${generateId()}`
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const projectToDo: NewToDo = {
      title: issueTitle,
      slots: [
        {
          dateStart: `${tomorrow.getDate()}`,
          timeStart: '1300',
          dateEnd: {
            day: tomorrow.getDate().toString(),
            month: (tomorrow.getMonth() + 1).toString(),
            year: tomorrow.getFullYear().toString()
          },
          timeEnd: '1400'
        }
      ]
    }

    // The stand already has a second account in sanity-ws - signing up a new one
    // and creating a workspace does not fit the default test timeout.
    using _page2 = await getSecondPage(browser)
    const page2 = _page2.page
    await (await page2.goto(`${PlatformURI}/workbench/sanity-ws/time`))?.finished()

    await test.step('Second user assigns a Default project issue to himself', async () => {
      // Assigning to self is what makes the server trigger create a ProjectToDo attached to the
      // project's space (see getCreateToDoTx in server-plugins/time-resources) - a plain todo would
      // land in the user's personal space instead, same as the anonymized-busy test above.
      const leftSideMenuPageSecond = new LeftSideMenuPage(page2)
      const issuesPageSecond = new IssuesPage(page2)

      await leftSideMenuPageSecond.clickTracker()
      await issuesPageSecond.clickLinkSidebarAll()
      await issuesPageSecond.clickModelSelectorAll()
      await issuesPageSecond.createNewIssue({
        title: issueTitle,
        description: 'Project todo visibility test',
        projectName: 'Default',
        status: 'Todo',
        assignee: SECOND_USER
      })
    })

    await test.step('Second user books a tomorrow slot for the auto-created project todo', async () => {
      const leftSideMenuPageSecond = new LeftSideMenuPage(page2)
      const planningPageSecond = new PlanningPage(page2)
      const planningNavigationMenuPageSecond = new PlanningNavigationMenuPage(page2)

      await leftSideMenuPageSecond.clickPlanner()
      await planningNavigationMenuPageSecond.clickOnButtonToDoAll()
      await planningPageSecond.checkToDoExist(projectToDo.title)
      await planningPageSecond.openToDoByName(projectToDo.title)
      if (projectToDo.slots != null) {
        await planningPageSecond.clickButtonCreateAddSlot()
        await planningPageSecond.setTimeSlot(0, projectToDo.slots[0])
      }
      await planningPageSecond.clickButtonCardClose()
    })

    await test.step('First user sees the issue title in the shared project, not an anonymous block', async () => {
      const leftSideMenuPage = new LeftSideMenuPage(page)
      const teamPage = new TeamPage(page)

      await leftSideMenuPage.clickPlanner()
      await teamPage.checkTeamPageIsOpened()
      await teamPage.openTeamOccupancy()
      await teamPage.selectTeam('Default')

      await expect(teamPage.getItemByText('Tomorrow', issueTitle)).toBeVisible()
    })
  })

  test('Switching modes through the dropdown persists across a reload', async ({ page }) => {
    const leftSideMenuPage = new LeftSideMenuPage(page)
    const teamPage = new TeamPage(page)

    await leftSideMenuPage.clickPlanner()
    await teamPage.checkTeamPageIsOpened()

    await teamPage.openTeamCalendar()
    await page.reload()
    await teamPage.checkTeamPageIsOpened()
    await expect(teamPage.buttonMode()).toContainText('Calendar')

    await teamPage.openTeamOccupancy()
    await page.reload()
    await teamPage.checkTeamPageIsOpened()
    await expect(teamPage.buttonMode()).toContainText('Team')
  })

  test('Hiding the todo panel makes the calendar span the full content width', async ({ page }) => {
    const leftSideMenuPage = new LeftSideMenuPage(page)
    const teamPage = new TeamPage(page)

    await leftSideMenuPage.clickPlanner()
    await teamPage.checkTeamPageIsOpened()
    await expect(teamPage.buttonMode()).toContainText('Schedule')
    await expect(teamPage.toDoListPanel()).toBeVisible()

    await teamPage.toggleTodos()
    await expect(teamPage.toDoListPanel()).toBeHidden()

    const panelBox = await teamPage.calendarPanel().boundingBox()
    const containerBox = await teamPage.calendarPanel().locator('xpath=..').boundingBox()
    expect(panelBox).not.toBeNull()
    expect(containerBox).not.toBeNull()
    // The navigator is a sibling inside the same row, so the panel is never as wide as the
    // container - what matters is that its right edge reaches the container's. A stale inline
    // width used to stop it short and leave the right side empty (PlanView.svelte).
    const panelRight = (panelBox?.x ?? 0) + (panelBox?.width ?? 0)
    const containerRight = (containerBox?.x ?? 0) + (containerBox?.width ?? 0)
    expect(Math.abs(panelRight - containerRight)).toBeLessThanOrEqual(2)
  })

  test('Todo panel default visibility differs per mode', async ({ page }) => {
    const leftSideMenuPage = new LeftSideMenuPage(page)
    const teamPage = new TeamPage(page)

    await leftSideMenuPage.clickPlanner()
    await teamPage.checkTeamPageIsOpened()
    await expect(teamPage.toDoListPanel()).toBeVisible()

    await teamPage.openTeamCalendar()
    await expect(teamPage.toDoListPanel()).toBeHidden()

    await teamPage.openTeamOccupancy()
    await expect(teamPage.toDoListPanel()).toBeHidden()
  })

  test('Picking a colleague overlays their busy time on my Schedule', async ({ page, browser }) => {
    const busyTitle = `Busy ToDo ${generateId()}`
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const busyToDo: NewToDo = {
      title: busyTitle,
      slots: [
        {
          dateStart: `${tomorrow.getDate()}`,
          timeStart: '1000',
          dateEnd: {
            day: tomorrow.getDate().toString(),
            month: (tomorrow.getMonth() + 1).toString(),
            year: tomorrow.getFullYear().toString()
          },
          timeEnd: '1100'
        }
      ]
    }

    // The stand already has a second account in sanity-ws - signing up a new one
    // and creating a workspace does not fit the default test timeout.
    using _page2 = await getSecondPage(browser)
    const page2 = _page2.page
    await (await page2.goto(`${PlatformURI}/workbench/sanity-ws/time`))?.finished()

    await test.step('Second user books a plain, project-less slot for today in Planner', async () => {
      const leftSideMenuPageSecond = new LeftSideMenuPage(page2)
      const planningPageSecond = new PlanningPage(page2)
      const planningNavigationMenuPageSecond = new PlanningNavigationMenuPage(page2)

      await leftSideMenuPageSecond.clickPlanner()
      await planningNavigationMenuPageSecond.clickOnButtonToDoAll()
      await planningPageSecond.createNewToDo({ title: busyToDo.title })
      await planningPageSecond.checkToDoExist(busyToDo.title)
      await planningPageSecond.openToDoByName(busyToDo.title)
      if (busyToDo.slots != null) {
        await planningPageSecond.clickButtonCreateAddSlot()
        await planningPageSecond.setTimeSlot(0, busyToDo.slots[0])
      }
      await planningPageSecond.clickButtonCardClose()
    })

    await test.step('First user overlays the colleague on their own Schedule', async () => {
      const leftSideMenuPage = new LeftSideMenuPage(page)
      const teamPage = new TeamPage(page)

      await leftSideMenuPage.clickPlanner()
      await teamPage.checkTeamPageIsOpened()
      await expect(teamPage.buttonMode()).toContainText('Schedule')

      await teamPage.selectExtraPerson(SECOND_USER)

      // Several stripes and blocks can carry the same colleague, one visible is enough.
      await expect(teamPage.backgroundElement(SECOND_USER).first()).toBeVisible()
    })
  })

  test('Colleague recurring meeting shows up in Schedule, Calendar and Team views', async ({ page, browser }) => {
    const title = `Recurring busy ${generateId()}`

    // The stand already has a second account in sanity-ws - signing up a new one
    // and creating a workspace does not fit the default test timeout.
    using _page2 = await getSecondPage(browser)
    const page2 = _page2.page

    await test.step('Second user creates a daily recurring meeting in their own calendar', async () => {
      const calendarPage2 = await openCalendarWidget(page2)
      await calendarPage2.clickFreeCellInWidget()
      await calendarPage2.inputEventTitle().fill(title)
      await calendarPage2.setRecurringDaily()
      await calendarPage2.buttonCreateEventSubmit().click()
      await expect(calendarPage2.eventInCalendarWidget(title)).toBeVisible()
    })

    const leftSideMenuPage = new LeftSideMenuPage(page)
    const teamPage = new TeamPage(page)
    await leftSideMenuPage.clickPlanner()
    await teamPage.checkTeamPageIsOpened()

    await test.step('Schedule mode overlays the colleague as busy', async () => {
      await teamPage.selectExtraPerson(SECOND_USER)
      await expect(teamPage.backgroundElement(SECOND_USER).first()).toBeVisible({ timeout: 15000 })
    })

    await test.step('Calendar mode shows a Busy entry for the colleague', async () => {
      await teamPage.openTeamCalendar()
      const rowIndex = await teamPage.findPersonRowIndex(SECOND_USER)
      await expect(teamPage.busyEntryTodayForRow(rowIndex).first()).toBeVisible({ timeout: 15000 })
    })

    await test.step('Team mode occupancy shows a Busy block for the colleague', async () => {
      await teamPage.openTeamOccupancy()
      await expect(teamPage.busyBlock('Today')).toBeVisible({ timeout: 15000 })
    })
  })
})
