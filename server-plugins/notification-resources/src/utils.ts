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
import core, {
  AnyAttribute,
  AttachedDoc,
  Class,
  Collection,
  Data,
  Doc,
  includesAny,
  Ref,
  Tx
} from '@hcengineering/core'
import notification, { MessageNotificationType, NotificationGroup, NotificationType } from '@hcengineering/notification'
import { TriggerControl } from '@hcengineering/server-core'
import { Receiver, TypeMatchClient, TypeMatchFunc } from '@hcengineering/server-notification'
import activity, { DocUpdateMessage } from '@hcengineering/activity'

export const IsUserFieldValueTypeMatch: TypeMatchFunc = (
  _client: TypeMatchClient,
  _type: NotificationType,
  _message: Doc,
  doc: Doc,
  receiver: Receiver
): boolean => {
  const type = _type as MessageNotificationType
  if (type.field === undefined) return false
  const value = (doc as any)[type.field]
  if (value == null) return false
  if (value === receiver.employeeRef) return true

  if (Array.isArray(value)) {
    return includesAny(value, receiver.socialIds)
  } else {
    return receiver.socialIds.includes(value)
  }
}

export const MeAddedInCollaboratorsNotificationTypeMatch: TypeMatchFunc = async (
  _client: TypeMatchClient,
  _type: NotificationType,
  _message: Doc,
  _doc: Doc,
  receiver: Receiver
): Promise<boolean> => {
  const message = _message as DocUpdateMessage
  if (message.objectClass !== core.class.Collaborator || message.action !== 'create') return false
  return message.objectAttributes?.collaborator === receiver.account
}

export const MeRemovedFromCollaboratorsNotificationTypeMatch: TypeMatchFunc = async (
  _client: TypeMatchClient,
  _type: NotificationType,
  _message: Doc,
  _doc: Doc,
  receiver: Receiver
): Promise<boolean> => {
  const message = _message as DocUpdateMessage
  if (message.objectClass !== core.class.Collaborator || message.action !== 'remove') return false
  return message.objectAttributes?.collaborator === receiver.account
}

export async function getClassNotificationGroup (
  control: TriggerControl,
  _class: Ref<Class<Doc>>
): Promise<NotificationGroup | undefined> {
  const group = (await control.findAll(control.ctx, notification.class.NotificationGroup, { objectClass: _class }))[0]

  if (group != null) return group

  const groups = await control.findAll(control.ctx, notification.class.NotificationGroup, {
    objectClass: { $exists: true }
  })

  for (const g of groups) {
    if (g.objectClass != null && control.hierarchy.isDerived(_class, g.objectClass)) {
      return g
    }
  }
}

export function generateAttributeNotificationType (
  control: TriggerControl,
  attribute: AnyAttribute,
  group: NotificationGroup,
  defaultEnabled = false
): Tx[] {
  const res: Tx[] = []

  const isCollection: boolean = core.class.Collection === attribute.type._class
  const objectClass = !isCollection ? attribute.attributeOf : (attribute.type as Collection<AttachedDoc>).of
  const messageClass = control.hierarchy.isDerived(objectClass, activity.class.ActivityMessage)
    ? objectClass
    : activity.class.DocUpdateMessage

  const data: Data<MessageNotificationType> = {
    attribute: attribute._id,
    group: group.parent ?? group._id,
    subGroup: group.parent != null ? group._id : undefined,
    field: attribute.name,
    generated: true,
    objectClass,
    messageClass,
    hidden: false,
    defaultEnabled,
    attachedToClass: attribute.attributeOf,
    templates: {
      text: notification.emailTemplate.GeneratedNotificationText,
      html: notification.emailTemplate.GeneratedNotificationHtml,
      subject: notification.emailTemplate.GeneratedNotificationSubject
    },
    label: attribute.label
  }
  const id =
    `${notification.class.MessageNotificationType}_${attribute.attributeOf}_${attribute.name}` as Ref<NotificationType>
  res.push(control.txFactory.createTxCreateDoc(notification.class.MessageNotificationType, core.space.Model, data, id))
  return res
}
