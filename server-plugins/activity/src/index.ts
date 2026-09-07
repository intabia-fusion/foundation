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

import { Plugin, Resource, plugin } from '@hcengineering/platform'
import type { TriggerFunc } from '@hcengineering/server-core'
import { Class, Mixin, Ref } from '@hcengineering/core'

import { IdentifierPresenter, TitlePresenter, UrlPresenter, AttributePresenter } from './types'

export * from './types'

/**
 * @public
 */
export const serverActivityId = 'server-activity' as Plugin

/**
 * @public
 */
export default plugin(serverActivityId, {
  trigger: {
    OnDocRemoved: '' as Resource<TriggerFunc>,
    OnDocClassChanged: '' as Resource<TriggerFunc>,
    ReferenceTrigger: '' as Resource<TriggerFunc>
  },
  class: {
    AttributePresenter: '' as Ref<Class<AttributePresenter>>
  },
  mixin: {
    TitlePresenter: '' as Ref<Mixin<TitlePresenter>>,
    UrlPresenter: '' as Ref<Mixin<UrlPresenter>>,
    IdentifierPresenter: '' as Ref<Mixin<IdentifierPresenter>>
  }
})
