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

import { type Ref, type Status, type Tx, type TxRemoveDoc, type TxUpdateDoc } from '@hcengineering/core'
import { type TriggerControl } from '@hcengineering/server-core'
import { type TaskType, type Project } from '@hcengineering/task'
import workflow from '@hcengineering/model-workflow'
import { type ProjectWorkflow, type Workflow } from '@hcengineering/workflow'

export async function OnWorkflowDelete (txes: TxRemoveDoc<Workflow>[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []
  const removedWorkflowIds = new Set<Ref<Workflow>>(txes.map((it) => it.objectId))

  if (removedWorkflowIds.size === 0) return result

  const projects = await control.findAll(control.ctx, workflow.mixin.ProjectWorkflow, {})

  for (const project of projects) {
    if (project.workflows == null) continue

    const updatedWorkflows: Record<Ref<TaskType>, Ref<Workflow>> = {}
    let modified = false

    for (const [taskType, wfId] of Object.entries(project.workflows)) {
      if (wfId != null && removedWorkflowIds.has(wfId)) {
        modified = true
      } else if (wfId != null) {
        updatedWorkflows[taskType as Ref<TaskType>] = wfId
      }
    }

    if (modified) {
      result.push(
        control.txFactory.createTxMixin<Project, ProjectWorkflow>(
          project._id as Ref<Project>,
          project._class,
          project.space,
          workflow.mixin.ProjectWorkflow,
          { workflows: updatedWorkflows }
        )
      )
    }
  }

  control.ctx?.info?.('[OnWorkflowDelete] Finished processing', { resultCount: result.length })
  return result
}

export async function OnTaskTypeDelete (txes: TxRemoveDoc<TaskType>[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []
  const removedTaskTypeIds = txes.map((it) => it.objectId)
  if (removedTaskTypeIds.length === 0) return result

  const workflows = await control.findAll(control.ctx, workflow.class.Workflow, {
    taskType: { $in: removedTaskTypeIds }
  })

  for (const wf of workflows) {
    result.push(control.txFactory.createTxRemoveDoc(workflow.class.Workflow, wf.space, wf._id))
  }

  return result
}

export async function OnStatusDelete (txes: TxRemoveDoc<Status>[], control: TriggerControl): Promise<Tx[]> {
  console.log('ON STATUS DELETED', txes)
  const result: Tx[] = []
  const removedStatusIds = new Set<Ref<Status>>(txes.map((it) => it.objectId))

  if (removedStatusIds.size === 0) return result

  const transitions = await control.findAll(control.ctx, workflow.class.WorkflowTransition, {})

  for (const t of transitions) {
    const isToDeleted = removedStatusIds.has(t.to)
    const isFromContainsDeleted = Array.isArray(t.from) && t.from.some((id) => removedStatusIds.has(id))

    if (isToDeleted) {
      result.push(control.txFactory.createTxRemoveDoc(workflow.class.WorkflowTransition, t.space, t._id))
    } else if (isFromContainsDeleted) {
      const remainingFrom = (t.from ?? []).filter((id) => !removedStatusIds.has(id))
      if (remainingFrom.length > 0) {
        result.push(
          control.txFactory.createTxUpdateDoc(workflow.class.WorkflowTransition, t.space, t._id, {
            from: remainingFrom
          })
        )
      } else {
        result.push(control.txFactory.createTxRemoveDoc(workflow.class.WorkflowTransition, t.space, t._id))
      }
    }
  }

  const workflows = await control.findAll(control.ctx, workflow.class.Workflow, {})
  for (const wf of workflows) {
    if (Array.isArray(wf.initialStatuses) && wf.initialStatuses.some((id) => removedStatusIds.has(id))) {
      const remainingInitials = wf.initialStatuses.filter((id) => !removedStatusIds.has(id))
      result.push(
        control.txFactory.createTxUpdateDoc(workflow.class.Workflow, wf.space, wf._id, {
          initialStatuses: remainingInitials.length === 0 ? undefined : remainingInitials
        })
      )
    }
  }

  return result
}

export function getNewStatusesFromTx (updateTx: TxUpdateDoc<TaskType>): Ref<Status>[] | undefined {
  const ops = updateTx.operations
  if (Array.isArray(ops.statuses)) return ops.statuses
  return undefined
}

export async function OnTaskTypeUpdate (txes: TxUpdateDoc<TaskType>[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []

  for (const updateTx of txes) {
    const newStatuses = getNewStatusesFromTx(updateTx)
    if (newStatuses == null) continue

    const taskTypeId = updateTx.objectId

    const workflows = await control.findAll(control.ctx, workflow.class.Workflow, {
      taskType: taskTypeId
    })
    const workflowIds = workflows.map((wf) => wf._id)
    const transitions = await control.findAll(control.ctx, workflow.class.WorkflowTransition, {
      attachedTo: { $in: workflowIds }
    })
    for (const wf of workflows) {
      const newInitialStatuses = (wf.initialStatuses ?? []).filter((it) => newStatuses.includes(it))
      if (newInitialStatuses.length !== (wf.initialStatuses?.length ?? 0)) {
        result.push(
          control.txFactory.createTxUpdateDoc(workflow.class.Workflow, wf.space, wf._id, {
            initialStatuses: newInitialStatuses.length === 0 ? undefined : newInitialStatuses
          })
        )
      }
    }

    for (const t of transitions) {
      const isToDeleted = !newStatuses.includes(t.to)

      if (isToDeleted) {
        result.push(control.txFactory.createTxRemoveDoc(workflow.class.WorkflowTransition, t.space, t._id))
      } else if (Array.isArray(t.from) && t.from.length > 0) {
        const remainingFrom = t.from.filter((id) => newStatuses.includes(id))
        const isChanged = remainingFrom.length !== t.from.length
        if (remainingFrom.length > 0 && isChanged) {
          result.push(
            control.txFactory.createTxUpdateDoc(workflow.class.WorkflowTransition, t.space, t._id, {
              from: remainingFrom
            })
          )
        } else if (remainingFrom.length === 0) {
          result.push(control.txFactory.createTxRemoveDoc(workflow.class.WorkflowTransition, t.space, t._id))
        }
      }
    }
  }

  control.ctx?.info?.('[OnTaskTypeUpdate] Finished processing', { resultCount: result.length })
  return result
}
