//
// Copyright © 2023 Hardcore Engineering Inc.
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

import { type Builder, Mixin, Model } from '@hcengineering/model'
import serverCore from '@hcengineering/server-core'
import core, { DOMAIN_MODEL } from '@hcengineering/core'
import serverActivity, {
  type IdentifierPresenter,
  type StringPresenterFn,
  type IconPresenterFn,
  type TitlePresenter,
  type UrlPresenter,
  type IntlStringPresenterFn,
  type LabelPresenter,
  type AttributePresenter,
  type AttributePresenterFn,
  type IconPresenter
} from '@hcengineering/server-activity'
import { TClass, TDoc } from '@hcengineering/model-core'
import activity from '@hcengineering/activity'
import notification from '@hcengineering/notification'
import type { Resource } from '@hcengineering/platform'

export { activityServerOperation } from './migration'
export { serverActivityId } from '@hcengineering/server-activity'

@Mixin(serverActivity.mixin.TitlePresenter, core.class.Class)
export class TTitlePresenter extends TClass implements TitlePresenter {
  presenter!: Resource<StringPresenterFn>
  triggerFields!: string[]
  personalized?: boolean
}

@Mixin(serverActivity.mixin.LabelPresenter, core.class.Class)
export class TLabelPresenter extends TClass implements LabelPresenter {
  presenter!: Resource<IntlStringPresenterFn>
  triggerFields!: string[]
}

@Mixin(serverActivity.mixin.IdentifierPresenter, core.class.Class)
export class TIdentifierPresenter extends TClass implements IdentifierPresenter {
  presenter!: Resource<StringPresenterFn>
  triggerFields!: string[]
}

@Mixin(serverActivity.mixin.UrlPresenter, core.class.Class)
export class TUrlPresenter extends TClass implements UrlPresenter {
  presenter!: Resource<StringPresenterFn>
  triggerFields!: string[]
}

@Mixin(serverActivity.mixin.IconPresenter, core.class.Class)
export class TIconPresenter extends TClass implements IconPresenter {
  presenter!: Resource<IconPresenterFn>
  triggerFields!: string[]
  personalized?: boolean
}

@Model(serverActivity.class.AttributePresenter, core.class.Doc, DOMAIN_MODEL)
export class TAttributePresenter extends TDoc implements AttributePresenter {
  attribute!: string
  presenter!: Resource<AttributePresenterFn>
}

export function createModel (builder: Builder): void {
  builder.createModel(
    TIdentifierPresenter,
    TUrlPresenter,
    TTitlePresenter,
    TAttributePresenter,
    TIconPresenter,
    TLabelPresenter
  )

  builder.createDoc(serverCore.class.Trigger, core.space.Model, {
    trigger: serverActivity.trigger.OnDocRemoved,
    isAsync: true
  })

  builder.createDoc(serverCore.class.Trigger, core.space.Model, {
    trigger: serverActivity.trigger.OnDocClassChanged,
    txMatch: {
      _class: core.class.TxUpdateDoc
    },
    isAsync: true
  })

  builder.createDoc(serverCore.class.Trigger, core.space.Model, {
    trigger: serverActivity.trigger.ReferenceTrigger,
    txMatch: {
      objectClass: { $ne: activity.class.ActivityReference },
      attachedToClass: {
        $nin: [
          notification.class.ReadState,
          notification.class.DocNotifyContext,
          notification.class.AppPushNotification
        ]
      }
    },
    isAsync: true
  })
}
