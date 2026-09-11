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

import { type Builder } from '@hcengineering/model'

import core from '@hcengineering/core'
import lead from '@hcengineering/model-lead'
import notification, { type NotificationType } from '@hcengineering/notification'
import serverLead from '@hcengineering/server-lead'
import serverNotification, { type TypeMatch } from '@hcengineering/server-notification'
import serverActivity from '@hcengineering/server-activity'

export { serverLeadId } from '@hcengineering/server-lead'

export function createModel (builder: Builder): void {
  builder.mixin(lead.class.Lead, core.class.Class, serverActivity.mixin.UrlPresenter, {
    presenter: serverLead.function.LeadUrlPresenter
  })

  builder.mixin(lead.class.Lead, core.class.Class, serverActivity.mixin.IdentifierPresenter, {
    presenter: serverLead.function.LeadIdentifierPresenter,
    triggerFields: ['number']
  })

  builder.mixin<NotificationType, TypeMatch>(
    lead.ids.AssigneeNotification,
    notification.class.MessageNotificationType,
    serverNotification.mixin.TypeMatch,
    {
      match: serverNotification.function.IsUserFieldValueTypeMatch
    }
  )
}
