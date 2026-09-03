//
// Copyright © 2025 Hardcore Engineering Inc.
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

import activity from '@hcengineering/activity'
import card, { Card, cardId, MasterTag, Tag } from '@hcengineering/card'
import contact, { Employee } from '@hcengineering/contact'
import core, {
  AnyAttribute,
  ArrOf,
  Class,
  concatLink,
  Data,
  Doc,
  DocumentUpdate,
  fillDefaults,
  getDiffUpdate,
  Mixin,
  MixinUpdate,
  PersonId,
  Ref,
  RefTo,
  splitMixinUpdate,
  Tx,
  TxCreateDoc,
  TxMixin,
  TxProcessor,
  TxRemoveDoc,
  TxUpdateDoc
} from '@hcengineering/core'
import { getMetadata, translate } from '@hcengineering/platform'
import serverCore, { TriggerControl } from '@hcengineering/server-core'
import setting from '@hcengineering/setting'
import view, { type BuildModelKey, type Viewlet } from '@hcengineering/view'
import { workbenchId } from '@hcengineering/workbench'
import notification, { NotificationGroup } from '@hcengineering/notification'
import {
  getClassNotificationGroup,
  generateAttributeNotificationType
} from '@hcengineering/server-notification-resources'
import { StringPresenterFn, PresenterControl } from '@hcengineering/server-activity'

type ViewletConfigItem = BuildModelKey | string
interface IndexedViewletConfigItem {
  item: ViewletConfigItem
  index: number
}

function getViewletConfigKey (item: ViewletConfigItem): string {
  return typeof item === 'string' ? item : item.key
}

function getAttributeKey (key: string): string {
  if (key.startsWith('$lookup.')) {
    return key.slice('$lookup.'.length)
  }
  const dotIndex = key.lastIndexOf('.')
  return dotIndex === -1 ? key : key.slice(dotIndex + 1)
}

function isSourceAttribute (control: TriggerControl, sourceClass: Ref<Class<Doc>>, key: string): boolean {
  return control.hierarchy.getAllAttributes(sourceClass).has(getAttributeKey(key))
}

function syncViewletConfigOrder (
  control: TriggerControl,
  sourceClass: Ref<Class<Doc>>,
  previousSourceConfig: ViewletConfigItem[],
  sourceConfig: ViewletConfigItem[],
  targetConfig: ViewletConfigItem[]
): ViewletConfigItem[] {
  const sourceKeys = new Set(sourceConfig.map(getViewletConfigKey))
  const previousSourceKeys = new Set(previousSourceConfig.map(getViewletConfigKey))
  const targetByKey = new Map<string, IndexedViewletConfigItem[]>()
  for (const [index, item] of targetConfig.entries()) {
    const key = getViewletConfigKey(item)
    const items = targetByKey.get(key) ?? []
    items.push({ item, index })
    targetByKey.set(key, items)
  }

  const sourceItems: ViewletConfigItem[] = []
  const usedIndexes = new Set<number>()
  for (const sourceItem of sourceConfig) {
    const key = getViewletConfigKey(sourceItem)
    const targetItem = targetByKey.get(key)?.shift()
    const item = targetItem?.item ?? sourceItem
    sourceItems.push(item)
    if (targetItem !== undefined) {
      usedIndexes.add(targetItem.index)
    }
  }

  const synced = [...sourceItems]
  for (const [index, targetItem] of targetConfig.entries()) {
    if (usedIndexes.has(index)) continue

    const key = getViewletConfigKey(targetItem)
    if (!sourceKeys.has(key) && (previousSourceKeys.has(key) || isSourceAttribute(control, sourceClass, key))) {
      continue
    }

    synced.splice(Math.min(index, synced.length), 0, targetItem)
  }

  return synced
}

function isConfigOrderChanged (current: ViewletConfigItem[], next: ViewletConfigItem[]): boolean {
  return current.length !== next.length || current.some((item, index) => item !== next[index])
}

