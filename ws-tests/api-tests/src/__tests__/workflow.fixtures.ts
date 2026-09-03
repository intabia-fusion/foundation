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

import {
  createRestClient,
  createRestTxOperations,
  getWorkspaceToken,
  loadServerConfig,
  type ServerConfig,
  type WorkspaceToken
} from '@hcengineering/api-client'
import core, {
  generateId,
  MeasureMetricsContext,
  pickPrimarySocialId,
  type Class,
  type Mixin,
  type Ref,
  type SocialId,
  type Status,
  type TxOperations
} from '@hcengineering/core'
import { getClient as getAccountClient } from '@hcengineering/account-client'
import { ensureEmployee } from '@hcengineering/contact'
import { makeRank } from '@hcengineering/rank'
import task, { createProjectType, type ProjectType, type TaskType, type TaskTypeWithFactory } from '@hcengineering/task'
import tracker, { IssuePriority, TimeReportDayType, type Issue, type Project } from '@hcengineering/tracker'

export const PlatformUrl = process.env.API_TESTS_URL ?? 'http://localhost:8083'
export const WorkspaceName = process.env.API_TESTS_WS ?? 'api-tests'

const ctx = new MeasureMetricsContext('workflow-tests', {})

let sharedToken: WorkspaceToken | undefined
let sharedClient: TxOperations | undefined
let sharedConfig: ServerConfig | undefined

/** One connection per jest worker: opening a transactor socket per test is the slowest part of the run. */
export async function connect (): Promise<TxOperations> {
  if (sharedClient !== undefined) return sharedClient
  sharedConfig = await loadServerConfig(PlatformUrl)
  sharedToken = await getWorkspaceToken(
    PlatformUrl,
    { email: 'user1', password: '1234', workspace: WorkspaceName },
    sharedConfig
  )
  const accountClient = getAccountClient(sharedConfig.ACCOUNTS_URL, sharedToken.token)
  const person = await accountClient.getPerson()
  const socialIds: SocialId[] = await accountClient.getSocialIds(true)
  await ensureEmployee(
    ctx,
    {
      uuid: sharedToken.info.account,
      role: sharedToken.info.role,
      primarySocialId: pickPrimarySocialId(socialIds)._id,
      socialIds: socialIds.map((si) => si._id),
      fullSocialIds: socialIds
    },
    createRestClient(sharedToken.endpoint, sharedToken.workspaceId, sharedToken.token),
    socialIds,
    async () => person
  )
  // fullModel: createProjectType resolves descriptors out of the model, a trimmed model has none.
  sharedClient = await createRestTxOperations(sharedToken.endpoint, sharedToken.workspaceId, sharedToken.token, true)
  return sharedClient
}

export interface TaskTypeSpec {
  name: string
  statuses: string[]
  /** Absent means "any parent"; an empty array means root-only. */
  allowedAsChildOf?: string[]
  isRootTaskType?: boolean
}

export interface ProjectTypeContext {
  client: TxOperations
  projectTypeId: Ref<ProjectType>
  /** Task type name to ref. */
  taskTypes: Record<string, Ref<TaskType>>
  /** Status name to ref, across all task types of the project type. */
  statuses: Record<string, Ref<Status>>
  suffix: string
}

export interface ProjectContext extends ProjectTypeContext {
  projectId: Ref<Project>
  identifier: string
}

export function uniqueSuffix (): string {
  return generateId().slice(-6).toUpperCase()
}

export async function createProjectTypeWith (
  client: TxOperations,
  specs: TaskTypeSpec[],
  suffix: string = uniqueSuffix()
): Promise<ProjectTypeContext> {
  const ids: Record<string, Ref<TaskType>> = {}
  for (const spec of specs) {
    ids[spec.name] = generateId<TaskType>()
  }

  const taskTypes: TaskTypeWithFactory[] = specs.map((spec) => ({
    _id: ids[spec.name],
    descriptor: tracker.descriptors.Issue,
    name: spec.name,
    ofClass: tracker.class.Issue,
    statusCategories: [
      task.statusCategory.UnStarted,
      task.statusCategory.ToDo,
      task.statusCategory.Active,
      task.statusCategory.Won,
      task.statusCategory.Lost
    ],
    statusClass: tracker.class.IssueStatus,
    icon: tracker.icon.Issue,
    color: 0,
    kind: 'both',
    isRootTaskType: spec.isRootTaskType,
    allowedAsChildOf: spec.allowedAsChildOf?.map((n) => ids[n]),
    factory: spec.statuses.map((name) => ({
      name,
      ofAttribute: tracker.attribute.IssueStatus,
      category: task.statusCategory.Active
    }))
  })) as unknown as TaskTypeWithFactory[]

  const projectTypeId = await createProjectType(
    client,
    {
      name: `WF Type ${suffix}`,
      descriptor: tracker.descriptors.ProjectType,
      shortDescription: '',
      description: '',
      tasks: [],
      roles: 0,
      classic: true
    },
    taskTypes,
    generateId<ProjectType>()
  )

  // Task types can end up with distinct status docs of the same name. Resolve a name to the
  // smallest ref, exactly like the workflow config importer does, or the two would disagree.
  const statuses: Record<string, Ref<Status>> = {}
  for (const spec of specs) {
    const tt = await client.findOne(task.class.TaskType, { _id: ids[spec.name] })
    const docs = await client.findAll(core.class.Status, { _id: { $in: tt?.statuses ?? [] } })
    for (const doc of docs) {
      const current = statuses[doc.name]
      if (current === undefined || doc._id < current) statuses[doc.name] = doc._id
    }
  }

  const taskTypeRefs: Record<string, Ref<TaskType>> = {}
  for (const spec of specs) taskTypeRefs[spec.name] = ids[spec.name]

  return { client, projectTypeId, taskTypes: taskTypeRefs, statuses, suffix }
}

