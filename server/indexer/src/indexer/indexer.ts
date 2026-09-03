//
// Copyright © 2022 Hardcore Engineering Inc.
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

import { Analytics } from '@hcengineering/analytics'
import attachmentPlugin, { type Attachment } from '@hcengineering/attachment'
import contactPlugin, { formatName } from '@hcengineering/contact'
import core, {
  type AnyAttribute,
  type AttachedDoc,
  type Blob,
  type Class,
  type Doc,
  docKey,
  type Domain,
  DOMAIN_COLLABORATOR,
  DOMAIN_MODEL,
  type FullTextSearchContext,
  getFullTextIndexableAttributes,
  groupByArray,
  type Hierarchy,
  type IdMap,
  isClassIndexable,
  isFullTextAttribute,
  isIndexedAttribute,
  type MeasureContext,
  type ModelDb,
  platformNow,
  type Ref,
  type Space,
  systemAccount,
  toIdMap,
  type TxCUD,
  TxProcessor,
  type VersionableDoc,
  withContext,
  type WorkspaceIds,
  type WorkspaceUuid
} from '@hcengineering/core'
import drivePlugin, { type FileVersion } from '@hcengineering/drive'
import type {
  ConsumerControl,
  ContentTextAdapter,
  DbAdapter,
  FullTextAdapter,
  FulltextListener,
  IndexedDoc,
  StorageAdapter
} from '@hcengineering/server-core'
import { RateLimiter, SessionDataImpl } from '@hcengineering/server-core'
import { jsonToText, markupToJSON, markupToText } from '@hcengineering/text'
import { findSearchPresenter, updateDocWithPresenter } from '../mapper'
import { type HulylakeWorkspaceClient } from '@hcengineering/hulylake-client'
import chunter, { type Chat, type DirectMessage } from '@hcengineering/chunter'
import { type Person } from '@hcengineering/contact'

import { type FullTextPipeline } from './types'
import { createIndexedDoc, getContent } from './utils'

export * from './types'
export * from './utils'

const printThresholdMs = 2500

const textLimit = 500 * 1024

// Global Memory management configuration

/**
 * @public
 */
export const globalIndexer = {
  allowParallel: 10,
  processingSize: 100
}

let indexCounter = 0

function extractValues (obj: any): string {
  let res = ''

  const o = [obj]
  while (o.length > 0) {
    const oo = o.shift()
    if (typeof oo === 'object') {
      o.push(Object.values(oo))
      continue
    }
    if (Array.isArray(oo)) {
      o.push(...oo)
      continue
    }
    res += `${oo} `
  }
  return res
}

class ElasticPushQueue {
  pushQueue = new RateLimiter(5)
  indexedDocs: IndexedDoc[] = []

  constructor (
    readonly fulltextAdapter: FullTextAdapter,
    readonly workspace: WorkspaceIds,
    readonly ctx: MeasureContext,
    readonly control?: ConsumerControl
  ) {}

  async push (doc: IndexedDoc): Promise<void> {
    this.indexedDocs.push(doc)
    if (this.indexedDocs.length > 25) {
      await this.pushToIndex()
    }
  }

  async waitProcessing (): Promise<void> {
    if (this.indexedDocs.length > 0) {
      await this.pushToIndex()
    }
    await this.pushQueue.waitProcessing()
  }

  async pushToIndex (): Promise<void> {
    const docs = [...this.indexedDocs]
    this.indexedDocs = []
    if (docs.length === 0) {
      return
    }
    await this.pushQueue.add(async () => {
      try {
        try {
          await this.ctx.with(
            'push-elastic',
            {},
            () => this.fulltextAdapter.updateMany(this.ctx, this.workspace.uuid, docs),
            { workspace: this.workspace.uuid }
          )

          await this.control?.heartbeat()
        } catch (err: any) {
          Analytics.handleError(err)
          // Try to push one by one
          await this.ctx.with(
            'push-elastic-by-one',
            {},
            async () => {
              for (const d of docs) {
                try {
                  await this.fulltextAdapter.update(this.ctx, this.workspace.uuid, d.id, d)
                } catch (err2: any) {
                  Analytics.handleError(err2)
                }
              }
            },
            {
              workspace: this.workspace.uuid
            }
          )
        }
      } catch (err: any) {
        Analytics.handleError(err)
      }
    })
  }
}

/**
 * @public
 */
export class FullTextIndexPipeline implements FullTextPipeline {
  cancelling: boolean = false

  indexId = indexCounter++

