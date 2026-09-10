//
// Copyright © 2020, 2021 Anticrm Platform Contributors.
// Copyright © 2021, 2022 Hardcore Engineering Inc.
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

import activity, { type ActivityMessage, type ActivityMessageLite, type Reaction } from '@hcengineering/activity'
import { type PersonSpace } from '@hcengineering/contact'
import {
  AccountRole,
  DOMAIN_MODEL,
  DOMAIN_TRANSIENT,
  IndexKind,
  type AccountUuid,
  type Class,
  type Doc,
  type DocumentQuery,
  type Domain,
  type IndexingConfiguration,
  type PersonId,
  type Ref,
  type Space,
  type Timestamp,
  type Tx,
  type AnyAttribute
} from '@hcengineering/core'
import {
  Index,
  Mixin,
  Model,
  Prop,
  TypeAccountUuid,
  TypeDate,
  TypeRef,
  TypeString,
  type Builder,
  TypeNumber,
  ArrOf,
  TypeRecord,
  TypeIntlString
} from '@hcengineering/model'
import core, { TAttachedDoc, TClass, TDoc } from '@hcengineering/model-core'
import preference, { TPreference } from '@hcengineering/model-preference'
import view from '@hcengineering/model-view'
import workbench from '@hcengineering/model-workbench'
import {
  DOMAIN_DOC_NOTIFY,
  DOMAIN_USER_NOTIFY,
  notificationId,
  type PushSubscriptionSetting,
  type MessageNotificationType,
  type TxNotificationType,
  DOMAIN_READ_STATE,
  type ReadState,
  ReadPosition,
  type ContextNotification,
  type NotificationAppearancePreference,
  type DocNotifyContext,
  type AppPushNotification,
  type PushSubscription,
  type PushSubscriptionKeys,
  type NotificationType,
  type NotificationGroup,
  type NotificationPreferencesGroup,
  type NotificationTemplate,
  type NotificationProvider,
  type NotificationProviderSetting,
  type NotificationTypeSetting,
  type NotificationObjectPresenter,
  type NotificationPreview,
  type NotificationContextPresenter,
  type ActivityNotificationViewlet,
  type NotificationProviderDefaults,
  type DocNotificationSetting,
  type DocNotificationMode,
  type UnreadMessage,
  type UnreadReaction,
  type CommonNotification,
  type UnreadMention,
  type ReadNotificationAction,
  type CreateNotificationAction,
  type CommonNotificationLite,
  type NotificationIntl
} from '@hcengineering/notification'
import { type Asset, getEmbeddedLabel, type IntlString, type Resource } from '@hcengineering/platform'
import setting from '@hcengineering/setting'
import { type AnyComponent, type Location } from '@hcengineering/ui/src/types'

import notification from './plugin'
import { defineNotifications } from './notifications'
import { defineActions } from './actions'

export { DOMAIN_DOC_NOTIFY, DOMAIN_USER_NOTIFY, DOMAIN_READ_STATE, notificationId } from '@hcengineering/notification'
export { notificationOperation } from './migration'
export { notification as default }
export { generateClassNotificationTypes } from './notifications'

@Model(notification.class.AppPushNotification, core.class.Doc, DOMAIN_TRANSIENT)
export class TAppPushNotification extends TDoc implements AppPushNotification {
  tag!: string
  titleIntl!: IntlString
  bodyIntl!: IntlString
  intlParams!: { senderName: string, title?: string } & Record<string, string>
  intlParamsNotLocalized?: Record<string, IntlString>
  sender!: PersonId
  onClickLocation!: Location
  account!: AccountUuid
  messageId?: Ref<ActivityMessage>
  objectId!: Ref<Doc>
  objectClass!: Ref<Class<Doc>>
  soundAlert!: boolean
}

@Model(notification.class.PushSubscription, core.class.Doc, DOMAIN_USER_NOTIFY)
export class TPushSubscription extends TDoc implements PushSubscription {
  user!: AccountUuid
  endpoint!: string
  keys!: PushSubscriptionKeys
  name?: string
}

@Model(notification.class.PushSubscriptionSetting, preference.class.Preference)
export class TPushSubscriptionSetting extends TPreference implements PushSubscriptionSetting {
  declare attachedTo: Ref<TPushSubscription>
  enabled!: boolean
}

@Model(notification.class.NotificationType, core.class.Doc, DOMAIN_MODEL)
export class TNotificationType extends TDoc implements NotificationType {
  generated!: boolean
  label!: IntlString
  group!: Ref<NotificationGroup>
  defaultEnabled!: boolean
  hidden!: boolean
  templates?: NotificationTemplate
  objectClass!: Ref<Class<Doc>>
}

