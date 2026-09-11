/**
 Copyright © 2026 Intabia Fusion.

 Licensed under the Eclipse Public License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License. You may
 obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

 See the License for the specific language governing permissions and
 limitations under the License.
 */

import { Class, Doc, Hierarchy, Ref } from '@hcengineering/core'
import activity, { type ActivityMessage, DocUpdateMessage } from '@hcengineering/activity'
import { getResource, IntlString, translate } from '@hcengineering/platform'
import { isEmptyMarkup, markupToText } from '@hcengineering/text-core'

import { serverActivityPlugin as serverActivity } from './plugin'
import type {
  Icon,
  IconPresenter,
  IdentifierPresenter,
  LabelPresenter,
  PresenterControl,
  PresenterOptions,
  TitlePresenter,
  UrlPresenter
} from './types'

export function isActivityDoc (_class: Ref<Class<Doc>>, hierarchy: Hierarchy): boolean {
  const mixin = hierarchy.classHierarchyMixin(_class, activity.mixin.ActivityDoc)

  return mixin !== undefined
}

export function getUrlPresenter (_class: Ref<Class<Doc>>, hierarchy: Hierarchy): UrlPresenter | undefined {
  return hierarchy.classHierarchyMixin(_class, serverActivity.mixin.UrlPresenter)
}

export function getIdentifierPresenter (_class: Ref<Class<Doc>>, hierarchy: Hierarchy): IdentifierPresenter | undefined {
  return hierarchy.classHierarchyMixin(_class, serverActivity.mixin.IdentifierPresenter)
}

export function getTitlePresenter (_class: Ref<Class<Doc>>, hierarchy: Hierarchy): TitlePresenter | undefined {
  return hierarchy.classHierarchyMixin(_class, serverActivity.mixin.TitlePresenter)
}

export function getLabelPresenter (_class: Ref<Class<Doc>>, hierarchy: Hierarchy): LabelPresenter | undefined {
  return hierarchy.classHierarchyMixin(_class, serverActivity.mixin.LabelPresenter)
}

export function getIconPresenter (_class: Ref<Class<Doc>>, hierarchy: Hierarchy): IconPresenter | undefined {
  return hierarchy.classHierarchyMixin(_class, serverActivity.mixin.IconPresenter)
}

export async function getDocTitle (
  control: PresenterControl,
  doc: Doc,
  options?: PresenterOptions
): Promise<string | undefined> {
  const MAX_MESSAGE_LENGTH = 100

  if (
    control.hierarchy.isDerived(doc._class, activity.class.DocUpdateMessage) &&
    (doc as DocUpdateMessage).messageIntl != null
  ) {
    const dum = doc as DocUpdateMessage
    if (dum.messageIntl != null) {
      const params = { ...dum.intlParams }

      for (const [key, value] of Object.entries(dum.intlParamsNotLocalized ?? {})) {
        if (typeof value === 'string' && value.includes(':')) {
          params[key] = await translate(value, params, options?.lang ?? control.branding?.defaultLanguage)
        } else {
          params[key] = value
        }
      }
      const text = await translate(dum.messageIntl, params, options?.lang ?? control.branding?.defaultLanguage)
      const normalized = text.length > MAX_MESSAGE_LENGTH ? text.slice(0, MAX_MESSAGE_LENGTH) + '...' : text
      if (text.length > 0) {
        return normalized
      }
    }
  } else if (control.hierarchy.isDerived(doc._class, activity.class.ActivityMessage)) {
    const message = doc as ActivityMessage
    if (message.message != null && !isEmptyMarkup(message.message)) {
      const text = markupToText(message.message).trim()
      const normalized = text.length > MAX_MESSAGE_LENGTH ? text.slice(0, MAX_MESSAGE_LENGTH).trim() + '...' : text
      if (text.length > 0) {
        return normalized
      }
    }

    return 'message'
  }

  const TitlePresenter = getTitlePresenter(doc._class, control.hierarchy)

  if (TitlePresenter !== undefined) {
    return await (
      await getResource(TitlePresenter.presenter)
    )(doc, control, options)
  }

  const clazz = control.hierarchy.getClass(doc._class)
  if (clazz.titleKey != null) {
    return (doc as any)[clazz.titleKey] ?? undefined
  }
}

export async function getDocLabel (control: PresenterControl, doc: Doc): Promise<IntlString | undefined> {
  const LabelPresenter = getLabelPresenter(doc._class, control.hierarchy)

  if (LabelPresenter === undefined) return
  return await (
    await getResource(LabelPresenter.presenter)
  )(doc, control)
}

export async function getDocIdentifier (control: PresenterControl, doc: Doc): Promise<string | undefined> {
  const IdentifierPresenter = getIdentifierPresenter(doc._class, control.hierarchy)

  if (IdentifierPresenter === undefined) return
  return await (
    await getResource(IdentifierPresenter.presenter)
  )(doc, control)
}

export async function getDocUrl (control: PresenterControl, doc: Doc): Promise<string | undefined> {
  const UrlPresenter = getUrlPresenter(doc._class, control.hierarchy)
  if (UrlPresenter === undefined) return
  return await (
    await getResource(UrlPresenter.presenter)
  )(doc, control)
}

export async function getDocIcon (
  control: PresenterControl,
  doc: Doc,
  options?: PresenterOptions
): Promise<Icon | undefined> {
  const IconPresenter = getIconPresenter(doc._class, control.hierarchy)
  if (IconPresenter === undefined) return
  return await (
    await getResource(IconPresenter.presenter)
  )(doc, control, options)
}
