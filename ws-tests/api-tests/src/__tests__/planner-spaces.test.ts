/**
  Copyright © 2026 Intabia Fusion.

  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License. You may
  obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

  See the License for the specific language governing permissions and
  limitations under the License.
*/

// api-tests for where planner docs actually live now that Event moved out of a shared system
// space (FUSIO-1308):
//   * a WorkSlot for a project ToDo lives in that project's own space - readable by project
//     members, not by workspace accounts outside the project;
//   * a WorkSlot for a personal ToDo lives in the owner's PersonSpace - readable only by the
//     owner;
//   * either way, the WorkSlot's paired BusySlot lives in the shared calendar.space.Calendar and
//     is readable by everyone, including accounts that cannot see the WorkSlot itself;
//   * moving a tracker Issue to another project carries its ProjectToDo.attachedSpace and the
//     ToDo's WorkSlot.space along (server-plugins/time-resources changeIssueDataHandler);
//   * the ProjectToDo document itself always lives in time.space.ToDos, never in the project.

import type { RestClient } from '@hcengineering/api-client'
import type { Ref, Space } from '@hcengineering/core'
import calendar from '@hcengineering/calendar'
import time, { type ProjectToDo, type ToDo, type WorkSlot } from '@hcengineering/time'
import {
  createIssue,
  createPersonalTodo,
  createTeamProject,
  createWorkSlot,
  moveIssueToProject,
  eventually,
  setupPlannerAccounts,
  waitForBusySlot,
  waitForProjectToDo,
  type PlannerAccount
} from './planner.fixtures'

describe('planner spaces (api-tests)', () => {
  let systemRest: RestClient
  let user1: PlannerAccount
  let user2: PlannerAccount

  beforeAll(async () => {
    const setup = await setupPlannerAccounts(['user1', 'user2'])
    systemRest = setup.systemRest
    ;[user1, user2] = setup.accounts
  }, 30000)

  it('a project ToDo slot lives in the project space: members read it, non-members do not', async () => {
    const project = await createTeamProject(user1, [])

    const issueId = await createIssue(project, { status: 'Active', assignee: user1.person._id })
    const todo = await waitForProjectToDo(user1.client, issueId)
    expect(todo.attachedSpace).toBe(project.projectId)

    const slot = await createWorkSlot(user1, todo)
    expect(slot.space).toBe(project.projectId)

    const seenByMember = await user1.client.findOne(time.class.WorkSlot, { _id: slot.id })
    expect(seenByMember?._id).toBe(slot.id)

    const seenByOutsider = await user2.client.findAll(time.class.WorkSlot, { _id: slot.id })
    expect(seenByOutsider.length).toBe(0)
  }, 30000)

  it("a personal ToDo slot lives in the owner's PersonSpace and is invisible to other accounts", async () => {
    const todoId = await createPersonalTodo(user1)
    const todo = (await user1.client.findOne(time.class.ToDo, { _id: todoId })) as ToDo
    expect(todo.attachedSpace).toBeUndefined()

    const slot = await createWorkSlot(user1, todo)
    expect(slot.space).toBe(user1.space._id as unknown as Ref<Space>)

    const seenByOwner = await user1.client.findOne(time.class.WorkSlot, { _id: slot.id })
    expect(seenByOwner?._id).toBe(slot.id)

    const seenByOther = await user2.client.findAll(time.class.WorkSlot, { _id: slot.id })
    expect(seenByOther.length).toBe(0)
  }, 30000)

  it('a WorkSlot always has a paired BusySlot, visible even to accounts that cannot see the slot', async () => {
    // Personal slot: user2 cannot see it (previous test), but must still see its BusySlot.
    const todoId = await createPersonalTodo(user1)
    const todo = (await user1.client.findOne(time.class.ToDo, { _id: todoId })) as ToDo
    const slot = await createWorkSlot(user1, todo, { participants: [user1.person._id] })

    const seenByOther = await user2.client.findAll(time.class.WorkSlot, { _id: slot.id })
    expect(seenByOther.length).toBe(0)

    const busySlot = await waitForBusySlot(systemRest, slot.eventId, user1.person._id)
    expect(busySlot.eventId).toBe(slot.eventId)

    const busySlotSeenByOther = await user2.client.findAll(calendar.class.BusySlot, { eventId: slot.eventId })
    expect(busySlotSeenByOther.length).toBe(1)
    expect(busySlotSeenByOther[0].person).toBe(user1.person._id)

    // Project slot: user2 is not a project member and still not a participant.
    const project = await createTeamProject(user1, [])
    const issueId = await createIssue(project, { status: 'Active', assignee: user1.person._id })
    const projectTodo = await waitForProjectToDo(user1.client, issueId)
    const projectSlot = await createWorkSlot(user1, projectTodo, { participants: [user1.person._id] })

    const projectSlotSeenByOther = await user2.client.findAll(time.class.WorkSlot, { _id: projectSlot.id })
    expect(projectSlotSeenByOther.length).toBe(0)

    await waitForBusySlot(systemRest, projectSlot.eventId, user1.person._id)
    const projectBusySeenByOther = await user2.client.findAll(calendar.class.BusySlot, { eventId: projectSlot.eventId })
    expect(projectBusySeenByOther.length).toBe(1)
  }, 30000)

  it("moving an Issue to another project carries the ToDo's attachedSpace and its WorkSlot's space along", async () => {
    const projectA = await createTeamProject(user1, [])
    const projectB = await createTeamProject(user1, [])

    const issueId = await createIssue(projectA, { status: 'Active', assignee: user1.person._id })
    const todo = await waitForProjectToDo(user1.client, issueId)
    expect(todo.attachedSpace).toBe(projectA.projectId)

    const slot = await createWorkSlot(user1, todo)
    expect(slot.space).toBe(projectA.projectId)

    await moveIssueToProject(user1.client, { _id: issueId, space: projectA.projectId }, projectB.projectId)

    await eventually(async () => {
      const moved = (await user1.client.findOne(time.class.ProjectToDo, { _id: todo._id })) as ProjectToDo | undefined
      return moved?.attachedSpace === projectB.projectId ? moved : undefined
    })

    await eventually(async () => {
      const movedSlot = (await user1.client.findOne(time.class.WorkSlot, { _id: slot.id })) as WorkSlot | undefined
      return movedSlot?.space === projectB.projectId ? movedSlot : undefined
    })
  }, 30000)

  it('the ProjectToDo doc itself lives in time.space.ToDos, not in the project', async () => {
    const project = await createTeamProject(user1, [])
    const issueId = await createIssue(project, { status: 'Active', assignee: user1.person._id })
    const todo = await waitForProjectToDo(user1.client, issueId)

    expect(todo.space).toBe(time.space.ToDos)
    expect(todo.attachedSpace).toBe(project.projectId)
    expect(todo.space).not.toBe(project.projectId)
  }, 30000)
})
