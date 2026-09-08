/* eslint-disable @typescript-eslint/unbound-method */
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
  AccountUuid,
  Branding,
  Class,
  Data,
  Doc,
  type DocumentQuery,
  type FindOptions,
  FindResult,
  Hierarchy,
  MeasureContext,
  ModelDb,
  notEmpty,
  PersonId,
  readOnlyGuestAccountUuid,
  Ref,
  Space,
  Timestamp,
  Tx,
  TxCreateDoc,
  TxCUD,
  TxFactory,
  TxProcessor,
  TxRemoveDoc,
  TxUpdateDoc,
  type WithLookup,
  WorkspaceInfoWithStatus
} from '@hcengineering/core'
import activity, { ActivityMessage, DocUpdateMessage, Reaction } from '@hcengineering/activity'
import { RestClient } from '@hcengineering/api-client'
import notification, {
  DocNotifyContext,
  InboxNotification,
  NotificationContent,
  NotificationProvider,
  NotificationType,
  ReactionInboxNotification,
  ReadPosition,
  ReadState,
  TxNotificationType
} from '@hcengineering/notification'
import contact, { Employee } from '@hcengineering/contact'
import serverNotification, {
  getSenderName,
  normalizeTextMessage,
  Receiver,
  TypeMatch
} from '@hcengineering/server-notification'
import { StorageAdapter } from '@hcengineering/storage'
import { getResource, IntlString, PlatformError, unknownError } from '@hcengineering/platform'
import { markupToText } from '@hcengineering/text-core'
import config from './config'
import { createPipeline, MiddlewareCreator, Pipeline, PipelineContext } from '@hcengineering/server-core'
import { getConfig } from '@hcengineering/server-pipeline'
import {
  ContextNameMiddleware,
  DBAdapterInitMiddleware,
  DBAdapterMiddleware,
  DomainFindMiddleware,
  DomainTxMiddleware,
  LowLevelMiddleware,
  ModelMiddleware
} from '@hcengineering/middleware'

import WsCache from './cache'
import { Client, NotifyResult } from './types'
import {
  getAllowedProviders,
  getMessageNotificationContent,
  getMessageNotifyResult,
  getNotifiedUsers,
  getTxNotifyResult,
  getTypeMatchClient,
  isMatchedTxType
} from './utils'
import { createMentionsData, getMentionNotificationContent } from './mention'
import { getReactionNotificationContent } from './reaction'

class Workspace {
  public readonly cache: WsCache

  private inProgress = false
  private lastUpdate: Timestamp | undefined = Date.now()

  private readonly txFactory = new TxFactory(core.account.System, true)
  readonly client: Client

  private constructor (
    private readonly ctx: MeasureContext,
    private readonly ws: WorkspaceInfoWithStatus,
    private readonly pipeline: Pipeline,
    private readonly hierarchy: Hierarchy,
    private readonly model: ModelDb,
    private readonly rest: RestClient,
    private readonly storage: StorageAdapter,
    private readonly branding: Branding | undefined,
    private readonly txTypes: TxNotificationType[]
  ) {
    this.client = this.getClient()
    this.cache = new WsCache(this.ctx, this.client)
  }

  async tx (tx: TxCUD<Doc>): Promise<void> {
    this.inProgress = true
    const domain = this.hierarchy.findDomain(tx.objectClass)
    if (domain == null) {
      this.inProgress = false
      return
    }

    if (domain === 'model') {
      // addTxes keeps the hierarchy in step, applying it here too would double $push/$inc.
      this.model.addTxes(this.ctx, [tx], true)
    }

    this.cache.tx(tx)

    if (this.hierarchy.isDerived(tx.objectClass, notification.class.DocNotifyContext)) return
    if (this.hierarchy.isDerived(tx.objectClass, notification.class.InboxNotification)) return
    if (this.hierarchy.isDerived(tx.objectClass, notification.class.BrowserNotification)) return
    if (this.hierarchy.isDerived(tx.objectClass, activity.class.ActivityReference)) return

    if (tx.meta?.silent === true) return

    const res: TxCUD<Doc>[] = []

    if (this.hierarchy.isDerived(tx.objectClass, notification.class.ReadState)) {
      res.push(...(await this.processReadState(tx as TxCUD<ReadState>)))
    } else {
      res.push(...(await this.processTxNotifications(tx)))

      const notifiedUsers = getNotifiedUsers(this.hierarchy, res)

      if (this.hierarchy.isDerived(tx.objectClass, activity.class.ActivityMessage)) {
        res.push(...(await this.processMessage(tx as TxCUD<ActivityMessage>, notifiedUsers, res)))
      }
    }

    if (res.length > 0) {
      if (tx.meta?.inboxOnly === true) this.keepInboxProviderOnly(res)
      this.lastUpdate = Date.now()
      await this.applyTxes(res)
    }

    this.inProgress = false
  }

