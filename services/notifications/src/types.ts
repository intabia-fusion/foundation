//
// Copyright © 2026 Intabia Fusion Inc.
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

import {
  AccountUuid,
  Branding,
  type Class,
  type Doc,
  type DocumentQuery,
  type FindOptions,
  FindResult,
  Hierarchy,
  MeasureContext,
  ModelDb,
  Ref,
  TxCreateDoc,
  TxFactory,
  TxRemoveDoc,
  TxUpdateDoc,
  type WithLookup,
  WorkspaceInfoWithStatus
} from '@hcengineering/core'
import {
  AppPushNotification,
  DocNotifyContext,
  MentionNotification,
  NotificationIntl,
  NotificationProvider,
  type NotificationProviderSetting,
  NotificationType,
  type NotificationTypeSetting,
  QueueNotificationMessage
} from '@hcengineering/notification'
import { Employee, SocialIdentity } from '@hcengineering/contact'
import { StorageAdapter } from '@hcengineering/storage'
import { Receiver } from '@hcengineering/server-notification'
import { UserMentionInfo } from '@hcengineering/activity'
import { IntlString } from '@hcengineering/platform'

export interface NotificationSettings {
  providersSettings: NotificationProviderSetting[]
  typesSettings: NotificationTypeSetting[]
  settingsByProvider: Map<Ref<NotificationProvider>, NotificationProviderSetting[]>
  typesByProvider: Map<Ref<NotificationProvider>, NotificationTypeSetting[]>
}

export type EmployeeInfo = Pick<Employee, '_id' | 'personUuid' | 'role' | 'active'>
export type SocialIdentityInfo = Pick<SocialIdentity, '_id' | 'attachedTo'>

export type NotifyProviders = Record<Ref<NotificationProvider>, NotificationType[]>

export interface Client {
  ctx: MeasureContext
  workspace: WorkspaceInfoWithStatus
  storage: StorageAdapter
  model: ModelDb
  hierarchy: Hierarchy
  txFactory: TxFactory
  branding: Branding | undefined
  findAll: <T extends Doc>(
    _class: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: FindOptions<T>
  ) => Promise<FindResult<T>>

  findOne: <T extends Doc>(
    _class: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: FindOptions<T>
  ) => Promise<WithLookup<T> | undefined>
}

export interface MentionResult {
  notification: Omit<MentionNotification, 'id' | 'type' | 'createdOn' | 'createdBy'>
  intl: Partial<NotificationIntl>
  context: DocNotifyContext | undefined
  receiver: Receiver
  notifyProviders: NotifyProviders
}

export interface Result {
  updateContextTx: TxUpdateDoc<DocNotifyContext>[]
  createContextTx: TxCreateDoc<DocNotifyContext>[]
  createAppPushNotificationTx: TxCreateDoc<AppPushNotification>[]

  createUserMentionInfoTx: TxCreateDoc<UserMentionInfo>[]
  updateUserMentionInfoTx: TxUpdateDoc<UserMentionInfo>[]
  removeUserMentionInfoTx: TxRemoveDoc<UserMentionInfo>[]

  queueMessages: QueueNotificationMessage[]
}

export interface TxCache {
  titleByDoc: Map<Ref<Doc>, Partial<Record<AccountUuid | '', string>>>
  urlByDoc: Map<Ref<Doc>, string>
  labelByDoc: Map<Ref<Doc>, IntlString>
  identifierByDoc: Map<Ref<Doc>, string>
  iconByDoc: Map<Ref<Doc>, Partial<Record<AccountUuid | '', DocNotifyContext['objectIcon']>>>
  templates: Map<string, QueueNotificationMessage['template']>
}

export type ObjectDisplayData = Pick<
  DocNotifyContext,
  | 'objectTitle'
  | 'objectIdentifier'
  | 'objectIcon'
  | 'objectLabel'
  | 'object'
  | 'parentObjectId'
  | 'parentObjectClass'
  | 'parentObjectTitle'
  | 'parentObjectIdentifier'
  | 'parentObjectLabel'
  | 'parentObjectIcon'
>
