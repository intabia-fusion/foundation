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

import { type Ref, type TxOperations } from '@hcengineering/core'
import workflow, {
  importWorkflowConfig,
  type RuleConfig,
  type TransitionConfig,
  type WorkflowFieldValue,
  type WorkflowTransformCall
} from '@hcengineering/workflow'
import tracker, { type Issue } from '@hcengineering/tracker'

import {
  connect,
  createIssue,
  createProject,
  createProjectTypeWith,
  eventually,
  setStatus,
  uniqueSuffix,
  type ProjectContext,
  type ProjectTypeContext
} from './workflow.fixtures'

const Statuses = ['Backlog', 'Todo', 'InProgress', 'Done']

describe('workflow post-functions', () => {
  let client: TxOperations
  let type: ProjectTypeContext

  beforeAll(async () => {
    client = await connect()
    type = await createProjectTypeWith(client, [{ name: 'Issue', statuses: Statuses }])
  }, 60000)

  function field (key: string): { attribute: string, fieldKey: string } {
    const attr = client.getHierarchy().getAttribute(tracker.class.Issue, key)
    return { attribute: attr._id, fieldKey: key }
  }

  function updateField (key: string, value: WorkflowFieldValue): RuleConfig {
    return {
      rule: workflow.postFunction.UpdateFieldValue,
      ruleClass: workflow.class.WorkflowPostFunction,
      props: { fields: [{ ...field(key), value }] }
    }
  }

  function updateFields (entries: Array<[string, WorkflowFieldValue]>): RuleConfig {
    return {
      rule: workflow.postFunction.UpdateFieldValue,
      ruleClass: workflow.class.WorkflowPostFunction,
      props: { fields: entries.map(([key, value]) => ({ ...field(key), value })) }
    }
  }

  function clearFields (...keys: string[]): RuleConfig {
    return {
      rule: workflow.postFunction.ClearFieldValue,
      ruleClass: workflow.class.WorkflowPostFunction,
      props: { fields: keys.map(field) }
    }
  }

  function constant (value: unknown, functions?: WorkflowTransformCall[]): WorkflowFieldValue {
    return { type: 'const', value, functions }
  }

  function thisField (key: string, functions?: WorkflowTransformCall[]): WorkflowFieldValue {
    const value: WorkflowFieldValue = { type: 'this', ...field(key), functions } as unknown as WorkflowFieldValue
    return value
  }

  function parentField (key: string, functions?: WorkflowTransformCall[]): WorkflowFieldValue {
    const value: WorkflowFieldValue = { type: 'parent', ...field(key), functions } as unknown as WorkflowFieldValue
    return value
  }

  async function withWorkflow (transitions: TransitionConfig[]): Promise<ProjectContext> {
    const name = `WF ${uniqueSuffix()}`
    const ctx = await createProject(type, 'Backlog')
    await importWorkflowConfig(client, type.projectTypeId, {
      version: 1,
      workflows: [{ name, taskType: 'Issue', transitions }],
      projects: [{ identifier: ctx.identifier, workflows: { Issue: name } }]
    })
    return ctx
  }

  /** Post-functions run in a trigger, so the value lands after the update transaction returns. */
  async function expectField<T> (issueId: Ref<Issue>, key: string, expected: T): Promise<void> {
    const value = await eventually(async () => {
      const issue = await client.findOne(tracker.class.Issue, { _id: issueId })
      const current = (issue as any)?.[key]
      return current === expected ? { current } : undefined
    })
    expect(value.current).toEqual(expected)
  }

  async function readField (issueId: Ref<Issue>, key: string): Promise<any> {
    const issue = await client.findOne(tracker.class.Issue, { _id: issueId })
    return (issue as any)?.[key]
  }

  describe('update field value', () => {
    it('writes a constant number', async () => {
      const ctx = await withWorkflow([
        { name: 'Start', from: ['Backlog'], to: 'Todo', postFunctions: [updateField('estimation', constant(7))] }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog' })
      await setStatus(ctx, issue, 'Todo')
      await expectField(issue, 'estimation', 7)
    })

    it('writes a constant string', async () => {
      const ctx = await withWorkflow([
        { name: 'Start', from: ['Backlog'], to: 'Todo', postFunctions: [updateField('title', constant('Renamed'))] }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog', title: 'Original' })
      await setStatus(ctx, issue, 'Todo')
      await expectField(issue, 'title', 'Renamed')
    })

    it('overwrites an existing value', async () => {
      const ctx = await withWorkflow([
        { name: 'Start', from: ['Backlog'], to: 'Todo', postFunctions: [updateField('estimation', constant(3))] }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog', estimation: 99 })
      await setStatus(ctx, issue, 'Todo')
      await expectField(issue, 'estimation', 3)
    })

    it('writes several fields in one rule', async () => {
      const ctx = await withWorkflow([
        {
          name: 'Start',
          from: ['Backlog'],
          to: 'Todo',
          postFunctions: [
            updateFields([
              ['estimation', constant(5)],
              ['title', constant('Both')]
            ])
          ]
        }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog' })
      await setStatus(ctx, issue, 'Todo')
      await expectField(issue, 'estimation', 5)
      await expectField(issue, 'title', 'Both')
    })

    it('runs two rules on the same transition', async () => {
      const ctx = await withWorkflow([
        {
          name: 'Start',
          from: ['Backlog'],
          to: 'Todo',
          postFunctions: [updateField('estimation', constant(5)), updateField('title', constant('Two rules'))]
        }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog' })
      await setStatus(ctx, issue, 'Todo')
      await expectField(issue, 'estimation', 5)
      await expectField(issue, 'title', 'Two rules')
    })

    it('fires only on its own transition', async () => {
      const ctx = await withWorkflow([
        { name: 'Start', from: ['Backlog'], to: 'Todo', postFunctions: [updateField('estimation', constant(7))] },
        { name: 'Park', from: ['Backlog'], to: 'InProgress' }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog', estimation: 1 })
      await setStatus(ctx, issue, 'InProgress')
      await new Promise((resolve) => setTimeout(resolve, 1500))
      expect(await readField(issue, 'estimation')).toEqual(1)
    })

    it('fires on a wildcard transition', async () => {
      const ctx = await withWorkflow([
        { name: 'Plan', from: ['Backlog'], to: 'Todo' },
        { name: 'Finish', from: null, to: 'Done', postFunctions: [updateField('estimation', constant(9))] }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog' })
      await setStatus(ctx, issue, 'Todo')
      await setStatus(ctx, issue, 'Done')
      await expectField(issue, 'estimation', 9)
    })

    it('copies a value from the task itself', async () => {
      const ctx = await withWorkflow([
        {
          name: 'Start',
          from: ['Backlog'],
          to: 'Todo',
          postFunctions: [updateField('remainingTime', thisField('estimation'))]
        }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog', estimation: 12 })
      await setStatus(ctx, issue, 'Todo')
      await expectField(issue, 'remainingTime', 12)
    })

    it('copies a value from the parent task', async () => {
      const ctx = await withWorkflow([
        {
          name: 'Start',
          from: ['Backlog'],
          to: 'Todo',
          postFunctions: [updateField('estimation', parentField('estimation'))]
        }
      ])
      const parent = await createIssue(ctx, { status: 'Backlog', estimation: 21 })
      const child = await createIssue(ctx, { status: 'Backlog', parent })
      await setStatus(ctx, child, 'Todo')
      await expectField(child, 'estimation', 21)
    })

    it('leaves the field alone when the parent value is missing', async () => {
      const ctx = await withWorkflow([
        {
          name: 'Start',
          from: ['Backlog'],
          to: 'Todo',
          postFunctions: [updateField('title', parentField('title'))]
        }
      ])
      const orphan = await createIssue(ctx, { status: 'Backlog', title: 'Orphan' })
      await setStatus(ctx, orphan, 'Todo')
      await new Promise((resolve) => setTimeout(resolve, 1500))
      expect(await readField(orphan, 'title')).toEqual('Orphan')
    })

    it('writes the current time from a preset', async () => {
      const ctx = await withWorkflow([
        {
          name: 'Start',
          from: ['Backlog'],
          to: 'Todo',
          postFunctions: [updateField('dueDate', { type: 'preset', preset: '$now' })]
        }
      ])
      const before = Date.now()
      const issue = await createIssue(ctx, { status: 'Backlog' })
      await setStatus(ctx, issue, 'Todo')
      const dueDate = await eventually(async () => {
        return (await readField(issue, 'dueDate')) ?? undefined
      })
      expect(dueDate).toBeGreaterThanOrEqual(before)
    })

    it('writes the acting user from a preset', async () => {
      const ctx = await withWorkflow([
        {
          name: 'Start',
          from: ['Backlog'],
          to: 'Todo',
          postFunctions: [updateField('assignee', { type: 'preset', preset: '$currentUser' })]
        }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog' })
      await setStatus(ctx, issue, 'Todo')
      const assignee = await eventually(async () => {
        return (await readField(issue, 'assignee')) ?? undefined
      })
      expect(assignee).toBeTruthy()
    })

    it.each([
      [workflow.function.Add, 5, 10, 15],
      [workflow.function.Subtract, 5, 10, 5],
      [workflow.function.Multiply, 3, 10, 30],
      [workflow.function.Divide, 2, 10, 5],
      [workflow.function.Modulo, 4, 10, 2],
      [workflow.function.Power, 2, 3, 9],
      [workflow.function.Min, 4, 10, 4],
      [workflow.function.Max, 4, 10, 10]
    ])('applies the numeric transform %s', async (func, operand, start, expected) => {
      const ctx = await withWorkflow([
        {
          name: 'Start',
          from: ['Backlog'],
          to: 'Todo',
          postFunctions: [
            updateField('estimation', thisField('estimation', [{ func: func as any, props: { value: operand } }]))
          ]
        }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog', estimation: start })
      await setStatus(ctx, issue, 'Todo')
      await expectField(issue, 'estimation', expected)
    })

    it.each([
      [workflow.function.Round, 2.4, 2],
      [workflow.function.Ceil, 2.1, 3],
      [workflow.function.Floor, 2.9, 2],
      [workflow.function.Absolute, -5, 5],
      [workflow.function.Sqrt, 9, 3]
    ])('applies the unary numeric transform %s', async (func, start, expected) => {
      const ctx = await withWorkflow([
        {
          name: 'Start',
          from: ['Backlog'],
          to: 'Todo',
          postFunctions: [updateField('estimation', constant(start, [{ func: func as any }]))]
        }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog' })
      await setStatus(ctx, issue, 'Todo')
      await expectField(issue, 'estimation', expected)
    })

    it.each([
      [workflow.function.UpperCase, {}, 'hello', 'HELLO'],
      [workflow.function.LowerCase, {}, 'HELLO', 'hello'],
      [workflow.function.Trim, {}, '  hi  ', 'hi'],
      [workflow.function.Prepend, { value: '>> ' }, 'note', '>> note'],
      [workflow.function.Append, { value: ' !' }, 'note', 'note !'],
      [workflow.function.Replace, { search: 'a', replacement: 'b' }, 'aaa', 'baa'],
      [workflow.function.ReplaceAll, { search: 'a', replacement: 'b' }, 'aaa', 'bbb'],
      [workflow.function.Cut, { start: 1, length: 3 }, 'abcdef', 'bcd']
    ])('applies the string transform %s', async (func, props, start, expected) => {
      const ctx = await withWorkflow([
        {
          name: 'Start',
          from: ['Backlog'],
          to: 'Todo',
          postFunctions: [updateField('title', constant(start, [{ func: func as any, props: props as any }]))]
        }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog' })
      await setStatus(ctx, issue, 'Todo')
      await expectField(issue, 'title', expected)
    })

    it('chains two transforms', async () => {
      const ctx = await withWorkflow([
        {
          name: 'Start',
          from: ['Backlog'],
          to: 'Todo',
          postFunctions: [
            updateField(
              'estimation',
              thisField('estimation', [
                { func: workflow.function.Add as any, props: { value: 10 } },
                { func: workflow.function.Multiply as any, props: { value: 2 } }
              ])
            )
          ]
        }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog', estimation: 5 })
      await setStatus(ctx, issue, 'Todo')
      await expectField(issue, 'estimation', 30)
    })

    it('chains a string transform onto a copied field', async () => {
      const ctx = await withWorkflow([
        {
          name: 'Start',
          from: ['Backlog'],
          to: 'Todo',
          postFunctions: [
            updateField(
              'title',
              thisField('title', [{ func: workflow.function.Append as any, props: { value: ' [done]' } }])
            )
          ]
        }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog', title: 'Task' })
      await setStatus(ctx, issue, 'Todo')
      await expectField(issue, 'title', 'Task [done]')
    })

    it('runs again on every matching transition', async () => {
      const ctx = await withWorkflow([
        {
          name: 'Bump',
          from: ['Backlog'],
          to: 'Todo',
          postFunctions: [
            updateField(
              'estimation',
              thisField('estimation', [{ func: workflow.function.Add as any, props: { value: 1 } }])
            )
          ]
        },
        {
          name: 'Bump back',
          from: ['Todo'],
          to: 'Backlog',
          postFunctions: [
            updateField(
              'estimation',
              thisField('estimation', [{ func: workflow.function.Add as any, props: { value: 1 } }])
            )
          ]
        }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog', estimation: 0 })
      await setStatus(ctx, issue, 'Todo')
      await expectField(issue, 'estimation', 1)
      await setStatus(ctx, issue, 'Backlog')
      await expectField(issue, 'estimation', 2)
    })

    it('does nothing when the field list is empty', async () => {
      const ctx = await withWorkflow([
        {
          name: 'Start',
          from: ['Backlog'],
          to: 'Todo',
          postFunctions: [
            {
              rule: workflow.postFunction.UpdateFieldValue,
              ruleClass: workflow.class.WorkflowPostFunction,
              props: { fields: [] }
            }
          ]
        }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog', estimation: 4 })
      await setStatus(ctx, issue, 'Todo')
      await new Promise((resolve) => setTimeout(resolve, 1500))
      expect(await readField(issue, 'estimation')).toEqual(4)
    })
  })

  describe('clear field value', () => {
    it('clears a number field', async () => {
      const ctx = await withWorkflow([
        { name: 'Start', from: ['Backlog'], to: 'Todo', postFunctions: [clearFields('estimation')] }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog', estimation: 8 })
      await setStatus(ctx, issue, 'Todo')
      await eventually(async () => {
        const value = await readField(issue, 'estimation')
        return value === undefined ? true : undefined
      })
      expect(await readField(issue, 'estimation')).toBeUndefined()
    })

    it('clears a date field', async () => {
      const ctx = await withWorkflow([
        { name: 'Start', from: ['Backlog'], to: 'Todo', postFunctions: [clearFields('dueDate')] }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog', dueDate: Date.now() })
      await setStatus(ctx, issue, 'Todo')
      await eventually(async () => {
        const value = await readField(issue, 'dueDate')
        return value === undefined ? true : undefined
      })
      expect(await readField(issue, 'dueDate')).toBeUndefined()
    })

    it('clears several fields at once', async () => {
      const ctx = await withWorkflow([
        { name: 'Start', from: ['Backlog'], to: 'Todo', postFunctions: [clearFields('estimation', 'dueDate')] }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog', estimation: 8, dueDate: Date.now() })
      await setStatus(ctx, issue, 'Todo')
      await eventually(async () => {
        const estimation = await readField(issue, 'estimation')
        const dueDate = await readField(issue, 'dueDate')
        return estimation === undefined && dueDate === undefined ? true : undefined
      })
    })

    it('is a no-op on an already empty field', async () => {
      const ctx = await withWorkflow([
        { name: 'Start', from: ['Backlog'], to: 'Todo', postFunctions: [clearFields('dueDate')] }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog', title: 'Kept' })
      await setStatus(ctx, issue, 'Todo')
      await new Promise((resolve) => setTimeout(resolve, 1500))
      expect(await readField(issue, 'title')).toEqual('Kept')
    })

    it('fires only on its own transition', async () => {
      const ctx = await withWorkflow([
        { name: 'Start', from: ['Backlog'], to: 'Todo', postFunctions: [clearFields('estimation')] },
        { name: 'Park', from: ['Backlog'], to: 'InProgress' }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog', estimation: 8 })
      await setStatus(ctx, issue, 'InProgress')
      await new Promise((resolve) => setTimeout(resolve, 1500))
      expect(await readField(issue, 'estimation')).toEqual(8)
    })

    it('does nothing when the field list is empty', async () => {
      const ctx = await withWorkflow([{ name: 'Start', from: ['Backlog'], to: 'Todo', postFunctions: [clearFields()] }])
      const issue = await createIssue(ctx, { status: 'Backlog', estimation: 8 })
      await setStatus(ctx, issue, 'Todo')
      await new Promise((resolve) => setTimeout(resolve, 1500))
      expect(await readField(issue, 'estimation')).toEqual(8)
    })

    it('combines with an update rule on the same transition', async () => {
      const ctx = await withWorkflow([
        {
          name: 'Start',
          from: ['Backlog'],
          to: 'Todo',
          postFunctions: [clearFields('dueDate'), updateField('estimation', constant(6))]
        }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog', dueDate: Date.now(), estimation: 1 })
      await setStatus(ctx, issue, 'Todo')
      await expectField(issue, 'estimation', 6)
      await eventually(async () => {
        const value = await readField(issue, 'dueDate')
        return value === undefined ? true : undefined
      })
    })

    it('clears a field that a previous transition had set', async () => {
      const ctx = await withWorkflow([
        { name: 'Set', from: ['Backlog'], to: 'Todo', postFunctions: [updateField('estimation', constant(11))] },
        { name: 'Clear', from: ['Todo'], to: 'Done', postFunctions: [clearFields('estimation')] }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog' })
      await setStatus(ctx, issue, 'Todo')
      await expectField(issue, 'estimation', 11)
      await setStatus(ctx, issue, 'Done')
      await eventually(async () => {
        const value = await readField(issue, 'estimation')
        return value === undefined ? true : undefined
      })
    })
  })

  describe('interaction with validators', () => {
    it('does not run when the transition is rejected', async () => {
      const ctx = await withWorkflow([
        {
          name: 'Start',
          from: ['Backlog'],
          to: 'Todo',
          validators: [
            {
              rule: workflow.validator.FieldRequired,
              ruleClass: workflow.class.WorkflowValidator,
              props: { fields: [field('dueDate')] }
            }
          ],
          postFunctions: [updateField('estimation', constant(42))]
        }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog', estimation: 1 })
      await expect(setStatus(ctx, issue, 'Todo')).rejects.toBeDefined()
      await new Promise((resolve) => setTimeout(resolve, 1500))
      expect(await readField(issue, 'estimation')).toEqual(1)
    })

    it('runs once the validator is satisfied', async () => {
      const ctx = await withWorkflow([
        {
          name: 'Start',
          from: ['Backlog'],
          to: 'Todo',
          validators: [
            {
              rule: workflow.validator.FieldRequired,
              ruleClass: workflow.class.WorkflowValidator,
              props: { fields: [field('dueDate')] }
            }
          ],
          postFunctions: [updateField('estimation', constant(42))]
        }
      ])
      const issue = await createIssue(ctx, { status: 'Backlog', dueDate: Date.now(), estimation: 1 })
      await setStatus(ctx, issue, 'Todo')
      await expectField(issue, 'estimation', 42)
    })
  })
})