@Model(notification.class.MessageNotificationType, notification.class.NotificationType)
export class TMessageNotificationType extends TNotificationType implements MessageNotificationType {
  messageClass!: Ref<Class<ActivityMessage>>
  attachedToClass!: Ref<Class<Doc>>
  attribute?: Ref<AnyAttribute>
  field?: string
  match?: DocumentQuery<ActivityMessage>
  notifyAuthor?: boolean
}

@Model(notification.class.TxNotificationType, notification.class.NotificationType)
export class TTxNotificationType extends TNotificationType implements TxNotificationType {
  txClasses!: Ref<Class<Tx>>[]
  field?: string
  match?: DocumentQuery<Tx>
  notifyAuthor?: boolean
  attachedToClass?: Ref<Class<Doc>>
}

@Model(notification.class.NotificationGroup, core.class.Doc, DOMAIN_MODEL)
export class TNotificationGroup extends TDoc implements NotificationGroup {
  label!: IntlString
  icon!: Asset
  // using for autogenerated settings
  objectClass?: Ref<Class<Doc>>
}

@Model(notification.class.NotificationPreferencesGroup, core.class.Doc, DOMAIN_MODEL)
export class TNotificationPreferencesGroup extends TDoc implements NotificationPreferencesGroup {
  label!: IntlString
  icon!: Asset
  presenter!: AnyComponent
}

@Model(notification.class.NotificationTypeSetting, preference.class.Preference)
export class TNotificationTypeSetting extends TPreference implements NotificationTypeSetting {
  declare attachedTo: Ref<TNotificationProvider>
  type!: Ref<NotificationType>
  enabled!: boolean
}

@Model(notification.class.NotificationProviderSetting, preference.class.Preference)
export class TNotificationProviderSetting extends TPreference implements NotificationProviderSetting {
  declare attachedTo: Ref<TNotificationProvider>
  enabled!: boolean
}

@Model(notification.class.DocNotificationSetting, preference.class.Preference)
export class TDocNotificationSetting extends TPreference implements DocNotificationSetting {
  declare attachedTo: Ref<Doc>
  attachedToClass!: Ref<Class<Doc>>
  account!: AccountUuid
  @Prop(TypeString(), getEmbeddedLabel('mode'))
  mode?: DocNotificationMode
}

@Mixin(notification.mixin.NotificationObjectPresenter, core.class.Class)
export class TNotificationObjectPresenter extends TClass implements NotificationObjectPresenter {
  presenter!: AnyComponent
}

@Mixin(notification.mixin.NotificationPreview, core.class.Class)
export class TNotificationPreview extends TClass implements NotificationPreview {
  presenter!: AnyComponent
}

@Mixin(notification.mixin.NotificationContextPresenter, core.class.Class)
export class TNotificationContextPresenter extends TClass implements NotificationContextPresenter {
  labelPresenter?: AnyComponent
}

@Model(notification.class.DocNotifyContext, core.class.Doc, DOMAIN_DOC_NOTIFY)
export class TDocNotifyContext extends TDoc implements DocNotifyContext {
  declare space: Ref<PersonSpace>

  @Prop(TypeAccountUuid(), core.string.Account)
  @Index(IndexKind.Indexed)
  user!: AccountUuid

  @Prop(TypeRef(core.class.Doc), core.string.Object)
  @Index(IndexKind.Indexed)
  objectId!: Ref<Doc>

  @Prop(TypeRef(core.class.Class), core.string.Class)
  objectClass!: Ref<Class<Doc>>

  @Prop(TypeRef(core.class.Space), core.string.Space)
  objectSpace!: Ref<Space>

  @Prop(TypeString(), core.string.String)
  objectIdentifier?: string

  @Prop(TypeString(), core.string.String)
  objectTitle!: string

  @Prop(TypeIntlString(), core.string.String)
  objectLabel?: IntlString

  @Prop(TypeRecord(), getEmbeddedLabel('icon'))
  objectIcon?: Record<string, any>

  @Prop(TypeRecord(), core.string.Object)
  object?: Partial<Doc>

  @Prop(TypeRef(core.class.Doc), core.string.Object)
  @Index(IndexKind.Indexed)
  parentObjectId?: Ref<Doc>

  @Prop(TypeRef(core.class.Class), core.string.Class)
  parentObjectClass?: Ref<Class<Doc>>

  @Prop(TypeString(), core.string.String)
  parentObjectTitle?: string

  @Prop(TypeString(), core.string.String)
  parentObjectIdentifier?: string

