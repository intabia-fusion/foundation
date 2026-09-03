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
  type Doc,
  type Tx,
  type TxUpdateDoc,
  type Ref,
  type TxCUD,
  type Status,
  Hierarchy
} from '@hcengineering/core'
import { type TriggerControl } from '@hcengineering/server-core'
import task, { Project, type Task, type TaskType } from '@hcengineering/task'
import workflow from '@hcengineering/model-workflow'
import { type ProjectWorkflow, type Workflow } from '@hcengineering/workflow'

import { executeTransitionPostFunctions } from './post-functions'

export async function PostFunctionsTrigger (txes: TxCUD<Doc>[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []
  for (const tx of txes) {
    if (!control.hierarchy.isDerived(tx.objectClass, task.class.Task)) {
      continue
    }

    if (tx._class === core.class.TxUpdateDoc) {
      // Only the updates that produced post-functions are worth a line; that log is below.
      const postTxes = await processTaskPostFunctions(tx as TxUpdateDoc<Task>, control)
      if (postTxes != null && postTxes.length > 0) {
        result.push(...postTxes)
      }
    }
  }
  return result
}

async function processTaskPostFunctions (updateTx: TxUpdateDoc<Task>, control: TriggerControl): Promise<Tx[]> {
  const toStatus = updateTx.operations.status
  if (toStatus == null) {
    return [] // not a status change - nothing for this trigger to do
  }

  const fromStatus: Ref<Status> | undefined = updateTx.meta?.fromStatus as Ref<Status> | undefined

  if (fromStatus == null) return []
  if (fromStatus === toStatus) return []

  const taskDoc = (await control.findAll(control.ctx, task.class.Task, { _id: updateTx.objectId }, { limit: 1 }))[0]
  if (taskDoc == null) return []

  const project = (
    await control.findAll(control.ctx, task.class.Project, { _id: taskDoc.space as Ref<Project> }, { limit: 1 })
  )[0]
  if (project == null) return []

  const workflowRef = findWorkflowForTaskType(control.hierarchy, project, taskDoc.kind)
  if (workflowRef == null) return []

  const transitions = await control.findAll(control.ctx, workflow.class.WorkflowTransition, {
    attachedTo: workflowRef
  })

  const allowedTransitions = transitions.filter((t) => {
    return (t.from == null || t.from.length === 0 || t.from.includes(fromStatus)) && t.to === toStatus
  })
  if (allowedTransitions.length === 0) return []

  const transition =
    allowedTransitions.find((t) => t.from != null && t.from.includes(fromStatus)) ??
    allowedTransitions.find((t) => t.from == null || t.from.length === 0)

  if (transition === undefined) return []

  return await executeTransitionPostFunctions(control, transition, taskDoc)
}

function findWorkflowForTaskType (
  h: Hierarchy,
  project: Project,
  taskTypeRef: Ref<TaskType>
): Ref<Workflow> | undefined {
  if (!h.hasMixin(project, workflow.mixin.ProjectWorkflow)) return undefined
  const projectWorkflow = h.as<Project, ProjectWorkflow>(project, workflow.mixin.ProjectWorkflow)
  return projectWorkflow.workflows?.[taskTypeRef]
}

export { FieldRequired, SubtaskStatus, ParentStatus } from '@hcengineering/workflow'