async function OnAttribute (ctx: TxCreateDoc<AnyAttribute>[], control: TriggerControl): Promise<Tx[]> {
  const attr = TxProcessor.createDoc2Doc(ctx[0])
  if (control.hierarchy.isDerived(attr.attributeOf, card.class.Card)) {
    const desc = control.hierarchy.getDescendants(attr.attributeOf)
    const res: Tx[] = []
    for (const des of desc) {
      const viewlets = control.modelDb.findAllSync(view.class.Viewlet, { attachTo: des, variant: { $exists: false } })
      for (const viewlet of viewlets) {
        const updatedConfig = [...viewlet.config]
        // let push it after grow for the list
        if (viewlet.descriptor === view.viewlet.RelationshipTable) continue
        if (viewlet.descriptor === view.viewlet.List) {
          const index = viewlet.config.findIndex((p) => typeof p !== 'string' && p.displayProps?.grow === true)
          if (index !== -1) {
            updatedConfig.splice(index + 1, 0, attr.name)
          } else {
            updatedConfig.push(attr.name)
          }
        } else {
          updatedConfig.push(attr.name)
        }
        res.push(
          control.txFactory.createTxUpdateDoc(viewlet._class, viewlet.space, viewlet._id, {
            config: updatedConfig
          })
        )

        const prefs = await control.findAll(control.ctx, view.class.ViewletPreference, { attachedTo: viewlet._id })
        for (const pref of prefs) {
          const updatedPrefConfig = [...pref.config]
          if (viewlet.descriptor === view.viewlet.List) {
            const index = updatedPrefConfig.findIndex((p) => typeof p !== 'string' && p.displayProps?.grow === true)
            if (index !== -1) {
              updatedPrefConfig.splice(index + 1, 0, attr.name)
            } else {
              updatedPrefConfig.push(attr.name)
            }
          } else {
            updatedPrefConfig.push(attr.name)
          }
          res.push(
            control.txFactory.createTxUpdateDoc(pref._class, pref.space, pref._id, {
              config: updatedPrefConfig
            })
          )
        }
      }
    }
    return res
  }
  return []
}

async function OnAttributeRemove (ctx: TxRemoveDoc<AnyAttribute>[], control: TriggerControl): Promise<Tx[]> {
  const attr = control.removedMap.get(ctx[0].objectId) as AnyAttribute
  if (attr === undefined) return []
  if (control.hierarchy.isDerived(attr.attributeOf, card.class.Card)) {
    const desc = control.hierarchy.getDescendants(attr.attributeOf)
    const forbidden = new Set(desc.map((d) => `${d}.${attr.name}`))
    forbidden.add(attr.name)

    const res: Tx[] = []
    const viewlets = control.modelDb.findAllSync(view.class.Viewlet, {})
    for (const viewlet of viewlets) {
      const filteredConfig = viewlet.config.filter((p) => {
        const key = typeof p === 'string' ? p : (p as any).key
        return !forbidden.has(key)
      })
      if (filteredConfig.length !== viewlet.config.length) {
        res.push(
          control.txFactory.createTxUpdateDoc(viewlet._class, viewlet.space, viewlet._id, {
            config: filteredConfig
          })
        )
      }
    }
    const prefs = await control.findAll(control.ctx, view.class.ViewletPreference, {})
    for (const pref of prefs) {
      const filteredPrefConfig = pref.config.filter((p) => {
        const key = typeof p === 'string' ? p : (p as any).key
        return !forbidden.has(key)
      })
      if (filteredPrefConfig.length !== pref.config.length) {
        res.push(
          control.txFactory.createTxUpdateDoc(pref._class, pref.space, pref._id, {
            config: filteredPrefConfig
          })
        )
      }
    }
    return res
  }
  return []
}

async function OnViewletUpdate (ctx: TxUpdateDoc<Viewlet>[], control: TriggerControl): Promise<Tx[]> {
  const updateTx = ctx[0]
  if (updateTx.space === core.space.DerivedTx) return []
  if (!Array.isArray(updateTx.operations.config)) return []

  const sourceViewlet = (await control.findAll<Viewlet>(control.ctx, view.class.Viewlet, { _id: updateTx.objectId }))[0]
  if (sourceViewlet === undefined) return []
  if (!control.hierarchy.isDerived(sourceViewlet.attachTo, card.class.Card)) return []

  const descendants = control.hierarchy
    .getDescendants(sourceViewlet.attachTo)
    .filter((it) => it !== sourceViewlet.attachTo)
  if (descendants.length === 0) return []

  const childViewlets = await control.findAll<Viewlet>(control.ctx, view.class.Viewlet, {
    attachTo: { $in: descendants },
    descriptor: sourceViewlet.descriptor,
    variant: sourceViewlet.variant ?? { $exists: false }
  })

  const res: Tx[] = []
  for (const childViewlet of childViewlets) {
    const config = syncViewletConfigOrder(
      control,
      sourceViewlet.attachTo,
      sourceViewlet.config,
      updateTx.operations.config,
      childViewlet.config
    )
    if (!isConfigOrderChanged(childViewlet.config, config)) continue

    res.push(
      control.txFactory.createTxUpdateDoc(childViewlet._class, childViewlet.space, childViewlet._id, {
        config
      })
    )
  }

  return res
}

