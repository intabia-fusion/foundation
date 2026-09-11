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

import { AccountUuid, Doc, Ref } from '@hcengineering/core'
import { NotificationIntl, NotificationType } from '@hcengineering/notification'
import { getSenderName, Sender } from '@hcengineering/server-notification'
import { IntlString } from '@hcengineering/platform'
import {
  getDocIcon as _getDocIcon,
  getDocIdentifier as _getDocIdentifier,
  getDocLabel as _getDocLabel,
  getDocTitle as _getDocTitle,
  getDocUrl as _getDocUrl,
  getIconPresenter,
  getTitlePresenter,
  Icon,
  PresenterControl
} from '@hcengineering/server-activity'
import activity, { ActivityMessage } from '@hcengineering/activity'

import { Client, ObjectDisplayData, TxCache } from '../types'
import Cache from '../cache'
import { toNotificationMessage } from './misc'

// ---- Cache helpers ----

/**
 * Fetches a value from a simple per-document cache, populating it on miss.
 */
async function withCache<T> (
  cache: Map<Ref<Doc>, T>,
  id: Ref<Doc>,
  fetch: () => Promise<T | null | undefined>
): Promise<T | undefined> {
  const cached = cache.get(id)
  if (cached != null) return cached

  const value = await fetch()
  if (value != null) cache.set(id, value)

  return value ?? undefined
}

/**
 * Fetches a value from a per-document cache keyed by account (or '' for non-personalized).
 */
async function withPersonalizedCache<T> (
  cache: Map<Ref<Doc>, Partial<Record<string, T>>>,
  id: Ref<Doc>,
  key: string,
  fetch: () => Promise<T | null | undefined>
): Promise<T | undefined> {
  const cached = cache.get(id)?.[key]
  if (cached != null) return cached

  const value = await fetch()
  if (value != null) {
    cache.set(id, { ...cache.get(id), [key]: value })
  }

  return value ?? undefined
}

// ---- Presenter control ----

function getPresenterControl (client: Client): PresenterControl {
  return {
    ctx: client.ctx,
    workspace: client.workspace,
    hierarchy: client.hierarchy,
    modelDb: client.model,
    branding: client.branding ?? null,
    findAll: (_ctx, _class, query, ops) => client.findAll(_class, query, ops)
  }
}

// ---- Document property lookups ----

export async function getDocTitle (
  client: Client,
  txCache: TxCache,
  doc: Doc,
  account?: AccountUuid,
  lang?: string
): Promise<string | undefined> {
  const presenter = getTitlePresenter(doc._class, client.hierarchy)
  const personalized = account != null && presenter?.personalized === true
  const key = personalized ? account : ''

  return await withPersonalizedCache(txCache.titleByDoc, doc._id, key, () =>
    _getDocTitle(getPresenterControl(client), doc, { account, lang })
  )
}

export async function getDocIdentifier (client: Client, txCache: TxCache, doc: Doc): Promise<string | undefined> {
  return await withCache(txCache.identifierByDoc, doc._id, () => _getDocIdentifier(getPresenterControl(client), doc))
}

export async function getDocUrl (client: Client, txCache: TxCache, doc: Doc): Promise<string | undefined> {
  return await withCache(txCache.urlByDoc, doc._id, () => _getDocUrl(getPresenterControl(client), doc))
}

export async function getDocLabel (client: Client, txCache: TxCache, doc: Doc): Promise<IntlString | undefined> {
  return await withCache(txCache.labelByDoc, doc._id, () => _getDocLabel(getPresenterControl(client), doc))
}

export async function getDocIcon (
  client: Client,
  txCache: TxCache,
  doc: Doc,
  account: AccountUuid
): Promise<Icon | undefined> {
  const presenter = getIconPresenter(doc._class, client.hierarchy)
  const personalized = account != null && presenter?.personalized === true
  const key = personalized ? account : ''

  return await withPersonalizedCache(txCache.iconByDoc, doc._id, key, () =>
    _getDocIcon(getPresenterControl(client), doc, { account })
  )
}

// ---- Aggregate display data ----

export async function getObjectDisplayData (
  client: Client,
  cache: Cache,
  txCache: TxCache,
  doc: Doc,
  account: AccountUuid
): Promise<ObjectDisplayData> {
  const title = (await getDocTitle(client, txCache, doc, account)) ?? ''
  const label = await getDocLabel(client, txCache, doc)
  const identifier = await getDocIdentifier(client, txCache, doc)
  const icon = await getDocIcon(client, txCache, doc, account)

  const displayData: ObjectDisplayData = {
    objectTitle: title,
    objectIdentifier: identifier,
    objectIcon: icon,
    objectLabel: label
  }

  if (client.hierarchy.isDerived(doc._class, activity.class.ActivityMessage)) {
    const message = doc as ActivityMessage
    const parentId = message.attachedTo
    const parentClass = message.attachedToClass
    const parentDoc = await cache.getDoc(parentId, parentClass)
    if (parentDoc != null) {
      displayData.parentObjectId = parentId
      displayData.parentObjectClass = parentClass
      displayData.parentObjectTitle = (await getDocTitle(client, txCache, parentDoc, account)) ?? ''
      displayData.parentObjectLabel = await getDocLabel(client, txCache, parentDoc)
      displayData.parentObjectIdentifier = await getDocIdentifier(client, txCache, parentDoc)
      displayData.parentObjectIcon = await getDocIcon(client, txCache, parentDoc, account)
    }
    displayData.object = toNotificationMessage(message)
  }

  return displayData
}

export async function getBaseDisplayParams (
  client: Client,
  txCache: TxCache,
  type: NotificationType | undefined,
  doc: Doc,
  sender: Sender,
  receiverLang: string
): Promise<Pick<NotificationIntl, 'intlParams' | 'intlParamsNotLocalized'>> {
  const intlParams: Record<string, string | number> = {}
  const intlParamsNotLocalized: Record<string, IntlString> = {}

  const title = await getDocTitle(client, txCache, doc, undefined, receiverLang)
  const url = await getDocUrl(client, txCache, doc)
  const identifier = await getDocIdentifier(client, txCache, doc)

  if (title != null) {
    intlParams.title = title
    intlParams.doc = title
  }
  if (url != null && url.length > 0) {
    intlParams.url = url
  }
  if (identifier != null && identifier.length > 0) {
    intlParams.identifier = identifier
  }

  const senderName = getSenderName(sender, client.branding?.lastNameFirst)

  if (type?.notificationMessage != null) {
    intlParamsNotLocalized.message = type.notificationMessage
  }

  return {
    intlParams: { ...intlParams, senderName },
    intlParamsNotLocalized
  }
}