  contexts: Map<Ref<Class<Doc>>, FullTextSearchContext>

  constructor (
    readonly fulltextAdapter: FullTextAdapter,
    private readonly storage: DbAdapter,
    readonly hierarchy: Hierarchy,
    readonly workspace: WorkspaceIds,
    readonly metrics: MeasureContext,
    readonly model: ModelDb,
    readonly storageAdapter: StorageAdapter,
    readonly contentAdapter: ContentTextAdapter,
    readonly broadcastUpdate: (ctx: MeasureContext, classes: Ref<Class<Doc>>[]) => void,
    readonly hulylake: HulylakeWorkspaceClient,
    readonly listener?: FulltextListener
  ) {
    this.contexts = new Map(model.findAllSync(core.class.FullTextSearchContext, {}).map((it) => [it.toClass, it]))
  }

  async getIndexClassess (): Promise<{ domain: Domain, classes: Ref<Class<Doc>>[] }[]> {
    const allClasses = this.hierarchy.getDescendants(core.class.Doc)
    const contexts = new Map(this.model.findAllSync(core.class.FullTextSearchContext, {}).map((it) => [it.toClass, it]))
    const allIndexed = allClasses.filter((it) => isClassIndexable(this.hierarchy, it, contexts))
    const domainPriorities: Record<string, number> = {
      space: 1500,
      contact: 1000,
      task: 500,
      recruit: 400,
      document: 300,
      attachment: -100
    }

    const byDomain = groupByArray(allIndexed, (it) => this.hierarchy.getDomain(it))

    // Delete few domains
    byDomain.delete(DOMAIN_COLLABORATOR)

    return Array.from(byDomain.entries())
      .sort((a, b) => {
        const ap = domainPriorities[a[0]] ?? 0
        const bp = domainPriorities[b[0]] ?? 0
        return bp - ap
      })
      .map((it) => ({
        domain: it[0],
        classes: it[1]
      }))
  }

  async reindex (
    ctx: MeasureContext,
    domain: Domain,
    classes: Ref<Class<Doc>>[],
    control?: ConsumerControl
  ): Promise<void> {
    let processed = 0
    await ctx.with(
      'reindex domain',
      { domain },
      async (ctx) => {
        // Iterate over all domain documents and add appropriate entries
        const allDocs = this.storage.rawFind(ctx, domain)
        try {
          let lastPrint = platformNow()
          const pushQueue = new ElasticPushQueue(this.fulltextAdapter, this.workspace, ctx, control)
          while (true) {
            await control?.heartbeat()
            const docs = await allDocs.find(ctx)
            if (docs.length === 0) {
              break
            }
            const byClass = groupByArray<Doc, Ref<Class<Doc>>>(docs, (it) => it._class)

            for (const [v, values] of byClass.entries()) {
              if (!isClassIndexable(this.hierarchy, v, this.contexts)) {
                // Skip non indexable classes
                continue
              }

              await this.indexDocuments(ctx, v, values, pushQueue)
              await control?.heartbeat()
            }

            processed += docs.length

            // Define the thresholds for logging

            // Find the next threshold to print

            const now = platformNow()
            if (now - lastPrint > printThresholdMs) {
              ctx.info('processed', {
                processed,
                elapsed: Math.round(now - lastPrint),
                domain,
                workspace: this.workspace.uuid
              })
              lastPrint = now
            }
          }
          await pushQueue.waitProcessing()
        } catch (err: any) {
          ctx.error('failed to restore index state', { err })
        } finally {
          await allDocs.close()
        }
      },
      {
        domain,
        workspace: this.workspace.uuid
      }
    )
    if (processed > 0) {
      ctx.info('reindex done', { domain, processed })
    }
  }

  async dropWorkspace (control?: ConsumerControl): Promise<void> {
    if (this.workspace.dataId != null) {
      await this.fulltextAdapter.clean(this.metrics, this.workspace.dataId as unknown as WorkspaceUuid)
    }
    await this.fulltextAdapter.clean(this.metrics, this.workspace.uuid)
  }

  broadcastClasses = new Set<Ref<Class<Doc>>>()
  broadcasts: number = 0

  cancel (): void {
    this.cancelling = true
    clearTimeout(this.broadCastTimeout)
  }

  broadCastTimeout: any

  scheduleBroadcast (): void {
    if (!this.cancelling) {
      // We need to send index update event
      if (this.broadcasts === 0) {
        this.broadcasts++
        this.broadCastTimeout = setTimeout(() => {
          this.broadcasts = 0
          if (this.broadcastClasses.size > 0 && !this.cancelling) {
            const toSend = Array.from(this.broadcastClasses.values())
            this.broadcastClasses.clear()
            this.broadcastUpdate(this.metrics, toSend)
          }
        }, 5000)
      }
    }
  }