async function OnMasterTagRemove (ctx: TxUpdateDoc<MasterTag>[], control: TriggerControl): Promise<Tx[]> {
  const updateTx = ctx[0]
  if (updateTx.space === core.space.DerivedTx) return []
  if (updateTx.operations.removed !== true) return []
  const res: Tx[] = []
  const desc = control.hierarchy.getDescendants(updateTx.objectId)
  // should remove objects if masterTag
  const cards = await control.findAll<Card>(control.ctx, updateTx.objectId, {})
  for (const doc of cards) {
    res.push(control.txFactory.createTxRemoveDoc(card.class.Card, doc.space, doc._id))
  }
  for (const des of desc) {
    res.push(...(await removeTagRelations(control, des)))
  }
  const spaces = await control.findAll(control.ctx, card.class.CardSpace, {
    types: updateTx.objectId
  })
  for (const space of spaces) {
    res.push(
      control.txFactory.createTxUpdateDoc(space._class, space.space, space._id, {
        types: space.types.filter((t) => t !== updateTx.objectId)
      })
    )
  }
  for (const des of desc) {
    if (des === updateTx.objectId) continue
    const _class = control.hierarchy.findClass(des)
    if (_class === undefined) continue
    if (_class._class === card.class.MasterTag) {
      res.push(
        control.txFactory.createTxUpdateDoc<MasterTag>(card.class.MasterTag, core.space.Model, des, {
          removed: true
        })
      )
    } else {
      res.push(control.txFactory.createTxRemoveDoc(card.class.Tag, core.space.Model, des))
    }
  }

  return res
}

async function OnTagRemove (ctx: TxRemoveDoc<Tag>[], control: TriggerControl): Promise<Tx[]> {
  const removeTx = ctx[0]
  const removedTag = control.removedMap.get(removeTx.objectId)
  if (removedTag === undefined) return []
  const res: Tx[] = []
  const desc = control.hierarchy.getDescendants(removeTx.objectId)

  for (const des of desc) {
    if (des === removeTx.objectId) continue
    res.push(control.txFactory.createTxRemoveDoc(card.class.Tag, core.space.Model, des))
  }

  res.push(...(await removeTagRelations(control, removeTx.objectId)))

  return res
}

async function removeTagRelations (control: TriggerControl, tag: Ref<Tag | MasterTag>): Promise<Tx[]> {
  const res: Tx[] = []
  const viewlets = await control.findAll(control.ctx, view.class.Viewlet, {
    attachTo: tag
  })
  for (const viewlet of viewlets) {
    res.push(control.txFactory.createTxRemoveDoc(viewlet._class, viewlet.space, viewlet._id))
  }
  const attributes = control.modelDb.findAllSync(core.class.Attribute, {
    attributeOf: tag
  })
  for (const attribute of attributes) {
    res.push(control.txFactory.createTxRemoveDoc(attribute._class, attribute.space, attribute._id))
  }
  const removedRelation = new Set()
  const relationsA = control.modelDb.findAllSync(core.class.Association, {
    classA: tag
  })
  for (const rel of relationsA) {
    removedRelation.add(rel._id)
    res.push(control.txFactory.createTxRemoveDoc(core.class.Association, core.space.Model, rel._id))
  }
  const relationsB = control.modelDb.findAllSync(core.class.Association, {
    classB: tag
  })
  for (const rel of relationsB) {
    if (removedRelation.has(rel._id)) continue
    res.push(control.txFactory.createTxRemoveDoc(core.class.Association, core.space.Model, rel._id))
  }
  return res
}

function extractObjectData<T extends Doc> (doc: T): Data<T> {
  const dataKeys = ['_id', 'space', 'modifiedOn', 'modifiedBy', 'createdBy', 'createdOn']
  const data: any = {}
  for (const key in doc) {
    if (dataKeys.includes(key)) {
      continue
    }
    data[key] = doc[key]
  }
  return data as Data<T>
}

