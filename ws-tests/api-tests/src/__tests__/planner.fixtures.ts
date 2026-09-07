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

// Reusable fixtures for the planner/calendar space-ownership tests
// (planner-spaces.test.ts and friends). Builds on top of workflow.fixtures's
// connect/project/issue helpers and mirrors the account bootstrap already
// used by love-invite-flow.test.ts and calendar-busy.test.ts.

import {
  createRestClient,
  createRestTxOperations,
  getWorkspaceToken,
  loadServerConfig,
  type RestClient,
  type ServerConfig,
  type WorkspaceToken
} from '@hcengineering/api-client'
import core, {
  generateId,
  MeasureMetricsContext,
  pickPrimarySocialId,
  SortingOrder,
  systemAccountUuid,
  type AccountUuid,
  type PersonId,
  type Ref,
  type Space,
  type SocialId,
  type TxOperations
} from '@hcengineering/core'
import { getClient as getAccountClient } from '@hcengineering/account-client'
import contact, { ensureEmployee, type Employee, type Person, type PersonSpace } from '@hcengineering/contact'
import calendar, {
  AccessLevel,
  generateEventId,
  type BusySlot,
  type Calendar,
  type Event,
  type ReccuringEvent,
  type RecurringRule
} from '@hcengineering/calendar'
import { generateToken } from '@hcengineering/server-token'
import { makeRank } from '@hcengineering/rank'
import tracker, { type Issue, type Project } from '@hcengineering/tracker'
import time, { type ProjectToDo, type ToDo, ToDoPriority, type WorkSlot } from '@hcengineering/time'
import {
  createIssue,
  createProject,
  createProjectTypeWith,
  eventually,
  uniqueSuffix,
  type CreateIssueOptions,
  type ProjectContext
} from './workflow.fixtures'

export { createIssue, createProject, createProjectTypeWith, eventually, uniqueSuffix }
export type { CreateIssueOptions, ProjectContext }

export const PLANNER_PLATFORM_URL = process.env.PLATFORM_URL ?? 'http://localhost:8083'
export const PLANNER_WORKSPACE = process.env.API_TESTS_WS ?? 'api-tests'

/** One workspace account, fully bootstrapped: Person, Employee, PersonSpace, default Calendar. */
export interface PlannerAccount {
  token: WorkspaceToken
  /** REST tx client authenticated as this account (fullModel — project types need descriptors). */
  client: TxOperations
  person: Person
  space: PersonSpace
  primary: PersonId
  calendar: Ref<Calendar>
}

/**
 * Logs the given accounts in, ensures Employee/PersonSpace/default-Calendar exist for each
 * (those are created asynchronously by server triggers, hence the `eventually` polling), and
 * resolves them via a system-token client so SpaceSecurityMiddleware never filters the lookup
 * itself. `emails` are plain dev-stand logins ('user1', 'user2', password '1234').
 */
export async function setupPlannerAccounts (
  emails: string[]
): Promise<{ config: ServerConfig, systemRest: RestClient, accounts: PlannerAccount[] }> {
  const config = await loadServerConfig(PLANNER_PLATFORM_URL)
  const tokens: WorkspaceToken[] = []
  for (const email of emails) {
    tokens.push(
      await getWorkspaceToken(PLANNER_PLATFORM_URL, { email, password: '1234', workspace: PLANNER_WORKSPACE }, config)
    )
  }
  const systemRest = createRestClient(
    tokens[0].endpoint,
    tokens[0].workspaceId,
    generateToken(systemAccountUuid, tokens[0].workspaceId, undefined, 'secret')
  )
  const accounts: PlannerAccount[] = []
  for (const token of tokens) {
    accounts.push(await setupPlannerAccount(token, config, systemRest))
  }
  return { config, systemRest, accounts }
}