  // Push/sound/email/telegram senders filter by allowedProviders, so trimming them leaves the inbox entry alone.
  private keepInboxProviderOnly (txes: TxCUD<Doc>[]): void {
    for (const tx of txes) {
      if (tx._class !== core.class.TxCreateDoc) continue
      if (!this.hierarchy.isDerived(tx.objectClass, notification.class.InboxNotification)) continue
      const attrs = (tx as TxCreateDoc<InboxNotification>).attributes
      const types = attrs.allowedProviders?.[notification.providers.InboxNotificationProvider]
      attrs.allowedProviders = types !== undefined ? { [notification.providers.InboxNotificationProvider]: types } : {}
    }
  }

  private async applyTxes (txes: TxCUD<Doc>[]): Promise<void> {
    if (txes.length === 0) return

    for (let i = 0; i < txes.length; i += config.ApplyTxBatchSize) {
      const batch = txes.slice(i, i + config.ApplyTxBatchSize)
      const txApply = this.txFactory.createTxApplyIf(
        core.space.DerivedTx,
        'notifications',
        [],
        [],
        batch,
        undefined,
        true
      )
      try {
        await this.rest.tx(txApply)
      } catch (e) {
        this.ctx.error('Failed to send tx batch', { e, tx: txApply, batchSize: batch.length })
      }
    }
  }

  private getClient (): Client {
    return {
      ctx: this.ctx,
      txFactory: this.txFactory,
      workspace: this.ws,
      storage: this.storage,
      hierarchy: this.hierarchy,
      model: this.model,
      branding: this.branding,
      findAll: async <T extends Doc>(
        _class: Ref<Class<T>>,
        query: DocumentQuery<T>,
        options?: FindOptions<T>
      ): Promise<FindResult<T>> => {
        return await this.pipeline.findAll(this.ctx, _class, query, options)
      },
      findOne: async <T extends Doc>(
        _class: Ref<Class<T>>,
        query: DocumentQuery<T>,
        options?: FindOptions<T>
      ): Promise<WithLookup<T> | undefined> => {
        return (await this.pipeline.findAll(this.ctx, _class, query, { ...options, limit: 1 }))[0]
      }
    }
  }

  async processReadState (_tx: TxCUD<ReadState>): Promise<TxCUD<Doc>[]> {
    if (_tx._class !== core.class.TxUpdateDoc) return []

    const tx = _tx as TxUpdateDoc<ReadState>
    if (tx.attachedTo == null) return []

    const res: TxCUD<Doc>[] = []
    const contexts = await this.cache.getContexts(tx.attachedTo)

    for (const [key, value] of Object.entries(tx.operations)) {
      const ctx = contexts.filter((it) => it.user === key)
      if (ctx.length === 0) continue
      const ts = (value as ReadPosition)?.timestamp ?? 0
      if (ts === 0) continue

      for (const context of ctx) {
        const current = context.lastView ?? 0
        if (current === ts) continue
        context.lastView = ts
        res.push(
          this.txFactory.createTxUpdateDoc(context._class, context.space, context._id, {
            lastView: ts
          })
        )
      }
    }

    return res
  }

