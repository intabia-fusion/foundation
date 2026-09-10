//
// Copyright © 2023 Hardcore Engineering Inc.
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
  type AttachedDoc,
  type Attribute,
  type Class,
  type Client,
  type Collection,
  type Doc,
  type Hierarchy,
  type Mixin,
  type Ref,
  SortingOrder
} from '@hcengineering/core'
import view, { type AttributeModel } from '@hcengineering/view'
import { getClient, getFiltredKeys } from '@hcengineering/presentation'
import {
  buildRemovedDoc,
  getAttributePresenter,
  getDocLinkTitle,
  hasAttributePresenter
} from '@hcengineering/view-resources'
import { type Person } from '@hcengineering/contact'
import { getResource, type IntlString } from '@hcengineering/platform'
import { type AnyComponent } from '@hcengineering/ui'
import activity, {
  type ActivityMessage,
  type ActivityMessagesFilter,
  type DocAttributeUpdates,
  type DocUpdateMessage
} from '@hcengineering/activity'

import { ActivityDirection } from './types'

const valueTypes: ReadonlyArray<Ref<Class<Doc>>> = [
  core.class.TypeString,
  core.class.EnumOf,
  core.class.TypeNumber,
  core.class.TypeDate,
  core.class.TypeFileSize,
  core.class.TypeMarkup,
  core.class.TypeHyperlink
]

export async function getAttributeValues (client: Client, values: any[], attrClass: Ref<Class<Doc>>): Promise<any[]> {
  if (values.some((value) => typeof value !== 'string')) {
    return values
  }

  if (valueTypes.includes(attrClass)) {
    return values
  }

  const docs = await client.findAll(attrClass, { _id: { $in: values } })
  const docIds = docs.map(({ _id }) => _id)
  const missedIds = values.filter((value) => !docIds.includes(value))
  const removedDocs = await Promise.all(missedIds.map(async (value) => await buildRemovedDoc(client, value, attrClass)))
  const allDocs = [...docs, ...removedDocs].filter((doc) => !(doc == null))

  if (allDocs.length > 0) {
    return allDocs
  }

  return values
}

export function getCollectionAttribute (
  hierarchy: Hierarchy,
  objectClass: Ref<Class<Doc>>,
  collection?: string
): Attribute<Collection<AttachedDoc>> | undefined {
  if (collection === undefined) {
    return undefined
  }

  const descendants = hierarchy.getDescendants(objectClass)

  for (const descendant of descendants) {
    const collectionAttribute = hierarchy.findAttribute(descendant, collection)
    if (collectionAttribute !== undefined) {
      return collectionAttribute
    }
  }

  return undefined
}

async function getAttributePresenterSafe (
  client: Client,
  _class: Ref<Class<Doc>>,
  attrKey: string,
  mixin?: Ref<Mixin<Doc>>
): Promise<AttributeModel | undefined> {
  try {
    return await getAttributePresenter(client, _class, attrKey, { key: attrKey }, mixin)
  } catch (e) {
    console.error(e)
  }
}

export async function getAttributeModel (
  client: Client,
  attributeUpdates: DocAttributeUpdates | undefined,
  objectClass: Ref<Class<Doc>>
): Promise<AttributeModel | undefined> {
  if (attributeUpdates === undefined) {
    return undefined
  }

  const hierarchy = client.getHierarchy()

  const { attrKey, attrClass, isMixin } = attributeUpdates
  let attrObjectClass = objectClass

  if (isMixin) {
    const keyedAttribute = getFiltredKeys(hierarchy, attrClass, []).find(({ key }) => key === attrKey)
    if (keyedAttribute === undefined) {
      return undefined
    }
    attrObjectClass = keyedAttribute.attr.attributeOf
  }

  const model = await getAttributePresenterSafe(client, attrObjectClass, attrKey, view.mixin.ActivityAttributePresenter)

  if (model !== undefined) {
    return model
  }

  return await getAttributePresenterSafe(client, attrObjectClass, attrKey)
}

export function hasAttributeModel (
  client: Client,
  attributeUpdates: DocAttributeUpdates | undefined,
  objectClass: Ref<Class<Doc>>
): boolean {
  if (attributeUpdates === undefined) {
    return false
  }

  const hierarchy = client.getHierarchy()

  try {
    const { attrKey, attrClass, isMixin } = attributeUpdates
    let attrObjectClass = objectClass
    if (isMixin) {
      const keyedAttribute = getFiltredKeys(hierarchy, attrClass, []).find(({ key }) => key === attrKey)
      if (keyedAttribute === undefined) {
        return false
      }
      attrObjectClass = keyedAttribute.attr.attributeOf
    }

    const hasActivityAttrPresenter = hasAttributePresenter(
      client,
      attrObjectClass,
      attrKey,
      view.mixin.ActivityAttributePresenter
    )

    if (hasActivityAttrPresenter) {
      return true
    }
    return hasAttributePresenter(client, attrObjectClass, attrKey)
  } catch (e) {
    return false
  }
}

