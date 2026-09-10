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

import contact, { Employee, type Person } from '@hcengineering/contact'
import core, {
  AccountUuid,
  AnyAttribute,
  type Class,
  Doc,
  Ref,
  Space,
  DocumentUpdate,
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
import {
  getTitlePresenter,
  getIdentifierPresenter,
  getIconPresenter,
  getDocIcon,
  isActivityDoc,
  getDocIdentifier,
  getDocTitle,
  getLabelPresenter,
  getDocLabel
} from '@hcengineering/server-activity'

import {
  generateAttributeNotificationType,
  getClassNotificationGroup,
  IsUserFieldValueTypeMatch,
  MeAddedInCollaboratorsNotificationTypeMatch,
  MeRemovedFromCollaboratorsNotificationTypeMatch
} from './utils'

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

async function OnDocRemove (txes: TxRemoveDoc<Doc>[], control: TriggerControl): Promise<Tx[]> {
  const res: Tx[] = []
  for (const tx of txes) {
    const contexts = await control.findAll(control.ctx, notification.class.DocNotifyContext, { objectId: tx.objectId })
    const readState = await control.findAll(control.ctx, notification.class.ReadState, { attachedTo: tx.objectId })

    res.push(
      ...readState.map((readState) =>
        control.txFactory.createTxRemoveDoc(readState._class, readState.space, readState._id)
      ),
      ...contexts.map((context) => control.txFactory.createTxRemoveDoc(context._class, context.space, context._id))
    )
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

async function OnDocUpdate (txes: TxUpdateDoc<Doc>[], control: TriggerControl): Promise<Tx[]> {
  const res: Tx[] = []

  for (const tx of txes) {
    const titleKey = control.hierarchy.findClass(tx.objectClass)?.titleKey
    const titlePresenter = getTitlePresenter(tx.objectClass, control.hierarchy)
    const labelPresenter = getLabelPresenter(tx.objectClass, control.hierarchy)
    const iconPresenter = getIconPresenter(tx.objectClass, control.hierarchy)
    const identifierPresenter = getIdentifierPresenter(tx.objectClass, control.hierarchy)

    const keys = new Set<string>()
    for (const [key, value] of Object.entries(tx.operations)) {
      if (key.startsWith('$')) {
        if (value != null && typeof value === 'object') {
          Object.keys(value).forEach((field) => {
            keys.add(field)
            keys.add(field.split('.')[0])
          })
        }
      } else {
        keys.add(key)
        keys.add(key.split('.')[0])
      }
    }

    const updateTitle =
      titlePresenter?.triggerFields.some((key) => keys.has(key)) ?? (titleKey != null && keys.has(titleKey))
    const updateIdentifier = identifierPresenter?.triggerFields.some((key) => keys.has(key)) ?? false
    const updateIcon = iconPresenter?.triggerFields.some((key) => keys.has(key)) ?? false
    const updateLabel = labelPresenter?.triggerFields.some((key) => keys.has(key)) ?? false

    if (!updateIcon && !updateIdentifier && !updateTitle && !updateLabel) continue

    const doc = (await control.findAll(control.ctx, tx.objectClass, { _id: tx.objectId }))[0]
    if (doc == null) continue

    const contexts = await control.findAll(control.ctx, notification.class.DocNotifyContext, { objectId: tx.objectId })
    const contextsByParent = await control.findAll(control.ctx, notification.class.DocNotifyContext, {
      parentObjectId: tx.objectId
    })
    if (contexts.length === 0 && contextsByParent.length === 0) continue

    const objectOps: DocumentUpdate<DocNotifyContext> = {}
    const parentOps: DocumentUpdate<DocNotifyContext> = {}

    if (updateTitle) {
      const title = await getDocTitle(control, doc)
      objectOps.objectTitle = title
      parentOps.parentObjectTitle = title
    }

    if (updateIdentifier) {
      const identifier = await getDocIdentifier(control, doc)
      objectOps.objectIdentifier = identifier
      parentOps.parentObjectIdentifier = identifier
    }

    if (updateIcon) {
      const icon = await getDocIcon(control, doc)
      objectOps.objectIcon = icon
      parentOps.parentObjectIcon = icon
    }

    if (updateLabel) {
      const label = await getDocLabel(control, doc)
      objectOps.objectLabel = label
      parentOps.parentObjectLabel = label
    }

    for (const context of contexts) {
      res.push(control.txFactory.createTxUpdateDoc(context._class, context.space, context._id, objectOps))
    }

    for (const context of contextsByParent) {
      res.push(control.txFactory.createTxUpdateDoc(context._class, context.space, context._id, parentOps))
    }
  }

  return res
}

export { getClassNotificationGroup, generateAttributeNotificationType } from './utils'

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
  }

  return result
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export default async () => ({
  trigger: {
    OnAttributeCreate,
    OnAttributeUpdate,
    OnDocCreated,
    OnDocUpdate,
    OnDocRemove,
    OnDocSpaceChanged,
    OnDocClassChanged,
    OnEmployeeDeactivate
  },
  function: {
    IsUserFieldValueTypeMatch,
    MeAddedInCollaboratorsNotificationTypeMatch,
    MeRemovedFromCollaboratorsNotificationTypeMatch
  }
})