async function createNotificationTypes (control: TriggerControl, tag: MasterTag): Promise<Tx[]> {
  const res: Tx[] = []
  const hierarchy = control.hierarchy

  const group = await getClassNotificationGroup(control, tag._id)
  const ignored = ['todos']
  const enabled = ['comments']
  const attributes = Array.from(hierarchy.getAllAttributes(tag._id, core.class.Doc).values()).filter(
    (p) => p.hidden !== true && p.readonly !== true
  )

  if (group != null) {
    for (const attr of attributes) {
      if (ignored.includes(attr.name)) continue
      const current = (
        await control.findAll(control.ctx, notification.class.MessageNotificationType, {
          attribute: attr._id,
          group: group.parent ?? group._id
        })
      )[0]
      if (current == null) {
        res.push(...generateAttributeNotificationType(control, attr, group, enabled.includes(attr.name)))
      }
    }
  } else {
    const createTx = control.txFactory.createTxCreateDoc(notification.class.NotificationGroup, core.space.Model, {
      label: tag.label,
      icon: tag.icon ?? card.icon.Card,
      objectClass: tag._id,
      parent: card.ids.CardNotificationGroup as Ref<NotificationGroup>
    })
    res.push(createTx)
    const g = TxProcessor.createDoc2Doc(createTx)
    for (const attr of attributes) {
      if (ignored.includes(attr.name)) continue
      res.push(...generateAttributeNotificationType(control, attr, g, enabled.includes(attr.name)))
    }
  }

  return res
}

async function OnMasterTagCreate (ctx: TxCreateDoc<MasterTag | Tag>[], control: TriggerControl): Promise<Tx[]> {
  const createTx = ctx[0]
  const tag = TxProcessor.createDoc2Doc(createTx)
  const res: Tx[] = []
  res.push(
    control.txFactory.createTxMixin(createTx.objectId, core.class.Mixin, core.space.Model, setting.mixin.Editable, {
      value: true
    })
  )
  res.push(
    control.txFactory.createTxMixin(createTx.objectId, core.class.Mixin, core.space.Model, setting.mixin.UserMixin, {})
  )

  if (tag._class === card.class.MasterTag) {
    res.push(...(await createNotificationTypes(control, tag as MasterTag)))
    const viewlets = await control.findAll(control.ctx, view.class.Viewlet, {
      attachTo: tag.extends,
      variant: { $exists: false }
    })
    const existingViewlets = await control.findAll(control.ctx, view.class.Viewlet, {
      attachTo: createTx.objectId,
      variant: { $exists: false }
    })
    for (const viewlet of viewlets) {
      if (existingViewlets.find((it) => it.descriptor === viewlet.descriptor) !== undefined) continue
      const base = extractObjectData(viewlet)
      res.push(
        control.txFactory.createTxCreateDoc(view.class.Viewlet, core.space.Model, {
          ...base,
          attachTo: createTx.objectId
        })
      )
    }
  }

  return res
}

async function OnCardRemove (ctx: TxRemoveDoc<Card>[], control: TriggerControl): Promise<Tx[]> {
  const removeTx = ctx[0]
  const removedCard = control.removedMap.get(removeTx.objectId) as Card
  if (removedCard === undefined) return []
  const res: Tx[] = []
  const cards = await control.findAll(control.ctx, card.class.Card, { parent: removedCard._id })
  for (const card of cards) {
    res.push(control.txFactory.createTxRemoveDoc(card._class, card.space, card._id))
  }

  const toDelete: string[] = []

  for (const key in removedCard.blobs ?? {}) {
    const val = removedCard.blobs[key]
    if (val === undefined) continue
    const toDelete: string[] = []
    toDelete.push(val.file)
  }

  if (toDelete.length > 0) {
    await control.storageAdapter.remove(control.ctx, control.workspace, toDelete)
  }

  if (removedCard.parent != null) {
    res.push(
      control.txFactory.createTxUpdateDoc(card.class.Card, core.space.Workspace, removedCard.parent, {
        $inc: {
          children: -1
        }
      })
    )
  }
  const favorites = await control.findAll(control.ctx, card.class.FavoriteCard, { attachedTo: removedCard._id })
  for (const favorite of favorites) {
    res.push(control.txFactory.createTxRemoveDoc(favorite._class, favorite.space, favorite._id))
  }

  return res
}

function unwrapPush (push: Record<string, any>): Record<string, any> {
  const res: Record<string, any> = {}
  for (const [key, value] of Object.entries(push)) {
    if (value.$each !== undefined) {
      res[key] = value.$each
    } else {
      res[key] = value
    }
  }
  return res
}