  private async findParents (ctx: MeasureContext, docs: AttachedDoc[]): Promise<IdMap<Doc>> {
    const result: Doc[] = []
    const groups = groupByArray(docs, (doc) => doc.attachedToClass)
    for (const [_class, _docs] of groups) {
      const pids = Array.from(new Set(_docs.map((it) => it.attachedTo)))
      try {
        const gdocs = await ctx.with('find-spaces', {}, (ctx) =>
          this.storage.findAll<Doc>(
            ctx,
            _class,
            {
              _id: {
                $in: pids
              }
            },
            {
              skipSpace: true
            }
          )
        )
        result.push(...gdocs)
      } catch (err: any) {
        ctx.error('failed to find parents for', {
          _class,
          pids,
          docCl: Array.from(new Set(_docs.map((it) => it._class)))
        })
        continue
      }
    }
    return toIdMap(result)
  }

  async indexDocuments (
    ctx: MeasureContext,
    _class: Ref<Class<Doc>>,
    docs: Doc[],
    pushQueue: ElasticPushQueue
  ): Promise<void> {
    let spaceDocs: IdMap<Space> | undefined
    const updateSpaces = async (): Promise<void> => {
      spaceDocs = toIdMap(
        await ctx.with('find-spaces', {}, (ctx) =>
          this.storage.findAll(
            ctx,
            core.class.Space,
            {
              _id: {
                $in: Array.from(new Set(docs.map((doc) => doc.space)))
              }
            },
            {
              skipClass: true,
              skipSpace: true
            }
          )
        )
      )
    }
    const searchPresenter = findSearchPresenter(this.hierarchy, _class)

    let parentDocs: IdMap<Doc> | undefined

    const rateLimit = new RateLimiter(10)
    // We need to add all to broadcast update
    for (const doc of docs) {
      if (typeof doc._id === 'object') {
        doc._id = (doc._id as any).toString()
      }
      this.broadcastClasses.add(doc._class)
      if (this.cancelling) {
        return
      }
      const indexedDoc = createIndexedDoc(doc, this.hierarchy.findAllMixins(doc), doc.space)

      await rateLimit.add(async () => {
        await ctx.with(
          'process-document',
          { _class: doc._class },
          async (ctx) => {
            try {
              // Collect all indexable values
              const attributes = getFullTextIndexableAttributes(this.hierarchy, doc._class)
              const content = getContent(this.hierarchy, attributes, doc)

              indexedDoc.fulltextSummary = ''
              indexedDoc.searchTitle = ''

              for (const [, v] of Object.entries(content)) {
                if (v.attr.type._class === core.class.TypeBlob) {
                  await ctx.with('process-blob', {}, (ctx) => this.processBlob(ctx, v, doc, indexedDoc), {
                    attr: v.attr.name,
                    value: v.value
                  })
                  continue
                }

                if (v.attr.type._class === core.class.TypeCollaborativeDoc) {
                  await this.processCollaborativeDoc(ctx, v, indexedDoc)
                  continue
                }
                if ((isFullTextAttribute(v.attr) || v.attr.isCustom === true) && v.value !== undefined) {
                  if (v.attr.type._class === core.class.TypeMarkup) {
                    ctx.withSync('markup-to-json-text', {}, () => {
                      indexedDoc.fulltextSummary += '\n' + jsonToText(markupToJSON(v.value))
                    })
                  } else {
                    indexedDoc.fulltextSummary += '\n' + v.value
                  }

                  if (v.attr.indexOptions?.searchTitle === true && v.value != null && searchPresenter == null) {
                    const titlePart = Array.isArray(v.value) ? v.value.join(' ') : v.value.toString()
                    if ((indexedDoc.searchTitle ?? '').length === 0) {
                      indexedDoc.searchTitle = titlePart
                    } else {
                      indexedDoc.searchTitle += ' ' + titlePart
                    }
                  }

                  continue
                }

                if (isIndexedAttribute(v.attr)) {
                  // We need to put indexed attr in place

                  // Check for content changes and collect update
                  const dKey = docKey(v.attr.name, v.attr.attributeOf)
                  if (dKey !== '_class') {
                    if (typeof v.value !== 'object') {
                      indexedDoc[dKey] = v.value
                    } else {
                      // We need to extract only values
                      indexedDoc[dKey] = extractValues(v.value)
                    }
                  }
                  continue
                }
              }

              // trim to large content
              if (indexedDoc.fulltextSummary.length > textLimit) {
                indexedDoc.fulltextSummary = indexedDoc.fulltextSummary.slice(0, textLimit)
              }

              if (searchPresenter !== undefined) {
                await ctx.with('update-search-presenter', { _class: doc._class }, async () => {
                  if (parentDocs === undefined) {
                    parentDocs = this.hierarchy.isDerived(_class, core.class.AttachedDoc)
                      ? await this.findParents(ctx, docs as unknown as AttachedDoc[])
                      : undefined
                  }
                  const parentDoc = parentDocs?.get((doc as AttachedDoc).attachedTo)
                  if (spaceDocs === undefined) {
                    await updateSpaces()
                  }
                  const spaceDoc = spaceDocs?.get(doc.space) // docState.$lookup?.space
                  await updateDocWithPresenter(
                    this.hierarchy,
                    doc,
                    indexedDoc,
                    parentDoc,
                    spaceDoc,
                    searchPresenter,
                    ctx,
                    this.storage
                  )
                })
              }

              indexedDoc.id = doc._id
              indexedDoc.space = doc.space

              if (this.hierarchy.isDerived(doc._class, chunter.class.Chat)) {
                const chat = doc as Chat
                indexedDoc.viewerId = chat.account
              }

              if (this.hierarchy.isDerived(doc._class, chunter.class.DirectMessage)) {
                const direct = doc as DirectMessage

                const members = direct.members ?? []
                let persons: Person[] = []
                try {
                  persons = await this.storage.findAll(
                    ctx,
                    contactPlugin.class.Person,
                    { personUuid: { $in: members } },
                    { skipSpace: true, skipClass: true }
                  )
                } catch (e: any) {
                  ctx.error('failed to find persons', { members, err: e })
                }

                if (members.length === 1) {
                  const title = persons
                    .map((p) => formatName(p.name))
                    .filter((name) => name !== '')
                    .join(' ')

                  const memberDoc = { ...indexedDoc, viewerId: members[0], searchTitle: title, fulltextSummary: title }

                  if (this.listener?.onIndexing !== undefined) {
                    await this.listener.onIndexing(memberDoc)
                  }
                  await pushQueue.push(memberDoc)
                  return
                }

                for (const member of members) {
                  const otherPersons = persons.filter((p) => p.personUuid !== member)
                  const title = otherPersons
                    .map((p) => formatName(p.name))
                    .filter((name) => name !== '')
                    .join(' ')

                  const memberDoc = { ...indexedDoc, viewerId: member, searchTitle: title, fulltextSummary: title }

                  if (this.listener?.onIndexing !== undefined) {
                    await this.listener.onIndexing(memberDoc)
                  }
                  await pushQueue.push(memberDoc)
                }
                return
              }

              if (this.listener?.onIndexing !== undefined) {
                await this.listener.onIndexing(indexedDoc)
              }
              await pushQueue.push(indexedDoc)
            } catch (err: any) {
              ctx.error('failed to process document', {
                id: doc._id,
                class: doc._class,
                workspace: this.workspace.uuid,
                err: err.message,
                stack: err.stack
              })
              Analytics.handleError(err)
            }
          },
          { workspace: this.workspace.uuid }
        )
      })
    }
    await rateLimit.waitProcessing()
  }

