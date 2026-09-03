import {
  BaseMiddleware,
  type Middleware,
  type PipelineContext,
  type TxMiddlewareResult
} from '@hcengineering/server-core'
import core, {
  type Doc,
  Tx,
  type TxCreateDoc,
  type TxCUD,
  TxProcessor,
  type TxUpdateDoc,
  MeasureContext,
  TxFactory,
  Ref,
  type Domain,
  type SessionData,
  AccountUuid,
  type Class,
  type DocumentQuery,
  type FindOptions,
  type FindResult,
  combineAttributes,
  systemAccountUuid
} from '@hcengineering/core'
import chunter, { Chat, type DirectMessage } from '@hcengineering/chunter'
import { PersonSpace } from '@hcengineering/contact'
import platform, { PlatformError, Severity, Status } from '@hcengineering/platform'
import { createHash } from 'crypto'
import notification, { ContextNotification, DocNotifyContext } from '@hcengineering/notification'

export const DOMAIN_CHUNTER_DOC = 'chunter_doc' as Domain

type ChatData = Pick<Chat, '_id' | '_class' | 'space' | 'attachedTo' | 'attachedToClass'>

export class ChunterMiddleware extends BaseMiddleware {
  private readonly hiddenChats = new Map<Ref<Doc>, ChatData[]>()

  static async create (ctx: MeasureContext, context: PipelineContext, next?: Middleware): Promise<Middleware> {
    return new ChunterMiddleware(context, next)
  }

  async tx (ctx: MeasureContext<SessionData>, txes: Tx[]): Promise<TxMiddlewareResult> {
    const { hierarchy } = this.context
    const factory = new TxFactory(core.account.System, true)

    for (const _tx of txes) {
      if (!TxProcessor.isExtendsCUD(_tx._class)) continue
      const tx = _tx as TxCUD<Doc>
      if (
        _tx._class === core.class.TxCreateDoc &&
        hierarchy.isDerived(tx.objectClass, notification.class.DocNotifyContext)
      ) {
        const tx = _tx as TxCreateDoc<DocNotifyContext>
        const context = TxProcessor.createDoc2Doc(tx)
        if (context.unreadMessages.length === 0 || context.latestNotifications.length === 0) continue

        const chats = await this.getHiddenChats(context.objectId)

        const ttxes = this.getUnhideChatsTx(factory, context.objectId, chats)
        if (ttxes.length > 0) {
          await this.context.derived?.tx(ctx, ttxes)
        }
      }

      if (
        _tx._class === core.class.TxUpdateDoc &&
        hierarchy.isDerived(tx.objectClass, notification.class.DocNotifyContext)
      ) {
        const tx = _tx as TxUpdateDoc<DocNotifyContext>
        const pushedNotifications: ContextNotification[] = combineAttributes(
          [tx.operations],
          'latestNotifications',
          '$push',
          '$each'
        )
        if (pushedNotifications.length === 0) continue
        const messageNotification = pushedNotifications.filter((it) => it.type === 'message')[0]
        if (messageNotification == null) continue

        const chats = await this.getHiddenChats(messageNotification.message.attachedTo)

        const ttxes = this.getUnhideChatsTx(factory, messageNotification.message.attachedTo, chats)
        if (ttxes.length > 0) {
          await this.context.derived?.tx(ctx, ttxes)
        }
      }

      if (
        _tx._class === core.class.TxCreateDoc &&
        this.context.hierarchy.isDerived(tx.objectClass, chunter.class.DirectMessage)
      ) {
        await this.onDirectCreate(ctx, _tx as TxCreateDoc<DirectMessage>)
      }

      if (
        _tx._class === core.class.TxUpdateDoc &&
        this.context.hierarchy.isDerived(tx.objectClass, chunter.class.DirectMessage)
      ) {
        await this.onDirectUpdate(ctx, _tx as TxUpdateDoc<DirectMessage>)
      }

      if (_tx._class === core.class.TxCreateDoc && hierarchy.isDerived(tx.objectClass, chunter.class.Chat)) {
        const createTx = _tx as TxCreateDoc<Chat>
        const chat = TxProcessor.createDoc2Doc(createTx)

        if (chat.attachedTo == null) {
          this.throwForbidden()
          continue
        }

        if (chat.hidden) {
          const current = this.hiddenChats.get(chat.attachedTo)
          if (current != null) current.push(chat)
        }
      }

      if (_tx._class === core.class.TxUpdateDoc && hierarchy.isDerived(tx.objectClass, chunter.class.Chat)) {
        const updateTx = _tx as TxUpdateDoc<Chat>
        if (updateTx.attachedTo == null || updateTx.attachedToClass == null) {
          this.throwForbidden()
          continue
        }

        const hidden = updateTx.operations.hidden
        if (hidden === true) {
          const current = this.hiddenChats.get(updateTx.attachedTo)
          if (current != null) {
            current.push({
              _id: updateTx.objectId,
              _class: updateTx.objectClass,
              space: updateTx.objectSpace as Ref<PersonSpace>,
              attachedTo: updateTx.attachedTo,
              attachedToClass: updateTx.attachedToClass
            })
          }
        } else if (hidden === false) {
          const current = this.hiddenChats.get(updateTx.attachedTo)
          if (current == null) continue
          this.hiddenChats.set(
            updateTx.attachedTo,
            current.filter((chat) => chat._id !== updateTx.objectId)
          )
        }
      }
    }

    return await this.provideTx(ctx, txes)
  }

