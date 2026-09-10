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

import { AccountUuid, Class, Doc } from '@hcengineering/core'
import { Asset, IntlString, Resource } from '@hcengineering/platform'
import { TriggerControl } from '@hcengineering/server-core'

export type PresenterControl = Pick<
  TriggerControl,
  'hierarchy' | 'ctx' | 'modelDb' | 'findAll' | 'branding' | 'workspace'
>

export interface PresenterOptions {
  account?: AccountUuid
  lang?: string
}

export interface Icon {
  asset?: Asset
  emoji?: number | number[]
  props?: Record<string, any>
}

export type StringPresenterFn<T extends Doc = Doc> = (
  doc: T,
  control: PresenterControl,
  options?: PresenterOptions
) => Promise<string | undefined>
export type IntlStringPresenterFn<T extends Doc = Doc> = (
  doc: T,
  control: PresenterControl,
  options?: PresenterOptions
) => Promise<IntlString | undefined>

export type IconPresenterFn<T extends Doc = Doc> = (
  doc: T,
  control: PresenterControl,
  options?: PresenterOptions
) => Promise<Icon>

export interface TitlePresenter<T extends Doc = Doc> extends Class<T> {
  presenter: Resource<StringPresenterFn<T>>
  triggerFields: string[]
  personalized?: boolean
}

export interface LabelPresenter<T extends Doc = Doc> extends Class<T> {
  presenter: Resource<IntlStringPresenterFn<T>>
  triggerFields: string[]
}

export interface IdentifierPresenter<T extends Doc = Doc> extends Class<T> {
  presenter: Resource<StringPresenterFn<T>>
  triggerFields: string[]
}

export interface UrlPresenter<T extends Doc = Doc> extends Class<T> {
  presenter: Resource<StringPresenterFn<T>>
}

export interface IconPresenter<T extends Doc = Doc> extends Class<T> {
  presenter: Resource<IconPresenterFn<T>>
  triggerFields: string[]
  personalized?: boolean
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
