//
// Copyright © 2022 Hardcore Engineering Inc.
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

import core from '@hcengineering/core'
import { type Builder } from '@hcengineering/model'
import tracker from '@hcengineering/model-tracker'
import notification, { type NotificationType } from '@hcengineering/notification'
import serverCore from '@hcengineering/server-core'
import serverNotification, { type TypeMatch } from '@hcengineering/server-notification'
import serverTracker from '@hcengineering/server-tracker'
import serverView from '@hcengineering/server-view'
import serverActivity from '@hcengineering/server-activity'

export { serverTrackerId } from '@hcengineering/server-tracker'

export function createModel (builder: Builder): void {
  builder.mixin(tracker.class.Issue, core.class.Class, serverActivity.mixin.IdentifierPresenter, {
    presenter: serverTracker.function.IssueIdentifierPresenter,
    triggerFields: ['seqNumber', 'prefix']
  })

  builder.mixin(tracker.class.Issue, core.class.Class, serverActivity.mixin.UrlPresenter, {
    presenter: serverTracker.function.IssueUrlPresenter
  })

  builder.mixin(tracker.class.Issue, core.class.Class, serverActivity.mixin.IconPresenter, {
    presenter: serverTracker.function.IssueIconPresenter,
    triggerFields: ['space', 'status', 'kind']
  })

  builder.createDoc(serverActivity.class.AttributePresenter, core.space.Model, {
    attribute: 'status',
    presenter: serverTracker.function.IssueStatusPresenter
  })

  builder.createDoc(serverActivity.class.AttributePresenter, core.space.Model, {
    attribute: 'priority',
    presenter: serverTracker.function.IssuePriorityPresenter
  })

  builder.mixin(tracker.class.TimeSpendReport, core.class.Class, serverActivity.mixin.TitlePresenter, {
    presenter: serverTracker.function.TimeSpendReportTitlePresenter,
    triggerFields: ['value']
  })

  builder.mixin(tracker.class.Issue, core.class.Class, serverView.mixin.ServerLinkIdProvider, {
    encode: serverTracker.function.IssueLinkIdProvider
  })

  builder.mixin(tracker.class.Issue, core.class.Class, serverCore.mixin.SearchPresenter, {
    iconConfig: {
      component: tracker.component.IssueSearchIcon,
      fields: [['status'], ['space']]
    },
    shortTitle: [['identifier']],
    title: [['title']]
  })

  builder.createDoc(serverCore.class.Trigger, core.space.Model, {
    trigger: serverTracker.trigger.OnIssueUpdate,
    txMatch: {
      objectClass: { $in: [tracker.class.Issue, tracker.class.TimeSpendReport] }
    }
  })

  builder.createDoc(serverCore.class.Trigger, core.space.Model, {
    trigger: serverTracker.trigger.OnComponentRemove,
    txMatch: {
      _class: core.class.TxRemoveDoc,
      objectClass: tracker.class.Component
    }
  })

  builder.createDoc(serverCore.class.Trigger, core.space.Model, {
    trigger: serverTracker.trigger.OnProjectRemove,
    txMatch: {
      _class: core.class.TxRemoveDoc,
      objectClass: tracker.class.Project
    }
  })

  builder.mixin<NotificationType, TypeMatch>(
    tracker.ids.AssigneeNotification,
    notification.class.MessageNotificationType,
    serverNotification.mixin.TypeMatch,
    {
      match: serverNotification.function.IsUserFieldValueTypeMatch
    }
  )
}
