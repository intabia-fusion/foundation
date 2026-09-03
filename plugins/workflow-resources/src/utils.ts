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

import core, {
  type Doc,
  type RefTo,
  type AnyAttribute,
  type Hierarchy,
  type Collection,
  type AttachedDoc,
  type Ref,
  type Class,
  type Mixin,
  notEmpty,
  ClassifierKind
} from '@hcengineering/core'
import { type Asset, type IntlString, translate } from '@hcengineering/platform'
import { type IconComponent } from '@hcengineering/ui'
import { getClient } from '@hcengineering/presentation'

export interface DisplayAttribute {
  id: Ref<AnyAttribute>
  key: string
  label: string
  collection: boolean
  icon?: IconComponent
  iconProps?: Record<string, any>
  mixin?: Ref<Class<Mixin<Doc>>>
}

export interface DisplayAttributeGroup {
  _class: Ref<Class<Doc>>
  classLabel: string
  regular: DisplayAttribute[]
  collection: DisplayAttribute[]
}

export function getAllClassAttributes (hierarchy: Hierarchy, _class: Ref<Class<Doc>>): AnyAttribute[] {
  const mixins = hierarchy
    .getDescendants(_class)
    .map((it) => hierarchy.findClass(it))
    .filter(notEmpty)
    .filter((it) => it._id !== _class && it.kind === ClassifierKind.MIXIN)

  const targetClasses: Array<Ref<Class<Doc>>> = [_class, ...mixins.map((it) => it._id)]
  const result: AnyAttribute[] = []
  const processedAttrs = new Set<string>()

  for (const targetClass of targetClasses) {
    const attrs = hierarchy.getAllAttributes(targetClass)
    for (const attr of attrs.values()) {
      if (processedAttrs.has(attr._id)) continue
      processedAttrs.add(attr._id)
      result.push(attr)
    }
  }

  return result
}

export function getAttributeIcon (
  hierarchy: Hierarchy,
  attr: AnyAttribute
): {
    icon?: Asset
    iconProps?: Record<string, any>
  } {
  if (hierarchy.isDerived(attr.type._class, core.class.RefTo)) {
    const refTo = attr.type as RefTo<Doc>
    const toClass = hierarchy.findClass(refTo.to)
    return {
      icon: attr.icon ?? toClass?.icon ?? attr.type?.icon,
      iconProps: attr.iconProps
    }
  } else if (hierarchy.isDerived(attr.type._class, core.class.Collection)) {
    const refTo = attr.type as Collection<AttachedDoc>
    const ofClass = hierarchy.findClass(refTo.of)
    return {
      icon: attr.icon ?? ofClass?.icon ?? attr.type?.icon,
      iconProps: attr.iconProps
    }
  }
  return {
    icon: attr.icon ?? attr.type?.icon,
    iconProps: attr.iconProps
  }
}

const buildAttributeDisplayItem = async (
  hierarchy: Hierarchy,
  it: AnyAttribute,
  collection: boolean,
  lang: string,
  mixin?: Ref<Class<Mixin<Doc>>>
): Promise<DisplayAttribute> => {
  if (hierarchy.isDerived(it.type._class, core.class.RefTo)) {
    const refTo = it.type as RefTo<Doc>
    const toClass = hierarchy.findClass(refTo.to)
    return {
      id: it._id,
      key: it.name,
      label: await translate(it.label, {}, lang),
      icon: it.icon ?? toClass?.icon ?? it.type?.icon,
      iconProps: it.iconProps,
      collection,
      mixin
    }
  } else if (hierarchy.isDerived(it.type._class, core.class.Collection)) {
    const refTo = it.type as Collection<AttachedDoc> & { itemLabel?: IntlString }
    const ofClass = hierarchy.findClass(refTo.of)
    const isComments = it.name === 'comments'
    const labelIntl = (
      isComments ? (refTo.itemLabel ?? ofClass?.label ?? ofClass?.shortLabel ?? it.label) : it.label
    ) as IntlString
    return {
      id: it._id,
      key: it.name,
      label: await translate(labelIntl, {}, lang),
      icon: it.icon ?? ofClass?.icon ?? it.type?.icon,
      iconProps: it.iconProps,
      collection,
      mixin
    }
  }
  return {
    id: it._id,
    key: it.name,
    label: await translate(it.label, {}, lang),
    icon: it.icon ?? it.type?.icon,
    iconProps: it.iconProps,
    collection,
    mixin
  }
}