  public async processTransactions (ctx: MeasureContext, result: TxCUD<Doc>[], control: ConsumerControl): Promise<void> {
    const contextData = this.createContextData()
    ctx.contextData = contextData

    const docEvents = result.filter((tx) => tx._class !== core.class.TxDomainEvent)

    // We need to update hierarchy and local model if required.
    for (const tx of docEvents) {
      try {
        const domain = this.hierarchy.findDomain(tx.objectClass)
        if (domain === DOMAIN_MODEL) {
          await this.model.tx(tx)
        }
        // After the model: hierarchy skips updates of model-owned docs and indexes by the new state.
        this.hierarchy.tx(tx)
      } catch (err: any) {
        ctx.error('failed to process tx', { err, tx })
        Analytics.handleError(err)
      }
    }

    const byClass = groupByArray<TxCUD<Doc>, Ref<Class<Doc>>>(docEvents, (it) => it.objectClass)

    const pushQueue = new ElasticPushQueue(this.fulltextAdapter, this.workspace, ctx, control)

    const toRemove: { _id: Ref<Doc>, _class: Ref<Class<Doc>> }[] = []

    for (const [v, values] of byClass.entries()) {
      if (!isClassIndexable(this.hierarchy, v, this.contexts)) {
        // Skip non indexable classes
        continue
      }

      try {
        // We need to load documents from storage
        const docs: Doc[] = await this.loadDocsFromTx(values, toRemove, ctx, v)

        await this.indexDocuments(ctx, v, docs, pushQueue)
      } catch (err: any) {
        ctx.error('failed to index documents', { err, tx: v })
        Analytics.handleError(err)
      }
    }

    try {
      if (toRemove.length !== 0) {
        // We need to add broadcast information
        for (const _cl of new Set(toRemove.map((it) => it._class))) {
          this.broadcastClasses.add(_cl)
        }
        const ids = toRemove.map((it) => it._id)
        if (this.listener?.onClean !== undefined) {
          await this.listener.onClean(ids)
        }
        await this.fulltextAdapter.remove(ctx, this.workspace.uuid, ids)
      }
    } catch (err: any) {
      Analytics.handleError(err)
    }

    await pushQueue.waitProcessing()
    this.scheduleBroadcast()
  }

