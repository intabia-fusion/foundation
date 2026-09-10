//
// Copyright © 2026 Intabia Fusion Inc.
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
  type Class,
  type Doc,
  type MeasureContext,
  type Ref,
  type Space,
  type TxCUD,
  type TxMixin,
  TxProcessor,
  type TxRemoveDoc,
  type TxUpdateDoc
} from '@hcengineering/core'
import activity, { type DocUpdateMessage } from '@hcengineering/activity'

import { type Client } from './types'

export const CACHE_TTL_MS = 10 * 60 * 1000

class WsCache {
  private readonly docs = new Map<Ref<Doc>, Doc>()
  private readonly recentMessages = new Map<Ref<DocUpdateMessage>, DocUpdateMessage>()
  private readonly attachedToIndex = new Map<Ref<Doc>, Set<Ref<DocUpdateMessage>>>()
  private logicalTime: number = 0
  private lastCleanLogicalTime: number = 0

  constructor (
    private readonly ctx: MeasureContext,
    private readonly client: Client,
    recentMessages: DocUpdateMessage[],
    logicalTime?: number
  ) {
    for (const msg of recentMessages) {
      this.addRecentMessage(msg)
    }
    this.logicalTime = logicalTime ?? Date.now()
    this.lastCleanLogicalTime = this.logicalTime
  }

  public tx (tx: TxCUD<Doc>): void {
    const txTime = tx.modifiedOn ?? 0
    this.logicalTime = Math.max(this.logicalTime, txTime)

    if (this.logicalTime - this.lastCleanLogicalTime > CACHE_TTL_MS) {
      this.lastCleanLogicalTime = this.logicalTime
      this.cleanRecentMessages()
    }

    this.clearLargeCaches()

    if ([core.class.TxUpdateDoc, core.class.TxMixin].includes(tx._class)) {
      this.txUpdateDoc(tx as TxUpdateDoc<Doc> | TxMixin<Doc, Doc>)
    }

    if (tx._class === core.class.TxRemoveDoc) {
      this.txRemoveDoc(tx)
    }
  }

  private txUpdateDoc (tx: TxUpdateDoc<Doc> | TxMixin<Doc, Doc>): void {
    const doc = this.docs.get(tx.objectId)
    const { hierarchy } = this.client

    if (doc != null) {
      const updated = this.updateOrMixin(tx, doc)
      this.docs.set(updated._id, updated)
    }

    if (hierarchy.isDerived(tx.objectClass, activity.class.ActivityMessage)) {
      const message = this.recentMessages.get(tx.objectId as Ref<DocUpdateMessage>)
      if (message != null) {
        const updated = this.updateOrMixin(tx, message)
        this.addRecentMessage(updated) // This will overwrite in maps
      }
    }
  }

  private txRemoveDoc (tx: TxRemoveDoc<Doc>): void {
    this.docs.delete(tx.objectId)

    const { hierarchy } = this.client

    if (hierarchy.isDerived(tx.objectClass, activity.class.ActivityMessage)) {
      const msg = this.recentMessages.get(tx.objectId as Ref<DocUpdateMessage>)
      if (msg != null) {
        this.recentMessages.delete(msg._id)
        this.attachedToIndex.get(msg.attachedTo)?.delete(msg._id)
      }
    }
  }

  private updateOrMixin<T extends Doc>(tx: TxUpdateDoc<Doc> | TxMixin<Doc, Doc>, doc: T): T {
    if (tx._class === core.class.TxUpdateDoc) {
      return TxProcessor.updateDoc2Doc(doc, tx as TxUpdateDoc<Doc>) as T
    }

    return TxProcessor.updateMixin4Doc(doc, tx as TxMixin<Doc, Doc>) as T
  }

  public async getDoc (_id: Ref<Doc>, _class: Ref<Class<Doc>>): Promise<Doc | undefined> {
    if (this.docs.has(_id)) return this.docs.get(_id)

    let doc = await this.client.findOne(_class, { _id })

    if (doc === undefined) {
      const createTx = (await this.client.findAll(core.class.TxCreateDoc, { objectId: _id }, { limit: 1 }))[0]

      doc = createTx !== undefined ? TxProcessor.createDoc2Doc(createTx) : undefined
    }
    if (doc !== undefined) {
      this.docs.set(_id, doc)
    } else {
      this.docs.delete(_id)
    }
    return doc
  }

  public async getDocSpace (doc: Doc): Promise<Space | undefined> {
    if (this.client.hierarchy.isDerived(doc._class, core.class.Space)) return doc as Space
    const current = this.docs.get(doc._id)
    if (current !== undefined) return current as Space

    const space = await this.client.findOne<Space>(core.class.Space, { _id: doc.space }, { limit: 1 })

    if (space !== undefined) {
      this.docs.set(doc.space, space)
    }

    return space
  }

  public addRecentMessage (msg: DocUpdateMessage): void {
    this.recentMessages.set(msg._id, msg)
    let set = this.attachedToIndex.get(msg.attachedTo)
    if (set === undefined) {
      set = new Set()
      this.attachedToIndex.set(msg.attachedTo, set)
    }
    set.add(msg._id)
  }

  public getRecentMessages (attachedTo: Ref<Doc>): DocUpdateMessage[] {
    const ids = this.attachedToIndex.get(attachedTo)
    if (ids === undefined) return []

    const result: DocUpdateMessage[] = []
    for (const id of ids) {
      const msg = this.recentMessages.get(id)
      if (msg != null) {
        result.push(msg)
      }
    }

    return result.sort((a, b) => (a.createdOn ?? a.modifiedOn ?? 0) - (b.createdOn ?? b.modifiedOn ?? 0))
  }

  private cleanRecentMessages (): void {
    const cutoff = this.logicalTime - CACHE_TTL_MS

    for (const [id, msg] of this.recentMessages.entries()) {
      const date = msg.createdOn ?? msg.modifiedOn ?? 0
      if (date < cutoff) {
        this.recentMessages.delete(id)
        const set = this.attachedToIndex.get(msg.attachedTo)
        if (set != null) {
          set.delete(id)
          if (set.size === 0) {
            this.attachedToIndex.delete(msg.attachedTo)
          }
        }
      }
    }
  }

  private clearLargeCaches (): void {
    const maxSize = 1000
    if (this.docs.size > maxSize) {
      this.docs.clear()
    }
  }

  public close (): void {
    this.docs.clear()
    this.recentMessages.clear()
    this.attachedToIndex.clear()
  }
}

export default WsCache
