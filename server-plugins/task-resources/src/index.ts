//
// Copyright © 2022 Hardcore Engineering Inc.
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

import core, { Doc, Tx, TxCUD, TxCreateDoc, TxProcessor, TxRemoveDoc, TxUpdateDoc } from '@hcengineering/core'
import { getEmbeddedLabel } from '@hcengineering/platform'
import { TriggerControl } from '@hcengineering/server-core'
import task, { Task, TaskType } from '@hcengineering/task'

/**
 * @public
 */
export async function OnStateUpdate (txes: TxCUD<Doc>[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []
  for (const actualTx of txes) {
    if (!control.hierarchy.isDerived(actualTx.objectClass, task.class.Task)) continue
    if (actualTx._class === core.class.TxCreateDoc) {
      const doc = TxProcessor.createDoc2Doc(actualTx as TxCreateDoc<Task>)
      const status = control.modelDb.findAllSync(core.class.Status, { _id: doc.status })[0]
      if (status?.category === task.statusCategory.Lost || status?.category === task.statusCategory.Won) {
        result.push(control.txFactory.createTxUpdateDoc(doc._class, doc.space, doc._id, { isDone: true }))
      }
    } else if (actualTx._class === core.class.TxUpdateDoc) {
      const updateTx = actualTx as TxUpdateDoc<Task>
      if (updateTx.operations.status !== undefined) {
        const status = control.modelDb.findAllSync(core.class.Status, { _id: updateTx.operations.status })[0]
        if (status?.category === task.statusCategory.Lost || status?.category === task.statusCategory.Won) {
          result.push(
            control.txFactory.createTxUpdateDoc(updateTx.objectClass, updateTx.objectSpace, updateTx.objectId, {
              isDone: true
            })
          )
        } else {
          result.push(
            control.txFactory.createTxUpdateDoc(updateTx.objectClass, updateTx.objectSpace, updateTx.objectId, {
              isDone: false
            })
          )
        }
      }
    }
  }
  return result
}

/**
 * @public
 */
export async function OnTaskTypeUpdate (txes: TxUpdateDoc<TaskType>[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []
  for (const updateTx of txes) {
    if (updateTx.operations.icon == null && updateTx.operations.color == null && updateTx.operations.name == null) {
      continue
    }

    const taskType = control.modelDb.findAllSync<TaskType>(task.class.TaskType, { _id: updateTx.objectId })[0]
    if (taskType?.targetClass != null) {
      result.push(
        control.txFactory.createTxUpdateDoc(core.class.Class, core.space.Model, taskType.targetClass, {
          ...(updateTx.operations.icon == null ? {} : { icon: updateTx.operations.icon }),
          ...(updateTx.operations.color == null ? {} : { color: updateTx.operations.color }),
          ...(updateTx.operations.name == null ? {} : { label: getEmbeddedLabel(updateTx.operations.name) })
        })
      )
    }
  }
  return result
}

/**
 * @public
 */
export async function OnTaskTypeRemove (txes: TxRemoveDoc<TaskType>[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []
  for (const tx of txes) {
    const taskType = control.removedMap.get(tx.objectId) as TaskType | undefined
    if (taskType?.targetClass != null && taskType.targetClass !== taskType.ofClass) {
      result.push(control.txFactory.createTxRemoveDoc(core.class.Class, core.space.Model, taskType.targetClass))
      const attributes = control.modelDb.findAllSync(core.class.Attribute, {
        attributeOf: taskType.targetClass
      })
      for (const attribute of attributes) {
        result.push(control.txFactory.createTxRemoveDoc(attribute._class, attribute.space, attribute._id))
      }
    }
  }
  return result
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export default async () => ({
  trigger: {
    OnStateUpdate,
    OnTaskTypeUpdate,
    OnTaskTypeRemove
  }
})