  private async loadDocsFromTx (
    values: TxCUD<Doc<Space>>[],
    toRemove: { _id: Ref<Doc<Space>>, _class: Ref<Class<Doc>> }[],
    ctx: MeasureContext<any>,
    v: Ref<Class<Doc<Space>>>
  ): Promise<Doc[]> {
    const byDoc = groupByArray(values, (it) => it.objectId)

    const docsToRetrieve = new Set<Ref<Doc>>()

    const docs: Doc[] = []

    // We need to find documents we need to retrieve
    for (const [docId, txes] of byDoc.entries()) {
      // Check if we have create tx, we do not need to retrieve a doc, just combine all updates
      txes.sort((a, b) => a.modifiedOn - b.modifiedOn)
      const doc = TxProcessor.buildDoc2Doc(txes)

      switch (doc) {
        case null:
          toRemove.push({ _id: docId, _class: txes[0].objectClass })
          break
        case undefined:
          docsToRetrieve.add(docId)
          break
        default:
          docs.push(doc)
      }
      if (doc != null && this.isNewVersion(doc)) {
        const versions = await this.storage.findAll(ctx, v, { baseId: doc.baseId })
        for (const version of versions) {
          if (version._id === doc._id) continue
          toRemove.push({ _id: version._id, _class: txes[0].objectClass })
        }
      }
    }
    if (docsToRetrieve.size > 0) {
      docs.push(...(await this.storage.findAll(ctx, v, { _id: { $in: Array.from(docsToRetrieve) } })))
    }
    return docs.filter((p) => !this.isOldVersion(p))
  }

  private isNewVersion (doc: Doc): doc is VersionableDoc {
    try {
      if (
        this.hierarchy.classHierarchyMixin(doc._class, core.mixin.VersionableClass)?.enabled === true &&
        (doc as VersionableDoc).baseId !== undefined
      ) {
        return (doc as VersionableDoc).baseId !== doc._id
      }
    } catch {}
    return false
  }

  private isOldVersion (doc: Doc): boolean {
    try {
      if (this.hierarchy.classHierarchyMixin(doc._class, core.mixin.VersionableClass)?.enabled === true) {
        return (doc as VersionableDoc).isLatest === false
      }
    } catch {}
    return false
  }

  private createContextData (): SessionDataImpl {
    return new SessionDataImpl(
      systemAccount,
      '',
      true,
      undefined,
      this.workspace,
      false,
      undefined,
      undefined,
      this.model,
      new Map(),
      'fulltext'
    )
  }

  @withContext('process-collaborative-doc')
  private async processCollaborativeDoc (
    ctx: MeasureContext<any>,
    v: { value: any, attr: AnyAttribute },
    indexedDoc: IndexedDoc
  ): Promise<void> {
    const value = v.value as Ref<Blob>
    if (value !== undefined && value !== '') {
      try {
        const readable = await this.storageAdapter?.read(ctx, this.workspace, value)
        const markup = Buffer.concat(readable as any).toString()
        let textContent = markupToText(markup)
        textContent = textContent
          .split(/ +|\t+|\f+/)
          .filter((it) => it)
          .join(' ')
          .split(/\n\n+/)
          .join('\n')

        indexedDoc.fulltextSummary += '\n' + textContent
      } catch (err: any) {
        Analytics.handleError(err)
        ctx.error('failed to handle blob', { _id: value, workspace: this.workspace.uuid })
      }
    }
  }

