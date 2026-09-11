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

import core, {
  AccountUuid,
  Class,
  Collaborator,
  Doc,
  getClassCollaborators,
  MeasureContext,
  Ref,
  Space,
  Tx,
  TxCreateDoc,
  TxCUD,
  TxMixin,
  TxProcessor,
  TxUpdateDoc
} from '@hcengineering/core'
import { type TriggerControl } from '@hcengineering/server-core'
import { getAddCollaboratorsTxes } from '@hcengineering/server-contact'
import contact, { formatName } from '@hcengineering/contact'
import { type PresenterControl, StringPresenterFn } from '@hcengineering/server-activity'

import {
  getCollaboratorsCached,
  getDocCached,
  getCollaboratorsFromDocFields,
  getCollaboratorsByTx,
  getDocSpace
} from './utils'

async function pushCollaboratorsToPublicSpace (
  control: TriggerControl,
  doc: Doc,
  collaborators: AccountUuid[],
  cache: Map<Ref<Doc>, Doc>
): Promise<TxUpdateDoc<Space>[]> {
  const space = await getDocSpace(control, doc, cache)
  if (space === undefined) return []

  cache.set(space._id, space)

  if (control.hierarchy.isDerived(space._class, core.class.SystemSpace)) return []
  if (space.private) return []

  return collaborators
    .filter((it) => !space.members.includes(it))
    .map((it) => control.txFactory.createTxUpdateDoc(space._class, space.space, space._id, { $push: { members: it } }))
}

async function setCollaboratorsOnDocCreate (
  ctx: MeasureContext,
  tx: TxCreateDoc<Doc>,
  control: TriggerControl,
  docCache: Map<Ref<Doc>, Doc>
): Promise<Tx[]> {
  const res: Tx[] = []
  const hierarchy = control.hierarchy
  const mixin = getClassCollaborators(control.modelDb, hierarchy, tx.objectClass)

  if (mixin === undefined) return res

  const doc = TxProcessor.createDoc2Doc(tx)
  docCache.set(doc._id, doc)

  const collaborators = await getCollaboratorsFromDocFields(ctx, control, doc, mixin)

  res.push(...getAddCollaboratorsTxes(tx.objectId, tx.objectClass, tx.objectSpace, control, collaborators))
  res.push(...(await pushCollaboratorsToPublicSpace(control, doc, collaborators, docCache)))

  return res
}

async function createSyncCollaboratorsTxes (
  ctx: MeasureContext,
  control: TriggerControl,
  objectId: Ref<Doc>,
  objectClass: Ref<Class<Doc>>,
  objectSpace: Ref<Space>,
  added: AccountUuid[],
  removed: AccountUuid[],
  cache: Map<Ref<Doc>, Collaborator[]>
): Promise<Tx[]> {
  if (added.length === 0 && removed.length === 0) return []

  const res: Tx[] = []

  let currentCollaborators = await getCollaboratorsCached(ctx, control, objectId, cache)

  const toAdd = added.filter((p) => !currentCollaborators.some((c) => c.collaborator === p))

  if (toAdd.length > 0) {
    const txes = getAddCollaboratorsTxes(objectId, objectClass, objectSpace, control, toAdd)
    res.push(...txes)
    txes.forEach((tx) => {
      const collab = TxProcessor.createDoc2Doc(tx)
      currentCollaborators.push(collab)
    })
  }

  if (removed.length > 0) {
    const toRemove: Collaborator[] = []
    const collabs: Collaborator[] = []
    for (const collab of currentCollaborators) {
      if (removed.includes(collab.collaborator)) {
        toRemove.push(collab)
      } else {
        collabs.push(collab)
      }
    }
    for (const removedCollab of toRemove) {
      res.push(control.txFactory.createTxRemoveDoc(core.class.Collaborator, removedCollab.space, removedCollab._id))
    }
    currentCollaborators = collabs
  }

  cache.set(objectId, currentCollaborators)

  return res
}