  async findAll<T extends Doc>(
    ctx: MeasureContext,
    _class: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: FindOptions<T>
  ): Promise<FindResult<T>> {
    const { hierarchy } = this.context
    if (hierarchy.isDerived(_class, chunter.class.DirectMessage)) {
      if (query?.$search != null && query.$search !== '' && !query.$search.startsWith('*')) {
        query.$search = query.$search.startsWith('*') ? query.$search : '*' + query.$search
      }
    }

    return await this.provideFindAll(ctx, _class, query, options)
  }

  private getUnhideChatsTx (factory: TxFactory, attachedTo: Ref<Doc>, chats: ChatData[]): Tx[] {
    this.hiddenChats.set(attachedTo, [])
    return chats.map((chat) => {
      const updateTx = factory.createTxUpdateDoc(chat._class, chat.space, chat._id, { hidden: false })
      return factory.createTxCollectionCUD(chat.attachedToClass, chat.attachedTo, chat.space, 'chats', updateTx)
    })
  }

  private async getHiddenChats (doc: Ref<Doc>): Promise<ChatData[]> {
    if (this.hiddenChats.has(doc)) return this.hiddenChats.get(doc) ?? []

    const chats =
      (await this.context.lowLevelStorage?.rawFindAll<Chat>(DOMAIN_CHUNTER_DOC, { hidden: true, attachedTo: doc })) ??
      []
    this.hiddenChats.set(doc, chats)

    return chats
  }

  private async onDirectCreate (ctx: MeasureContext<SessionData>, tx: TxCreateDoc<DirectMessage>): Promise<void> {
    const account = ctx.contextData.account

    tx.objectSpace = core.space.Space
    tx.attributes.archived = false
    tx.attributes.autoJoin = false
    tx.attributes.private = true
    // A service creates directs on someone else's behalf (ai-bot welcome): adding the system account
    // makes it a three-member group, which skips the referenceId dedup below.
    if (account.uuid !== systemAccountUuid) {
      tx.attributes.members = Array.from(new Set([...tx.attributes.members, account.uuid]))
    }
    tx.attributes.type = tx.attributes.members.length > 2 ? 'group' : 'person'

    delete tx.attributes.referenceId

    if (tx.attributes.members.length <= 2) {
      const referenceId = getMembersHash(tx.attributes.members)

      const direct = await this.findAll(ctx, chunter.class.DirectMessage, { referenceId })
      if (direct.length > 0) {
        this.throwForbidden()
      }
      tx.attributes.referenceId = referenceId
    }
  }

  private async onDirectUpdate (ctx: MeasureContext<SessionData>, tx: TxUpdateDoc<DirectMessage>): Promise<void> {
    if (tx.operations.referenceId != null) {
      this.throwForbidden()
    }
    if (tx.operations?.$unset?.referenceId != null) {
      this.throwForbidden()
    }
    if (tx.operations.private != null) {
      this.throwForbidden()
    }
    if (tx.operations?.$unset?.private != null) {
      this.throwForbidden()
    }
    if (tx.operations.type != null) {
      this.throwForbidden()
    }
    if (tx.operations?.$unset?.type != null) {
      this.throwForbidden()
    }

    const hasMembersUpdates =
      tx.operations.members != null ||
      tx.operations.$unset?.members != null ||
      tx.operations.$pull?.members != null ||
      tx.operations.$push?.members != null

    if (!hasMembersUpdates) return

    const direct = (await this.findAll(ctx, chunter.class.DirectMessage, { _id: tx.objectId }))[0]
    if (direct?.referenceId != null || direct.type === 'person') {
      this.throwForbidden()
    }
  }

  private throwForbidden (): void {
    throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
  }
}

function getMembersHash (uuids: AccountUuid[]): string | undefined {
  if (uuids.length === 0) return undefined

  return createHash('sha256').update(uuids.slice().sort().join('|')).digest().toString('base64url')
}
