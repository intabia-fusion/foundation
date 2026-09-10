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

import { Class, Doc } from '@hcengineering/core'
import { IntlString, Resource } from '@hcengineering/platform'
import { TriggerControl } from '@hcengineering/server-core'

export type PresenterControl = Pick<
  TriggerControl,
  'hierarchy' | 'ctx' | 'modelDb' | 'findAll' | 'branding' | 'workspace'
>
export type Presenter<T extends Doc = any> = (doc: T, control: PresenterControl) => Promise<string | undefined>

export interface TitlePresenter<T extends Doc = any> extends Class<T> {
  presenter: Resource<Presenter<T>>
}

export interface IdentifierPresenter<T extends Doc = any> extends Class<T> {
  presenter: Resource<Presenter<T>>
}

export interface UrlPresenter<T extends Doc = any> extends Class<T> {
  presenter: Resource<Presenter<T>>
}

export type AttributePresenterFn<T extends Doc = Doc, V = any> = (
  doc: T,
  attributeValue: V,
  control: PresenterControl,
  lang?: string
) => Promise<
  | {
    intlString?: IntlString
    value: any
  }
  | undefined
>

export interface AttributePresenter<T extends Doc = Doc> extends Doc {
  attribute: string
  presenter: Resource<AttributePresenterFn<T>>
}
