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

import activity, { type ActivityMessage, type Reaction } from '@hcengineering/activity'
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
  type IndexingConfiguration,
  type Markup,
  type PersonId,
  type Ref,
  type Space,
  type Timestamp,
  type TxCUD,
  type AnyAttribute,
  type Tx
} from '@hcengineering/core'
import {
  Index,
  Mixin,
  Model,
  Prop,
  TypeAccountUuid,
  TypeBoolean,
  TypeDate,
  TypeIntlString,
  TypeMarkup,
  TypeRef,
  type Builder
} from '@hcengineering/model'
import core, { TAttachedDoc, TClass, TDoc } from '@hcengineering/model-core'
import preference, { TPreference } from '@hcengineering/model-preference'
import view from '@hcengineering/model-view'
import workbench from '@hcengineering/model-workbench'
import {
  DOMAIN_DOC_NOTIFY,
  DOMAIN_NOTIFICATION,
  DOMAIN_USER_NOTIFY,
  notificationId,
  type ActivityInboxNotification,
  type ActivityNotificationViewlet,
  type BrowserNotification,
  type CommonInboxNotification,
  type DocNotifyContext,
  type InboxNotification,
  type MentionInboxNotification,
  type NotificationContextPresenter,
  type NotificationGroup,
  type NotificationObjectPresenter,
  type NotificationPreferencesGroup,
  type NotificationPreview,
  type NotificationProvider,
  type NotificationProviderDefaults,
  type NotificationProviderSetting,
  type NotificationTemplate,
  type NotificationType,
  type NotificationTypeSetting,
  type PushSubscription,
  type PushSubscriptionKeys,
  type PushSubscriptionSetting,
  type ReactionInboxNotification,
  type MessageNotificationType,
  type TxNotificationType,
  DOMAIN_READ_STATE,
  type ReadState,
  type ReadPosition,
  type NotificationAppearancePreference
} from '@hcengineering/notification'
import { type Asset, type IntlString, type Resource } from '@hcengineering/platform'
import setting from '@hcengineering/setting'
import { type AnyComponent, type Location } from '@hcengineering/ui/src/types'

import notification from './plugin'
import { defineNotifications } from './notifications'
import { defineActions } from './actions'

export {
  DOMAIN_DOC_NOTIFY,
  DOMAIN_NOTIFICATION,
  DOMAIN_USER_NOTIFY,
  DOMAIN_READ_STATE,
  notificationId
} from '@hcengineering/notification'
export { notificationOperation } from './migration'
export { notification as default }
export { generateClassNotificationTypes } from './notifications'

@Model(notification.class.BrowserNotification, core.class.Doc, DOMAIN_TRANSIENT)
export class TBrowserNotification extends TDoc implements BrowserNotification {
  tag!: Ref<Doc<Space>>
  title!: IntlString
  body!: IntlString
  intlParams!: Record<string, any>
  intlParamsNotLocalized?: Record<string, IntlString>
  sender!: PersonId
  onClickLocation?: Location | undefined
  user!: AccountUuid
  messageId?: Ref<ActivityMessage>
  messageClass?: Ref<Class<ActivityMessage>>
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
  onlyOwn?: boolean
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

  declare space: Ref<PersonSpace>

  @Prop(TypeDate(), core.string.Date)
  lastView?: Timestamp

  @Prop(TypeDate(), core.string.Date)
  lastUpdate?: Timestamp

  @Prop(TypeDate(), core.string.Date)
  lastNotify?: Timestamp

  @Prop(TypeDate(), core.string.Date)
  lastNotifiedMessage?: Timestamp

  tx?: Ref<TxCUD<Doc>>
}

@Model(notification.class.ReadState, core.class.Doc, DOMAIN_READ_STATE)
export class TReadState extends TAttachedDoc implements ReadState {
  [key: AccountUuid]: ReadPosition
}

@Model(notification.class.InboxNotification, core.class.Doc, DOMAIN_NOTIFICATION)
export class TInboxNotification extends TDoc implements InboxNotification {
  @Prop(TypeRef(notification.class.DocNotifyContext), core.string.AttachedTo)
  @Index(IndexKind.Indexed)
  docNotifyContext!: Ref<DocNotifyContext>

  @Prop(TypeAccountUuid(), core.string.Account)
  @Index(IndexKind.Indexed)
  user!: AccountUuid

  @Prop(TypeBoolean(), core.string.Boolean)
  // @Index(IndexKind.Indexed)
  isViewed!: boolean

  @Prop(TypeBoolean(), core.string.Boolean)
  archived!: boolean

  objectId!: Ref<Doc>
  objectClass!: Ref<Class<Doc>>

  declare space: Ref<PersonSpace>

  allowedProviders!: Record<Ref<NotificationProvider>, Ref<NotificationType>[]>

  title?: IntlString
  body?: IntlString
  intlParams?: Record<string, string | number>
  intlParamsNotLocalized?: Record<string, IntlString>
}

