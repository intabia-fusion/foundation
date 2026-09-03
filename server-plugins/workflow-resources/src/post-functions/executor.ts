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

import core, { type Tx, TxProcessor, type TxUpdateDoc, type TxMixin, type TxCUD } from '@hcengineering/core'
import { type TriggerControl } from '@hcengineering/server-core'
import { getResource } from '@hcengineering/platform'
import { type Task } from '@hcengineering/task'
import workflow from '@hcengineering/model-workflow'
import serverWorkflow, { type PostFunctionImpl } from '@hcengineering/server-workflow'
import {
  type WorkflowPostFunction,
  type WorkflowTransition,
  type WorkflowPostFunctionConfig
} from '@hcengineering/workflow'

export async function executeTransitionPostFunctions (
  control: TriggerControl,
  transition: WorkflowTransition,
  task: Task
): Promise<Tx[]> {
  const postFunctions = transition.postFunctions
  if (postFunctions == null || postFunctions.length === 0) return []

  const resultTxes: Tx[] = []
  for (const pfConfig of postFunctions) {
    try {
      const txes = await executePostFunction(control, pfConfig, transition, task, resultTxes)
      if (txes.length > 0) {
        resultTxes.push(...txes)
        for (const tx of txes) {
          applyTxToTask(task, tx)
        }
      }
    } catch (err) {
      control.ctx.error('[WorkflowPostFunctions] Error executing post-function', {
        pfId: pfConfig.id ?? (pfConfig.rule as string),
        error: err
      })
    }
  }
  return resultTxes
}

function applyTxToTask (task: Task, tx: Tx): void {
  if (!TxProcessor.isExtendsCUD(tx._class)) return
  if ((tx as TxCUD<Task>).objectId !== task._id) return

  if (tx._class === core.class.TxUpdateDoc) {
    TxProcessor.updateDoc2Doc(task, tx as TxUpdateDoc<Task>)
  } else if (tx._class === core.class.TxMixin) {
    TxProcessor.updateMixin4Doc(task, tx as TxMixin<Task, Task>)
  }
}

async function executePostFunction (
  control: TriggerControl,
  pfConfig: WorkflowPostFunctionConfig,
  transition: WorkflowTransition,
  task: Task,
  currentTxes: Tx[] = []
): Promise<Tx[]> {
  if (pfConfig?.rule == null) return []

  const postFunction = (
    await control.findAll(control.ctx, workflow.class.WorkflowPostFunction, { _id: pfConfig.rule }, { limit: 1 })
  )[0]

  if (postFunction == null) return []

  if (!control.hierarchy.hasMixin(postFunction, serverWorkflow.mixin.PostFunctionImpl)) {
    return []
  }

  const pfImpl = control.hierarchy.as<WorkflowPostFunction, PostFunctionImpl>(
    postFunction,
    serverWorkflow.mixin.PostFunctionImpl
  )
  if (pfImpl.serverExecutor == null) return []

  const executorFn = await getResource(pfImpl.serverExecutor)
  if (executorFn == null) return []

  return (await (executorFn as any)(control, task, transition, pfConfig.props, currentTxes)) ?? []
}