  async processTxNotifications (tx: TxCUD<Doc>): Promise<TxCUD<Doc>[]> {
    if (this.hierarchy.isDerived(tx.objectClass, activity.class.Reaction)) {
      return await this.processReaction(tx as TxCUD<Reaction>)
    }

    let matched: TxNotificationType[] = []
    const client: Client = this.client
    const { hierarchy } = client

    for (const type of this.txTypes) {
      if (isMatchedTxType(client, tx, type)) {
        matched.push(type)
      }
    }

    if (matched.length === 0) return []

    const txAttachedToDoc =
      tx.attachedTo != null && tx.attachedToClass != null
        ? await this.cache.getDoc(tx.attachedTo, tx.attachedToClass)
        : undefined
    const txObject =
      tx._class === core.class.TxCreateDoc
        ? TxProcessor.createDoc2Doc(tx as TxCreateDoc<Doc>)
        : await this.cache.getDoc(tx.objectId, tx.objectClass)
    if (txObject === undefined) return []

    const space = await this.cache.getDocSpace(txObject)
    if (space === undefined) return []

    const res: TxCUD<Doc>[] = []
    const sender = await this.cache.getSender(tx.modifiedBy)

    const settings = await this.cache.getSettings()
    const mentionType = matched.find((it) => it._id === notification.ids.MentionNotificationType)

    if (mentionType != null) {
      const doc = hierarchy.isDerived(txObject._class, activity.class.ActivityMessage)
        ? (txAttachedToDoc ?? txObject)
        : txObject
      const contexts = await this.cache.getContexts(doc._id)
      if (
        tx._class === core.class.TxCreateDoc &&
        hierarchy.isDerived(txObject._class, activity.class.ActivityMessage)
      ) {
        res.push(
          ...this.updateContextLastUpdate(
            contexts,
            (txObject as ActivityMessage).createdOn ?? tx.modifiedOn,
            sender.account,
            []
          )
        )
      }
      const result = await createMentionsData(client, this.cache, tx, contexts, doc, txObject, settings, mentionType)
      res.push(...result.txes)

      for (const d of result.data) {
        res.push(
          ...(await this.createNotifications(
            notification.class.MentionInboxNotification,
            d.data,
            await getMentionNotificationContent(client, doc, txObject, d.data.markup, sender),
            doc,
            tx.modifiedOn,
            tx.modifiedBy,
            d.context,
            d.receiver,
            d.notifyResult,
            hierarchy.isDerived(txObject._class, activity.class.ActivityMessage),
            [],
            (txObject as ActivityMessage).createdOn
          ))
        )
      }

      matched = matched.filter((it) => it._id !== notification.ids.MentionNotificationType)
    }

    if (matched.length === 0) return res

    const notifiedUsers = getNotifiedUsers(this.hierarchy, res)

    for (const matchedType of matched) {
      const doc =
        hierarchy.isDerived(txObject._class, activity.class.ActivityMessage) || matchedType.attachToParent === true
          ? (txAttachedToDoc ?? txObject)
          : txObject
      const contexts = await this.cache.getContexts(doc._id)
      const collaborators = (await this.getCollaboratorAccounts(doc, space)).filter((it) => !notifiedUsers.includes(it))
      if (collaborators.length === 0) continue

      const receivers = await this.cache.getReceivers(collaborators)

      for (const receiver of receivers) {
        const context = contexts.find((it) => it.user === receiver.account)
        const mode = context?.settings?.mode ?? 'all'
        if (mode === 'mute') continue
        const notifyResult = await getTxNotifyResult(client, tx, doc, receiver, settings, [matchedType], mode)

        const types = notifyResult[notification.providers.InboxNotificationProvider] ?? []
        const type = types[0] as TxNotificationType
        if (type == null) continue

        if (client.hierarchy.hasMixin(type, serverNotification.mixin.TypeMatch)) {
          const mixin = client.hierarchy.as<NotificationType, TypeMatch>(type, serverNotification.mixin.TypeMatch)
          if (mixin.create == null) continue
          const f = await getResource(mixin.create)
          const data = await f(getTypeMatchClient(client), tx, txAttachedToDoc, txObject, receiver)
          if (data == null) continue
          let content: NotificationContent

          if (mixin.contentProvider != null) {
            const f = await getResource(mixin.contentProvider)
            content = await f(getTypeMatchClient(client), type, tx, txAttachedToDoc ?? txObject, txObject, sender)
          } else {
            const intlParams: Record<string, string | number> = {
              ...data.intlParams,
              senderName: getSenderName(sender, client.branding?.lastNameFirst)
            }
            const intlParamsNotLocalized: Record<string, IntlString> = { ...data.intlParamsNotLocalized }

            if (data.markup != null) {
              intlParams.message = normalizeTextMessage(markupToText(data.markup))
            } else if (data.message != null) {
              intlParamsNotLocalized.message = data.message
            }

            if (data.header != null) {
              intlParamsNotLocalized.title = data.header
            }

            const message = intlParams.message ?? intlParamsNotLocalized.message
            content = {
              title:
                intlParams.identifier != null
                  ? notification.string.CommonNotificationTitleWithIdentifier
                  : notification.string.CommonNotificationTitle,
              body:
                message != null
                  ? notification.string.MessageNotificationBody
                  : notification.string.UpdateNotificationBody,
              intlParams,
              intlParamsNotLocalized
            }
          }

          notifiedUsers.push(receiver.account)
          res.push(
            ...(await this.createNotifications(
              notification.class.CommonInboxNotification,
              data,
              content,
              doc,
              tx.modifiedOn,
              tx.modifiedBy,
              context,
              receiver,
              notifyResult,
              false
            ))
          )
        }
      }
    }

    return res
  }