async function setupPlannerAccount (
  token: WorkspaceToken,
  config: ServerConfig,
  systemRest: RestClient
): Promise<PlannerAccount> {
  const accClient = getAccountClient(config.ACCOUNTS_URL, token.token)
  const person = await accClient.getPerson()
  const socialIds: SocialId[] = await accClient.getSocialIds(true)
  const primary = pickPrimarySocialId(socialIds)._id
  const client = await createRestTxOperations(token.endpoint, token.workspaceId, token.token, true)
  await ensureEmployee(
    new MeasureMetricsContext('planner-fixtures', {}),
    {
      uuid: token.info.account,
      role: token.info.role,
      primarySocialId: primary,
      socialIds: socialIds.map((si) => si._id),
      fullSocialIds: socialIds
    },
    client,
    socialIds,
    async () => person
  )

  // PersonSpace + the default Calendar are created asynchronously by the OnEmployee(Create)
  // trigger chain; ensureEmployee returns before it settles.
  const personDoc = await eventually(
    async () => (await systemRest.findAll(contact.class.Person, { personUuid: token.info.account as any }))[0]
  )
  const space = await eventually(
    async () => (await systemRest.findAll(contact.class.PersonSpace, { person: personDoc._id }))[0]
  )
  const calendarId = `${token.info.account}_calendar` as Ref<Calendar>
  await eventually(async () => await systemRest.findOne(calendar.class.Calendar, { _id: calendarId }))

  return { token, client, person: personDoc, space, primary, calendar: calendarId }
}

/**
 * Mirrors `getWorkSlotSpace` from plugins/time-resources/src/utils.ts: a project todo's slot
 * lives in the project's own space (`attachedSpace`), a personal todo's slot lives in the
 * owner's PersonSpace. Reimplemented here because the original reads a browser-only global
 * (`getCurrentEmployeeSpace()`) that a headless client never populates.
 */
export function workSlotSpaceFor (todo: Pick<ToDo, 'attachedSpace'>, owner: PlannerAccount): Ref<Space> {
  return todo.attachedSpace ?? (owner.space._id as unknown as Ref<Space>)
}

/** A team project (tracker.class.Project) private to `owner` + `members`. */
export interface PlannerProject extends ProjectContext {
  owner: PlannerAccount
}

export async function createTeamProject (
  owner: PlannerAccount,
  members: PlannerAccount[],
  statuses: string[] = ['Active']
): Promise<PlannerProject> {
  const typeCtx = await createProjectTypeWith(owner.client, [{ name: 'Task', statuses }])
  const project = await createProject(typeCtx, statuses[0])
  const memberUuids = Array.from(
    new Set<AccountUuid>([owner.token.info.account, ...members.map((m) => m.token.info.account)])
  )
  await owner.client.updateDoc(tracker.class.Project, core.space.Space, project.projectId, {
    private: true,
    owners: [owner.token.info.account],
    members: memberUuids
  })
  return { ...project, owner }
}

export async function moveIssueToProject (
  client: TxOperations,
  issue: Pick<Issue, '_id' | 'space'>,
  target: Ref<Project>
): Promise<void> {
  await client.updateDoc(tracker.class.Issue, issue.space, issue._id, { space: target })
}

export async function waitForProjectToDo (
  client: TxOperations,
  issueId: Ref<Issue>,
  timeoutMs = 15000
): Promise<ProjectToDo> {
  return await eventually(
    async () => (await client.findOne(time.class.ProjectToDo, { attachedTo: issueId })) as ProjectToDo | undefined,
    timeoutMs
  )
}

export async function createPersonalTodo (
  owner: PlannerAccount,
  title: string = `Personal ${uniqueSuffix()}`
): Promise<Ref<ToDo>> {
  const latest = await owner.client.findOne(
    time.class.ToDo,
    { user: owner.person._id as Ref<Employee>, doneOn: null },
    { sort: { rank: SortingOrder.Ascending } }
  )
  return await owner.client.addCollection(
    time.class.ToDo,
    time.space.ToDos,
    time.ids.NotAttached,
    time.class.ToDo,
    'todos',
    {
      title,
      description: '',
      user: owner.person._id as Ref<Employee>,
      workslots: 0,
      doneOn: null,
      priority: ToDoPriority.NoPriority,
      visibility: 'private',
      rank: makeRank(undefined, latest?.rank)
    }
  )
}

