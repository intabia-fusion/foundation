//
// Copyright © 2022, 2023 Hardcore Engineering Inc.
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

import { type Builder } from '@hcengineering/model'

import core, { type Class, type Doc } from '@hcengineering/core'
import chunter from '@hcengineering/chunter'
import serverNotification, { type TypeMatch } from '@hcengineering/server-notification'
import serverCore, { type ObjectDDParticipant } from '@hcengineering/server-core'
import serverChunter from '@hcengineering/server-chunter'
import notification, { type NotificationType } from '@hcengineering/notification'
import serverActivity from '@hcengineering/server-activity'
import contact from '@hcengineering/contact'

export { serverChunterId } from '@hcengineering/server-chunter'

export function createModel (builder: Builder): void {
  builder.mixin(chunter.class.ChunterSpace, core.class.Class, serverActivity.mixin.UrlPresenter, {
    presenter: serverChunter.function.ChannelUrlPresenter
  })

  builder.mixin(chunter.class.Channel, core.class.Class, serverActivity.mixin.TitlePresenter, {
    presenter: serverChunter.function.ChannelTitlePresenter,
    triggerFields: ['name']
  })

  builder.mixin(chunter.class.DirectMessage, core.class.Class, serverActivity.mixin.TitlePresenter, {
    presenter: serverChunter.function.DirectTitlePresenter,
    triggerFields: ['name', 'members'],
    personalized: true
  })

  builder.mixin(chunter.class.DirectMessage, core.class.Class, serverActivity.mixin.LabelPresenter, {
    presenter: serverChunter.function.DirectLabelPresenter,
    triggerFields: ['type']
  })

  builder.mixin(chunter.class.Channel, core.class.Class, serverActivity.mixin.IconPresenter, {
    presenter: serverChunter.function.ChannelIconPresenter,
    triggerFields: ['private', 'emoji', 'icon']
  })

  builder.mixin(chunter.class.DirectMessage, core.class.Class, serverActivity.mixin.IconPresenter, {
    presenter: serverChunter.function.DirectIconPresenter,
    triggerFields: ['members'],
    personalized: true
  })

  builder.mixin<Class<Doc>, ObjectDDParticipant>(
    chunter.class.ChatMessage,
    core.class.Class,
    serverCore.mixin.ObjectDDParticipant,
    {
      collectDocs: serverChunter.function.CommentRemove
    }
  )

  builder.createDoc(serverCore.class.Trigger, core.space.Model, {
    trigger: serverChunter.trigger.ChunterTrigger
  })

  builder.createDoc(serverCore.class.Trigger, core.space.Model, {
    trigger: serverChunter.trigger.OnCollaboratorAdded,
    txMatch: {
      objectClass: core.class.Collaborator,
      _class: core.class.TxCreateDoc
    },
    isAsync: true
  })

  builder.createDoc(serverCore.class.Trigger, core.space.Model, {
    trigger: serverChunter.trigger.OnCollaboratorRemoved,
    txMatch: {
      objectClass: core.class.Collaborator,
      _class: core.class.TxRemoveDoc
    },
    isAsync: true
  })

  builder.createDoc(serverCore.class.Trigger, core.space.Model, {
    trigger: serverChunter.trigger.OnUserStatus,
    txMatch: {
      objectClass: core.class.UserStatus
    },
    isAsync: true
  })

  builder.createDoc(serverCore.class.Trigger, core.space.Model, {
    trigger: serverChunter.trigger.OnPersonNameChanged,
    txMatch: {
      objectClass: contact.class.Person,
      _class: core.class.TxUpdateDoc,
      'operations.name': { $exists: true }
    },
    isAsync: true
  })

  builder.mixin<NotificationType, TypeMatch>(
    chunter.ids.JoinChannelNotification,
    notification.class.MessageNotificationType,
    serverNotification.mixin.TypeMatch,
    {
      match: serverChunter.function.JoinChannelTypeMatch
    }
  )

  builder.mixin(chunter.class.Chat, core.class.Class, serverCore.mixin.SearchPresenter, {
    title: [['func', serverChunter.function.ChatSearchTitleProvider, 'title']],
    shortTitle: [['func', serverChunter.function.ChatSearchTitleProvider, 'short']]
  })

  builder.mixin(chunter.class.Channel, core.class.Class, serverCore.mixin.SearchPresenter, {
    title: [['name']]
  })
}