  private async processReaction (tx: TxCUD<Reaction>): Promise<TxCUD<Doc>[]> {
    if (tx._class === core.class.TxCreateDoc) {
      return await this.processCreateReaction(tx as TxCreateDoc<Reaction>)
    } else if (tx._class === core.class.TxRemoveDoc) {
      return await this.processRemoveReaction(tx)
    }

    return []
  }

  private async processCreateReaction (tx: TxCreateDoc<Reaction>): Promise<TxCUD<Doc>[]> {
    if (tx.attachedTo === undefined) return []

    const reaction = TxProcessor.createDoc2Doc(tx)

    const message = await this.client.findOne(activity.class.ActivityMessage, { _id: reaction.attachedTo })
    if (message === undefined) return []

    const socialId = message.createdBy ?? message.modifiedBy
    if (socialId === core.account.System || socialId === tx.modifiedBy) return []

    const doc = await this.client.findOne(message.attachedToClass, { _id: message.attachedTo })
    if (doc === undefined) return []

    const account = await this.cache.getAccountBySocialId(socialId)
    if (account == null) return []

    const receiver = (await this.cache.getReceivers([account]))[0]
    if (receiver === undefined) return []

    const settings = await this.cache.getSettings()

    const data: Partial<Data<ReactionInboxNotification>> = {
      emoji: reaction.emoji,
      attachedTo: message._id,
      attachedToClass: message._class,
      ref: reaction._id
    }

    const type: TxNotificationType = this.model.findAllSync(notification.class.TxNotificationType, {
      _id: activity.ids.AddReactionNotification
    })[0]

    const providers: Ref<NotificationProvider>[] = getAllowedProviders(this.client, settings, receiver.socialIds, type)
    if (providers.length === 0 || !providers.includes(notification.providers.InboxNotificationProvider)) return []

    const res: TxCUD<Doc>[] = []
    const context = (await this.cache.getContexts(doc._id)).find((it) => it.user === receiver.account)
    const sender = await this.cache.getSender(reaction.modifiedBy)

    const notifyResult: NotifyResult = Object.fromEntries(providers.map((p) => [p, [type]]))

    const txes = await this.createNotifications(
      notification.class.ReactionInboxNotification,
      data,
      getReactionNotificationContent(this.client, message, reaction, sender),
      doc,
      reaction.modifiedOn,
      reaction.modifiedBy,
      context,
      receiver,
      notifyResult,
      false
    )

    res.push(...txes)

    return res
  }

  private async processRemoveReaction (tx: TxRemoveDoc<Reaction>): Promise<TxCUD<Doc>[]> {
    const toRemove = await this.client.findAll(notification.class.ReactionInboxNotification, { ref: tx.objectId })

    return toRemove.map((it) => this.txFactory.createTxRemoveDoc(it._class, it.space, it._id))
  }

  private async processMessage (
    tx: TxCUD<ActivityMessage>,
    notifiedUsers: AccountUuid[],
    _res: TxCUD<Doc>[]
  ): Promise<TxCUD<Doc>[]> {
    if (tx._class === core.class.TxCreateDoc) {
      return await this.processCreateMessage(tx as TxCreateDoc<ActivityMessage>, notifiedUsers, _res)
    } else if (tx._class === core.class.TxRemoveDoc) {
      return await this.processRemoveMessage(tx)
    } else if (tx._class === core.class.TxUpdateDoc) {
      if (!this.client.hierarchy.isDerived(tx.objectClass, activity.class.DocUpdateMessage)) return []

      const updateTx = tx as TxUpdateDoc<DocUpdateMessage>
      const ops = updateTx.operations ?? {}
      const historyChanged =
        ops.history !== undefined || ops.$push?.history !== undefined || ops.$pull?.history !== undefined

      // Skip processing if it's a simple aggregation of history within CREATE_COMBINE_THRESHOLD.
      // This aggregation ONLY uses $push: { history: ... } and doesn't change the main message content.
      const isCombine = ops.$push?.history !== undefined && Object.keys(ops).length === 1

      if (historyChanged && !isCombine) {
        return await this.processUpdateMessage(updateTx, notifiedUsers, _res)
      }
    }

    return []
  }

