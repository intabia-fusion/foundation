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

import type { Plugin, Resource } from '@hcengineering/platform'
import { plugin } from '@hcengineering/platform'
import { ObjectDDParticipantFunc, SearchPresenterProvider, TriggerFunc } from '@hcengineering/server-core'
import { TypeMatchFuncResource } from '@hcengineering/server-notification'
import { IconPresenterFn, IntlStringPresenterFn, StringPresenterFn } from '@hcengineering/server-activity'

export const serverChunterId = 'server-chunter' as Plugin
export { ChunterMiddleware } from './middleware'

export default plugin(serverChunterId, {
  trigger: {
    ChunterTrigger: '' as Resource<TriggerFunc>,
    OnUserStatus: '' as Resource<TriggerFunc>,
    OnCollaboratorAdded: '' as Resource<TriggerFunc>,
    OnCollaboratorRemoved: '' as Resource<TriggerFunc>,
    OnPersonNameChanged: '' as Resource<TriggerFunc>
  },
  function: {
    CommentRemove: '' as Resource<ObjectDDParticipantFunc>,
    ChannelUrlPresenter: '' as Resource<StringPresenterFn>,
    ChannelTitlePresenter: '' as Resource<StringPresenterFn>,
    DirectTitlePresenter: '' as Resource<StringPresenterFn>,
    DirectLabelPresenter: '' as Resource<IntlStringPresenterFn>,
    ChatSearchTitleProvider: '' as Resource<SearchPresenterProvider>,
    ChannelIconPresenter: '' as Resource<IconPresenterFn>,
    DirectIconPresenter: '' as Resource<IconPresenterFn>,
    JoinChannelTypeMatch: '' as TypeMatchFuncResource
  }
})
