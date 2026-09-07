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

import core, {
  generateId,
  type AnyAttribute,
  type Class,
  type Data,
  type Doc,
  type Ref,
  type Type,
  type TxOperations,
  type WorkspaceUuid
} from '@hcengineering/core'
import { getEmbeddedLabel } from '@hcengineering/platform'
import task, { type TaskType } from '@hcengineering/task'
import { type Issue } from '@hcengineering/tracker'
import { importWorkflowConfig, type Workflow } from '@hcengineering/workflow'

import {
  connect,
  createIssue,
  createProject,
  createProjectTypeWith,
  eventually,
  getIssue,
  uniqueSuffix,
  type ProjectContext,
  type ProjectTypeContext
} from './workflow.fixtures'

const Statuses = ['Backlog', 'Todo', 'InProgress', 'Done']
const wsUuid = 'test-workspace-uuid' as unknown as WorkspaceUuid

/**
 * Adds a custom attribute to a task type's target class, the way the settings UI does.
 * Returns the attribute name, which is also the key it occupies on the issue document.
 */
async function addCustomAttribute (
  client: TxOperations,
  taskTypeId: Ref<TaskType>,
  typeClass: Ref<Class<Doc>>,
  label: string,
  name: string = `custom${generateId()}`
): Promise<string> {
  const taskType = await client.findOne(task.class.TaskType, { _id: taskTypeId })
  if (taskType === undefined) throw new Error(`Task type ${taskTypeId} not found`)

  const type: Type<any> = { _class: typeClass, label: getEmbeddedLabel(label) }
  const data: Data<AnyAttribute> = {
    attributeOf: taskType.targetClass,
    name,
    label: getEmbeddedLabel(label),
    isCustom: true,
    type
  }
  await client.createDoc(core.class.Attribute, core.space.Model, data)
  return name
}

async function taskTypeOf (client: TxOperations, id: Ref<TaskType>): Promise<TaskType> {
  const tt = await client.findOne(task.class.TaskType, { _id: id })
  if (tt === undefined) throw new Error(`Task type ${id} not found`)
  return tt
}

