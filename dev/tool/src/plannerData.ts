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

// Populates a workspace with tracker projects/issues, personal todos, work slots and calendar
// events so Team Planner and the calendar have something to look at. Mirrors the space-placement
// rules exercised by ws-tests/api-tests/src/__tests__/planner.fixtures.ts (getWorkSlotSpace: a
// project todo's slot lives in the project's space, a personal todo's slot lives in the owner's
// PersonSpace) but reimplemented here for a headless CLI (no jest, real account login per user).

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
  type Class,
  type PersonId,
  type Ref,
  type Space,
  type SocialId,
  type TxOperations
} from '@hcengineering/core'
import { getClient as getAccountClient } from '@hcengineering/account-client'
import contact, { type Employee, ensureEmployee, type Person, type PersonSpace } from '@hcengineering/contact'
import calendarPlugin, {
  AccessLevel,
  type Calendar,
  generateEventId,
  type RecurringRule
} from '@hcengineering/calendar'
import { generateToken } from '@hcengineering/server-token'
import { makeRank } from '@hcengineering/rank'
import tracker, {
  IssuePriority,
  TimeReportDayType,
  type Issue,
  type IssueStatus,
  type Project
} from '@hcengineering/tracker'
import time, { type ProjectToDo, type ToDo, ToDoPriority, type WorkSlot } from '@hcengineering/time'

const ctx = new MeasureMetricsContext('generate-planner-data', {})
const DAY = 24 * 60 * 60 * 1000

async function eventually<T> (check: () => Promise<T | undefined>, timeoutMs = 15000): Promise<T> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const res = await check()
    if (res !== undefined) return res
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('condition was not met in time')
}

function uniqueSuffix (): string {
  return generateId().slice(-6).toUpperCase()
}

interface PlannerAccount {
  token: WorkspaceToken
  client: TxOperations
  person: Person
  space: PersonSpace
  primary: PersonId
  calendarId: Ref<Calendar>
}

/** Logs `email` in and ensures Employee/PersonSpace/default-Calendar exist (created async by server triggers). */
async function setupAccount (
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
    ctx,
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
  const personDoc = await eventually(
    async () => (await systemRest.findAll(contact.class.Person, { personUuid: token.info.account as any }))[0]
  )
  const space = await eventually(
    async () => (await systemRest.findAll(contact.class.PersonSpace, { person: personDoc._id }))[0]
  )
  const calendarId = `${token.info.account}_calendar` as Ref<Calendar>
  await eventually(async () => await systemRest.findOne(calendarPlugin.class.Calendar, { _id: calendarId }))
  return { token, client, person: personDoc, space, primary, calendarId }
}

interface ProjectSpec {
  key: string
  name: string
  private: boolean
  ownerIdx: number
  /** Members (and, for private projects, the only accounts issues get assigned to). */
  memberIdxs: number[]
}

async function createProjectDoc (
  accounts: PlannerAccount[],
  spec: ProjectSpec,
  identifier: string
): Promise<Ref<Project>> {
  const owner = accounts[spec.ownerIdx]
  const projectId = generateId<Project>()
  const memberUuids = Array.from(new Set(spec.memberIdxs.map((i) => accounts[i].token.info.account)))
  await owner.client.createDoc(
    tracker.class.Project,
    core.space.Space,
    {
      name: spec.name,
      description: '',
      private: spec.private,
      members: memberUuids,
      owners: spec.private ? [owner.token.info.account] : [],
      archived: false,
      autoJoin: false,
      identifier,
      sequence: 0,
      defaultIssueStatus: tracker.status.Todo,
      defaultTimeReportDay: TimeReportDayType.PreviousWorkDay,
      // Reuse the well-known classic project type the model seeds into every workspace
      // (tracker.project.DefaultProject is built the same way) instead of createProjectType.
      type: tracker.ids.ClassingProjectType
    },
    projectId
  )
  return projectId
}

async function nextIssueNumber (client: TxOperations, projectId: Ref<Project>): Promise<number> {
  const res: any = await client.updateDoc(
    tracker.class.Project,
    core.space.Space,
    projectId,
    { $inc: { sequence: 1 } },
    true
  )
  return res.object.sequence
}

