//
// Copyright © 2020, 2021 Anticrm Platform Contributors.
// Copyright © 2021, 2022 Hardcore Engineering Inc.
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

import activity, { ActivityMessage } from '@hcengineering/activity'
import contact, { Employee, type Person } from '@hcengineering/contact'
import core, {
  AccountUuid,
  AnyAttribute,
  type Class,
  Collaborator,
  Doc,
  getClassCollaborators,
  Ref,
  SortingOrder,
  Space,
  Tx,
  TxCreateDoc,
  TxCUD,
  TxMixin,
  TxProcessor,
  TxRemoveDoc,
  TxUpdateDoc
} from '@hcengineering/core'
import notification, { DocNotifyContext } from '@hcengineering/notification'
import { type TriggerControl } from '@hcengineering/server-core'
import { isActivityDoc } from '@hcengineering/server-activity-resources'

import { PushNotificationsHandler } from './push'
import {
  generateAttributeNotificationType,
  getClassNotificationGroup,
  IsUserFieldValueTypeMatch,
  MeAddedInCollaboratorsNotificationTypeMatch,
  MeRemovedFromCollaboratorsNotificationTypeMatch
} from './utils'

async function removeContexts (
  control: TriggerControl,
  contexts: DocNotifyContext[],
  unsubscribe: AccountUuid[]
): Promise<Tx[]> {
  if (contexts.length === 0) return []
  if (unsubscribe.length === 0) return []

  const res: Tx[] = []

  for (const context of contexts) {
    if (!unsubscribe.includes(context.user)) {
      continue
    }

    const removeTx = control.txFactory.createTxRemoveDoc(context._class, context.space, context._id)

    res.push(removeTx)
  }

  return res
}

async function removeContextNotifications (control: TriggerControl, contextId: Ref<DocNotifyContext>[]): Promise<Tx[]> {
  const inboxNotifications = await control.findAll(
    control.ctx,
    notification.class.InboxNotification,
    {
      docNotifyContext: { $in: contextId }
    },
    {
      projection: {
        _id: 1,
        _class: 1,
        space: 1
      }
    }
  )

  return inboxNotifications.map((it) => control.txFactory.createTxRemoveDoc(it._class, it.space, it._id))
}
async function removeCollaboratorDoc (tx: TxRemoveDoc<Doc>, control: TriggerControl): Promise<Tx[]> {
  const mixin = getClassCollaborators(control.modelDb, control.hierarchy, tx.objectClass)

  if (mixin === undefined) return []

  const res: Tx[] = []
  const contexts = await control.findAll(
    control.ctx,
    notification.class.DocNotifyContext,
    { objectId: tx.objectId },
    {
      projection: {
        _id: 1,
        _class: 1,
        space: 1
      }
    }
  )

  if (contexts.length === 0) return []

  const contextIds = contexts.map(({ _id }) => _id)
  const txes = await removeContextNotifications(control, contextIds)

  res.push(...txes)

  contexts.forEach((it) => res.push(control.txFactory.createTxRemoveDoc(it._class, it.space, it._id)))

  return res
}