async function OnCardUpdate (ctx: TxUpdateDoc<Card>[], control: TriggerControl): Promise<Tx[]> {
  const updateTx = ctx[0]
  const doc = (await control.findAll(control.ctx, card.class.Card, { _id: updateTx.objectId }))[0]
  if (doc === undefined) return []
  const res: Tx[] = []
  if (updateTx.operations.parent !== undefined) {
    const newParent = updateTx.operations.parent
    const oldParent = doc.parentInfo[doc.parentInfo.length - 1]?._id
    if (newParent != null) {
      const parent = (await control.findAll(control.ctx, card.class.Card, { _id: newParent }))[0]
      if (parent !== undefined) {
        if (parent.parentInfo.findIndex((p) => p._id === doc._id) === -1) {
          res.push(
            control.txFactory.createTxUpdateDoc(parent._class, parent.space, parent._id, {
              $inc: {
                children: 1
              }
            })
          )
          res.push(
            control.txFactory.createTxUpdateDoc(doc._class, doc.space, doc._id, {
              parentInfo: [
                ...parent.parentInfo,
                {
                  _id: parent._id,
                  _class: parent._class,
                  title: parent.title
                }
              ]
            })
          )
        } else {
          // rollback
          return [
            control.txFactory.createTxUpdateDoc(doc._class, doc.space, doc._id, {
              parent: oldParent ?? null
            })
          ]
        }
      }
    }
    if (oldParent != null) {
      const parent = (await control.findAll(control.ctx, card.class.Card, { _id: oldParent }))[0]
      if (parent !== undefined) {
        res.push(
          control.txFactory.createTxUpdateDoc(parent._class, parent.space, parent._id, {
            $inc: {
              children: -1
            }
          })
        )
      }
    }
  }
  if (updateTx.operations.title !== undefined) {
    res.push(...(await updateParentInfoName(control, doc._id, updateTx.operations.title, doc._id)))
  }

  await updateCollaborators(control, updateTx.operations, doc._class, doc, updateTx.modifiedBy)

  const push = (updateTx.operations as any).$push?.readonlySections as Ref<Class<Doc>> | undefined
  const pull = (updateTx.operations as any).$pull?.readonlySections as Ref<Class<Doc>> | undefined
  const sectionId = push ?? pull
  if (sectionId !== undefined) {
    const sectionClass = control.hierarchy.getClass(sectionId)
    const label = sectionClass?.label ?? sectionId
    const section = await translate(label, {})
    res.push(
      control.txFactory.createTxCreateDoc(activity.class.ActivityInfoMessage, doc.space, {
        attachedTo: doc._id,
        attachedToClass: doc._class,
        message: push !== undefined ? card.string.SectionLocked : card.string.SectionUnlocked,
        props: { section },
        collection: 'activity'
      })
    )
  }
  return res
}

function getUpdateEmployees (
  control: TriggerControl,
  field: string,
  value: any,
  _class: Ref<Class<Doc>>
): Ref<Employee>[] | undefined {
  const res: Ref<Employee>[] = []
  const attr = control.hierarchy.findAttribute(_class, field)
  if (attr === undefined) return
  const parentType = attr.type._class === core.class.ArrOf ? (attr.type as ArrOf<Doc>).of : attr.type
  if (parentType._class !== core.class.RefTo) return
  const to = (parentType as RefTo<Doc>).to
  if (control.hierarchy.isDerived(to, contact.mixin.Employee)) {
    if (value != null) {
      if (Array.isArray(value)) {
        for (const val of value) {
          res.push(val)
        }
      } else {
        res.push(value)
      }
    }
  }
  return res
}

async function updateCollaborators (
  control: TriggerControl,
  ops: MixinUpdate<Card, Card> | DocumentUpdate<Card>,
  _class: Ref<Class<Doc>>,
  doc: Card,
  modifiedBy: PersonId
): Promise<void> {
  const collaboratorRefs = new Set<Ref<Employee>>()

  for (const [field, value] of Object.entries(ops)) {
    if (field === '$push') {
      const unwrap = unwrapPush(value)
      for (const [field, value] of Object.entries(unwrap)) {
        const col = getUpdateEmployees(control, field, value, _class)
        if (col !== undefined) {
          col.map((p) => collaboratorRefs.add(p))
        }
      }
    }
    if (field.startsWith('$')) continue
    const col = getUpdateEmployees(control, field, value, _class)
    if (col !== undefined) {
      col.map((p) => collaboratorRefs.add(p))
    }
  }
}