@Model(notification.class.ActivityInboxNotification, notification.class.InboxNotification)
export class TActivityInboxNotification extends TInboxNotification implements ActivityInboxNotification {
  @Prop(TypeRef(activity.class.ActivityMessage), core.string.AttachedTo)
  attachedTo!: Ref<ActivityMessage>

  @Prop(TypeRef(activity.class.ActivityMessage), core.string.AttachedToClass)
  attachedToClass!: Ref<Class<ActivityMessage>>
}

@Model(notification.class.CommonInboxNotification, notification.class.InboxNotification)
export class TCommonInboxNotification extends TInboxNotification implements CommonInboxNotification {
  @Prop(TypeIntlString(), core.string.String)
  header?: IntlString

  @Prop(TypeRef(core.class.Doc), core.string.Object)
  headerObjectId?: Ref<Doc>

  @Prop(TypeRef(core.class.Doc), core.string.Class)
  headerObjectClass?: Ref<Class<Doc>>

  @Prop(TypeIntlString(), notification.string.Message)
  message?: IntlString

  headerIcon?: Asset

  @Prop(TypeMarkup(), notification.string.Message)
  markup?: Markup

  props?: Record<string, any>
  icon?: Asset
  iconProps?: Record<string, any>
}

@Model(notification.class.MentionInboxNotification, notification.class.CommonInboxNotification)
export class TMentionInboxNotification extends TCommonInboxNotification implements MentionInboxNotification {
  @Prop(TypeRef(core.class.Doc), core.string.Object)
  mentionedIn!: Ref<Doc>

  @Prop(TypeRef(core.class.Doc), core.string.Class)
  mentionedInClass!: Ref<Class<Doc>>
}

@Model(notification.class.ReactionInboxNotification, notification.class.CommonInboxNotification)
export class TReactionInboxNotification extends TCommonInboxNotification implements ReactionInboxNotification {
  emoji!: string
  ref!: Ref<Reaction>
  @Prop(TypeRef(activity.class.ActivityMessage), core.string.AttachedTo)
  attachedTo!: Ref<ActivityMessage>

  @Prop(TypeRef(activity.class.ActivityMessage), core.string.AttachedToClass)
  attachedToClass!: Ref<Class<ActivityMessage>>
}

@Model(notification.class.ActivityNotificationViewlet, core.class.Doc, DOMAIN_MODEL)
export class TActivityNotificationViewlet extends TDoc implements ActivityNotificationViewlet {
  messageMatch!: DocumentQuery<Doc>

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

export function createModel (builder: Builder): void {
  builder.createModel(
    TBrowserNotification,
    TNotificationType,
    TMessageNotificationType,
    TTxNotificationType,
    TNotificationGroup,
    TNotificationPreferencesGroup,
    TNotificationObjectPresenter,
    TNotificationPreview,
    TDocNotifyContext,
    TInboxNotification,
    TActivityInboxNotification,
    TCommonInboxNotification,
    TNotificationContextPresenter,
    TActivityNotificationViewlet,
    TNotificationType,
    TMentionInboxNotification,
    TPushSubscription,
    TPushSubscriptionSetting,
    TNotificationProvider,
    TNotificationProviderSetting,
    TNotificationTypeSetting,
    TNotificationProviderDefaults,
    TReactionInboxNotification,
    TReadState,
    TNotificationAppearancePreference
  )

  builder.mixin(notification.class.BrowserNotification, core.class.Class, core.mixin.TransientConfiguration, {
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

  builder.mixin(notification.class.ActivityInboxNotification, core.class.Class, view.mixin.ObjectPresenter, {
    presenter: notification.component.ActivityInboxNotificationPresenter
  })

  builder.mixin(notification.class.CommonInboxNotification, core.class.Class, view.mixin.ObjectPresenter, {
    presenter: notification.component.CommonInboxNotificationPresenter
  })
  builder.mixin(notification.class.MentionInboxNotification, core.class.Class, view.mixin.ObjectPresenter, {
    presenter: notification.component.MentionInboxNotificationPresenter
  })

  builder.mixin(notification.class.BrowserNotification, core.class.Class, core.mixin.TxAccessLevel, {
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

  builder.createDoc(core.class.DomainIndexConfiguration, core.space.Model, {
    domain: DOMAIN_NOTIFICATION,
    indexes: [{ keys: { user: 1, archived: 1, space: 1 } }],
    disabled: [{ modifiedOn: 1 }, { modifiedBy: 1 }, { createdBy: 1 }, { isViewed: 1 }, { hidden: 1 }]
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

  builder.mixin<Class<InboxNotification>, IndexingConfiguration<InboxNotification>>(
    notification.class.InboxNotification,
    core.class.Class,
    core.mixin.IndexConfiguration,
    {
      searchDisabled: true,
      indexes: []
    }
  )
  builder.mixin<Class<BrowserNotification>, IndexingConfiguration<BrowserNotification>>(
    notification.class.BrowserNotification,
    core.class.Class,
    core.mixin.IndexConfiguration,
    {
      searchDisabled: true,
      indexes: []
    }
  )

  builder.mixin<Class<BrowserNotification>, IndexingConfiguration<BrowserNotification>>(
    notification.class.BrowserNotification,
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
