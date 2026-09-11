//
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

import { type ActivityMessage, type Reaction } from '@hcengineering/activity'
import { type PersonSpace } from '@hcengineering/contact'
import {
  type AccountUuid,
  type Class,
  type Doc,
  type Domain,
  type Markup,
  type Ref,
  type Space,
  type Timestamp,
  type TxCUD
} from '@hcengineering/core'
import { type DocNotificationMode, type NotificationProvider, type NotificationType } from '@hcengineering/notification'
import { type Asset, type IntlString } from '@hcengineering/platform'

export const DOMAIN_NOTIFICATION = 'notification' as Domain
export const DOMAIN_CONTACT = 'contact' as Domain

export interface InboxNotification extends Doc<PersonSpace> {
  user: AccountUuid
  isViewed: boolean

  docNotifyContext: Ref<DocNotifyContextOld>
  objectId: Ref<Doc>
  objectClass: Ref<Class<Doc>>

  // For browser notifications
  title?: IntlString
  body?: IntlString
  message?: IntlString
  data?: Markup
  intlParams?: Record<string, string | number>
  intlParamsNotLocalized?: Record<string, IntlString>
  archived: boolean

  allowedProviders: Record<Ref<NotificationProvider>, Ref<NotificationType>[]>
}

export interface ActivityInboxNotification extends InboxNotification {
  attachedTo: Ref<ActivityMessage>
  attachedToClass: Ref<Class<ActivityMessage>>
}

export interface CommonInboxNotification extends InboxNotification {
  header?: IntlString
  headerIcon?: Asset
  headerObjectId?: Ref<Doc>
  headerObjectClass?: Ref<Class<Doc>>
  message?: IntlString
  markup?: Markup
  icon?: Asset
  iconProps?: Record<string, any>
  props?: Record<string, any>
}

export interface ReactionInboxNotification extends CommonInboxNotification {
  emoji: string
  ref: Ref<Reaction>
  attachedTo: Ref<ActivityMessage>
  attachedToClass: Ref<Class<ActivityMessage>>
}

export interface MentionInboxNotification extends CommonInboxNotification {
  mentionedIn: Ref<Doc>
  mentionedInClass: Ref<Class<Doc>>
}

export interface DocNotifyContextOld extends Doc<PersonSpace> {
  user: AccountUuid
  // Context
  objectId: Ref<Doc>
  objectClass: Ref<Class<Doc>>
  objectSpace: Ref<Space>

  lastView?: Timestamp
  lastUpdate?: Timestamp
  lastNotify?: Timestamp
  lastNotifiedMessage?: Timestamp

  // Only for debug
  tx?: Ref<TxCUD<Doc>>

  settings?: {
    mode?: DocNotificationMode
  }
}
