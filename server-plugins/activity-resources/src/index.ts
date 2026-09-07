//
// Copyright © 2023 Hardcore Engineering Inc.
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

import activity, { type ActivityMessage, type DocUpdateMessage } from '@hcengineering/activity'
import core, {
  type Class,
  type Doc,
  type DocumentUpdate,
  type Ref,
  type Tx,
  type TxCUD,
  type TxUpdateDoc
} from '@hcengineering/core'
import type { TriggerControl } from '@hcengineering/server-core'

import { ReferenceTrigger } from './references'

async function OnDocRemoved (txes: TxCUD<Doc>[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []
  for (const tx of txes) {
    if (tx._class !== core.class.TxRemoveDoc) continue

    const activityDocMixin = control.hierarchy.classHierarchyMixin(tx.objectClass, activity.mixin.ActivityDoc)
    if (activityDocMixin === undefined) continue

    const messages = await control.findAll(
      control.ctx,
      activity.class.ActivityMessage,
      { attachedTo: tx.objectId },
      { projection: { _id: 1, _class: 1, space: 1 } }
    )

    result.push(
      ...messages.map((message) => control.txFactory.createTxRemoveDoc(message._class, message.space, message._id))
    )
  }
  return result
}

export async function OnDocClassChanged (txes: TxCUD<Doc>[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []

  for (const tx of txes) {
    if (tx._class !== core.class.TxUpdateDoc) continue

    const objectClass = ((tx as TxUpdateDoc<Doc>).operations as any)._class as Ref<Class<Doc>> | undefined
    if (objectClass == null || objectClass === tx.objectClass) continue

    const messages = await control.findAll(control.ctx, activity.class.ActivityMessage, {
      attachedTo: tx.objectId
    })
    for (const message of messages) {
      const ops: DocumentUpdate<ActivityMessage> = {}
      if (message.attachedToClass !== objectClass) {
        ops.attachedToClass = objectClass
      }
      // DocUpdateMessage keeps its own copy of the class it describes.
      const own = (message as DocUpdateMessage).objectClass
      if (own != null && own !== objectClass) {
        ;(ops as DocumentUpdate<DocUpdateMessage>).objectClass = objectClass
      }
      if (Object.keys(ops).length === 0) continue
      result.push(control.txFactory.createTxUpdateDoc(message._class, message.space, message._id, ops))
    }
  }

  return result
}

export * from './references'
export { getDocTitle, getDocUrl, getDocIdentifier, isActivityDoc } from './utils'

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export default async () => ({
  trigger: {
    ReferenceTrigger,
    OnDocRemoved,
    OnDocClassChanged
  }
})
