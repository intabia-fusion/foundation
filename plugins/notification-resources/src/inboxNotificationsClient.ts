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
import activity, { type ActivityMessage } from '@hcengineering/activity'
import core, {
  type Account,
  AccountRole,
  type Client,
  type Doc,
  generateId,
  getCurrentAccount,
  type IdMap,
  type Ref,
  SortingOrder,
  toIdMap,
  type Tx,
  type TxCreateDoc,
  type TxOperations,
  TxProcessor,
  type TxUpdateDoc,
  type WithLookup
} from '@hcengineering/core'
import notification, {
  type ActivityInboxNotification,
  type DocNotifyContext,
  type InboxNotification,
  type InboxNotificationsClient,
  type ReadState
} from '@hcengineering/notification'
import { addTxListener, createQuery, getClient, onClient } from '@hcengineering/presentation'
import { derived, get, writable } from 'svelte/store'

/**
 * @public
 */
export class InboxNotificationsClientImpl implements InboxNotificationsClient {
  protected static _instance: InboxNotificationsClientImpl | undefined = undefined

  readonly contexts = writable<DocNotifyContext[]>([])
  readonly contextByDoc = writable<Map<Ref<Doc>, DocNotifyContext>>(new Map())
  readonly contextById = derived(
    [this.contexts],
    ([contexts]) => toIdMap(contexts),
    new Map() as IdMap<DocNotifyContext>
  )

  readonly readStateByDoc = writable<Map<Ref<Doc>, ReadState | null>>(new Map())

  readonly activityInboxNotifications = writable<Array<WithLookup<ActivityInboxNotification>>>([])
  readonly otherInboxNotifications = writable<InboxNotification[]>([])

  readonly inboxNotifications = derived(
    [this.activityInboxNotifications, this.otherInboxNotifications],
    ([activityNotifications, otherNotifications]) => {
      return otherNotifications
        .concat(activityNotifications)
        .sort((n1, n2) => (n2.createdOn ?? n2.modifiedOn) - (n1.createdOn ?? n1.modifiedOn))
    },
    [] as InboxNotification[]
  )

  readonly inboxNotificationsByContext = derived(
    [this.contextById, this.inboxNotifications],
    ([contextById, inboxNotifications]) => {
      if (inboxNotifications.length === 0 || contextById.size === 0) {
        return new Map<Ref<DocNotifyContext>, InboxNotification[]>()
      }

      return inboxNotifications.reduce((result, notification) => {
        const notifyContext = contextById.get(notification.docNotifyContext)

        if (notifyContext === undefined) {
          return result
        }

        return result.set(notifyContext._id, (result.get(notifyContext._id) ?? []).concat(notification))
      }, new Map<Ref<DocNotifyContext>, InboxNotification[]>())
    }
  )

  private readonly contextsQuery = createQuery(true)
  private readonly otherInboxNotificationsQuery = createQuery(true)
  private readonly activityInboxNotificationsQuery = createQuery(true)

  private _contextByDoc = new Map<Ref<Doc>, DocNotifyContext>()

  private constructor () {
    onClient(this.init.bind(this))
  }

  private async init (client: Client, account: Account): Promise<void> {
    this.contextsQuery.query(
      notification.class.DocNotifyContext,
      {
        user: account.uuid
      },
      (result: DocNotifyContext[]) => {
        this.contexts.set(result)
        this._contextByDoc = new Map(result.map((updates) => [updates.objectId, updates]))
        this.contextByDoc.set(this._contextByDoc)
      }
    )
    this.otherInboxNotificationsQuery.query(
      notification.class.CommonInboxNotification,
      {
        archived: false,
        user: account.uuid
      },
      (result: InboxNotification[]) => {
        result.sort((a, b) => (b.createdOn ?? b.modifiedOn) - (a.createdOn ?? a.modifiedOn))
        this.otherInboxNotifications.set(result)
      }
    )

    this.activityInboxNotificationsQuery.query(
      notification.class.ActivityInboxNotification,
      {
        archived: false,
        user: account.uuid
      },
      (result: ActivityInboxNotification[]) => {
        this.activityInboxNotifications.set(result)
      },
      {
        sort: {
          createdOn: SortingOrder.Descending
        },
        lookup: {
          attachedTo: activity.class.ActivityMessage
        },
        limit: 1000
      }
    )
  }

  static createClient (): InboxNotificationsClientImpl {
    InboxNotificationsClientImpl._instance = new InboxNotificationsClientImpl()
    return InboxNotificationsClientImpl._instance
  }

  static getClient (): InboxNotificationsClientImpl {
    InboxNotificationsClientImpl._instance ??= new InboxNotificationsClientImpl()
    return InboxNotificationsClientImpl._instance
  }

  async loadReadState (attachedTo: Ref<Doc>): Promise<void> {
    const current = get(this.readStateByDoc).get(attachedTo)
    if (current != null) {
      return
    }

    const client = getClient()
    const state = await client.findOne(notification.class.ReadState, { attachedTo })

    this.readStateByDoc.update((readStateByDoc) => {
      readStateByDoc.set(attachedTo, state ?? null)

      return readStateByDoc
    })
  }

  async getReadState (attachedTo: Ref<Doc>): Promise<ReadState | undefined> {
    const current = get(this.readStateByDoc).get(attachedTo)
    if (current != null) {
      return current
    }

    const client = getClient()
    const state = await client.findOne(notification.class.ReadState, { attachedTo })

    this.readStateByDoc.update((readStateByDoc) => readStateByDoc.set(attachedTo, state ?? null))

    return state
  }

