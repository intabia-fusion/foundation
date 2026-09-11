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

import { Doc } from '@hcengineering/core'
import type { Plugin, Resource } from '@hcengineering/platform'
import { plugin } from '@hcengineering/platform'
import { TriggerFunc } from '@hcengineering/server-core'
import { NotificationIntlProvider } from '@hcengineering/server-notification'
import { IconPresenterFn, type StringPresenterFn, type AttributePresenterFn } from '@hcengineering/server-activity'

/**
 * @public
 */
export const serverTrackerId = 'server-tracker' as Plugin

/**
 * @public
 */
export default plugin(serverTrackerId, {
  function: {
    IssueIdentifierPresenter: '' as Resource<StringPresenterFn>,
    IssueUrlPresenter: '' as Resource<StringPresenterFn>,
    IssueNotificationContentProvider: '' as Resource<NotificationIntlProvider>,
    IssueLinkIdProvider: '' as Resource<(doc: Doc) => Promise<string>>,
    IssueIconPresenter: '' as Resource<IconPresenterFn>,
    IssueStatusPresenter: '' as Resource<AttributePresenterFn>,
    IssuePriorityPresenter: '' as Resource<AttributePresenterFn>,
    TimeSpendReportTitlePresenter: '' as Resource<StringPresenterFn>
  },
  trigger: {
    OnIssueUpdate: '' as Resource<TriggerFunc>,
    OnComponentRemove: '' as Resource<TriggerFunc>,
    OnProjectRemove: '' as Resource<TriggerFunc>
  }
})
