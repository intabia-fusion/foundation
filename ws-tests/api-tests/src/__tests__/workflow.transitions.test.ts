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

import { generateId, type Ref, type TxOperations, type WorkspaceUuid } from '@hcengineering/core'
import workflow, {
  importWorkflowConfig,
  removeTransition,
  setWorkflow,
  type RequestConfig,
  type ValidatorConfig,
  type PostFunctionConfig,
  type Workflow,
  type WorkflowTransition
} from '@hcengineering/workflow'
import task, { type Project } from '@hcengineering/task'

import {
  connect,
  createIssue,
  createProject,
  createProjectTypeWith,
  expectRejected,
  getStatus,
  setStatus,
  uniqueSuffix,
  type ProjectContext,
  type ProjectTypeContext
} from './workflow.fixtures'

const Statuses = ['Backlog', 'Todo', 'InProgress', 'InReview', 'Done', 'Cancelled']
const wsUuid = 'test-workspace-uuid' as unknown as WorkspaceUuid

interface TransitionSpec {
  name: string
  from: string[] | null
  to: string
  requests?: RequestConfig[]
  validators?: ValidatorConfig[]
  postFunctions?: PostFunctionConfig[]
}

describe('workflow transitions', () => {
  let client: TxOperations
  let type: ProjectTypeContext

  beforeAll(async () => {
    client = await connect()
    type = await createProjectTypeWith(client, [
      { name: 'Issue', statuses: Statuses },
      { name: 'Bug', statuses: Statuses }
    ])
  }, 60000)

  /** Creates a project, imports one workflow and binds it to the given task types. */
  async function withWorkflow (
    transitions: TransitionSpec[],
    opts: {
      initialStatuses?: string[]
      defaultStatus?: string
      taskType?: string
      bindTo?: string[]
    } = {}
  ): Promise<{ ctx: ProjectContext, workflowId: Ref<Workflow>, name: string }> {
    const name = `WF ${uniqueSuffix()}`
    const ctx = await createProject(type, opts.defaultStatus ?? 'Backlog')
    const taskType = opts.taskType ?? 'Issue'
    const bindTo = opts.bindTo ?? [taskType]
    const wfId = generateId<Workflow>()
    const res = await importWorkflowConfig(client, type.projectTypeId, {
      version: 1,
      exportDate: new Date().toISOString(),
      workspace: wsUuid,
      projectTypeId: type.projectTypeId,
      statuses: Statuses.map((s) => ({ id: type.statuses[s], name: s, color: 0 })),
      workflows: [
        {
          id: wfId,
          name,
          taskTypeName: taskType,
          taskTypeId: type.taskTypes[taskType],
          initialStatuses: opts.initialStatuses?.map((s) => type.statuses[s]),
          transitions: transitions.map((t) => ({
            id: generateId(),
            name: t.name,
            from: t.from == null ? null : t.from.map((s) => type.statuses[s]),
            to: type.statuses[t.to],
            requests: t.requests,
            validators: t.validators,
            postFunctions: t.postFunctions
          }))
        }
      ],
      projects: [
        {
          project: ctx.projectId,
          identifier: ctx.identifier,
          workflows: Object.fromEntries(bindTo.map((t) => [t, name]))
        }
      ]
    })
    return { ctx, workflowId: res.workflows[wfId], name }
  }

  it('allows any transition when no workflow is bound', async () => {
    const ctx = await createProject(type, 'Backlog')
    const issue = await createIssue(ctx, { status: 'Backlog' })
    await setStatus(ctx, issue, 'Done')
    expect(await getStatus(ctx, issue)).toEqual('Done')
  })

  it('allows a transition declared in the workflow', async () => {
    const { ctx } = await withWorkflow([{ name: 'Start', from: ['Backlog'], to: 'InProgress' }])
    const issue = await createIssue(ctx, { status: 'Backlog' })
    await setStatus(ctx, issue, 'InProgress')
    expect(await getStatus(ctx, issue)).toEqual('InProgress')
  })

  it('blocks a transition that is not declared', async () => {
    const { ctx } = await withWorkflow([{ name: 'Start', from: ['Backlog'], to: 'InProgress' }])
    const issue = await createIssue(ctx, { status: 'Backlog' })
    const err = await expectRejected(async () => {
      await setStatus(ctx, issue, 'Done')
    })
    expect(err).toContain('ForbiddenTransition')
    expect(await getStatus(ctx, issue)).toEqual('Backlog')
  })

  it('blocks the reverse of a declared transition', async () => {
    const { ctx } = await withWorkflow([{ name: 'Start', from: ['Backlog'], to: 'InProgress' }])
    const issue = await createIssue(ctx, { status: 'Backlog' })
    await setStatus(ctx, issue, 'InProgress')
    const err = await expectRejected(async () => {
      await setStatus(ctx, issue, 'Backlog')
    })
    expect(err).toContain('ForbiddenTransition')
  })

  it('allows the reverse once it is declared too', async () => {
    const { ctx } = await withWorkflow([
      { name: 'Start', from: ['Backlog'], to: 'InProgress' },
      { name: 'Stop', from: ['InProgress'], to: 'Backlog' }
    ])
    const issue = await createIssue(ctx, { status: 'Backlog' })
    await setStatus(ctx, issue, 'InProgress')
    await setStatus(ctx, issue, 'Backlog')
    expect(await getStatus(ctx, issue)).toEqual('Backlog')
  })

  it('treats a null "from" as any status', async () => {
    const { ctx } = await withWorkflow([{ name: 'Cancel', from: null, to: 'Cancelled' }])
    const issue = await createIssue(ctx, { status: 'Backlog' })
    await setStatus(ctx, issue, 'Cancelled')
    expect(await getStatus(ctx, issue)).toEqual('Cancelled')
  })

  it('treats an empty "from" as any status', async () => {
    const { ctx } = await withWorkflow([{ name: 'Cancel', from: [], to: 'Cancelled' }])
    const issue = await createIssue(ctx, { status: 'Todo' })
    await setStatus(ctx, issue, 'Cancelled')
    expect(await getStatus(ctx, issue)).toEqual('Cancelled')
  })

  it('reaches a wildcard target from every status in turn', async () => {
    const { ctx } = await withWorkflow([
      { name: 'Cancel', from: null, to: 'Cancelled' },
      { name: 'Reopen', from: ['Cancelled'], to: 'Backlog' },
      { name: 'Plan', from: ['Backlog'], to: 'Todo' },
      { name: 'Start', from: ['Todo'], to: 'InProgress' }
    ])
    for (const from of ['Backlog', 'Todo', 'InProgress']) {
      const issue = await createIssue(ctx, { status: 'Backlog' })
      if (from !== 'Backlog') await setStatus(ctx, issue, 'Todo')
      if (from === 'InProgress') await setStatus(ctx, issue, 'InProgress')
      await setStatus(ctx, issue, 'Cancelled')
      expect(await getStatus(ctx, issue)).toEqual('Cancelled')
    }
  })

  it('accepts every status listed in a multi-source transition', async () => {
    const { ctx } = await withWorkflow([
      { name: 'Finish', from: ['Todo', 'InProgress', 'InReview'], to: 'Done' },
      { name: 'Plan', from: ['Backlog'], to: 'Todo' },
      { name: 'Start', from: ['Todo'], to: 'InProgress' },
      { name: 'Review', from: ['InProgress'], to: 'InReview' }
    ])
    for (const path of [['Todo'], ['Todo', 'InProgress'], ['Todo', 'InProgress', 'InReview']]) {
      const issue = await createIssue(ctx, { status: 'Backlog' })
      for (const step of path) await setStatus(ctx, issue, step)
      await setStatus(ctx, issue, 'Done')
      expect(await getStatus(ctx, issue)).toEqual('Done')
    }
  })

  it('blocks a status that is not listed in a multi-source transition', async () => {
    const { ctx } = await withWorkflow([{ name: 'Finish', from: ['Todo', 'InProgress'], to: 'Done' }])
    const issue = await createIssue(ctx, { status: 'Backlog' })
    const err = await expectRejected(async () => {
      await setStatus(ctx, issue, 'Done')
    })
    expect(err).toContain('ForbiddenTransition')
  })

  it('walks a full linear workflow', async () => {
    const { ctx } = await withWorkflow([
      { name: 'Plan', from: ['Backlog'], to: 'Todo' },
      { name: 'Start', from: ['Todo'], to: 'InProgress' },
      { name: 'Review', from: ['InProgress'], to: 'InReview' },
      { name: 'Finish', from: ['InReview'], to: 'Done' }
    ])
    const issue = await createIssue(ctx, { status: 'Backlog' })
    for (const step of ['Todo', 'InProgress', 'InReview', 'Done']) {
      await setStatus(ctx, issue, step)
      expect(await getStatus(ctx, issue)).toEqual(step)
    }
  })

  it('blocks skipping a step of a linear workflow', async () => {
    const { ctx } = await withWorkflow([
      { name: 'Plan', from: ['Backlog'], to: 'Todo' },
      { name: 'Start', from: ['Todo'], to: 'InProgress' },
      { name: 'Finish', from: ['InProgress'], to: 'Done' }
    ])
    const issue = await createIssue(ctx, { status: 'Backlog' })
    await setStatus(ctx, issue, 'Todo')
    const err = await expectRejected(async () => {
      await setStatus(ctx, issue, 'Done')
    })
    expect(err).toContain('ForbiddenTransition')
    expect(await getStatus(ctx, issue)).toEqual('Todo')
  })

  it('blocks every transition when the workflow declares none', async () => {
    const { ctx } = await withWorkflow([])
    const issue = await createIssue(ctx, { status: 'Backlog' })
    const err = await expectRejected(async () => {
      await setStatus(ctx, issue, 'Todo')
    })
    expect(err).toContain('ForbiddenTransition')
  })

  it.each([
    ['Todo', true],
    ['InProgress', true],
    ['Done', false],
    ['Cancelled', false]
  ])('restricts creation to the initial statuses: %s', async (status, allowed) => {
    const { ctx } = await withWorkflow([{ name: 'Any', from: null, to: 'Done' }], {
      initialStatuses: ['Todo', 'InProgress']
    })
    if (allowed) {
      const issue = await createIssue(ctx, { status })
      expect(await getStatus(ctx, issue)).toEqual(status)
    } else {
      const err = await expectRejected(async () => {
        await createIssue(ctx, { status })
      })
      expect(err).toContain('InitialStatusNotAllowed')
    }
  })

  it('allows any initial status when the list is empty', async () => {
    const { ctx } = await withWorkflow([{ name: 'Any', from: null, to: 'Done' }], { initialStatuses: [] })
    for (const status of Statuses) {
      const issue = await createIssue(ctx, { status })
      expect(await getStatus(ctx, issue)).toEqual(status)
    }
  })

  it('allows any initial status when the list is absent', async () => {
    const { ctx } = await withWorkflow([{ name: 'Any', from: null, to: 'Done' }])
    const issue = await createIssue(ctx, { status: 'Done' })
    expect(await getStatus(ctx, issue)).toEqual('Done')
  })

  it('restricts only the bound task type', async () => {
    const { ctx } = await withWorkflow([{ name: 'Start', from: ['Backlog'], to: 'Todo' }], {
      taskType: 'Issue',
      bindTo: ['Issue']
    })
    const bug = await createIssue(ctx, { status: 'Backlog', taskType: 'Bug' })
    await setStatus(ctx, bug, 'Done')
    expect(await getStatus(ctx, bug)).toEqual('Done')

    const issue = await createIssue(ctx, { status: 'Backlog' })
    const err = await expectRejected(async () => {
      await setStatus(ctx, issue, 'Done')
    })
    expect(err).toContain('ForbiddenTransition')
  })

  it('restricts both task types when both are bound', async () => {
    const name = `WF ${uniqueSuffix()}`
    const ctx = await createProject(type, 'Backlog')
    await importWorkflowConfig(client, type.projectTypeId, {
      version: 1,
      exportDate: new Date().toISOString(),
      workspace: wsUuid,
      projectTypeId: type.projectTypeId,
      statuses: Statuses.map((s) => ({ id: type.statuses[s], name: s, color: 0 })),
      workflows: [
        {
          id: generateId(),
          name: `${name} I`,
          taskTypeName: 'Issue',
          taskTypeId: type.taskTypes.Issue,
          transitions: [{ id: generateId(), name: 'Start', from: [type.statuses.Backlog], to: type.statuses.Todo }]
        },
        {
          id: generateId(),
          name: `${name} B`,
          taskTypeName: 'Bug',
          taskTypeId: type.taskTypes.Bug,
          transitions: [{ id: generateId(), name: 'Start', from: [type.statuses.Backlog], to: type.statuses.Todo }]
        }
      ],
      projects: [
        { project: ctx.projectId, identifier: ctx.identifier, workflows: { Issue: `${name} I`, Bug: `${name} B` } }
      ]
    })
    for (const taskType of ['Issue', 'Bug']) {
      const issue = await createIssue(ctx, { status: 'Backlog', taskType })
      const err = await expectRejected(async () => {
        await setStatus(ctx, issue, 'Done')
      })
      expect(err).toContain('ForbiddenTransition')
    }
  })

  it('stops restricting once the mapping is removed', async () => {
    const { ctx } = await withWorkflow([{ name: 'Start', from: ['Backlog'], to: 'Todo' }])
    const issue = await createIssue(ctx, { status: 'Backlog' })
    await expectRejected(async () => {
      await setStatus(ctx, issue, 'Done')
    })

    const project = await client.findOne(task.class.Project, { _id: ctx.projectId })
    await setWorkflow(client, project as Project, type.taskTypes.Issue, null)
    await setStatus(ctx, issue, 'Done')
    expect(await getStatus(ctx, issue)).toEqual('Done')
  })

  it('blocks a transition after it is deleted from the workflow', async () => {
    const { ctx, workflowId } = await withWorkflow([
      { name: 'Start', from: ['Backlog'], to: 'Todo' },
      { name: 'Finish', from: ['Todo'], to: 'Done' }
    ])
    const first = await createIssue(ctx, { status: 'Backlog' })
    await setStatus(ctx, first, 'Todo')
    await setStatus(ctx, first, 'Done')

    const finish = await client.findOne(workflow.class.WorkflowTransition, { attachedTo: workflowId, name: 'Finish' })
    await removeTransition(client, workflowId, (finish as WorkflowTransition)._id)

    const second = await createIssue(ctx, { status: 'Backlog' })
    await setStatus(ctx, second, 'Todo')
    const err = await expectRejected(async () => {
      await setStatus(ctx, second, 'Done')
    })
    expect(err).toContain('ForbiddenTransition')
  })

  it('does not leak a workflow between projects of the same type', async () => {
    const { ctx } = await withWorkflow([{ name: 'Start', from: ['Backlog'], to: 'Todo' }])
    const free = await createProject(type, 'Backlog')
    const issue = await createIssue(free, { status: 'Backlog' })
    await setStatus(free, issue, 'Done')
    expect(await getStatus(free, issue)).toEqual('Done')

    const restricted = await createIssue(ctx, { status: 'Backlog' })
    await expectRejected(async () => {
      await setStatus(ctx, restricted, 'Done')
    })
  })

  it('applies one workflow to two projects', async () => {
    const { ctx, name } = await withWorkflow([{ name: 'Start', from: ['Backlog'], to: 'Todo' }])
    const other = await createProject(type, 'Backlog')
    await importWorkflowConfig(client, type.projectTypeId, {
      version: 1,
      exportDate: new Date().toISOString(),
      workspace: wsUuid,
      projectTypeId: type.projectTypeId,
      statuses: Statuses.map((s) => ({ id: type.statuses[s], name: s, color: 0 })),
      workflows: [{ id: generateId(), name, taskTypeName: 'Issue', taskTypeId: type.taskTypes.Issue }],
      projects: [{ project: other.projectId, identifier: other.identifier, workflows: { Issue: name } }]
    })
    for (const project of [ctx, other]) {
      const issue = await createIssue(project, { status: 'Backlog' })
      await setStatus(project, issue, 'Todo')
      expect(await getStatus(project, issue)).toEqual('Todo')
      const err = await expectRejected(async () => {
        await setStatus(project, issue, 'Done')
      })
      expect(err).toContain('ForbiddenTransition')
    }
  })

  it('leaves non-status updates alone', async () => {
    const { ctx } = await withWorkflow([{ name: 'Start', from: ['Backlog'], to: 'Todo' }])
    const issueId = await createIssue(ctx, { status: 'Backlog' })
    const issue = await ctx.client.findOne(task.class.Task, { _id: issueId as any })
    await ctx.client.update(issue as any, { title: 'Renamed' })
    const updated = await ctx.client.findOne(task.class.Task, { _id: issueId as any })
    expect((updated as any).title).toEqual('Renamed')
  })

  it.each([
    ['Backlog', 'Todo', true],
    ['Backlog', 'InProgress', false],
    ['Todo', 'InProgress', true],
    ['Todo', 'Done', false],
    ['InProgress', 'Done', true],
    ['InProgress', 'Backlog', false],
    ['Done', 'Backlog', false]
  ])('enforces the graph edge %s -> %s', async (from, to, allowed) => {
    const { ctx } = await withWorkflow(
      [
        { name: 'Plan', from: ['Backlog'], to: 'Todo' },
        { name: 'Start', from: ['Todo'], to: 'InProgress' },
        { name: 'Finish', from: ['InProgress'], to: 'Done' }
      ],
      { initialStatuses: [] }
    )
    const issue = await createIssue(ctx, { status: from })
    if (allowed) {
      await setStatus(ctx, issue, to)
      expect(await getStatus(ctx, issue)).toEqual(to)
    } else {
      const err = await expectRejected(async () => {
        await setStatus(ctx, issue, to)
      })
      expect(err).toContain('ForbiddenTransition')
    }
  })

  it('reports the offending statuses in the error', async () => {
    const { ctx } = await withWorkflow([{ name: 'Start', from: ['Backlog'], to: 'Todo' }])
    const issue = await createIssue(ctx, { status: 'Backlog' })
    const err = await expectRejected(async () => {
      await setStatus(ctx, issue, 'Done')
    })
    expect(err).toContain(type.statuses.Backlog)
    expect(err).toContain(type.statuses.Done)
  })

  it('allows a loop back to an earlier status', async () => {
    const { ctx } = await withWorkflow([
      { name: 'Start', from: ['Backlog'], to: 'InProgress' },
      { name: 'Review', from: ['InProgress'], to: 'InReview' },
      { name: 'Rework', from: ['InReview'], to: 'InProgress' }
    ])
    const issue = await createIssue(ctx, { status: 'Backlog' })
    await setStatus(ctx, issue, 'InProgress')
    await setStatus(ctx, issue, 'InReview')
    await setStatus(ctx, issue, 'InProgress')
    await setStatus(ctx, issue, 'InReview')
    expect(await getStatus(ctx, issue)).toEqual('InReview')
  })

  it('keeps a terminal status terminal', async () => {
    const { ctx } = await withWorkflow([{ name: 'Finish', from: ['Backlog'], to: 'Done' }])
    const issue = await createIssue(ctx, { status: 'Backlog' })
    await setStatus(ctx, issue, 'Done')
    for (const target of Statuses.filter((s) => s !== 'Done')) {
      const err = await expectRejected(async () => {
        await setStatus(ctx, issue, target)
      })
      expect(err).toContain('ForbiddenTransition')
    }
  })

  it('counts transitions on the workflow doc', async () => {
    const { workflowId } = await withWorkflow([
      { name: 'A', from: ['Backlog'], to: 'Todo' },
      { name: 'B', from: ['Todo'], to: 'InProgress' },
      { name: 'C', from: ['InProgress'], to: 'Done' }
    ])
    const transitions = await client.findAll(workflow.class.WorkflowTransition, { attachedTo: workflowId })
    expect(transitions).toHaveLength(3)
  })

  it('binds the workflow through the project mixin', async () => {
    const { ctx, workflowId } = await withWorkflow([{ name: 'A', from: ['Backlog'], to: 'Todo' }])
    const project = await client.findOne(task.class.Project, { _id: ctx.projectId })
    const mapping = client.getHierarchy().as(project as Project, workflow.mixin.ProjectWorkflow).workflows
    expect(mapping?.[type.taskTypes.Issue]).toEqual(workflowId)
  })

  it('rejects a transition when the project is bound after the issue exists', async () => {
    const ctx = await createProject(type, 'Backlog')
    const issue = await createIssue(ctx, { status: 'Backlog' })
    await setStatus(ctx, issue, 'Todo')

    const name = `WF ${uniqueSuffix()}`
    await importWorkflowConfig(client, type.projectTypeId, {
      version: 1,
      exportDate: new Date().toISOString(),
      workspace: wsUuid,
      projectTypeId: type.projectTypeId,
      statuses: Statuses.map((s) => ({ id: type.statuses[s], name: s, color: 0 })),
      workflows: [
        {
          id: generateId(),
          name,
          taskTypeName: 'Issue',
          taskTypeId: type.taskTypes.Issue,
          transitions: [{ id: generateId(), name: 'Only', from: [type.statuses.Backlog], to: type.statuses.Todo }]
        }
      ],
      projects: [{ project: ctx.projectId, identifier: ctx.identifier, workflows: { Issue: name } }]
    })
    const err = await expectRejected(async () => {
      await setStatus(ctx, issue, 'Done')
    })
    expect(err).toContain('ForbiddenTransition')
  })
})