async function OnAttributeCreate (txes: Tx[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []
  for (const tx of txes) {
    const attribute = TxProcessor.createDoc2Doc(tx as TxCreateDoc<AnyAttribute>)

    const group = await getClassNotificationGroup(control, attribute.attributeOf)
    if (group === undefined) continue

    result.push(...generateAttributeNotificationType(control, attribute, group))
  }
  return result
}

async function OnAttributeUpdate (txes: Tx[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []
  for (const tx of txes) {
    const ctx = tx as TxUpdateDoc<AnyAttribute>
    if (ctx.operations.hidden === undefined) {
      continue
    }
    const type = (
      await control.findAll(control.ctx, notification.class.MessageNotificationType, { attribute: ctx.objectId })
    )[0]
    if (type === undefined) {
      continue
    }
    result.push(
      control.txFactory.createTxUpdateDoc(type._class, type.space, type._id, {
        hidden: ctx.operations.hidden
      })
    )
  }
  return result
}

async function OnCollaboratorRemoved (txes: TxRemoveDoc<Collaborator>[], control: TriggerControl): Promise<Tx[]> {
  const res: Tx[] = []

  for (const tx of txes) {
    const collaborator = control.removedMap.get(tx._id) as Collaborator | undefined
    if (collaborator === undefined) continue

    const { attachedTo, attachedToClass } = collaborator

    const doc = (await control.findAll(control.ctx, attachedToClass, { _id: attachedTo }, { limit: 1 }))[0]
    if (doc === undefined) continue

    const contexts = await control.findAll(control.ctx, notification.class.DocNotifyContext, {
      objectId: attachedTo,
      user: collaborator.collaborator
    })

    res.push(...(await removeContexts(control, contexts, [collaborator.collaborator])))
  }

  return res
}

async function OnActivityMessageRemove (message: ActivityMessage, control: TriggerControl): Promise<Tx[]> {
  if (control.removedMap.has(message.attachedTo)) {
    return []
  }

  const res: Tx[] = []

  const reactionNotifications = await control.findAll(control.ctx, notification.class.ReactionInboxNotification, {
    attachedTo: message._id
  })
  const mentionNotifications = await control.findAll(control.ctx, notification.class.MentionInboxNotification, {
    mentionedIn: message._id
  })
  const activityNotifications = await control.findAll(control.ctx, notification.class.ActivityInboxNotification, {
    attachedTo: message._id
  })

  res.push(...activityNotifications.map((it) => control.txFactory.createTxRemoveDoc(it._class, it.space, it._id)))
  res.push(...reactionNotifications.map((it) => control.txFactory.createTxRemoveDoc(it._class, it.space, it._id)))
  res.push(...mentionNotifications.map((it) => control.txFactory.createTxRemoveDoc(it._class, it.space, it._id)))

  const contexts = await control.findAll(control.ctx, notification.class.DocNotifyContext, {
    objectId: message.attachedTo,
    lastUpdate: message.createdOn
  })
  if (contexts.length === 0) return res

  const lastMessage = (
    await control.findAll(
      control.ctx,
      activity.class.ActivityMessage,
      { attachedTo: message.attachedTo, space: message.space },
      { sort: { createdOn: SortingOrder.Descending }, limit: 1 }
    )
  )[0]
  if (lastMessage === undefined) return res

  for (const context of contexts) {
    res.push(
      control.txFactory.createTxUpdateDoc(context._class, context.space, context._id, {
        lastUpdate: lastMessage.createdOn ?? lastMessage.modifiedOn
      })
    )
  }

  return res
}

async function OnEmployeeDeactivate (txes: TxCUD<Doc>[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []
  for (const tx of txes) {
    const actualTx = tx
    if (core.class.TxMixin !== actualTx._class) {
      return []
    }
    const ctx = actualTx as TxMixin<Person, Employee>
    if (ctx.mixin !== contact.mixin.Employee || ctx.attributes.active !== false) {
      return []
    }
    const person = (await control.findAll(control.ctx, contact.class.Person, { _id: ctx.objectId }))[0]
    if (person?.personUuid === undefined) return []

    const subscriptions = await control.findAll(control.ctx, notification.class.PushSubscription, {
      user: person.personUuid as AccountUuid
    })
    for (const sub of subscriptions) {
      result.push(control.txFactory.createTxRemoveDoc(sub._class, sub.space, sub._id))
    }
  }
  return result
}

async function OnDocRemove (txes: TxCUD<Doc>[], control: TriggerControl): Promise<Tx[]> {
  const ltxes = txes.filter((it) => it._class === core.class.TxRemoveDoc) as TxRemoveDoc<Doc>[]
  const res: Tx[] = []
  for (const tx of ltxes) {
    if (control.hierarchy.isDerived(tx.objectClass, activity.class.ActivityMessage)) {
      const message = control.removedMap.get(tx.objectId) as ActivityMessage | undefined

      if (message !== undefined) {
        const txes = await OnActivityMessageRemove(message, control)
        res.push(...txes)
      }
    } else if (control.hierarchy.isDerived(tx.objectClass, notification.class.DocNotifyContext)) {
      res.push(...(await removeContextNotifications(control, [tx.objectId as Ref<DocNotifyContext>])))
    }

    const readState = await control.findAll(control.ctx, notification.class.ReadState, { attachedTo: tx.objectId })
    res.push(
      ...readState.map((readState) =>
        control.txFactory.createTxRemoveDoc(readState._class, readState.space, readState._id)
      )
    )

    res.push(...(await removeCollaboratorDoc(tx, control)))
  }
  return res
}

async function OnDocCreated (txes: TxCreateDoc<Doc>[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []
  for (const tx of txes) {
    if (!isActivityDoc(tx.objectClass, control.hierarchy)) continue
    const isSpace = control.hierarchy.isDerived(tx.objectClass, core.class.Space)
    const space = isSpace ? (tx.objectId as Ref<Space>) : tx.objectSpace
    result.push(
      control.txFactory.createTxCreateDoc(notification.class.ReadState, space, {
        attachedTo: tx.objectId,
        attachedToClass: tx.objectClass,
        collection: 'readStates'
      })
    )
  }

  return result
}

async function OnDocSpaceChanged (txes: TxUpdateDoc<Doc>[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []

  for (const tx of txes) {
    if (!isActivityDoc(tx.objectClass, control.hierarchy)) continue
    const space = tx.operations.space
    if (space == null) continue

    const state = (await control.findAll(control.ctx, notification.class.ReadState, { attachedTo: tx.objectId }))[0]
    if (state == null) continue
    result.push(control.txFactory.createTxUpdateDoc(state._class, state.space, state._id, { space }))
  }

  return result
}

export async function OnDocClassChanged (txes: TxUpdateDoc<Doc>[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []

  for (const tx of txes) {
    const objectClass = (tx.operations as any)._class as Ref<Class<Doc>> | undefined
    if (objectClass == null || objectClass === tx.objectClass) continue

    const contexts = await control.findAll(control.ctx, notification.class.DocNotifyContext, {
      objectId: tx.objectId
    })
    for (const context of contexts) {
      result.push(control.txFactory.createTxUpdateDoc(context._class, context.space, context._id, { objectClass }))
    }

    const notifications = await control.findAll(control.ctx, notification.class.InboxNotification, {
      objectId: tx.objectId
    })
    for (const item of notifications) {
      result.push(control.txFactory.createTxUpdateDoc(item._class, item.space, item._id, { objectClass }))
    }
  }

  return result
}

export * from './push'
export type * from './types'
export * from './utils'

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export default async () => ({
  trigger: {
    OnAttributeCreate,
    OnAttributeUpdate,
    OnDocRemove,
    OnDocCreated,
    OnDocSpaceChanged,
    OnDocClassChanged,
    OnEmployeeDeactivate,
    PushNotificationsHandler,
    OnCollaboratorRemoved
  },
  function: {
    IsUserFieldValueTypeMatch,
    MeAddedInCollaboratorsNotificationTypeMatch,
    MeRemovedFromCollaboratorsNotificationTypeMatch
  }
})