  private async processBlob (
    ctx: MeasureContext<any>,
    v: { value: any, attr: AnyAttribute },
    doc: Doc<Space>,
    indexedDoc: IndexedDoc
  ): Promise<void> {
    // We need retrieve value of attached document content.
    try {
      const ref = v.value as Ref<Blob>
      if (ref === '' || ref.startsWith('http://') || ref.startsWith('https://')) {
        return
      }
      if (ref.startsWith('{')) {
        return
      }
      if (v.attr.name === 'avatar' || v.attr.attributeOf === contactPlugin.class.Contact) {
        return
      }
      if (v.attr.attributeOf === attachmentPlugin.class.Attachment && v.attr.name === 'file') {
        const file = doc as Attachment
        if (!isBlobAllowed(file.type)) {
          // Skip blob with invalid, or diallowed content type
          return
        }
      }
      if (v.attr.attributeOf === drivePlugin.class.FileVersion && v.attr.name === 'file') {
        const file = doc as FileVersion
        if (!isBlobAllowed(file.type)) {
          // Skip blob with invalid, or diallowed content type
          return
        }
      }
      await this.handleBlobRef(ctx, ref, indexedDoc)
    } catch (err: any) {
      ctx.warn('faild to process text content', {
        id: doc._id,
        _class: doc._class,
        field: v.attr.name,
        err: err.message,
        workspace: this.workspace.uuid
      })
    }
  }

  private async handleBlobRef (
    ctx: MeasureContext<any>,
    ref: Ref<Blob>,
    indexedDoc: IndexedDoc,
    defaultContentType: string = ''
  ): Promise<void> {
    const docInfo: Blob | undefined = await this.storageAdapter.stat(ctx, this.workspace, ref)
    if (docInfo !== undefined && docInfo.size < 30 * 1024 * 1024) {
      // We have blob, we need to decode it to string.
      const contentType = (docInfo.contentType ?? defaultContentType).split(';')[0]

      const ct = contentType.toLocaleLowerCase()
      if ((ct.includes('text/') && contentType !== 'text/rtf') || ct.includes('application/vnd.github.version.diff')) {
        await this.handleTextBlob(ctx, docInfo, indexedDoc)
      } else if (isBlobAllowed(contentType)) {
        await this.handleBlob(ctx, docInfo, indexedDoc)
      }
    }
  }

  private async handleBlob (ctx: MeasureContext<any>, docInfo: Blob | undefined, indexedDoc: IndexedDoc): Promise<void> {
    if (docInfo !== undefined) {
      const contentType = (docInfo.contentType ?? '').split(';')[0]

      if (docInfo.size > 30 * 1024 * 1024) {
        throw new Error('Blob size exceeds limit of 30MB')
      }
      const buffer = Buffer.concat(
        await ctx.with('fetch', {}, (ctx) => this.storageAdapter?.read(ctx, this.workspace, docInfo._id))
      )
      let textContent = await ctx.with(
        'to-text',
        {},
        (ctx) => this.contentAdapter.content(ctx, this.workspace.uuid, docInfo._id, contentType, buffer),
        {
          workspace: this.workspace.uuid,
          blobId: docInfo._id,
          contentType
        }
      )
      textContent = textContent
        .split(/ +|\t+|\f+/)
        .filter((it) => it)
        .join(' ')
        .split(/\n\n+/)
        .join('\n')

      indexedDoc.fulltextSummary += '\n' + textContent
    }
  }

  private async handleTextBlob (
    ctx: MeasureContext<any>,
    docInfo: Blob | undefined,
    indexedDoc: IndexedDoc
  ): Promise<void> {
    if (docInfo !== undefined) {
      let textContent = Buffer.concat(
        (await this.storageAdapter?.read(ctx, this.workspace, docInfo._id)) as any
      ).toString()

      textContent = textContent
        .split(/ +|\t+|\f+/)
        .filter((it) => it)
        .join(' ')
        .split(/\n\n+/)
        .join('\n')

      indexedDoc.fulltextSummary += '\n' + textContent
    }
  }
}
function isBlobAllowed (contentType: string): boolean {
  return (
    !contentType.includes('image/') &&
    !contentType.includes('video/') &&
    !contentType.includes('binary/octet-stream') &&
    !contentType.includes('application/octet-stream') &&
    !contentType.includes('application/zip') &&
    !contentType.includes('application/x-zip-compressed') &&
    !contentType.includes('application/link-preview')
  )
}
