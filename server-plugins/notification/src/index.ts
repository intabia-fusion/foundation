//
// Copyright © 2020, 2021 Anticrm Platform Contributors.
// Copyright © 2021, 2022, 2023 Hardcore Engineering Inc.
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

import { Employee, Person, PersonSpace } from '@hcengineering/contact'
import { PersonId, Class, Doc, Mixin, Ref, TxCUD, AccountUuid, Markup, Data } from '@hcengineering/core'
import { CommonInboxNotification, NotificationContent, NotificationType } from '@hcengineering/notification'
import { Metadata, Plugin, Resource, plugin } from '@hcengineering/platform'
import type { TriggerControl, TriggerFunc } from '@hcengineering/server-core'
import { ActivityMessage } from '@hcengineering/activity'

export const serverNotificationId = 'server-notification' as Plugin
export { DOMAIN_USER_NOTIFY, DOMAIN_NOTIFICATION, DOMAIN_DOC_NOTIFY } from '@hcengineering/notification'

export interface Receiver {
  account: AccountUuid
  employeeRef: Ref<Employee>
  role?: 'USER' | 'GUEST'
  socialIds: PersonId[]
  space: Ref<PersonSpace>
  online: boolean
}

export interface Sender {
  socialId: PersonId
  person?: Person
  account?: AccountUuid
}

export type TypeMatchClient = Pick<
TriggerControl,
'hierarchy' | 'modelDb' | 'findAll' | 'txFactory' | 'ctx' | 'branding'
>
export type TypeMatchFunc = (
  client: TypeMatchClient,
  type: NotificationType,
  typeObject: Doc,
  doc: Doc,
  receiver: Receiver
) => Promise<boolean> | boolean

export type TypeMatchFuncResource = Resource<TypeMatchFunc>
export type CreateNotificationResult = Omit<
Data<CommonInboxNotification>,
'archived' | 'user' | 'allowedProviders' | 'docNotifyContext' | 'isViewed' | 'objectId' | 'objectClass'
>
export type CreateNotificationFunc = (
  client: TypeMatchClient,
  tx: TxCUD<Doc>,
  attachedToDoc: Doc | undefined,
  object: Doc,
  receiver: Receiver
) => Promise<CreateNotificationResult | undefined>
export type CreateNotificationResource = Resource<CreateNotificationFunc>

export interface TypeMatch extends NotificationType {
  match?: TypeMatchFuncResource
  create?: CreateNotificationResource
  contentProvider?: NotificationContentProviderResource
}

export type NotificationContentProviderResource = Resource<NotificationContentProvider>

export type NotificationContentProvider = (
  client: TypeMatchClient,
  type: NotificationType,
  typeObject: Doc,
  doc: Doc,
  object: Doc | undefined,
  sender: Sender
) => Promise<NotificationContent>

export interface MentionRef {
  markup: Markup
  docId: Ref<Doc>
  docClass: Ref<Class<Doc>>
  messageId?: Ref<ActivityMessage>
  messageClass?: Ref<Class<ActivityMessage>>
  mentionId: Ref<Person>
  mentionClass: Ref<Class<Person>>
}

export const NOTIFICATION_BODY_SIZE = 150
export const PUSH_NOTIFICATION_TITLE_SIZE = 80

export * from './utils'
export * from './middleware'

/**
 * @public
 */
export default plugin(serverNotificationId, {
  metadata: {
    MailUrl: '' as Metadata<string>,
    MailAuthToken: '' as Metadata<string>,
    WebPushUrl: '' as Metadata<string>,
    InboxOnlyNotifications: '' as Metadata<boolean>
  },
  mixin: {
    TypeMatch: '' as Ref<Mixin<TypeMatch>>
  },
  trigger: {
    OnAttributeCreate: '' as Resource<TriggerFunc>,
    OnAttributeUpdate: '' as Resource<TriggerFunc>,
    OnDocRemove: '' as Resource<TriggerFunc>,
    OnDocCreated: '' as Resource<TriggerFunc>,
    OnDocSpaceChanged: '' as Resource<TriggerFunc>,
    OnDocClassChanged: '' as Resource<TriggerFunc>,
    OnEmployeeDeactivate: '' as Resource<TriggerFunc>,
    PushNotificationsHandler: '' as Resource<TriggerFunc>,
    OnCollaboratorRemoved: '' as Resource<TriggerFunc>
  },
  function: {
    IsUserFieldValueTypeMatch: '' as TypeMatchFuncResource,
    MeAddedInCollaboratorsNotificationTypeMatch: '' as TypeMatchFuncResource,
    MeRemovedFromCollaboratorsNotificationTypeMatch: '' as TypeMatchFuncResource
  }
})