export interface WorkSlotOptions {
  date?: number
  dueDate?: number
  participants?: Array<Ref<Person>>
}

/** Creates a WorkSlot for `todo`, in the space `getWorkSlotSpace` would pick client-side. */
export async function createWorkSlot (
  owner: PlannerAccount,
  todo: Pick<ToDo, '_id' | '_class' | 'attachedSpace' | 'title' | 'visibility'>,
  opts: WorkSlotOptions = {}
): Promise<{ id: Ref<WorkSlot>, eventId: string, space: Ref<Space> }> {
  const date = opts.date ?? Date.now()
  const dueDate = opts.dueDate ?? date + 30 * 60 * 1000
  const eventId = generateEventId()
  const space = workSlotSpaceFor(todo, owner)
  const id = await owner.client.addCollection(time.class.WorkSlot, space, todo._id, todo._class, 'workslots', {
    calendar: owner.calendar,
    eventId,
    date,
    dueDate,
    description: '',
    participants: opts.participants ?? [owner.person._id],
    title: todo.title,
    allDay: false,
    blockTime: true,
    access: AccessLevel.Owner,
    visibility: todo.visibility === 'public' ? 'public' : 'freeBusy',
    reminders: [],
    user: owner.primary
  })
  return { id, eventId, space }
}

export async function waitForBusySlot (
  systemRest: RestClient,
  eventId: string,
  person: Ref<Person>,
  timeoutMs = 15000
): Promise<BusySlot> {
  return await eventually(
    async () => (await systemRest.findAll(calendar.class.BusySlot, { eventId, person }))[0],
    timeoutMs
  )
}

export interface CalendarEventOptions {
  participants: Array<Ref<Person>>
  blockTime?: boolean
  date?: number
  dueDate?: number
  title?: string
}

/** A plain (non-recurring) Event owned by `owner`, in owner's own PersonSpace. */
export async function createCalendarEvent (
  owner: PlannerAccount,
  opts: CalendarEventOptions
): Promise<{ id: Ref<Event>, eventId: string, date: number, dueDate: number }> {
  const id = generateId<Event>()
  const eventId = generateEventId()
  const date = opts.date ?? Date.now()
  const dueDate = opts.dueDate ?? date + 60 * 60 * 1000
  await owner.client.addCollection(
    calendar.class.Event,
    owner.space._id as unknown as Ref<Space>,
    calendar.ids.NoAttached,
    calendar.class.Event,
    'events',
    {
      eventId,
      calendar: owner.calendar,
      title: opts.title ?? 'planner fixture event',
      description: '',
      date,
      dueDate,
      allDay: false,
      participants: opts.participants,
      access: AccessLevel.Owner,
      user: owner.primary,
      blockTime: opts.blockTime ?? true
    },
    id
  )
  return { id, eventId, date, dueDate }
}

export interface RecurringCalendarEventOptions extends CalendarEventOptions {
  rules: RecurringRule[]
}

/** A recurring Event (single master doc, occurrences are never persisted). */
export async function createRecurringCalendarEvent (
  owner: PlannerAccount,
  opts: RecurringCalendarEventOptions
): Promise<{ id: Ref<ReccuringEvent>, eventId: string, date: number, dueDate: number }> {
  const id = generateId<ReccuringEvent>()
  const eventId = generateEventId()
  const date = opts.date ?? Date.now()
  const dueDate = opts.dueDate ?? date + 60 * 60 * 1000
  await owner.client.addCollection(
    calendar.class.ReccuringEvent,
    owner.space._id as unknown as Ref<Space>,
    calendar.ids.NoAttached,
    calendar.class.Event,
    'events',
    {
      eventId,
      calendar: owner.calendar,
      title: opts.title ?? 'planner fixture recurring event',
      description: '',
      date,
      dueDate,
      allDay: false,
      participants: opts.participants,
      access: AccessLevel.Owner,
      user: owner.primary,
      blockTime: opts.blockTime ?? true,
      rules: opts.rules,
      exdate: [],
      rdate: [],
      originalStartTime: date,
      timeZone: 'Etc/UTC'
    },
    id
  )
  return { id, eventId, date, dueDate }
}