export async function getDisplayAttributes (
  _class: Ref<Class<Doc>>,
  lang: string,
  skipFields: string[] = [],
  skipTypes: Array<Ref<Class<Doc>>> = []
): Promise<DisplayAttributeGroup[]> {
  const client = getClient()
  const hierarchy = client.getHierarchy()

  const mixins = hierarchy
    .getDescendants(_class)
    .map((it) => hierarchy.findClass(it))
    .filter(notEmpty)
    .filter((it) => it._id !== _class && it.kind === ClassifierKind.MIXIN)

  const targetClasses: Array<Ref<Class<Doc>>> = [_class, ...mixins.map((it) => it._id)]
  const result: DisplayAttributeGroup[] = []

  const processedAttrs = new Set<string>()

  for (const targetClass of targetClasses) {
    const targetClazz = hierarchy.findClass(targetClass)
    const classLabel =
      targetClazz != null ? await translate(targetClazz.label ?? targetClazz.shortLabel ?? targetClass, {}, lang) : ''

    const isMixin = targetClass !== _class
    const mixin = isMixin ? (targetClass as Ref<Class<Mixin<Doc>>>) : undefined

    const attrs = Array.from(hierarchy.getAllAttributes(targetClass).values()).filter(
      (it) =>
        it.hidden !== true &&
        it.readonly !== true &&
        it.automationOnly !== true &&
        it.type?._class !== core.class.TypeIdentifier &&
        !hierarchy.isDerived(it.type._class, core.class.TypeIdentifier) &&
        !processedAttrs.has(it._id) &&
        !processedAttrs.has(it.name) &&
        !skipFields.includes(it.name) &&
        !skipTypes.includes(it.type._class)
    )

    for (const it of attrs) {
      processedAttrs.add(it._id)
      processedAttrs.add(it.name)
    }

    const regularAttrs: typeof attrs = []
    const collectionAttrs: typeof attrs = []

    for (const it of attrs) {
      if (hierarchy.isDerived(it.type._class, core.class.Collection) || it.type._class === core.class.ArrOf) {
        collectionAttrs.push(it)
      } else {
        regularAttrs.push(it)
      }
    }

    const regularItems = await Promise.all(
      regularAttrs.map(async (it) => await buildAttributeDisplayItem(hierarchy, it, false, lang, mixin))
    )
    const collectionItems = await Promise.all(
      collectionAttrs.map(async (it) => await buildAttributeDisplayItem(hierarchy, it, true, lang, mixin))
    )

    regularItems.sort((a, b) => a.label.localeCompare(b.label, lang))
    collectionItems.sort((a, b) => a.label.localeCompare(b.label, lang))

    if (targetClass === _class || regularItems.length > 0 || collectionItems.length > 0) {
      result.push({
        _class: targetClass,
        classLabel,
        regular: regularItems,
        collection: collectionItems
      })
    }
  }

  result.sort((a, b) => {
    if (a._class === _class) return -1
    if (b._class === _class) return 1

    const isMixinA = hierarchy.isDerived(a._class, core.class.Mixin)
    const isMixinB = hierarchy.isDerived(b._class, core.class.Mixin)

    if (isMixinA !== isMixinB) {
      return isMixinA ? -1 : 1
    }

    return a.classLabel.localeCompare(b.classLabel, lang)
  })

  return result
}