  async readDoc (_id: Ref<Doc>): Promise<void> {
    const client = getClient()
    const docNotifyContext = this._contextByDoc.get(_id)
    const me = getCurrentAccount()

    if (me.role === AccountRole.ReadOnlyGuest) {
      return
    }
    const op = client.apply(undefined, 'readDoc', true)

    const read = await this.forceReadDocState(op, _id)

    if (docNotifyContext != null) {
      const inboxNotifications = await client.findAll(
        notification.class.InboxNotification,
        { docNotifyContext: docNotifyContext._id, isViewed: false },
        { projection: { _id: 1, _class: 1, space: 1 } }
      )

      for (const notification of inboxNotifications) {
        await op.updateDoc(notification._class, notification.space, notification._id, { isViewed: true })
      }

      if (!read) {
        const ts = Math.max(docNotifyContext.lastUpdate ?? 0, docNotifyContext.lastView ?? 0)
        if (ts > 0) {
          await op.update(docNotifyContext, { lastView: ts })
        }
      }
    }

    await op.commit()
  }

  async forceReadDoc (doc: Doc): Promise<void> {
    const context = this._contextByDoc.get(doc._id)

    if (context !== undefined) {
      await this.readDoc(doc._id)
      return
    }

    const client = getClient()

    const current = await client.findOne(core.class.Collaborator, {
      attachedTo: doc._id,
      collaborator: getCurrentAccount().uuid
    })

    if (current === undefined) {
      await client.addCollection(core.class.Collaborator, doc.space, doc._id, doc._class, 'collaborators', {
        collaborator: getCurrentAccount().uuid
      })
    }

    await this.forceReadDocState(client, doc._id)
  }

  async readNotifications (client: TxOperations, ids: Array<Ref<InboxNotification>>): Promise<void> {
    const notificationsToRead = (get(this.inboxNotifications) ?? []).filter(
      ({ _id, isViewed }) => ids.includes(_id) && !isViewed
    )

    for (const notification of notificationsToRead) {
      await client.update(notification, { isViewed: true })
    }
  }

  private async forceReadDocState (client: TxOperations, attachedTo: Ref<Doc>): Promise<boolean> {
    const me = getCurrentAccount()
    const state = await this.getReadState(attachedTo)
    if (state != null) {
      await client.update(state, {
        [me.uuid]: {
          messageId: generateId<ActivityMessage>(),
          timestamp: Date.now()
        }
      })
      return true
    }
    return false
  }

  async removeAllNotifications (): Promise<void> {
    const ops = getClient().apply(undefined, 'removeAllNotifications', true)

    try {
      const inboxNotifications = await ops.findAll(
        notification.class.InboxNotification,
        {
          user: getCurrentAccount().uuid,
          archived: false
        },
        { projection: { _id: 1, _class: 1, space: 1 } }
      )
      const contexts = get(this.contexts) ?? []
      for (const notification of inboxNotifications) {
        await ops.removeDoc(notification._class, notification.space, notification._id)
      }

      for (const context of contexts) {
        const lastUpdate = context.lastUpdate ?? 0
        const lastView = context.lastView ?? 0
        if (lastUpdate > lastView) {
          const read = await this.forceReadDocState(ops, context.objectId)
          if (!read) {
            const ts = Math.max(context.lastUpdate ?? 0, context.lastView ?? 0)
            if (ts > 0) {
              await ops.update(context, { lastView: ts })
            }
          }
        }
      }
    } finally {
      await ops.commit()
    }
  }

  async readAllNotifications (): Promise<void> {
    const ops = getClient().apply(undefined, 'readAllNotifications', true)

    try {
      const inboxNotifications = await ops.findAll(
        notification.class.InboxNotification,
        {
          user: getCurrentAccount().uuid,
          isViewed: false,
          archived: false
        },
        { projection: { _id: 1, _class: 1, space: 1 } }
      )
      const contexts = get(this.contexts) ?? []
      for (const notification of inboxNotifications) {
        await ops.updateDoc(notification._class, notification.space, notification._id, { isViewed: true })
      }
      for (const context of contexts) {
        const lastUpdate = context.lastUpdate ?? 0
        const lastView = context.lastView ?? 0
        if (lastUpdate > lastView) {
          const read = await this.forceReadDocState(ops, context.objectId)
          if (!read) {
            const ts = Math.max(context.lastUpdate ?? 0, context.lastView ?? 0)
            if (ts > 0) {
              await ops.update(context, { lastView: ts })
            }
          }
        }
      }
    } finally {
      await ops.commit()
    }
  }
}

addTxListener((txes: Tx[]) => {
  for (const tx of txes) {
    if (tx._class === core.class.TxCreateDoc) {
      const createTx = tx as TxCreateDoc<Doc>
      if (createTx.objectClass !== notification.class.ReadState) continue
      const notificationClient = InboxNotificationsClientImpl.getClient()
      const state = TxProcessor.createDoc2Doc(createTx as TxCreateDoc<ReadState>)
      const current = get(notificationClient.readStateByDoc).has(state.attachedTo)
      if (current == null) {
        notificationClient.readStateByDoc.update((readStateByDoc) => {
          return readStateByDoc.set(state.attachedTo, state)
        })
      }
    }

    if (tx._class === core.class.TxUpdateDoc) {
      const updateTx = tx as TxUpdateDoc<Doc>
      if (updateTx.attachedTo == null) continue
      if (updateTx.objectClass !== notification.class.ReadState) continue
      const notificationClient = InboxNotificationsClientImpl.getClient()
      const attachedTo = updateTx.attachedTo
      notificationClient.readStateByDoc.update((readStateByDoc) => {
        const current = readStateByDoc.get(attachedTo)
        if (current == null) {
          return readStateByDoc
        }

        return readStateByDoc.set(attachedTo, TxProcessor.updateDoc2Doc(current, updateTx as TxUpdateDoc<ReadState>))
      })
    }
  }
})