  @Prop(TypeIntlString(), core.string.String)
  parentObjectLabel?: IntlString

  @Prop(TypeRecord(), getEmbeddedLabel('icon'))
  parentObjectIcon?: Record<string, any>

  @Prop(TypeDate(), core.string.Date)
  lastNotify!: Timestamp

  @Prop(ArrOf(TypeRecord()), getEmbeddedLabel('latestNotifications'))
  latestNotifications!: ContextNotification[]

  @Prop(ArrOf(TypeRecord()), getEmbeddedLabel('unreadReactions'))
  unreadReactions!: UnreadReaction[] // store unread reaction notifications

  @Prop(ArrOf(TypeRecord()), getEmbeddedLabel('unreadMentions'))
  unreadMentions!: UnreadMention[] // store unread mention notifications

  @Prop(ArrOf(TypeRecord()), getEmbeddedLabel('unreadCommons'))
  unreadCommons!: CommonNotification[] // store unread common notifications

  @Prop(TypeNumber(), core.string.Number)
  unreadCount!: number

  @Prop(ArrOf(TypeRecord()), getEmbeddedLabel('unreadMessages'))
  unreadMessages!: UnreadMessage[]
}

@Model(notification.class.ReadState, core.class.Doc, DOMAIN_READ_STATE)
export class TReadState extends TAttachedDoc implements ReadState {
  latestMessageId?: Ref<ActivityMessage>
  latestMessageTimestamp?: Timestamp;
  [key: AccountUuid]: ReadPosition
}

@Model(notification.class.ReadNotificationAction, core.class.Doc, DOMAIN_TRANSIENT)
export class TReadNotificationAction extends TDoc implements ReadNotificationAction {
  declare space: Ref<PersonSpace>

  @Prop(TypeRef(core.class.Doc), core.string.Object)
  attachedTo!: Ref<Doc>

  @Prop(TypeRef(core.class.Class), core.string.Class)
  attachedToClass!: Ref<Class<Doc>>

  @Prop(TypeAccountUuid(), core.string.Account)
  account!: AccountUuid

  @Prop(ArrOf(TypeRef(activity.class.Reaction)), getEmbeddedLabel('reactionIds'))
  reactionIds?: Ref<Reaction>[]

  @Prop(ArrOf(TypeRef(activity.class.ActivityMessage)), getEmbeddedLabel('messageIds'))
  messageIds?: Ref<ActivityMessage>[]

  @Prop(ArrOf(TypeString()), getEmbeddedLabel('commonIds'))
  commonIds?: string[]

  @Prop(ArrOf(TypeString()), getEmbeddedLabel('mentionIds'))
  mentionIds?: string[]
}

@Model(notification.class.CreateNotificationAction, core.class.Doc, DOMAIN_TRANSIENT)
export class TCreateNotificationAction extends TDoc implements CreateNotificationAction {
  declare space: Ref<PersonSpace>

  @Prop(TypeRef(core.class.Doc), core.string.Object)
  attachedTo!: Ref<Doc>

  @Prop(TypeRef(core.class.Class), core.string.Class)
  attachedToClass!: Ref<Class<Doc>>

  @Prop(TypeAccountUuid(), core.string.Account)
  account!: AccountUuid

  @Prop(TypeRef(notification.class.NotificationType), notification.string.Notification)
  type?: Ref<NotificationType>

  @Prop(TypeRecord(), notification.string.Notification)
  notification!: CommonNotificationLite

  intl?: Partial<NotificationIntl>
}

@Model(notification.class.ActivityNotificationViewlet, core.class.Doc, DOMAIN_MODEL)
export class TActivityNotificationViewlet extends TDoc implements ActivityNotificationViewlet {
  messageMatch!: DocumentQuery<ActivityMessageLite>

  presenter!: AnyComponent
}

@Model(notification.class.NotificationProvider, core.class.Doc)
export class TNotificationProvider extends TDoc implements NotificationProvider {
  icon!: Asset
  label!: IntlString
  description!: IntlString
  defaultEnabled!: boolean
  order!: number
  depends?: Ref<NotificationProvider>
  ignoreAll?: boolean
  canDisable!: boolean
  presenter?: AnyComponent
  isAvailableFn?: Resource<() => boolean>
}

@Model(notification.class.NotificationProviderDefaults, core.class.Doc)
export class TNotificationProviderDefaults extends TDoc implements NotificationProviderDefaults {
  provider!: Ref<NotificationProvider>
  excludeIgnore?: Ref<NotificationType>[]
  ignoredTypes!: Ref<NotificationType>[]
  enabledTypes!: Ref<NotificationType>[]
}

