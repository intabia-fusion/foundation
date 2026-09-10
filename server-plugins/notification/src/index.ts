//
// Copyright © 2020, 2021 Anticrm Platform Contributors.
// Copyright © 2021, 2022, 2023 Hardcore Engineering Inc.
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

import { Employee, Person, PersonSpace } from '@hcengineering/contact'
import { PersonId, Class, Doc, Mixin, Ref, TxCUD, AccountUuid, Markup } from '@hcengineering/core'
import { CreateNotificationAction, NotificationIntl, NotificationType } from '@hcengineering/notification'
import { Metadata, Plugin, Resource, plugin } from '@hcengineering/platform'
import type { TriggerControl, TriggerFunc } from '@hcengineering/server-core'
import { ActivityMessage } from '@hcengineering/activity'

export const serverNotificationId = 'server-notification' as Plugin
export { DOMAIN_USER_NOTIFY, DOMAIN_DOC_NOTIFY } from '@hcengineering/notification'

export interface Receiver {
  account: AccountUuid
  employeeRef: Ref<Employee>
  role?: 'USER' | 'GUEST'
  socialIds: PersonId[]
  space: Ref<PersonSpace>
  online: boolean
  language: string
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
export type CreateNotificationResult = Pick<CreateNotificationAction, 'notification' | 'intl'>
export type CreateTxNotificationFunc = (
  client: TypeMatchClient,
  tx: TxCUD<Doc>,
  attachedToDoc: Doc | undefined,
  object: Doc,
  receiver: Receiver
) => Promise<CreateNotificationResult | undefined>
export type CreateTxNotificationResource = Resource<CreateTxNotificationFunc>

export interface TypeMatch extends NotificationType {
  match?: TypeMatchFuncResource
  create?: CreateTxNotificationResource
  intlProvider?: NotificationIntlProviderResource
}

export type NotificationIntlProviderResource = Resource<NotificationIntlProvider>

export type NotificationIntlProvider = (
  client: TypeMatchClient,
  type: NotificationType,
  typeObject: Doc,
  doc: Doc,
  object: Doc | undefined,
  sender: Sender
) => Promise<NotificationIntl>

export interface MentionRef {
  markup: Markup
  docId: Ref<Doc>
  docClass: Ref<Class<Doc>>
  messageId?: Ref<ActivityMessage>
  messageClass?: Ref<Class<ActivityMessage>>
  mentionId: Ref<Person>
  mentionClass: Ref<Class<Person>>
}

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
    OnDocUpdate: '' as Resource<TriggerFunc>,
    OnDocCreated: '' as Resource<TriggerFunc>,
    OnDocSpaceChanged: '' as Resource<TriggerFunc>,
    OnDocClassChanged: '' as Resource<TriggerFunc>,
    OnEmployeeDeactivate: '' as Resource<TriggerFunc>
  },
  function: {
    IsUserFieldValueTypeMatch: '' as TypeMatchFuncResource,
    MeAddedInCollaboratorsNotificationTypeMatch: '' as TypeMatchFuncResource,
    MeRemovedFromCollaboratorsNotificationTypeMatch: '' as TypeMatchFuncResource
  }
})