  private async processCreateMessage (
    tx: TxCreateDoc<ActivityMessage>,
    notifiedUsers: AccountUuid[],
    _res: TxCUD<Doc>[]
  ): Promise<TxCUD<Doc>[]> {
    const client = this.client
    const message = TxProcessor.createDoc2Doc(tx)

    const doc = await this.cache.getDoc(message.attachedTo, message.attachedToClass)
    if (doc === undefined) return []

    const space = await this.cache.getDocSpace(doc)
    if (space === undefined) return []

    const res: TxCUD<Doc>[] = []
    const contexts = await this.cache.getContexts(doc._id)
    const sender = await this.cache.getSender(message.modifiedBy)

    res.push(...this.updateContextLastUpdate(contexts, message.createdOn ?? message.modifiedOn, sender.account, _res))

    const collaborators = (await this.getCollaboratorAccounts(doc, space)).filter((it) => !notifiedUsers.includes(it))

    if (client.hierarchy.isDerived(message._class, activity.class.DocUpdateMessage)) {
      const dum = message as DocUpdateMessage

      if (dum.objectClass === core.class.Collaborator) {
        const acc = dum.objectAttributes?.collaborator as AccountUuid | undefined
        if (acc != null && !collaborators.includes(acc)) collaborators.push(acc)
      }
    }

    if (collaborators.length === 0) return res

    const settings = await this.cache.getSettings()
    const receivers = await this.cache.getReceivers(collaborators)

    if (receivers.length === 0) return res
    const contentByType = new Map<Ref<NotificationType>, NotificationContent>()

    for (const receiver of receivers) {
      const context = contexts.find((it) => it.user === receiver.account)
      const mode = context?.settings?.mode ?? 'all'
      if (mode === 'mute') continue
      const notifyResult = await getMessageNotifyResult(client, message, doc, receiver, settings, mode)

      const types = notifyResult[notification.providers.InboxNotificationProvider] ?? []
      const type = types[0]
      if (type == null) continue

      const content =
        contentByType.get(type._id) ??
        (await getMessageNotificationContent(
          client,
          type,
          doc,
          message,
          sender,
          client.branding?.defaultLanguage ?? 'en'
        ))
      contentByType.set(type._id, content)

      res.push(
        ...(await this.createNotifications(
          notification.class.ActivityInboxNotification,
          {
            attachedTo: message._id,
            attachedToClass: message._class
          },
          content,
          doc,
          message.modifiedOn,
          message.modifiedBy,
          context,
          receiver,
          notifyResult,
          true,
          res,
          message.createdOn
        ))
      )
    }
    return res
  }

  private async createNotifications<T extends InboxNotification>(
    _class: Ref<Class<T>>,
    data: Partial<Data<T>>,
    content: NotificationContent,
    doc: Doc,
    modifiedOn: Timestamp,
    modifiedBy: PersonId,
    context: DocNotifyContext | undefined,
    receiver: Receiver,
    notifyResult: NotifyResult,
    isMessageNotify: boolean,
    txes: TxCUD<Doc>[] = [],
    messageCreatedOn?: Timestamp
  ): Promise<TxCUD<Doc>[]> {
    const res: TxCUD<Doc>[] = []

    let contextId: Ref<DocNotifyContext>
    if (context != null) {
      contextId = context._id
      const updateTx = this.findContextUpdateTx(txes, contextId)
      if (updateTx != null) {
        updateTx.operations.lastNotify = modifiedOn
        if (isMessageNotify) {
          updateTx.operations.lastNotifiedMessage = modifiedOn
        }
      } else {
        res.push(
          this.txFactory.createTxUpdateDoc(context._class, context.space, context._id, {
            lastNotify: modifiedOn,
            ...(isMessageNotify ? { lastNotifiedMessage: modifiedOn } : {})
          })
        )
      }
    } else {
      const readState = await this.cache.getDocReadState(doc._id)
      const lastView = readState?.[receiver.account]?.timestamp ?? 0
      const contextTx = this.getCreateContextTx(doc, receiver, modifiedOn, lastView, isMessageNotify, messageCreatedOn)
      res.push(contextTx)
      contextId = TxProcessor.createDoc2Doc(contextTx)._id
    }

    const allowedProviders: Record<Ref<NotificationProvider>, Ref<NotificationType>[]> = Object.fromEntries(
      Object.entries(notifyResult).map(([provider, types]) => [provider, types.map((it) => it._id)])
    )

    const attrs: Data<InboxNotification> = {
      ...data,
      ...content,
      intlParams: { ...data.intlParams, ...content.intlParams },
      intlParamsNotLocalized: { ...data.intlParamsNotLocalized, ...content.intlParamsNotLocalized },
      objectId: doc._id,
      objectClass: doc._class,
      user: receiver.account,
      isViewed: receiver.role === 'GUEST' && receiver.account === readOnlyGuestAccountUuid,
      docNotifyContext: contextId,
      archived: false,
      allowedProviders
    }
    const tx = this.txFactory.createTxCreateDoc(_class, receiver.space, attrs, undefined, modifiedOn, modifiedBy)
    res.push(tx)

    return res
  }

