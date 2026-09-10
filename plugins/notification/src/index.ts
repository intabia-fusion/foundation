//
// Copyright © 2022 Hardcore Engineering Inc.
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

import { Class, Doc, type Domain, Mixin, Ref } from '@hcengineering/core'
import type { Asset, IntlString, Metadata, Plugin, Resource } from '@hcengineering/platform'
import { plugin } from '@hcengineering/platform'
import { IntegrationType } from '@hcengineering/setting'
import { AnyComponent, Location, ResolvedLocation } from '@hcengineering/ui'
import { Action } from '@hcengineering/view'

import {
  ActivityNotificationViewlet,
  AppPushNotification,
  DocNotificationSetting,
  DocNotifyContext,
  MessageNotificationType,
  NotificationAppearancePreference,
  NotificationContextPresenter,
  NotificationGroup,
  NotificationObjectPresenter,
  NotificationPreferencesGroup,
  NotificationPreview,
  NotificationProvider,
  NotificationProviderDefaults,
  NotificationProviderSetting,
  NotificationsClientFactory,
  NotificationType,
  NotificationTypeSetting,
  NotifyFunc,
  PushSubscriptionSetting,
  ReadState,
  TxNotificationType,
  PushSubscription,
  ReadNotificationAction,
  CreateNotificationAction
} from './types'

export type * from './types'
export * from './utils'

export const DOMAIN_DOC_NOTIFY = 'notification-dnc' as Domain
export const DOMAIN_USER_NOTIFY = 'notification-user' as Domain
export const DOMAIN_READ_STATE = 'notification-read-state' as Domain

export const notificationId = 'notification' as Plugin

