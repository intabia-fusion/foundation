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

import core, {
  type Class,
  type Client,
  type Doc,
  type DocumentQuery,
  type Hierarchy,
  type PersonId,
  type Ref,
  type Tx,
  type TxResult,
  TxOperations,
  toFindResult
} from '@hcengineering/core'
import { type ProjectType, type TaskType } from '@hcengineering/task'
import { createIssue } from '../ops'
import { type Project } from '..'

const user = 'test-user' as PersonId
const projectTypeId = 'task:projectType:Test' as Ref<ProjectType>

function makeProject (): Project {
  return {
    type: projectTypeId,
    identifier: 'TST',
    sequence: 0,
    defaultIssueStatus: 'tracker:status:Todo' as any
  } as unknown as Project
}

function makeTaskType (id: string, overrides: Partial<TaskType> = {}): TaskType {
  return {
    _id: id as Ref<TaskType>,
    parent: projectTypeId,
    targetClass: 'tracker:class:Issue' as Ref<Class<Doc>>,
    statuses: ['tracker:status:Todo' as any],
    isRootTaskType: true,
    ...overrides
  } as unknown as TaskType
}

// Minimal Client stub: only the calls createIssue/resolveTaskType actually make.
// Captures the `kind` written on the created issue's TxCreateDoc for assertions.
function makeClient (taskTypes: TaskType[]): { client: TxOperations, capturedKind: () => unknown } {
  let capturedKind: unknown
  const hierarchy = { hasClass: () => true } as unknown as Hierarchy
  const client: Client = {
    getHierarchy: () => hierarchy,
    getModel: () => undefined as any,
    close: async () => {},
    findAll: async <T extends Doc>(_class: Ref<Class<T>>, query: DocumentQuery<T>) => {
      if (_class === ('task:class:TaskType' as Ref<Class<T>>)) {
        const parent = (query as any).parent
        return toFindResult(taskTypes.filter((t) => t.parent === parent) as unknown as T[], taskTypes.length)
      }
      return toFindResult([], 0)
    },
    findOne: async () => undefined,
    tx: async (tx: Tx): Promise<TxResult> => {
      if (tx._class === core.class.TxCreateDoc) {
        capturedKind = (tx as any).attributes.kind
      }
      if (tx._class === core.class.TxUpdateDoc) {
        return { object: { sequence: 1 } }
      }
      return {}
    },
    domainRequest: async () => ({ domain: '' as any, value: null as any }),
    searchFulltext: async () => ({ docs: [] })
  }
  return { client: new TxOperations(client, user), capturedKind: () => capturedKind }
}

describe('createIssue task type resolution', () => {
  it('resolves the task type by TaskType.parent === project.type, not ProjectType.tasks', async () => {
    // No ProjectType is queried at all any more - only a TaskType whose parent matches the project.
    const taskType = makeTaskType('tracker:taskTypes:Issue')
    const { client, capturedKind } = makeClient([taskType])

    const result = await createIssue(client, makeProject(), { title: 'Hello' })
    expect(result.identifier).toBe('TST-1')
    expect(capturedKind()).toBe(taskType._id)
  })

  it('prefers a root task type over a non-root one for the same project', async () => {
    const child = makeTaskType('tracker:taskTypes:Sub', { isRootTaskType: false })
    const root = makeTaskType('tracker:taskTypes:Root', { isRootTaskType: true })
    const { client, capturedKind } = makeClient([child, root])

    await createIssue(client, makeProject(), { title: 'Hello' })
    expect(capturedKind()).toBe(root._id)
  })

  it('fails fast with a clear error instead of writing an empty kind when the project has no task type', async () => {
    const { client } = makeClient([])

    await expect(createIssue(client, makeProject(), { title: 'Hello' })).rejects.toThrow(/task type/i)
  })
})