  private getCreateContextTx (
    doc: Doc,
    receiver: Receiver,
    createdOn: Timestamp,
    lastView: Timestamp,
    isMessageNotify: boolean,
    messageCreatedOn?: Timestamp
  ): TxCreateDoc<DocNotifyContext> {
    const createTx = this.txFactory.createTxCreateDoc(notification.class.DocNotifyContext, receiver.space, {
      user: receiver.account,
      objectId: doc._id,
      objectClass: doc._class,
      objectSpace: doc.space,
      lastView,
      lastUpdate: isMessageNotify ? (messageCreatedOn ?? createdOn) : undefined,
      lastNotify: createdOn,
      lastNotifiedMessage: isMessageNotify ? createdOn : undefined
    })

    this.cache.storeContext(TxProcessor.createDoc2Doc(createTx))
    return createTx
  }

  private async processRemoveMessage (tx: TxRemoveDoc<ActivityMessage>): Promise<TxCUD<Doc>[]> {
    return []
  }

  private async processUpdateMessage (
    tx: TxUpdateDoc<DocUpdateMessage>,
    notifiedUsers: AccountUuid[],
    _res: TxCUD<Doc>[]
  ): Promise<TxCUD<Doc>[]> {
    const client = this.client
    const _message = await this.cache.getDoc(tx.objectId, tx.objectClass)
    if (_message === undefined) return []

    const message = TxProcessor.updateDoc2Doc(_message, tx)

    const doc = await this.cache.getDoc(message.attachedTo, message.attachedToClass)
    if (doc === undefined) return []

    const space = await this.cache.getDocSpace(doc)
    if (space === undefined) return []

    const res: TxCUD<Doc>[] = []
    const contexts = await this.cache.getContexts(doc._id)
    const sender = await this.cache.getSender(tx.modifiedBy)

    const collaborators = (await this.getCollaboratorAccounts(doc, space)).filter((it) => !notifiedUsers.includes(it))

    if (message.objectClass === core.class.Collaborator) {
      const acc = message.objectAttributes?.collaborator as AccountUuid | undefined
      if (acc != null && !collaborators.includes(acc)) collaborators.push(acc)
    }

    if (collaborators.length === 0) return res

    const settings = await this.cache.getSettings()
    const receivers = await this.cache.getReceivers(collaborators)

    if (receivers.length === 0) return res

    const oldNotifications = (await this.client.findAll(notification.class.ActivityInboxNotification, {
      attachedTo: message._id
    })) as InboxNotification[]

    for (const receiver of receivers) {
      const context = contexts.find((it) => it.user === receiver.account)
      const mode = context?.settings?.mode ?? 'all'
      if (mode === 'mute') continue

      const notifyResult = await getMessageNotifyResult(client, message, doc, receiver, settings, mode)
      const types = notifyResult[notification.providers.InboxNotificationProvider] ?? []
      const type = types[0]
      if (type == null) continue

      const oldNotification = oldNotifications.find((it) => it.user === receiver.account)
      if (oldNotification != null) {
        res.push(this.txFactory.createTxRemoveDoc(oldNotification._class, oldNotification.space, oldNotification._id))
      }

      res.push(
        ...(await this.createNotifications(
          notification.class.ActivityInboxNotification,
          {
            attachedTo: message._id,
            attachedToClass: message._class
          },
          await getMessageNotificationContent(
            client,
            type,
            doc,
            message,
            sender,
            client.branding?.defaultLanguage ?? 'en'
          ),
          doc,
          tx.modifiedOn,
          tx.modifiedBy,
          context,
          receiver,
          notifyResult,
          true,
          res
        ))
      )
    }
    return res
  }