async function updateParentInfoName (
  control: TriggerControl,
  parent: Ref<Card>,
  title: string,
  originParent: Ref<Card>
): Promise<Tx[]> {
  const res: Tx[] = []
  const childs = await control.findAll(control.ctx, card.class.Card, { parent })
  for (const child of childs) {
    if (child._id === originParent) continue
    const parentInfo = child.parentInfo
    const index = parentInfo.findIndex((p) => p._id === parent)
    if (index === -1) {
      continue
    }
    parentInfo[index].title = title
    res.push(
      control.txFactory.createTxUpdateDoc(child._class, child.space, child._id, {
        parentInfo
      })
    )
    res.push(...(await updateParentInfoName(control, child._id, title, originParent)))
  }
  return res
}

async function OnCardCreate (ctx: TxCreateDoc<Card>[], control: TriggerControl): Promise<Tx[]> {
  const createTx = ctx[0]
  const doc = TxProcessor.createDoc2Doc(createTx)
  const res: Tx[] = []
  if (doc.parent != null) {
    const parent = (await control.findAll(control.ctx, card.class.Card, { _id: doc.parent }))[0]
    if (parent !== undefined) {
      res.push(
        control.txFactory.createTxUpdateDoc(parent._class, parent.space, parent._id, {
          $inc: {
            children: 1
          }
        })
      )
      if ((doc.parentInfo?.length ?? 0) === 0) {
        const parentInfo = [
          ...(parent.parentInfo ?? []),
          {
            _id: parent._id,
            _class: parent._class,
            title: parent.title
          }
        ]
        res.push(
          control.txFactory.createTxUpdateDoc(doc._class, doc.space, doc._id, {
            parentInfo
          })
        )
      }
    }
  }

  return res
}

export async function OnCardTag (ctx: TxMixin<Card, Card>[], control: TriggerControl): Promise<Tx[]> {
  const res: Tx[] = []
  for (const tx of ctx) {
    if (tx.space === core.space.DerivedTx) continue
    if (tx._class !== core.class.TxMixin) continue
    const target = tx.mixin
    const to = control.hierarchy.getBaseClass(target)
    const ancestors = control.hierarchy.getAncestors(target).filter((p) => control.hierarchy.isDerived(p, to))
    const mixinAncestors: Ref<Mixin<Doc>>[] = []
    const doc = (await control.findAll(control.ctx, tx.objectClass, { _id: tx.objectId }))[0]
    if (doc === undefined) continue
    for (const anc of ancestors) {
      if (anc === target) continue
      if (control.hierarchy.hasMixin(doc, anc)) break
      if (anc === to) break
      mixinAncestors.unshift(anc)
    }
    for (const anc of mixinAncestors) {
      res.push(control.txFactory.createTxMixin(doc._id, doc._class, doc.space, anc, {}))
    }
    const updated = fillDefaults(control.hierarchy, control.hierarchy.as(control.hierarchy.clone(doc), target), target)
    const diff = getDiffUpdate(doc, updated)
    const splitted = splitMixinUpdate(control.hierarchy, diff, target, doc._class)
    for (const it of splitted) {
      if (control.hierarchy.isMixin(it[0])) {
        res.push(control.txFactory.createTxMixin(doc._id, doc._class, doc.space, it[0], it[1]))
      } else {
        res.push(control.txFactory.createTxUpdateDoc(it[0], doc.space, doc._id, it[1]))
      }
    }
    await updateCollaborators(control, tx.attributes, tx.mixin, doc, tx.modifiedBy)
  }
  return res
}

const CardUrlPresenter: StringPresenterFn = async (doc: Doc, control: PresenterControl): Promise<string> => {
  const card = doc as Card

  const front = control.branding?.front ?? getMetadata(serverCore.metadata.FrontUrl) ?? ''
  const path = `${workbenchId}/${control.workspace.url}/${cardId}/${card._id}`

  return concatLink(front, path)
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export default async () => ({
  function: {
    CardUrlPresenter
  },
  trigger: {
    OnAttribute,
    OnAttributeRemove,
    OnViewletUpdate,
    OnMasterTagCreate,
    OnMasterTagRemove,
    OnTagRemove,
    OnCardRemove,
    OnCardCreate,
    OnCardUpdate,
    OnCardTag
  }
})
