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

import { generateId, type AnyAttribute, type Ref, type TxOperations, type WorkspaceUuid } from '@hcengineering/core'
import workflow, {
  importWorkflowConfig,
  type RequestConfig,
  type ValidatorConfig,
  type PostFunctionConfig,
  type WorkflowRule
} from '@hcengineering/workflow'
import tracker, { type Issue } from '@hcengineering/tracker'

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

const Statuses = ['Backlog', 'Todo', 'InProgress', 'Done']
const wsUuid = 'test-workspace-uuid' as unknown as WorkspaceUuid

interface TransitionSpec {
  name: string
  from: string[] | null
  to: string
  requests?: RequestConfig[]
  validators?: ValidatorConfig[]
  postFunctions?: PostFunctionConfig[]
}

describe('workflow validators', () => {
  let client: TxOperations
  let type: ProjectTypeContext

  beforeAll(async () => {
    client = await connect()
    type = await createProjectTypeWith(client, [
      { name: 'Issue', statuses: Statuses },
      { name: 'Bug', statuses: Statuses }
    ])
  }, 60000)

  function field (key: string): { attribute: Ref<AnyAttribute>, fieldKey: string } {
    const attr = client.getHierarchy().getAttribute(tracker.class.Issue, key)
    return { attribute: attr._id, fieldKey: key }
  }

  function fieldRequired (...keys: string[]): ValidatorConfig {
    return {
      id: generateId(),
      rule: workflow.validator.FieldRequired,
      ruleClass: workflow.class.WorkflowValidator,
      props: { fields: keys.map(field) }
    }
  }

  function statusRule (rule: Ref<WorkflowRule>, statuses: Record<string, string[] | null>): ValidatorConfig {
    const mapped: Record<string, string[] | null> = {}
    for (const [taskType, values] of Object.entries(statuses)) {
      mapped[`$taskType:${taskType}`] = values === null ? null : values.map((s) => `$status:${s}`)
    }
    return {
      id: generateId(),
      rule,
      ruleClass: workflow.class.WorkflowValidator,
      props: { statuses: mapped }
    }
  }

  async function withWorkflow (transitions: TransitionSpec[]): Promise<ProjectContext> {
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
          name,
          taskTypeName: 'Issue',
          taskTypeId: type.taskTypes.Issue,
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
      projects: [{ project: ctx.projectId, identifier: ctx.identifier, workflows: { Issue: name } }]
    })
    return ctx
  }

  /** Same, but both task types are bound so subtask/parent rules can span them. */
  async function withWorkflows (
    issueTransitions: TransitionSpec[],
    bugTransitions: TransitionSpec[] = [{ name: 'Any', from: null, to: 'Done' }]
  ): Promise<ProjectContext> {
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
          transitions: issueTransitions.map((t) => ({
            id: generateId(),
            name: t.name,
            from: t.from == null ? null : t.from.map((s) => type.statuses[s]),
            to: type.statuses[t.to],
            requests: t.requests,
            validators: t.validators,
            postFunctions: t.postFunctions
          }))
        },
        {
          id: generateId(),
          name: `${name} B`,
          taskTypeName: 'Bug',
          taskTypeId: type.taskTypes.Bug,
          transitions: bugTransitions.map((t) => ({
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
        { project: ctx.projectId, identifier: ctx.identifier, workflows: { Issue: `${name} I`, Bug: `${name} B` } }
      ]
    })
    return ctx
  }

  describe('field required', () => {
    it('blocks the transition when the field is empty', async () => {
      const ctx = await withWorkflow([
        { name: 'Start', from: ['Backlog'], to: 'InProgress', validators: [fieldRequired('dueDate')] }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog' })
      const err = await expectRejected(async () => {
        await setStatus(ctx, issue, 'InProgress')
      })
      expect(err).toContain('FieldRequiredError')
      expect(await getStatus(ctx, issue)).toEqual('Backlog')
    })

    it('allows the transition when the field is filled', async () => {
      const ctx = await withWorkflow([
        { name: 'Start', from: ['Backlog'], to: 'InProgress', validators: [fieldRequired('dueDate')] }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog', dueDate: Date.now() })
      await setStatus(ctx, issue, 'InProgress')
      expect(await getStatus(ctx, issue)).toEqual('InProgress')
    })

    it('treats a zero number as empty', async () => {
      const ctx = await withWorkflow([
        { name: 'Start', from: ['Backlog'], to: 'InProgress', validators: [fieldRequired('estimation')] }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog', estimation: 0 })
      const err = await expectRejected(async () => {
        await setStatus(ctx, issue, 'InProgress')
      })
      expect(err).toContain('FieldRequiredError')
    })

    it('accepts a non-zero number', async () => {
      const ctx = await withWorkflow([
        { name: 'Start', from: ['Backlog'], to: 'InProgress', validators: [fieldRequired('estimation')] }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog', estimation: 4 })
      await setStatus(ctx, issue, 'InProgress')
      expect(await getStatus(ctx, issue)).toEqual('InProgress')
    })

    it('treats a null reference as empty', async () => {
      const ctx = await withWorkflow([
        { name: 'Start', from: ['Backlog'], to: 'InProgress', validators: [fieldRequired('assignee')] }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog' })
      const err = await expectRejected(async () => {
        await setStatus(ctx, issue, 'InProgress')
      })
      expect(err).toContain('FieldRequiredError')
    })

    it('reports the first empty field of several', async () => {
      const ctx = await withWorkflow([
        {
          name: 'Start',
          from: ['Backlog'],
          to: 'InProgress',
          validators: [fieldRequired('dueDate', 'estimation')]
        }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog', estimation: 4 })
      const err = await expectRejected(async () => {
        await setStatus(ctx, issue, 'InProgress')
      })
      expect(err).toContain('FieldRequiredError')
    })

    it('passes once every listed field is filled', async () => {
      const ctx = await withWorkflow([
        {
          name: 'Start',
          from: ['Backlog'],
          to: 'InProgress',
          validators: [fieldRequired('dueDate', 'estimation')]
        }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog', estimation: 4, dueDate: Date.now() })
      await setStatus(ctx, issue, 'InProgress')
      expect(await getStatus(ctx, issue)).toEqual('InProgress')
    })

    it('passes when the field list is empty', async () => {
      const ctx = await withWorkflow([
        { name: 'Start', from: ['Backlog'], to: 'InProgress', validators: [fieldRequired()] }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog' })
      await setStatus(ctx, issue, 'InProgress')
      expect(await getStatus(ctx, issue)).toEqual('InProgress')
    })

    it('applies only to the transition it is attached to', async () => {
      const ctx = await withWorkflow([
        { name: 'Start', from: ['Backlog'], to: 'InProgress', validators: [fieldRequired('dueDate')] },
        { name: 'Park', from: ['Backlog'], to: 'Todo' }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog' })
      await setStatus(ctx, issue, 'Todo')
      expect(await getStatus(ctx, issue)).toEqual('Todo')
    })

    it('applies to a wildcard transition from any status', async () => {
      const ctx = await withWorkflow([
        { name: 'Plan', from: ['Backlog'], to: 'Todo' },
        { name: 'Finish', from: null, to: 'Done', validators: [fieldRequired('dueDate')] }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog' })
      await setStatus(ctx, issue, 'Todo')
      const err = await expectRejected(async () => {
        await setStatus(ctx, issue, 'Done')
      })
      expect(err).toContain('FieldRequiredError')
    })

    it('lets the transition through after the field is filled in', async () => {
      const ctx = await withWorkflow([
        { name: 'Start', from: ['Backlog'], to: 'InProgress', validators: [fieldRequired('dueDate')] }
      ])
      const issueId = await createIssue(ctx, { status: 'Backlog' })
      await expectRejected(async () => {
        await setStatus(ctx, issueId, 'InProgress')
      })
      const issue = await client.findOne(tracker.class.Issue, { _id: issueId })
      await client.update(issue as Issue, { dueDate: Date.now() })
      await setStatus(ctx, issueId, 'InProgress')
      expect(await getStatus(ctx, issueId)).toEqual('InProgress')
    })

    it.each(['dueDate', 'estimation', 'assignee'])('blocks on the empty field %s', async (key) => {
      const ctx = await withWorkflow([
        { name: 'Start', from: ['Backlog'], to: 'InProgress', validators: [fieldRequired(key)] }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog' })
      const err = await expectRejected(async () => {
        await setStatus(ctx, issue, 'InProgress')
      })
      expect(err).toContain('FieldRequiredError')
    })

    it('runs two validators on one transition', async () => {
      const ctx = await withWorkflow([
        {
          name: 'Start',
          from: ['Backlog'],
          to: 'InProgress',
          validators: [fieldRequired('dueDate'), fieldRequired('estimation')]
        }
      ])
      const withDue = await createIssue(ctx, { status: 'Backlog', dueDate: Date.now() })
      const err = await expectRejected(async () => {
        await setStatus(ctx, withDue, 'InProgress')
      })
      expect(err).toContain('FieldRequiredError')

      const withBoth = await createIssue(ctx, { status: 'Backlog', dueDate: Date.now(), estimation: 2 })
      await setStatus(ctx, withBoth, 'InProgress')
      expect(await getStatus(ctx, withBoth)).toEqual('InProgress')
    })

    it('does not affect the issue when the transition is rejected', async () => {
      const ctx = await withWorkflow([
        { name: 'Start', from: ['Backlog'], to: 'InProgress', validators: [fieldRequired('dueDate')] }
      ])
      const issueId = await createIssue(ctx, { status: 'Backlog', title: 'Untouched' })
      await expectRejected(async () => {
        await setStatus(ctx, issueId, 'InProgress')
      })
      const issue = await client.findOne(tracker.class.Issue, { _id: issueId })
      expect(issue?.title).toEqual('Untouched')
      expect(issue?.status).toEqual(type.statuses.Backlog)
    })
  })

  describe('subtask status', () => {
    it('blocks the parent while a subtask is in a disallowed status', async () => {
      const ctx = await withWorkflows([
        {
          name: 'Finish',
          from: ['Backlog'],
          to: 'Done',
          validators: [statusRule(workflow.validator.SubtaskStatus, { Issue: ['Done'] })]
        }
      ])
      const parent = await createIssue(ctx, { status: 'Backlog' })
      await createIssue(ctx, { status: 'Backlog', parent })
      const err = await expectRejected(async () => {
        await setStatus(ctx, parent, 'Done')
      })
      expect(err).toContain('SubtaskStatusError')
    })

    it('allows the parent once the subtask is in an allowed status', async () => {
      const ctx = await withWorkflows([
        { name: 'Close sub', from: ['Backlog'], to: 'Done' },
        {
          name: 'Finish',
          from: ['Todo'],
          to: 'Done',
          validators: [statusRule(workflow.validator.SubtaskStatus, { Issue: ['Done'] })]
        },
        { name: 'Plan', from: ['Backlog'], to: 'Todo' }
      ])
      const parent = await createIssue(ctx, { status: 'Backlog' })
      const child = await createIssue(ctx, { status: 'Backlog', parent })
      await setStatus(ctx, child, 'Done')
      await setStatus(ctx, parent, 'Todo')
      await setStatus(ctx, parent, 'Done')
      expect(await getStatus(ctx, parent)).toEqual('Done')
    })

    it('passes when there are no subtasks at all', async () => {
      const ctx = await withWorkflows([
        {
          name: 'Finish',
          from: ['Backlog'],
          to: 'Done',
          validators: [statusRule(workflow.validator.SubtaskStatus, { Issue: ['Done'] })]
        }
      ])
      const parent = await createIssue(ctx, { status: 'Backlog' })
      await setStatus(ctx, parent, 'Done')
      expect(await getStatus(ctx, parent)).toEqual('Done')
    })

    it('passes when the status map is empty', async () => {
      const ctx = await withWorkflows([
        {
          name: 'Finish',
          from: ['Backlog'],
          to: 'Done',
          validators: [statusRule(workflow.validator.SubtaskStatus, {})]
        }
      ])
      const parent = await createIssue(ctx, { status: 'Backlog' })
      await createIssue(ctx, { status: 'Backlog', parent })
      await setStatus(ctx, parent, 'Done')
      expect(await getStatus(ctx, parent)).toEqual('Done')
    })

    it('treats a null entry as any status', async () => {
      const ctx = await withWorkflows([
        {
          name: 'Finish',
          from: ['Backlog'],
          to: 'Done',
          validators: [statusRule(workflow.validator.SubtaskStatus, { Issue: null })]
        }
      ])
      const parent = await createIssue(ctx, { status: 'Backlog' })
      await createIssue(ctx, { status: 'Backlog', parent })
      await setStatus(ctx, parent, 'Done')
      expect(await getStatus(ctx, parent)).toEqual('Done')
    })

    it('accepts any of several allowed statuses', async () => {
      const ctx = await withWorkflows([
        { name: 'Close sub', from: ['Backlog'], to: 'Todo' },
        {
          name: 'Finish',
          from: ['Backlog'],
          to: 'Done',
          validators: [statusRule(workflow.validator.SubtaskStatus, { Issue: ['Todo', 'Done'] })]
        }
      ])
      const parent = await createIssue(ctx, { status: 'Backlog' })
      const child = await createIssue(ctx, { status: 'Backlog', parent })
      await setStatus(ctx, child, 'Todo')
      await setStatus(ctx, parent, 'Done')
      expect(await getStatus(ctx, parent)).toEqual('Done')
    })

    it('blocks when one of several subtasks is not ready', async () => {
      const ctx = await withWorkflows([
        { name: 'Close sub', from: ['Backlog'], to: 'Done' },
        {
          name: 'Finish',
          from: ['Todo'],
          to: 'Done',
          validators: [statusRule(workflow.validator.SubtaskStatus, { Issue: ['Done'] })]
        },
        { name: 'Plan', from: ['Backlog'], to: 'Todo' }
      ])
      const parent = await createIssue(ctx, { status: 'Backlog' })
      const first = await createIssue(ctx, { status: 'Backlog', parent })
      await createIssue(ctx, { status: 'Backlog', parent })
      await setStatus(ctx, first, 'Done')
      await setStatus(ctx, parent, 'Todo')
      const err = await expectRejected(async () => {
        await setStatus(ctx, parent, 'Done')
      })
      expect(err).toContain('SubtaskStatusError')
    })

    it('ignores subtasks of a task type that is not in the map', async () => {
      const ctx = await withWorkflows([
        {
          name: 'Finish',
          from: ['Backlog'],
          to: 'Done',
          validators: [statusRule(workflow.validator.SubtaskStatus, { Bug: ['Done'] })]
        }
      ])
      const parent = await createIssue(ctx, { status: 'Backlog' })
      await createIssue(ctx, { status: 'Backlog', parent, taskType: 'Issue' })
      await setStatus(ctx, parent, 'Done')
      expect(await getStatus(ctx, parent)).toEqual('Done')
    })

    it('checks subtasks of the mapped task type', async () => {
      const ctx = await withWorkflows([
        {
          name: 'Finish',
          from: ['Backlog'],
          to: 'Done',
          validators: [statusRule(workflow.validator.SubtaskStatus, { Bug: ['Done'] })]
        }
      ])
      const parent = await createIssue(ctx, { status: 'Backlog' })
      await createIssue(ctx, { status: 'Backlog', parent, taskType: 'Bug' })
      const err = await expectRejected(async () => {
        await setStatus(ctx, parent, 'Done')
      })
      expect(err).toContain('SubtaskStatusError')
    })

    it('does not look at grandchildren', async () => {
      const ctx = await withWorkflows([
        { name: 'Close', from: ['Backlog'], to: 'Done' },
        {
          name: 'Finish',
          from: ['Todo'],
          to: 'Done',
          validators: [statusRule(workflow.validator.SubtaskStatus, { Issue: ['Done'] })]
        },
        { name: 'Plan', from: ['Backlog'], to: 'Todo' }
      ])
      const parent = await createIssue(ctx, { status: 'Backlog' })
      const child = await createIssue(ctx, { status: 'Backlog', parent })
      await createIssue(ctx, { status: 'Backlog', parent: child })
      await setStatus(ctx, child, 'Done')
      await setStatus(ctx, parent, 'Todo')
      await setStatus(ctx, parent, 'Done')
      expect(await getStatus(ctx, parent)).toEqual('Done')
    })
  })

  describe('parent status', () => {
    it('blocks the subtask while the parent is in a disallowed status', async () => {
      const ctx = await withWorkflows([
        {
          name: 'Start',
          from: ['Backlog'],
          to: 'InProgress',
          validators: [statusRule(workflow.validator.ParentStatus, { Issue: ['InProgress'] })]
        }
      ])
      const parent = await createIssue(ctx, { status: 'Backlog' })
      const child = await createIssue(ctx, { status: 'Backlog', parent })
      const err = await expectRejected(async () => {
        await setStatus(ctx, child, 'InProgress')
      })
      expect(err).toContain('ParentStatusError')
    })

    it('allows the subtask once the parent reaches an allowed status', async () => {
      const ctx = await withWorkflows([
        {
          name: 'Start',
          from: ['Backlog'],
          to: 'InProgress',
          validators: [statusRule(workflow.validator.ParentStatus, { Issue: ['InProgress'] })]
        }
      ])
      const parent = await createIssue(ctx, { status: 'Backlog' })
      const child = await createIssue(ctx, { status: 'Backlog', parent })
      await setStatus(ctx, parent, 'InProgress')
      await setStatus(ctx, child, 'InProgress')
      expect(await getStatus(ctx, child)).toEqual('InProgress')
    })

    it('passes for a task without a parent', async () => {
      const ctx = await withWorkflows([
        {
          name: 'Start',
          from: ['Backlog'],
          to: 'InProgress',
          validators: [statusRule(workflow.validator.ParentStatus, { Issue: ['Done'] })]
        }
      ])
      const orphan = await createIssue(ctx, { status: 'Backlog' })
      await setStatus(ctx, orphan, 'InProgress')
      expect(await getStatus(ctx, orphan)).toEqual('InProgress')
    })

    it('passes when the status map is empty', async () => {
      const ctx = await withWorkflows([
        {
          name: 'Start',
          from: ['Backlog'],
          to: 'InProgress',
          validators: [statusRule(workflow.validator.ParentStatus, {})]
        }
      ])
      const parent = await createIssue(ctx, { status: 'Backlog' })
      const child = await createIssue(ctx, { status: 'Backlog', parent })
      await setStatus(ctx, child, 'InProgress')
      expect(await getStatus(ctx, child)).toEqual('InProgress')
    })

    it('treats a null entry as any status', async () => {
      const ctx = await withWorkflows([
        {
          name: 'Start',
          from: ['Backlog'],
          to: 'InProgress',
          validators: [statusRule(workflow.validator.ParentStatus, { Issue: null })]
        }
      ])
      const parent = await createIssue(ctx, { status: 'Backlog' })
      const child = await createIssue(ctx, { status: 'Backlog', parent })
      await setStatus(ctx, child, 'InProgress')
      expect(await getStatus(ctx, child)).toEqual('InProgress')
    })

    it('accepts any of several allowed parent statuses', async () => {
      const ctx = await withWorkflows([
        {
          name: 'Start',
          from: ['Backlog'],
          to: 'InProgress',
          validators: [statusRule(workflow.validator.ParentStatus, { Issue: ['Backlog', 'Todo'] })]
        }
      ])
      const parent = await createIssue(ctx, { status: 'Backlog' })
      const child = await createIssue(ctx, { status: 'Backlog', parent })
      await setStatus(ctx, child, 'InProgress')
      expect(await getStatus(ctx, child)).toEqual('InProgress')
    })

    it('ignores a parent whose task type is not in the map', async () => {
      const ctx = await withWorkflows([
        {
          name: 'Start',
          from: ['Backlog'],
          to: 'InProgress',
          validators: [statusRule(workflow.validator.ParentStatus, { Bug: ['Done'] })]
        }
      ])
      const parent = await createIssue(ctx, { status: 'Backlog', taskType: 'Issue' })
      const child = await createIssue(ctx, { status: 'Backlog', parent })
      await setStatus(ctx, child, 'InProgress')
      expect(await getStatus(ctx, child)).toEqual('InProgress')
    })

    it('checks a parent of the mapped task type', async () => {
      const ctx = await withWorkflows([
        {
          name: 'Start',
          from: ['Backlog'],
          to: 'InProgress',
          validators: [statusRule(workflow.validator.ParentStatus, { Bug: ['Done'] })]
        }
      ])
      const parent = await createIssue(ctx, { status: 'Backlog', taskType: 'Bug' })
      const child = await createIssue(ctx, { status: 'Backlog', parent, taskType: 'Issue' })
      const err = await expectRejected(async () => {
        await setStatus(ctx, child, 'InProgress')
      })
      expect(err).toContain('ParentStatusError')
    })
  })

  describe('combined rules', () => {
    it('runs a field rule and a parent rule on the same transition', async () => {
      const ctx = await withWorkflows([
        {
          name: 'Start',
          from: ['Backlog'],
          to: 'InProgress',
          validators: [fieldRequired('dueDate'), statusRule(workflow.validator.ParentStatus, { Issue: ['InProgress'] })]
        }
      ])
      // The parent runs the same rules, so it needs a due date of its own to be able to move.
      const parent = await createIssue(ctx, { status: 'Backlog', dueDate: Date.now() })
      const noDue = await createIssue(ctx, { status: 'Backlog', parent })
      expect(
        await expectRejected(async () => {
          await setStatus(ctx, noDue, 'InProgress')
        })
      ).toContain('FieldRequiredError')

      const withDue = await createIssue(ctx, { status: 'Backlog', parent, dueDate: Date.now() })
      expect(
        await expectRejected(async () => {
          await setStatus(ctx, withDue, 'InProgress')
        })
      ).toContain('ParentStatusError')

      await setStatus(ctx, parent, 'InProgress')
      await setStatus(ctx, withDue, 'InProgress')
      expect(await getStatus(ctx, withDue)).toEqual('InProgress')
    })

    it('runs subtask and parent rules on the two ends of one hierarchy', async () => {
      // One workflow serves both ends, so the two rules have to sit on different edges - two
      // transitions with the same from/to would be rejected as a conflict.
      const ctx = await withWorkflows([
        { name: 'Plan', from: ['Backlog'], to: 'Todo' },
        {
          name: 'Close child',
          from: ['Todo'],
          to: 'Done',
          validators: [statusRule(workflow.validator.ParentStatus, { Issue: ['Todo'] })]
        },
        {
          name: 'Close parent',
          from: ['InProgress'],
          to: 'Done',
          validators: [statusRule(workflow.validator.SubtaskStatus, { Issue: ['Done'] })]
        },
        { name: 'Start parent', from: ['Todo'], to: 'InProgress' }
      ])
      const parent = await createIssue(ctx, { status: 'Backlog' })
      const child = await createIssue(ctx, { status: 'Backlog', parent })
      await setStatus(ctx, parent, 'Todo')
      await setStatus(ctx, child, 'Todo')
      await setStatus(ctx, child, 'Done')
      await setStatus(ctx, parent, 'InProgress')
      await setStatus(ctx, parent, 'Done')
      expect(await getStatus(ctx, parent)).toEqual('Done')
    })

    it('rejects the parent while its subtask is still open, then lets it through', async () => {
      const ctx = await withWorkflows([
        { name: 'Plan', from: ['Backlog'], to: 'Todo' },
        { name: 'Close child', from: ['Todo'], to: 'Done' },
        {
          name: 'Close parent',
          from: ['InProgress'],
          to: 'Done',
          validators: [statusRule(workflow.validator.SubtaskStatus, { Issue: ['Done'] })]
        },
        { name: 'Start parent', from: ['Todo'], to: 'InProgress' }
      ])
      const parent = await createIssue(ctx, { status: 'Backlog' })
      const child = await createIssue(ctx, { status: 'Backlog', parent })
      await setStatus(ctx, parent, 'Todo')
      await setStatus(ctx, parent, 'InProgress')
      expect(
        await expectRejected(async () => {
          await setStatus(ctx, parent, 'Done')
        })
      ).toContain('SubtaskStatusError')

      await setStatus(ctx, child, 'Todo')
      await setStatus(ctx, child, 'Done')
      await setStatus(ctx, parent, 'Done')
      expect(await getStatus(ctx, parent)).toEqual('Done')
    })

    it('reports a rejection without applying the status change', async () => {
      const ctx = await withWorkflows([
        {
          name: 'Finish',
          from: ['Backlog'],
          to: 'Done',
          validators: [statusRule(workflow.validator.SubtaskStatus, { Issue: ['Done'] })]
        }
      ])
      const parent = await createIssue(ctx, { status: 'Backlog' })
      await createIssue(ctx, { status: 'Backlog', parent })
      await expectRejected(async () => {
        await setStatus(ctx, parent, 'Done')
      })
      expect(await getStatus(ctx, parent)).toEqual('Backlog')
    })
  })
})