describe('task type change', () => {
  let client: TxOperations
  let type: ProjectTypeContext

  beforeAll(async () => {
    client = await connect()
    type = await createProjectTypeWith(client, [
      { name: 'Issue', statuses: Statuses },
      { name: 'Bug', statuses: Statuses }
    ])
  }, 60000)

  async function project (): Promise<ProjectContext> {
    return await createProject(type, 'Backlog')
  }

  it('changes kind and derives the new _class on the server', async () => {
    const ctx = await project()
    const issueId = await createIssue(ctx, { status: 'Backlog', taskType: 'Issue' })

    const bug = await taskTypeOf(client, type.taskTypes.Bug)
    const before = await getIssue(ctx, issueId)
    expect(before?.kind).toBe(type.taskTypes.Issue)

    const issue = before as Issue
    await client.updateDoc(issue._class, issue.space, issue._id, { kind: type.taskTypes.Bug })

    const after = await eventually(async () => {
      const doc = await getIssue(ctx, issueId)
      return doc?.kind === type.taskTypes.Bug ? doc : undefined
    })

    expect(after.kind).toBe(type.taskTypes.Bug)
    // The client never sends _class; TaskMiddleware derives it from kind.
    expect(after._class).toBe(bug.targetClass)
  })

  it('keeps a custom attribute the target type also declares', async () => {
    const ctx = await project()
    const shared = `shared${uniqueSuffix()}`

    // Same attribute name and type on both task types.
    for (const tt of [type.taskTypes.Issue, type.taskTypes.Bug]) {
      await addCustomAttribute(client, tt, core.class.TypeString, shared, shared)
    }

    const issueId = await createIssue(ctx, { status: 'Backlog', taskType: 'Issue' })
    const issue = (await getIssue(ctx, issueId)) as Issue
    await client.updateDoc(issue._class, issue.space, issue._id, { [shared]: 'carried over' } as any)

    const withValue = (await getIssue(ctx, issueId)) as any
    expect(withValue[shared]).toBe('carried over')

    await client.updateDoc(issue._class, issue.space, issue._id, { kind: type.taskTypes.Bug })

    const after = await eventually(async () => {
      const doc = await getIssue(ctx, issueId)
      return doc?.kind === type.taskTypes.Bug ? doc : undefined
    })
    expect((after as any)[shared]).toBe('carried over')
  })

  it('clears a custom attribute the target type does not have', async () => {
    const ctx = await project()
    const onlyOnIssue = await addCustomAttribute(client, type.taskTypes.Issue, core.class.TypeString, 'Only on Issue')

    const issueId = await createIssue(ctx, { status: 'Backlog', taskType: 'Issue' })
    const issue = (await getIssue(ctx, issueId)) as Issue
    await client.updateDoc(issue._class, issue.space, issue._id, { [onlyOnIssue]: 'to be dropped' } as any)
    expect(((await getIssue(ctx, issueId)) as any)[onlyOnIssue]).toBe('to be dropped')

    // What the dialog sends: the new kind plus an $unset for every attribute left behind.
    await client.updateDoc(issue._class, issue.space, issue._id, {
      kind: type.taskTypes.Bug,
      $unset: { [onlyOnIssue]: '' }
    } as any)

    const after = await eventually(async () => {
      const doc = await getIssue(ctx, issueId)
      return doc?.kind === type.taskTypes.Bug ? doc : undefined
    })
    expect((after as any)[onlyOnIssue]).toBeUndefined()
  })

  it('applies the picked status together with the new type', async () => {
    const ctx = await project()
    const issueId = await createIssue(ctx, { status: 'Backlog', taskType: 'Issue' })
    const issue = (await getIssue(ctx, issueId)) as Issue

    const bugType = await taskTypeOf(client, type.taskTypes.Bug)
    const target = bugType.statuses[bugType.statuses.length - 1]

    await client.updateDoc(issue._class, issue.space, issue._id, { kind: type.taskTypes.Bug, status: target })

    const after = await eventually(async () => {
      const doc = await getIssue(ctx, issueId)
      return doc?.kind === type.taskTypes.Bug ? doc : undefined
    })
    expect(after.status).toBe(target)
  })

  it('leaves sub-issues untouched', async () => {
    const ctx = await project()
    const parentId = await createIssue(ctx, { status: 'Backlog', taskType: 'Issue' })
    const childId = await createIssue(ctx, { status: 'Backlog', taskType: 'Issue', parent: parentId })

    const childBefore = (await getIssue(ctx, childId)) as Issue
    const parent = (await getIssue(ctx, parentId)) as Issue
    await client.updateDoc(parent._class, parent.space, parent._id, { kind: type.taskTypes.Bug })

    await eventually(async () => {
      const doc = await getIssue(ctx, parentId)
      return doc?.kind === type.taskTypes.Bug ? doc : undefined
    })

    const childAfter = (await getIssue(ctx, childId)) as Issue
    expect(childAfter.kind).toBe(childBefore.kind)
    expect(childAfter._class).toBe(childBefore._class)
    expect(childAfter.attachedTo).toBe(parentId)
  })

  it('is not blocked by the workflow bound to the task type', async () => {
    const ctx = await createProject(type, 'Backlog')

    // A workflow on Bug that only ever allows Backlog -> Todo, bound to the Bug task type.
    const name = `WF ${uniqueSuffix()}`
    await importWorkflowConfig(client, type.projectTypeId, {
      version: 1,
      exportDate: new Date().toISOString(),
      workspace: wsUuid,
      projectTypeId: type.projectTypeId,
      statuses: Statuses.map((s) => ({ id: type.statuses[s], name: s, color: 0 })),
      workflows: [
        {
          id: generateId<Workflow>(),
          name,
          taskTypeName: 'Bug',
          taskTypeId: type.taskTypes.Bug,
          transitions: [
            {
              id: generateId(),
              name: 'Start',
              from: [type.statuses.Backlog],
              to: type.statuses.Todo
            }
          ]
        }
      ],
      projects: [
        {
          project: ctx.projectId,
          identifier: ctx.identifier,
          workflows: { Bug: name }
        }
      ]
    })

    const issueId = await createIssue(ctx, { status: 'Backlog', taskType: 'Issue' })
    const issue = (await getIssue(ctx, issueId)) as Issue

    const bugType = await taskTypeOf(client, type.taskTypes.Bug)
    // Deliberately a status the Bug workflow has no transition into.
    const target = bugType.statuses[bugType.statuses.length - 1]

    await expect(
      client.updateDoc(issue._class, issue.space, issue._id, { kind: type.taskTypes.Bug, status: target })
    ).resolves.not.toThrow()

    const after = await eventually(async () => {
      const doc = await getIssue(ctx, issueId)
      return doc?.kind === type.taskTypes.Bug ? doc : undefined
    })
    expect(after.status).toBe(target)
  })
})
