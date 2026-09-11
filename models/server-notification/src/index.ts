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

import { type Builder, Mixin } from '@hcengineering/model'

import contact from '@hcengineering/contact'
import core from '@hcengineering/core'
import { TNotificationType } from '@hcengineering/model-notification'
import notification from '@hcengineering/notification'
import serverCore from '@hcengineering/server-core'
import serverNotification, {
  type CreateTxNotificationResource,
  type NotificationIntlProviderResource,
  type TypeMatch,
  type TypeMatchFuncResource
} from '@hcengineering/server-notification'

export { serverNotificationId } from '@hcengineering/server-notification'

@Mixin(serverNotification.mixin.TypeMatch, notification.class.NotificationType)
export class TTypeMatch extends TNotificationType implements TypeMatch {
  match?: TypeMatchFuncResource
  create?: CreateTxNotificationResource
  contentProvider?: NotificationIntlProviderResource
}

export function createModel (builder: Builder): void {
  builder.createModel(TTypeMatch)

  builder.createDoc(serverCore.class.Trigger, core.space.Model, {
    trigger: serverNotification.trigger.OnAttributeCreate,
    txMatch: {
      objectClass: core.class.Attribute,
      _class: core.class.TxCreateDoc
    }
  })

  builder.createDoc(serverCore.class.Trigger, core.space.Model, {
    trigger: serverNotification.trigger.OnAttributeUpdate,
    txMatch: {
      objectClass: core.class.Attribute,
      _class: core.class.TxUpdateDoc
    }
  })

  builder.createDoc(serverCore.class.Trigger, core.space.Model, {
    trigger: serverNotification.trigger.OnDocRemove,
    txMatch: {
      _class: core.class.TxRemoveDoc
    }
  })

  builder.createDoc(serverCore.class.Trigger, core.space.Model, {
    trigger: serverNotification.trigger.OnDocUpdate,
    txMatch: {
      _class: core.class.TxUpdateDoc
    }
  })

  builder.createDoc(serverCore.class.Trigger, core.space.Model, {
    trigger: serverNotification.trigger.OnEmployeeDeactivate,
    isAsync: true,
    txMatch: {
      _class: core.class.TxMixin,
      mixin: contact.mixin.Employee
    }
  })

  builder.mixin(
    notification.ids.MeAddedInCollaboratorsNotification,
    notification.class.NotificationType,
    serverNotification.mixin.TypeMatch,
    {
      match: serverNotification.function.MeAddedInCollaboratorsNotificationTypeMatch
    }
  )

  builder.mixin(
    notification.ids.MeRemovedFromCollaboratorsNotification,
    notification.class.NotificationType,
    serverNotification.mixin.TypeMatch,
    {
      match: serverNotification.function.MeRemovedFromCollaboratorsNotificationTypeMatch
    }
  )

  builder.createDoc(serverCore.class.Trigger, core.space.Model, {
    trigger: serverNotification.trigger.OnDocCreated,
    txMatch: {
      _class: core.class.TxCreateDoc
    },
    isAsync: false
  })

  builder.createDoc(serverCore.class.Trigger, core.space.Model, {
    trigger: serverNotification.trigger.OnDocSpaceChanged,
    txMatch: {
      _class: core.class.TxUpdateDoc
    },
    isAsync: true
  })

  builder.createDoc(serverCore.class.Trigger, core.space.Model, {
    trigger: serverNotification.trigger.OnDocClassChanged,
    txMatch: {
      _class: core.class.TxUpdateDoc
    },
    isAsync: true
  })
}