async function updateCollaboratorOnDocUpdate (
  ctx: MeasureContext,
  tx: TxUpdateDoc<Doc> | TxMixin<Doc, Doc>,
  control: TriggerControl,
  cache: Map<Ref<Doc>, Collaborator[]>,
  docCache: Map<Ref<Doc>, Doc>
): Promise<Tx[]> {
  const hierarchy = control.hierarchy
  const res: Tx[] = []

  const mixin = getClassCollaborators(control.modelDb, hierarchy, tx.objectClass)
  if (mixin === undefined) return res

  const doc = await getDocCached(ctx, control, tx.objectClass, tx.objectId, docCache)
  if (doc === undefined) return []

  // we should handle change field and subscribe new collaborators
  const { added, removed } = await getCollaboratorsByTx(ctx, control, tx, doc, cache)
  const sync = await createSyncCollaboratorsTxes(ctx, control, doc._id, doc._class, doc.space, added, removed, cache)
  res.push(...sync)

  return res
}

async function updateCollaboratorsFromDerivedTx (
  ctx: MeasureContext,
  control: TriggerControl,
  tx: TxCUD<Doc>,
  cache: Map<Ref<Doc>, Collaborator[]>
): Promise<Tx[]> {
  if (tx._class !== core.class.TxUpdateDoc && tx._class !== core.class.TxMixin) return []

  const { hierarchy } = control

  const mixin = getClassCollaborators(control.modelDb, hierarchy, tx.objectClass)
  if (mixin === undefined) return []

  const doc = await getDocCached(ctx, control, tx.objectClass, tx.objectId, new Map())
  if (doc === undefined) return []

  const collabsByTx = await getCollaboratorsByTx(ctx, control, tx, doc, cache)

  const res: Tx[] = []

  const txes = await createSyncCollaboratorsTxes(
    ctx,
    control,
    doc._id,
    doc._class,
    doc.space,
    collabsByTx.added,
    collabsByTx.removed,
    cache
  )

  res.push(...txes)

  return res
}

async function setupCollaborators (
  ctx: MeasureContext,
  control: TriggerControl,
  tx: TxCUD<Doc>,
  cache: Map<Ref<Doc>, Collaborator[]> = new Map<Ref<Doc>, Collaborator[]>(),
  docCache: Map<Ref<Doc>, Doc> = new Map<Ref<Doc>, Doc>()
): Promise<Tx[]> {
  if (tx.space === core.space.DerivedTx) {
    // do not forgot update collaborators for derived tx
    return await ctx.with('derivedTx -> updateCollaborators', {}, (ctx) =>
      updateCollaboratorsFromDerivedTx(ctx, control, tx, cache)
    )
  }

  switch (tx._class) {
    case core.class.TxCreateDoc: {
      return await ctx.with('set-collaborators-on-doc-create', {}, (ctx) =>
        setCollaboratorsOnDocCreate(ctx, tx as TxCreateDoc<Doc>, control, docCache)
      )
    }
    case core.class.TxUpdateDoc:
    case core.class.TxMixin: {
      return await ctx.with('update-collaborator-on-doc-update', {}, (ctx) =>
        updateCollaboratorOnDocUpdate(ctx, tx as TxUpdateDoc<Doc>, control, cache, docCache)
      )
    }
  }

  return []
}

export async function ManageCollaboratorsTrigger (txes: TxCUD<Doc>[], control: TriggerControl): Promise<Tx[]> {
  const docCache = new Map<Ref<Doc>, Doc>()
  const cache = new Map<Ref<Doc>, Collaborator[]>()

  const res: Tx[] = []

  for (const tx of txes) {
    if (!TxProcessor.isExtendsCUD(tx._class)) continue
    const txes = await control.ctx.with(
      'setup-collaborators',
      { domain: control.hierarchy.findDomain(tx.objectClass) },
      (ctx) => setupCollaborators(ctx, control, tx, cache, docCache)
    )
    res.push(...txes)
  }

  return res
}

export const CollaboratorTitlePresenter: StringPresenterFn<Collaborator> = async (
  doc: Collaborator,
  control: PresenterControl
): Promise<string> => {
  const person = (
    await control.findAll(control.ctx, contact.class.Person, {
      personUuid: doc.collaborator
    })
  )[0]
  if (person == null) return ''
  return formatName(person.name)
}