type ActivityMessageDate = Pick<ActivityMessage, 'createdOn' | 'modifiedOn'>
export function activityMessagesComparator<T extends ActivityMessageDate> (message1: T, message2: T): number {
  const time1 = getMessageTime(message1)
  const time2 = getMessageTime(message2)

  return time1 - time2
}

function getMessageTime<T extends ActivityMessageDate> (message: T): number {
  return message.createdOn ?? message.modifiedOn
}

export function sortActivityMessages<T extends ActivityMessageDate> (
  messages: T[],
  order: SortingOrder = SortingOrder.Ascending
): T[] {
  return messages.sort((message1, message2) =>
    order === SortingOrder.Ascending
      ? activityMessagesComparator(message1, message2)
      : activityMessagesComparator(message2, message1)
  )
}

export function referencesFilter (message: ActivityMessage, _class?: Ref<Doc>): boolean {
  return message._class === activity.class.ActivityReference
}

export function attributesFilter (message: ActivityMessage, _class?: Ref<Doc>): boolean {
  if (message._class === activity.class.DocUpdateMessage) {
    return (message as DocUpdateMessage).objectClass === _class
  }

  return false
}

export function pinnedFilter (message: ActivityMessage, _class?: Ref<Doc>): boolean {
  return message.isPinned === true
}

export interface LinkData {
  title?: string
  preposition: IntlString
  panelComponent: AnyComponent
  object: Doc
}

export async function getLinkData (
  message: ActivityMessage,
  object: Doc | undefined,
  parentObject: Doc | undefined,
  person: Person | undefined,
  lang: string
): Promise<LinkData | undefined> {
  const client = getClient()
  const hierarchy = client.getHierarchy()

  let linkObject: Doc | undefined

  if (hierarchy.isDerived(message.attachedToClass, activity.class.ActivityMessage)) {
    linkObject = parentObject
  } else if (message._class === activity.class.DocUpdateMessage) {
    linkObject = (message as DocUpdateMessage).action === 'update' ? object : (parentObject ?? object)
  } else {
    linkObject = parentObject ?? object
  }

  if (linkObject === undefined) {
    return undefined
  }

  if (person?._id === linkObject._id) {
    return undefined
  }

  const title = await getDocLinkTitle(client, linkObject._id, linkObject._class, linkObject, lang)

  const preposition = hierarchy.classHierarchyMixin(linkObject._class, activity.mixin.ActivityDoc)?.preposition
  const panelComponent = hierarchy.classHierarchyMixin(linkObject._class, view.mixin.ObjectPanel)

  return {
    title,
    preposition: preposition ?? activity.string.In,
    panelComponent: panelComponent?.component ?? view.component.EditDoc,
    object: linkObject
  }
}

export function isActivityMessage (message?: Doc): message is ActivityMessage {
  if (message === undefined) {
    return false
  }

  return getClient().getHierarchy().isDerived(message._class, activity.class.ActivityMessage)
}

export function isActivityMessageClass (_class?: Ref<Class<Doc>>): boolean {
  if (_class === undefined) {
    return false
  }

  return getClient().getHierarchy().isDerived(_class, activity.class.ActivityMessage)
}

export async function filterMessages (
  _class: Ref<Class<Doc>>,
  messages: ActivityMessage[],
  filters: ActivityMessagesFilter[],
  enabledFilters: Array<Ref<ActivityMessagesFilter>>,
  direction: ActivityDirection
): Promise<ActivityMessage[]> {
  const sortOrder = direction === ActivityDirection.Backward ? SortingOrder.Descending : SortingOrder.Ascending
  const baseComparator = (m1: ActivityMessage, m2: ActivityMessage): number =>
    sortOrder === SortingOrder.Ascending ? activityMessagesComparator(m1, m2) : activityMessagesComparator(m2, m1)

  const sorted = messages.sort((message1, message2) => {
    const isPinned1 = message1.isPinned ?? false
    const isPinned2 = message2.isPinned ?? false
    return isPinned1 === isPinned2 ? baseComparator(message1, message2) : Number(isPinned2) - Number(isPinned1)
  })

  if (filters.every((it) => enabledFilters.includes(it._id))) return sorted

  const selectedFilters = filters.filter((filter) => enabledFilters.includes(filter._id))
  const filterActions: Array<(message: ActivityMessage, _class?: Ref<Doc>) => boolean> = []
  for (const filter of selectedFilters) {
    const fltr = await getResource(filter.filter)
    filterActions.push(fltr)
  }
  return sorted.filter((message) => filterActions.some((f) => f(message, _class)))
}