export async function createProject (
  typeCtx: ProjectTypeContext,
  defaultStatus: string,
  identifier: string = `P${uniqueSuffix()}`
): Promise<ProjectContext> {
  const { client, projectTypeId } = typeCtx
  const projectId = generateId<Project>()
  await client.createDoc(
    tracker.class.Project,
    core.space.Space,
    {
      name: `WF Project ${identifier}`,
      description: '',
      private: false,
      members: [],
      owners: [],
      archived: false,
      autoJoin: false,
      identifier,
      sequence: 0,
      defaultIssueStatus: typeCtx.statuses[defaultStatus],
      defaultTimeReportDay: TimeReportDayType.PreviousWorkDay,
      type: projectTypeId
    },
    projectId
  )
  await client.createMixin(
    projectId,
    tracker.class.Project,
    core.space.Space,
    `${projectTypeId}:type:mixin` as Ref<Mixin<Project>>,
    {}
  )
  return { ...typeCtx, projectId, identifier }
}

export interface CreateIssueOptions {
  title?: string
  status: string
  taskType?: string
  parent?: Ref<Issue>
  assignee?: Issue['assignee']
  estimation?: number
  dueDate?: number | null
}

export async function createIssue (ctx: ProjectContext, opts: CreateIssueOptions): Promise<Ref<Issue>> {
  const { client } = ctx
  const incResult = await client.updateDoc(
    tracker.class.Project,
    core.space.Space,
    ctx.projectId,
    { $inc: { sequence: 1 } },
    true
  )
  const number = (incResult as any).object.sequence
  const taskTypeName = opts.taskType ?? Object.keys(ctx.taskTypes)[0]
  const parents = opts.parent === undefined ? [] : await parentInfo(ctx, opts.parent)
  const issueId = generateId<Issue>()
  await client.addCollection(
    tracker.class.Issue,
    ctx.projectId,
    opts.parent ?? tracker.ids.NoParent,
    tracker.class.Issue,
    'subIssues',
    {
      title: opts.title ?? `Issue ${number}`,
      description: null,
      assignee: opts.assignee ?? null,
      component: null,
      milestone: null,
      number,
      status: ctx.statuses[opts.status],
      priority: IssuePriority.NoPriority,
      rank: makeRank(undefined, undefined),
      comments: 0,
      subIssues: 0,
      dueDate: opts.dueDate ?? null,
      parents,
      reportedTime: 0,
      remainingTime: 0,
      estimation: opts.estimation ?? 0,
      reports: 0,
      relations: [],
      childInfo: [],
      kind: ctx.taskTypes[taskTypeName],
      identifier: `${ctx.identifier}-${number}`
    },
    issueId
  )
  return issueId
}

async function parentInfo (ctx: ProjectContext, parent: Ref<Issue>): Promise<Issue['parents']> {
  const doc = await ctx.client.findOne(tracker.class.Issue, { _id: parent })
  if (doc === undefined) return []
  return [{ parentId: doc._id, parentTitle: doc.title, space: doc.space, identifier: doc.identifier }, ...doc.parents]
}

export async function setStatus (ctx: ProjectContext, issueId: Ref<Issue>, status: string): Promise<void> {
  const issue = await ctx.client.findOne(tracker.class.Issue, { _id: issueId })
  if (issue === undefined) throw new Error(`Issue ${issueId} not found`)
  await ctx.client.update(issue, { status: ctx.statuses[status] })
}

export async function getStatus (ctx: ProjectContext, issueId: Ref<Issue>): Promise<string | undefined> {
  const issue = await ctx.client.findOne(tracker.class.Issue, { _id: issueId })
  if (issue === undefined) return undefined
  const found = Object.entries(ctx.statuses).find(([, ref]) => ref === issue.status)
  return found?.[0]
}

export async function getIssue (ctx: ProjectContext, issueId: Ref<Issue>): Promise<Issue | undefined> {
  return await ctx.client.findOne(tracker.class.Issue, { _id: issueId })
}

/** Resolves once `check` returns true, or throws - post-functions land asynchronously via triggers. */
export async function eventually<T> (check: () => Promise<T | undefined>, timeoutMs = 10000): Promise<T> {
  const started = Date.now()
  let last: T | undefined
  while (Date.now() - started < timeoutMs) {
    last = await check()
    if (last !== undefined) return last
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Condition was not met in time')
}

export async function expectRejected (op: () => Promise<unknown>): Promise<string> {
  try {
    await op()
  } catch (err: any) {
    return String(err?.message ?? err)
  }
  throw new Error('Expected the operation to be rejected, but it succeeded')
}

export function attributeOf (
  client: TxOperations,
  _class: Ref<Class<any>>,
  key: string
): { attribute: string, fieldKey: string } {
  const attr = client.getHierarchy().getAttribute(_class, key)
  return { attribute: attr._id, fieldKey: key }
}