const notification = plugin(notificationId, {
  mixin: {
    NotificationObjectPresenter: '' as Ref<Mixin<NotificationObjectPresenter>>,
    NotificationPreview: '' as Ref<Mixin<NotificationPreview>>,
    NotificationContextPresenter: '' as Ref<Mixin<NotificationContextPresenter>>
  },
  class: {
    NotificationType: '' as Ref<Class<NotificationType>>,
    MessageNotificationType: '' as Ref<Class<MessageNotificationType>>,
    TxNotificationType: '' as Ref<Class<TxNotificationType>>,

    AppPushNotification: '' as Ref<Class<AppPushNotification>>,
    PushSubscription: '' as Ref<Class<PushSubscription>>,
    PushSubscriptionSetting: '' as Ref<Class<PushSubscriptionSetting>>,
    NotificationGroup: '' as Ref<Class<NotificationGroup>>,
    NotificationPreferencesGroup: '' as Ref<Class<NotificationPreferencesGroup>>,
    DocNotifyContext: '' as Ref<Class<DocNotifyContext>>,

    ActivityNotificationViewlet: '' as Ref<Class<ActivityNotificationViewlet>>,

    NotificationProvider: '' as Ref<Class<NotificationProvider>>,
    NotificationTypeSetting: '' as Ref<Class<NotificationTypeSetting>>,
    NotificationProviderSetting: '' as Ref<Class<NotificationProviderSetting>>,
    NotificationProviderDefaults: '' as Ref<Mixin<NotificationProviderDefaults>>,

    ReadState: '' as Ref<Class<ReadState>>,
    NotificationAppearancePreference: '' as Ref<Class<NotificationAppearancePreference>>,
    DocNotificationSetting: '' as Ref<Class<DocNotificationSetting>>,
    ReadNotificationAction: '' as Ref<Class<ReadNotificationAction>>,
    CreateNotificationAction: '' as Ref<Class<CreateNotificationAction>>
  },
  ids: {
    NotificationSettings: '' as Ref<Doc>,
    NotificationGroup: '' as Ref<NotificationGroup>,
    NotificationAppearancePreferencesGroup: '' as Ref<NotificationPreferencesGroup>,
    MeAddedInCollaboratorsNotification: '' as Ref<MessageNotificationType>,
    MeRemovedFromCollaboratorsNotification: '' as Ref<MessageNotificationType>,
    MentionNotificationType: '' as Ref<TxNotificationType>
  },
  metadata: {
    PushPublicKey: '' as Metadata<string>
  },
  providers: {
    InboxNotificationProvider: '' as Ref<NotificationProvider>,
    PushNotificationProvider: '' as Ref<NotificationProvider>,
    SoundNotificationProvider: '' as Ref<NotificationProvider>
  },
  integrationType: {
    MobileApp: '' as Ref<IntegrationType>
  },
  component: {
    Inbox: '' as AnyComponent,
    NotificationPresenter: '' as AnyComponent,
    CollaboratorsChanged: '' as AnyComponent,
    DocNotifyContextPresenter: '' as AnyComponent,
    GeneralPreferencesGroup: '' as AnyComponent,
    WebpushesPreferencesPresenter: '' as AnyComponent,
    MutePopup: '' as AnyComponent,
    NotificationAppearancePreferencesPresenter: '' as AnyComponent
  },
  action: {
    ReadNotifyContext: '' as Ref<Action>,
    RemoveDocNotifyContext: '' as Ref<Action>
  },
  icon: {
    Notifications: '' as Asset,
    Inbox: '' as Asset,
    BellCrossed: '' as Asset,
    Appearance: '' as Asset
  },
  sound: {
    InboxNotification: '' as Asset
  },
  string: {
    Appearance: '' as IntlString,
    Notification: '' as IntlString,
    Notifications: '' as IntlString,
    DontTrack: '' as IntlString,
    Inbox: '' as IntlString,
    CommonNotificationTitle: '' as IntlString,
    CommonNotificationTitleWithIdentifier: '' as IntlString,
    MessageNotificationBody: '' as IntlString,
    UpdateNotificationBody: '' as IntlString,
    ChangedCollaborators: '' as IntlString,
    NewCollaborators: '' as IntlString,
    RemovedCollaborators: '' as IntlString,
    Edited: '' as IntlString,
    Pinned: '' as IntlString,
    All: '' as IntlString,
    ClearAll: '' as IntlString,
    MarkReadAll: '' as IntlString,
    RemoveAllConfirmationTitle: '' as IntlString,
    RemoveAllConfirmationMessage: '' as IntlString,
    YouAddedCollaborators: '' as IntlString,
    YouRemovedCollaborators: '' as IntlString,
    Push: '' as IntlString,
    HasNewNotifications: '' as IntlString,
    UnreadNotificationsCount: '' as IntlString,
    General: '' as IntlString,
    InboxNotificationsDescription: '' as IntlString,
    PushNotificationsDescription: '' as IntlString,
    CommonNotificationCollectionAdded: '' as IntlString,
    CommonNotificationCollectionRemoved: '' as IntlString,
    SoundNotificationsDescription: '' as IntlString,
    Sound: '' as IntlString,
    NoAccessToObject: '' as IntlString,
    ViewIn: '' as IntlString,
    Clear: '' as IntlString,
    YouAddedAsCollaborator: '' as IntlString,
    YouRemovedFromCollaborators: '' as IntlString,
    Webpushes: '' as IntlString,
    UnknownDevice: '' as IntlString,
    RemoveWebpush: '' as IntlString,
    WebpushRemoveConfirm: '' as IntlString,
    Value: '' as IntlString,
    Current: '' as IntlString,
    PushOnDesktop: '' as IntlString,
    AlreadySubscribed: '' as IntlString,
    PushNotConfigured: '' as IntlString,
    PushNotSupported: '' as IntlString,
    PushDenied: '' as IntlString,
    PushSubscribeError: '' as IntlString,
    PushSubscribeErrorPermissionDenied: '' as IntlString,
    PushSubscribeErrorNetwork: '' as IntlString,
    PushSubscribeErrorNotSupported: '' as IntlString,
    PushSubscribeErrorDefault: '' as IntlString,
    Subscribe: '' as IntlString,
    AllNotifications: '' as IntlString,
    JustMentions: '' as IntlString,
    Mute: '' as IntlString,
    EditNotifications: '' as IntlString,
    AddMeInCollaborators: '' as IntlString,
    RemoveMeFromCollaborators: '' as IntlString,
    ShowChatBadge: '' as IntlString,
    Clearing: '' as IntlString,
    Reading: '' as IntlString
  },
  emailTemplate: {
    MeAddedInCollaboratorsNotificationText: '' as IntlString,
    MeAddedInCollaboratorsNotificationHtml: '' as IntlString,
    MeAddedInCollaboratorsNotificationSubject: '' as IntlString,
    MeRemovedFromCollaboratorsNotificationText: '' as IntlString,
    MeRemovedFromCollaboratorsNotificationHtml: '' as IntlString,
    MeRemovedFromCollaboratorsNotificationSubject: '' as IntlString,
    MentionNotificationText: '' as IntlString,
    MentionNotificationHtml: '' as IntlString,
    MentionNotificationSubject: '' as IntlString,
    GeneratedNotificationText: '' as IntlString,
    GeneratedNotificationHtml: '' as IntlString,
    GeneratedNotificationSubject: '' as IntlString
  },
  function: {
    Notify: '' as Resource<NotifyFunc>,
    CheckWebPushPermission: '' as Resource<(value: boolean) => Promise<boolean>>,
    GetNotificationsClient: '' as Resource<NotificationsClientFactory>,
    EditDocNotificationsVisibilityTester: '' as Resource<(doc: Doc | Doc[] | undefined) => Promise<boolean>>
  },
  resolver: {
    Location: '' as Resource<(loc: Location) => Promise<ResolvedLocation | undefined>>
  }
})

export default notification
