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
  type MeasureContext,
  type Tx,
  type TxCreateDoc,
  type TxCUD,
  TxProcessor,
  type TxUpdateDoc
} from '@hcengineering/core'
import platform, { PlatformError, Severity, Status } from '@hcengineering/platform'
import {
  BaseMiddleware,
  type Middleware,
  type PipelineContext,
  type TxMiddlewareResult
} from '@hcengineering/server-core'
import task, { type Task, type TaskType } from '@hcengineering/task'

/**
 * @public
 */
export class TaskMiddleware extends BaseMiddleware {
  static async create (ctx: MeasureContext, context: PipelineContext, next?: Middleware): Promise<Middleware> {
    return new TaskMiddleware(context, next)
  }

  async tx (ctx: MeasureContext, txes: Tx[]): Promise<TxMiddlewareResult> {
    for (const _tx of txes) {
      if (!TxProcessor.isExtendsCUD(_tx._class)) continue
      const tx = _tx as TxCUD<Doc>
      if (tx._class === core.class.TxCreateDoc && this.context.hierarchy.isDerived(tx.objectClass, task.class.Task)) {
        const createTx = tx as TxCreateDoc<Task>
        const kind = createTx.attributes.kind
        if (kind != null) {
          const taskType = this.context.modelDb.findAllSync<TaskType>(task.class.TaskType, { _id: kind })[0]
          if (taskType == null) {
            throw new PlatformError(
              new Status(Severity.ERROR, platform.status.BadRequest, {
                message: `TaskType '${kind}' not found`
              })
            )
          }
          if (!this.context.hierarchy.isDerived(tx.objectClass, taskType.targetClass)) {
            createTx.objectClass = taskType.targetClass
          }
        }
      } else if (
        tx._class === core.class.TxUpdateDoc &&
        this.context.hierarchy.isDerived(tx.objectClass, task.class.Task)
      ) {
        const updateTx = tx as TxUpdateDoc<Task>
        const newKind = updateTx.operations.kind
        if (newKind != null) {
          const taskType = this.context.modelDb.findAllSync<TaskType>(task.class.TaskType, { _id: newKind })[0]
          if (taskType == null) {
            throw new PlatformError(
              new Status(Severity.ERROR, platform.status.BadRequest, {
                message: `TaskType '${newKind}' not found`
              })
            )
          }
          ;(updateTx.operations as any)._class = taskType.targetClass
        }
      }
    }
    return await this.provideTx(ctx, txes)
  }
}