async function createIssueDoc (
  client: TxOperations,
  projectId: Ref<Project>,
  identifier: string,
  number: number,
  title: string,
  assignee: Ref<Employee>,
  status: Ref<IssueStatus>
): Promise<Ref<Issue>> {
  const issueId = generateId<Issue>()
  await client.addCollection(
    tracker.class.Issue,
    projectId,
    tracker.ids.NoParent,
    tracker.class.Issue,
    'subIssues',
    {
      title,
      description: null,
      assignee,
      component: null,
      milestone: null,
      number,
      status,
      priority: IssuePriority.NoPriority,
      rank: makeRank(undefined, undefined),
      comments: 0,
      subIssues: 0,
      dueDate: null,
      parents: [],
      reportedTime: 0,
      remainingTime: 0,
      estimation: 0,
      reports: 0,
      relations: [],
      childInfo: [],
      kind: tracker.taskTypes.Issue,
      identifier: `${identifier}-${number}`
    },
    issueId
  )
  return issueId
}

async function createPersonalTodo (owner: PlannerAccount, title: string): Promise<Ref<ToDo>> {
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

/** Mirrors getWorkSlotSpace (plugins/time-resources/src/utils.ts): project todo -> project space, personal todo -> owner's PersonSpace. */
async function createWorkSlotDoc (
  owner: PlannerAccount,
  todo: { _id: Ref<ToDo>, _class: Ref<Class<ToDo>>, attachedSpace?: Ref<Space>, title: string, visibility: string },
  date: number,
  dueDate: number,
  participants: Array<Ref<Person>>
): Promise<Ref<WorkSlot>> {
  const space = todo.attachedSpace ?? (owner.space._id as unknown as Ref<Space>)
  return await owner.client.addCollection(time.class.WorkSlot, space, todo._id, todo._class, 'workslots', {
    calendar: owner.calendarId,
    eventId: generateEventId(),
    date,
    dueDate,
    description: '',
    participants,
    title: todo.title,
    allDay: false,
    blockTime: true,
    access: AccessLevel.Owner,
    visibility: todo.visibility === 'public' ? 'public' : 'freeBusy',
    reminders: [],
    user: owner.primary
  })
}

async function createEventDoc (
  owner: PlannerAccount,
  title: string,
  date: number,
  dueDate: number,
  participants: Array<Ref<Person>>
): Promise<void> {
  await owner.client.addCollection(
    calendarPlugin.class.Event,
    owner.space._id as unknown as Ref<Space>,
    calendarPlugin.ids.NoAttached,
    calendarPlugin.class.Event,
    'events',
    {
      eventId: generateEventId(),
      calendar: owner.calendarId,
      title,
      description: '',
      date,
      dueDate,
      allDay: false,
      participants,
      access: AccessLevel.Owner,
      user: owner.primary,
      blockTime: true
    },
    generateId()
  )
}

async function createRecurringEventDoc (
  owner: PlannerAccount,
  title: string,
  date: number,
  dueDate: number,
  participants: Array<Ref<Person>>,
  rules: RecurringRule[]
): Promise<void> {
  await owner.client.addCollection(
    calendarPlugin.class.ReccuringEvent,
    owner.space._id as unknown as Ref<Space>,
    calendarPlugin.ids.NoAttached,
    calendarPlugin.class.Event,
    'events',
    {
      eventId: generateEventId(),
      calendar: owner.calendarId,
      title,
      description: '',
      date,
      dueDate,
      allDay: false,
      participants,
      access: AccessLevel.Owner,
      user: owner.primary,
      blockTime: true,
      rules,
      exdate: [],
      rdate: [],
      originalStartTime: date,
      timeZone: 'Etc/UTC'
    },
    generateId()
  )
}

/** 09:00 local on `now + offsetDays`. */
function dayStart (now: number, offsetDays: number): number {
  const d = new Date(now + offsetDays * DAY)
  d.setHours(9, 0, 0, 0)
  return d.getTime()
}

export interface GeneratePlannerDataOptions {
  workspace: string
  platformUrl: string
  accountEmails: string[]
  password: string
}

export async function generatePlannerData (opts: GeneratePlannerDataOptions): Promise<void> {
  const { workspace, platformUrl, accountEmails, password } = opts
  if (accountEmails.length < 3) {
    throw new Error('need at least 3 accounts to populate planner/calendar data meaningfully')
  }
  const suffix = uniqueSuffix()
  console.log(`[planner-data] workspace=${workspace} accounts=${accountEmails.join(',')} suffix=${suffix}`)

  const config = await loadServerConfig(platformUrl)
  const tokens: WorkspaceToken[] = []
  for (const email of accountEmails) {
    tokens.push(await getWorkspaceToken(platformUrl, { email, password, workspace }, config))
  }
  const systemRest = createRestClient(
    tokens[0].endpoint,
    tokens[0].workspaceId,
    generateToken(systemAccountUuid, tokens[0].workspaceId, { service: 'tool' })
  )

  const accounts: PlannerAccount[] = []
  for (const token of tokens) {
    accounts.push(await setupAccount(token, config, systemRest))
    console.log(`[planner-data] account ready: ${token.info.account}`)
  }

  const now = Date.now()

  // Three projects with distinct membership: a solo private one, a shared private one, and a
  // public one where the security filter does not restrict anybody (private: false).
  const specs: ProjectSpec[] = [
    { key: 'PSOLO', name: `Planner Solo ${suffix}`, private: true, ownerIdx: 0, memberIdxs: [0] },
    { key: 'PSHARE', name: `Planner Shared ${suffix}`, private: true, ownerIdx: 1, memberIdxs: [1, 2] },
    { key: 'PPUB', name: `Planner Public ${suffix}`, private: false, ownerIdx: 2, memberIdxs: [] }
  ]

  let issueCount = 0
  let workSlotCount = 0
  const offsets = [-1, 0, 1, 2, 3, 7, 10, 14]
  let offsetIdx = 0
  const nextOffset = (): number => offsets[offsetIdx++ % offsets.length]

  for (const spec of specs) {
    const identifier = `${spec.key}${suffix}`
    const owner = accounts[spec.ownerIdx]
    const projectId = await createProjectDoc(accounts, spec, identifier)
    console.log(
      `[planner-data] project ${identifier} (${spec.private ? 'private' : 'public'}, members=${spec.memberIdxs.length})`
    )

    // Public project: assignable to anyone. Private project: only its own members.
    const assignable = spec.private ? spec.memberIdxs : accounts.map((_, i) => i)
    for (let i = 0; i < 2; i++) {
      const assignee = accounts[assignable[i % assignable.length]]
      const number = await nextIssueNumber(owner.client, projectId)
      const status = i % 2 === 0 ? tracker.status.Todo : tracker.status.InProgress
      const issueId = await createIssueDoc(
        owner.client,
        projectId,
        identifier,
        number,
        `Planner issue ${identifier}-${number} ${suffix}`,
        assignee.person._id as Ref<Employee>,
        status
      )
      issueCount++
      // The server trigger (IssueToDoFactory -> getCreateToDoTx) creates the ProjectToDo async.
      const todo = await eventually<ProjectToDo>(
        async () => await systemRest.findOne(time.class.ProjectToDo, { attachedTo: issueId })
      )
      const date = dayStart(now, nextOffset())
      await createWorkSlotDoc(assignee, todo, date, date + 45 * 60 * 1000, [assignee.person._id])
      workSlotCount++
      console.log(`[planner-data] issue ${identifier}-${number} -> assignee=${assignee.token.info.account}`)
    }
  }

  // Personal todos for each of the given accounts, each with its own work slot.
  let personalTodoCount = 0
  for (const owner of accounts) {
    for (let i = 0; i < 2; i++) {
      const todo = await createPersonalTodo(owner, `Personal task ${i + 1} ${suffix}`)
      personalTodoCount++
      const date = dayStart(now, nextOffset())
      await createWorkSlotDoc(
        owner,
        {
          _id: todo,
          _class: time.class.ToDo,
          attachedSpace: undefined,
          title: `Personal task ${i + 1} ${suffix}`,
          visibility: 'private'
        },
        date,
        date + 30 * 60 * 1000,
        [owner.person._id]
      )
      workSlotCount++
    }
  }
  console.log(`[planner-data] personal todos: ${personalTodoCount}`)

  // Calendar events: a couple of plain multi-participant events plus a recurring one, all
  // blockTime: true so the server mirrors them into calendar.class.BusySlot.
  let eventCount = 0
  const allPersonRefs = accounts.map((a) => a.person._id)
  for (let i = 0; i < accounts.length; i++) {
    const owner = accounts[i]
    const others = allPersonRefs.filter((_, idx) => idx !== i)
    const date = dayStart(now, nextOffset())
    await createEventDoc(owner, `Planner sync ${i + 1} ${suffix}`, date, date + 60 * 60 * 1000, [
      owner.person._id,
      ...others
    ])
    eventCount++
  }
  // One recurring event (weekly, 6 occurrences) owned by the first account, everyone invited.
  {
    const owner = accounts[0]
    const date = dayStart(now, 1)
    const rules: RecurringRule[] = [{ freq: 'WEEKLY', interval: 1, count: 6 }]
    await createRecurringEventDoc(owner, `Planner standup ${suffix}`, date, date + 30 * 60 * 1000, allPersonRefs, rules)
    eventCount++
  }
  console.log(`[planner-data] calendar events: ${eventCount}`)

  console.log(
    `[planner-data] done: suffix=${suffix} projects=${specs.length} issues=${issueCount} ` +
      `personalTodos=${personalTodoCount} workSlots=${workSlotCount} events=${eventCount}`
  )
}