@Model(notification.class.NotificationAppearancePreference, preference.class.Preference)
export class TNotificationAppearancePreference extends TPreference implements NotificationAppearancePreference {
  showChatBadge!: boolean
}

const DOMAIN_NOTIFICATION = 'notification' as Domain

@Model('notification:class:InboxNotification' as any, core.class.Doc, DOMAIN_NOTIFICATION)
export class TInboxNotification extends TDoc {}

@Model('notification:class:ActivityInboxNotification' as any, 'notification:class:InboxNotification' as any)
export class TActivityInboxNotification extends TInboxNotification {}

@Model('notification:class:ReactionInboxNotification' as any, 'notification:class:InboxNotification' as any)
export class TReactionInboxNotification extends TInboxNotification {}

@Model('notification:class:MentionInboxNotification' as any, 'notification:class:InboxNotification' as any)
export class TMentionInboxNotification extends TInboxNotification {}

@Model('notification:class:CommonInboxNotification' as any, 'notification:class:InboxNotification' as any)
export class TCommonInboxNotification extends TInboxNotification {}

export function createModel (builder: Builder): void {
  builder.createModel(
    TInboxNotification,
    TActivityInboxNotification,
    TReactionInboxNotification,
    TMentionInboxNotification,
    TCommonInboxNotification,
    TAppPushNotification,
    TNotificationType,
    TMessageNotificationType,
    TTxNotificationType,
    TNotificationGroup,
    TNotificationPreferencesGroup,
    TNotificationObjectPresenter,
    TNotificationPreview,
    TDocNotifyContext,
    TNotificationContextPresenter,
    TActivityNotificationViewlet,
    TNotificationType,
    TPushSubscription,
    TPushSubscriptionSetting,
    TNotificationProvider,
    TNotificationProviderSetting,
    TNotificationTypeSetting,
    TNotificationProviderDefaults,
    TReadState,
    TNotificationAppearancePreference,
    TDocNotificationSetting,
    TReadNotificationAction,
    TCreateNotificationAction
  )

  builder.mixin(notification.class.AppPushNotification, core.class.Class, core.mixin.TransientConfiguration, {
    broadcastOnly: true
  })

  builder.createDoc(
    setting.class.SettingsCategory,
    core.space.Model,
    {
      name: 'notifications',
      label: notification.string.Notifications,
      icon: notification.icon.Notifications,
      component: notification.component.NotificationSettings,
      group: 'settings-account',
      role: AccountRole.Guest,
      order: 1500
    },
    notification.ids.NotificationSettings
  )

  builder.createDoc(
    workbench.class.Application,
    core.space.Model,
    {
      label: notification.string.Inbox,
      icon: notification.icon.Notifications,
      locationDataResolver: notification.function.LocationDataResolver,
      alias: notificationId,
      hidden: true,
      locationResolver: notification.resolver.Location,
      component: notification.component.Inbox,
      order: 50
    },
    notification.app.Inbox
  )

  builder.mixin(notification.class.DocNotifyContext, core.class.Class, view.mixin.ObjectPresenter, {
    presenter: notification.component.DocNotifyContextPresenter
  })

  builder.mixin(notification.class.AppPushNotification, core.class.Class, core.mixin.TxAccessLevel, {
    removeAccessLevel: AccountRole.Guest
  })

  builder.mixin(notification.class.NotificationTypeSetting, core.class.Class, core.mixin.TxAccessLevel, {
    createAccessLevel: AccountRole.Guest,
    updateAccessLevel: AccountRole.Guest,
    removeAccessLevel: AccountRole.Guest
  })

  builder.mixin(notification.class.NotificationProviderSetting, core.class.Class, core.mixin.TxAccessLevel, {
    createAccessLevel: AccountRole.Guest,
    updateAccessLevel: AccountRole.Guest,
    removeAccessLevel: AccountRole.Guest
  })

  builder.mixin(notification.class.DocNotifyContext, core.class.Class, core.mixin.TxAccessLevel, {
    createAccessLevel: AccountRole.Guest,
    updateAccessLevel: AccountRole.Guest,
    removeAccessLevel: AccountRole.Guest
  })

  builder.mixin(notification.class.ReadNotificationAction, core.class.Class, core.mixin.TransientConfiguration, {
    broadcastOnly: true
  })
  builder.mixin(notification.class.CreateNotificationAction, core.class.Class, core.mixin.TransientConfiguration, {
    broadcastOnly: true
  })

  builder.mixin(notification.class.ReadNotificationAction, core.class.Class, core.mixin.TxAccessLevel, {
    createAccessLevel: AccountRole.Guest
  })
  builder.mixin(notification.class.CreateNotificationAction, core.class.Class, core.mixin.TxAccessLevel, {
    createAccessLevel: AccountRole.Admin
  })

  builder.createDoc(core.class.DomainIndexConfiguration, core.space.Model, {
    domain: DOMAIN_DOC_NOTIFY,
    indexes: [{ keys: { user: 1 } }],
    disabled: [
      { _class: 1 },
      { modifiedOn: 1 },
      { modifiedBy: 1 },
      { createdBy: 1 },
      { isViewed: 1 },
      { hidden: 1 },
      { createdOn: -1 },
      { attachedTo: 1 },
      { space: 1 }
    ]
  })
  builder.createDoc(core.class.DomainIndexConfiguration, core.space.Model, {
    domain: DOMAIN_USER_NOTIFY,
    indexes: [{ keys: { user: 1 } }],
    disabled: [
      { _class: 1 },
      { modifiedOn: 1 },
      { modifiedBy: 1 },
      { createdBy: 1 },
      { isViewed: 1 },
      { hidden: 1 },
      { createdOn: -1 },
      { attachedTo: 1 }
    ]
  })
  builder.createDoc(core.class.DomainIndexConfiguration, core.space.Model, {
    domain: DOMAIN_USER_NOTIFY,
    indexes: [],
    disabled: [
      { _class: 1 },
      { modifiedOn: 1 },
      { modifiedBy: 1 },
      { createdBy: 1 },
      { isViewed: 1 },
      { hidden: 1 },
      { createdOn: -1 },
      { attachedTo: 1 }
    ]
  })

  builder.mixin<Class<DocNotifyContext>, IndexingConfiguration<DocNotifyContext>>(
    notification.class.DocNotifyContext,
    core.class.Class,
    core.mixin.IndexConfiguration,
    {
      searchDisabled: true,
      indexes: []
    }
  )

  builder.mixin<Class<ReadState>, IndexingConfiguration<ReadState>>(
    notification.class.ReadState,
    core.class.Class,
    core.mixin.IndexConfiguration,
    {
      searchDisabled: true,
      indexes: []
    }
  )

  builder.mixin<Class<AppPushNotification>, IndexingConfiguration<AppPushNotification>>(
    notification.class.AppPushNotification,
    core.class.Class,
    core.mixin.IndexConfiguration,
    {
      searchDisabled: true,
      indexes: []
    }
  )

  builder.mixin<Class<AppPushNotification>, IndexingConfiguration<AppPushNotification>>(
    notification.class.AppPushNotification,
    core.class.Class,
    core.mixin.IndexConfiguration,
    {
      searchDisabled: true,
      indexes: []
    }
  )

  builder.mixin<Class<PushSubscription>, IndexingConfiguration<PushSubscription>>(
    notification.class.PushSubscription,
    core.class.Class,
    core.mixin.IndexConfiguration,
    {
      searchDisabled: true,
      indexes: []
    }
  )

  builder.createDoc(notification.class.NotificationPreferencesGroup, core.space.Model, {
    label: notification.string.General,
    icon: notification.icon.Notifications,
    presenter: notification.component.GeneralPreferencesGroup
  })

  builder.createDoc(notification.class.NotificationPreferencesGroup, core.space.Model, {
    label: notification.string.Webpushes,
    icon: view.icon.Card,
    presenter: notification.component.WebpushesPreferencesPresenter
  })

  builder.createDoc(
    notification.class.NotificationProvider,
    core.space.Model,
    {
      icon: notification.icon.Inbox,
      label: notification.string.Inbox,
      description: notification.string.InboxNotificationsDescription,
      defaultEnabled: true,
      canDisable: false,
      order: 100
    },
    notification.providers.InboxNotificationProvider
  )

  builder.createDoc(
    notification.class.NotificationProvider,
    core.space.Model,
    {
      icon: notification.icon.Notifications,
      label: notification.string.Push,
      description: notification.string.PushNotificationsDescription,
      depends: notification.providers.InboxNotificationProvider,
      defaultEnabled: true,
      canDisable: true,
      order: 200
    },
    notification.providers.PushNotificationProvider
  )

  builder.createDoc(
    notification.class.NotificationProvider,
    core.space.Model,
    {
      icon: notification.icon.Notifications,
      label: notification.string.Sound,
      description: notification.string.SoundNotificationsDescription,
      depends: notification.providers.PushNotificationProvider,
      defaultEnabled: true,
      canDisable: true,
      order: 250
    },
    notification.providers.SoundNotificationProvider
  )

  defineNotifications(builder)
  defineActions(builder)
}
