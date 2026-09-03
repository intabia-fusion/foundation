// Copyright © 2022 Hardcore Engineering Inc.
// Copyright © 2026 Intabia Fusion.

import { Analytics } from '@hcengineering/analytics'
import core, {
  type Class,
  type Data,
  type Doc,
  type DocumentQuery,
  type FindResult,
  type Ref,
  type TxCUD
} from '@hcengineering/core'
import { type Asset } from '@hcengineering/platform'
import { getClient } from '@hcengineering/presentation'
import {
  type TagCategory,
  type TagElement,
  type TagElement as TagElementType,
  type TagReference,
  TagsEvents,
  findTagCategory
} from '@hcengineering/tags'
import { type ColorDefinition, getColorNumberByText } from '@hcengineering/ui'
import { type AttributeApplierResult, type Filter } from '@hcengineering/view'
import { FilterQuery } from '@hcengineering/view-resources'
import { writable } from 'svelte/store'
import tags from './plugin'

export function getTagStyle (color: ColorDefinition, selected = false): string {
  return `
    background: ${color.color + (selected ? 'ff' : '33')};
    border: 1px solid ${color.color + (selected ? 'ff' : '66')};
    color: ${color.title ?? 'var(--theme-caption-color)'};
  `
}

export async function getRefs (filter: Filter, onUpdate: () => void): Promise<Array<Ref<Doc>>> {
  const lq = FilterQuery.getLiveQuery(filter.index)
  const promise = new Promise<Array<Ref<Doc>>>((resolve, reject) => {
    const level = filter.props?.level ?? 0
    const q: DocumentQuery<TagReference> = {
      tag: { $in: filter.value }
    }
    if (level > 0) {
      q.weight = { $gte: level as TagReference['weight'] }
    }
    const refresh = lq.query(tags.class.TagReference, q, (refs: FindResult<TagReference>) => {
      const result = Array.from(new Set(refs.map((p) => p.attachedTo)))
      FilterQuery.results.set(filter.index, result)
      resolve(result)
      onUpdate()
    })
    if (!refresh) {
      resolve(FilterQuery.results.get(filter.index) ?? [])
    }
  })
  return await promise
}

export const tagLevel: Record<0 | 1 | 2 | 3, Asset> = {
  3: tags.icon.Level3,
  2: tags.icon.Level2,
  1: tags.icon.Level1,
  0: tags.icon.Tags
}

/**
 * @public
 */
export interface TagElementInfo {
  count: number
  modifiedOn: number
}

/**
 * @public
 */
export const selectedTagElements = writable<Array<Ref<TagElement>>>([])

/**
 * Task type classes extend the base one (Issue, Lead...), tags are bound to the class declaring the attribute.
 * @public
 */
export function getTagsTargetClass (_class: Ref<Class<Doc>>, key: string = 'labels'): Ref<Class<Doc>> {
  return getClient().getHierarchy().findAttribute(_class, key)?.attributeOf ?? _class
}

/**
 * @public
 */
export async function createTagElement (
  title: string,
  targetClass: Ref<Class<Doc>>,
  category?: Ref<TagCategory> | null,
  description?: string | null,
  color?: number | null,
  keyTitle?: string
): Promise<Ref<TagElement>> {
  const client = getClient()

  // Callers pick the category from a query that can still be pending when the user submits. There is
  // no TagCategory with the NoCategory id, and TagsPopup renders tags only inside a category group -
  // so a tag that falls back to it is stored fine and then never shows up in the list again.
  if (category == null) {
    const categories = await client.findAll(tags.class.TagCategory, { targetClass })
    if (categories.length > 0) {
      category = findTagCategory(title, categories)
    }
  }

  const tagElement: Data<TagElement> = {
    title,
    description: description ?? '',
    targetClass,
    color: color ?? getColorNumberByText(title),
    category: category ?? tags.category.NoCategory
  }

  const ref = await client.createDoc<TagElement>(tags.class.TagElement, core.space.Workspace, tagElement)
  Analytics.handleEvent(TagsEvents.TagCreated, { key: keyTitle, id: ref })
  return ref
}

export async function labelsApplier (
  doc: Doc,
  value: Array<Ref<TagElementType>> | undefined
): Promise<AttributeApplierResult<Doc>> {
  if (!Array.isArray(value)) return {}

  const client = getClient()
  const txes: Array<TxCUD<Doc>> = []

  const existing = (await client.findAll(tags.class.TagReference, { attachedTo: doc._id })) as TagReference[]
  const existingTagIds = existing.map((it) => it.tag)

  const toAdd = value.filter((tagId) => !existingTagIds.includes(tagId))
  const toRemove = existing.filter((it) => !value.includes(it.tag))

  if (toAdd.length > 0) {
    const tagElements = await client.findAll(tags.class.TagElement, { _id: { $in: toAdd } })
    const tagElementsMap = new Map(tagElements.map((el) => [el._id, el]))

    for (const tagId of toAdd) {
      const tagElement = tagElementsMap.get(tagId)
      const createTx = client.txFactory.createTxCreateDoc(tags.class.TagReference, doc.space, {
        attachedTo: doc._id,
        attachedToClass: doc._class,
        collection: 'labels',
        tag: tagId,
        title: tagElement?.title ?? '',
        color: tagElement?.color ?? 0
      })
      const tx = client.txFactory.createTxCollectionCUD(doc._class, doc._id, doc.space, 'labels', createTx)
      txes.push(tx)
    }
  }

  for (const it of toRemove) {
    const removeTx = client.txFactory.createTxRemoveDoc(tags.class.TagReference, it.space, it._id)
    const tx = client.txFactory.createTxCollectionCUD(doc._class, doc._id, doc.space, 'labels', removeTx)
    txes.push(tx)
  }

  return { txes }
}