  private async getCollaboratorAccounts (doc: Doc, space: Space): Promise<AccountUuid[]> {
    const collaborators = await this.cache.getCollaborators(doc._id, doc._class)

    const filtered = !space.private
      ? collaborators
      : collaborators.filter((it) => space.members.includes(it.collaborator))

    const accounts = new Set(filtered.map((it) => it.collaborator))

    if (this.hierarchy.isDerived(doc._class, contact.mixin.Employee)) {
      const account = (doc as Employee).personUuid

      if (account != null) {
        accounts.add(account)
      }
    }

    return Array.from(accounts)
  }

  private findContextUpdateTx (
    txes: TxCUD<Doc>[],
    _id: Ref<DocNotifyContext>
  ): TxUpdateDoc<DocNotifyContext> | undefined {
    return txes.find(
      (it): it is TxUpdateDoc<DocNotifyContext> =>
        it._class === core.class.TxUpdateDoc &&
        (it as TxUpdateDoc<Doc>).objectClass === notification.class.DocNotifyContext &&
        (it as TxUpdateDoc<DocNotifyContext>).objectId === _id
    )
  }

  private updateContextLastUpdate (
    contexts: DocNotifyContext[],
    timestamp: Timestamp,
    author: AccountUuid | undefined,
    txes: TxCUD<Doc>[]
  ): TxCUD<Doc>[] {
    return contexts
      .map((it) => {
        const updateTx = this.findContextUpdateTx(txes, it._id)
        if (updateTx != null) {
          updateTx.operations.lastUpdate = Math.max(updateTx.operations.lastUpdate ?? it.lastUpdate ?? 0, timestamp)
          if (it.user === author) {
            updateTx.operations.lastView = Math.max(updateTx.operations.lastView ?? it.lastView ?? 0, timestamp)
          }
          return undefined
        }
        return this.txFactory.createTxUpdateDoc(it._class, it.space, it._id, {
          lastUpdate: Math.max(it.lastUpdate ?? 0, timestamp),
          ...(it.user === author ? { lastView: Math.max(timestamp, it.lastView ?? 0) } : {})
        })
      })
      .filter(notEmpty)
  }

  public isInProgress (): boolean {
    return this.inProgress
  }

  public getLastTxDate (): Timestamp | undefined {
    return this.lastUpdate
  }

  static async create (
    ctx: MeasureContext,
    ws: WorkspaceInfoWithStatus,
    hierarchy: Hierarchy,
    modelDb: ModelDb,
    sysModel: Tx[],
    storage: StorageAdapter,
    rest: RestClient,
    branding: Branding | undefined,
    txTypes: TxNotificationType[]
  ): Promise<Workspace> {
    const dbConf = getConfig(ctx, config.DbUrl, ctx, {
      disableTriggers: true,
      externalStorage: storage
    })

    const middlewares: MiddlewareCreator[] = [
      LowLevelMiddleware.create,
      ContextNameMiddleware.create,
      DomainFindMiddleware.create,
      DomainTxMiddleware.create,
      DBAdapterInitMiddleware.create,
      ModelMiddleware.create(sysModel),
      DBAdapterMiddleware.create(dbConf)
    ]

    const context: PipelineContext = {
      workspace: {
        uuid: ws.uuid,
        url: ws.url
      },
      branding: branding ?? null,
      modelDb,
      hierarchy,
      storageAdapter: storage,
      contextVars: {}
    }
    const pipeline = await createPipeline(ctx, middlewares, context)

    const defaultAdapter = pipeline.context.adapterManager?.getDefaultAdapter()
    if (defaultAdapter === undefined) {
      throw new PlatformError(unknownError('Default adapter should be set'))
    }

    if (pipeline.context.lowLevelStorage === undefined) {
      throw new Error('Low level storage is not defined')
    }

    return new Workspace(ctx, ws, pipeline, hierarchy, modelDb, rest, storage, branding, txTypes)
  }

  async close (): Promise<void> {
    try {
      await this.pipeline.close()
    } catch (e) {
      this.ctx.error('Error during close workspace', { e })
    }
  }
}

export default Workspace
