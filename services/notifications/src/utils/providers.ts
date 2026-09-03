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

import core, {
  type AnyAttribute,
  type ArrOf,
  type AttachedDoc,
  type Class,
  Doc,
  getTxOperations,
  type Hierarchy,
  matchQuery, MeasureContext,
  PersonId,
  Ref,
  type RefTo,
  TxCUD
} from '@hcengineering/core'
import activity, { ActivityMessage, DocUpdateMessage } from '@hcengineering/activity'
import notification, {
  DocNotificationMode,
  MessageNotificationType,
  NotificationProvider,
  NotificationType,
  TxNotificationType
} from '@hcengineering/notification'
import serverNotification, { Receiver } from '@hcengineering/server-notification'
import { getResource } from '@hcengineering/platform'

import { Client, NotificationSettings, NotifyProviders } from '../types'
import config from '../config'
import { getTypeMatchClient } from './misc'

export const MAX_NOTIFICATION_TYPE_PRIORITY = Number.MAX_SAFE_INTEGER

// ---- Public API: Provider resolution ----

/**
 * Returns providers allowed for a given notification type based on the receiver's settings.
 */
export function getAllowedProviders (
  client: Client,
  settings: NotificationSettings,
  socialIds: PersonId[],
  type: NotificationType
): Ref<NotificationProvider>[] {
  return getAllProviders(client)
    .filter((provider) => isTypeAllowed(client, socialIds, type, provider, settings))
    .map((provider) => provider._id)
}

/**
 * Resolves matching providers for an activity message notification.
 */
export async function getMessageNotifyProviders (
  client: Client,
  message: ActivityMessage,
  doc: Doc,
  receiver: Receiver,
  notificationSettings: NotificationSettings,
  mode: DocNotificationMode
): Promise<NotifyProviders> {
  const types = getMatchedMessageTypes(client, message, doc)

  return await resolveNotifyProviders(client, message, doc, receiver, notificationSettings, types, mode)
}

/**
 * Resolves matching providers for a transaction-based notification.
 */
export async function getTxNotifyProviders (
  client: Client,
  tx: TxCUD<Doc>,
  doc: Doc,
  receiver: Receiver,
  notificationSettings: NotificationSettings,
  types: TxNotificationType[],
  mode: DocNotificationMode
): Promise<NotifyProviders> {
  return await resolveNotifyProviders(client, tx, doc, receiver, notificationSettings, types, mode)
}

// ---- Public API: Type matching ----

/**
 * Checks if a transaction matches a TxNotificationType definition.
 */
export function isMatchedTxType (client: Client, tx: TxCUD<Doc>, type: TxNotificationType): boolean {
  const { hierarchy } = client

  if (!type.txClasses.includes(tx._class)) return false

  if (type.attachedToClass != null) {
    if (tx.attachedToClass == null) return false
    if (!isDerivedBase(client.ctx, hierarchy, tx.attachedToClass, type.attachedToClass)) return false
  }

  if (type.objectClass !== core.class.Doc) {
    if (!isDerivedBase(client.ctx, hierarchy, tx.objectClass, type.objectClass)) return false
  }

  if (type.field !== undefined) {
    if (!extractTxFields(tx).includes(type.field)) return false
  }

  if (type.attrTypes !== undefined) {
    const hasMatchingAttr = extractTxFields(tx).some((field) => {
      const attr = hierarchy.findAttribute(tx.objectClass, field)
      if (attr == null) return false
      return type.attrTypes?.includes(resolveAttrClass(hierarchy, attr)) ?? false
    })

    if (!hasMatchingAttr) return false
  }

  if (type.match !== undefined) {
    if (matchQuery([tx], type.match, tx._class, hierarchy, true).length === 0) return false
  }

  return true
}

/**
 * Checks whether a transaction should trigger notification processing
 * based on target classes or attribute type definitions.
 */
export function isTxTrigger (
  hierarchy: Hierarchy,
  tx: TxCUD<Doc>,
  triggerClasses: Ref<Class<Doc>>[],
  txTypes: TxNotificationType[]
): boolean {
  if (triggerClasses.some((it) => hierarchy.isDerived(tx.objectClass, it))) return true

  for (const type of txTypes) {
    if (type.objectClass !== core.class.Doc) continue
    if (type.attrTypes === undefined) continue
    if (!type.txClasses.includes(tx._class)) continue

    for (const field of extractTxFields(tx)) {
      const attr = hierarchy.findAttribute(tx.objectClass, field)
      if (attr === undefined) continue
      if (type.attrTypes.includes(resolveAttrClass(hierarchy, attr))) return true
    }
  }

  return false
}

// ---- Internal: Provider resolution core ----

function getAllProviders (client: Client): NotificationProvider[] {
  const providers = client.model.findAllSync(notification.class.NotificationProvider, {})

  if (config.AllowedNotificationProviders.includes('all')) {
    return providers
  }

  return providers.filter((it) => config.AllowedNotificationProviders.includes(it._id))
}

/**
 * Core logic: for each notification type that passes mode/author/mixin checks,
 * accumulates allowed providers into the result map.
 */
async function resolveNotifyProviders (
  client: Client,
  source: Doc,
  doc: Doc,
  receiver: Receiver,
  notificationSettings: NotificationSettings,
  types: NotificationType[],
  mode: DocNotificationMode
): Promise<NotifyProviders> {
  const authorSocialId = source.createdBy ?? source.modifiedBy
  const providers = getAllProviders(client)
  const { hierarchy } = client
  const result: NotifyProviders = {}

  for (const type of types) {
    if (mode === 'mute') continue
    if (type.notifyAuthor !== true && receiver.socialIds.includes(authorSocialId)) continue
    if (mode === 'mentions' && type.isMention !== true) continue

    if (hierarchy.hasMixin(type, serverNotification.mixin.TypeMatch)) {
      const mixin = hierarchy.as(type, serverNotification.mixin.TypeMatch)

      if (mixin.match !== undefined) {
        const matchFn = await getResource(mixin.match)
        let matched = matchFn(getTypeMatchClient(client), type, source, doc, receiver)
        if (matched instanceof Promise) {
          matched = await matched
        }

        if (!matched) continue
      }
    }

    for (const provider of providers) {
      if (isTypeAllowed(client, receiver.socialIds, type, provider, notificationSettings)) {
        const existing = result[provider._id] ?? []
        result[provider._id] = [...existing, type]
      }
    }
  }

  return result
}

/**
 * Determines if a notification type is allowed for a provider,
 * checking user settings → provider defaults → type defaults (in priority order).
 */
function isTypeAllowed (
  client: Client,
  socialIds: PersonId[],
  type: NotificationType,
  provider: NotificationProvider,
  settings: NotificationSettings
): boolean {
  // 1. Check per-provider user settings
  const providerSettings = (settings.settingsByProvider.get(provider._id) ?? []).filter(
    ({ createdBy }) => createdBy !== undefined && socialIds.includes(createdBy)
  )

  if (providerSettings.length > 0 && providerSettings.every((s) => !s.enabled)) return false
  if (providerSettings.length === 0 && !provider.defaultEnabled) return false

  // 2. Check provider-level defaults for type overrides
  const providerDefaults = client.model.findAllSync(notification.class.NotificationProviderDefaults, {})
  const isForProvider = (it: { provider: Ref<NotificationProvider> }): boolean => it.provider === provider._id

  if (providerDefaults.some((it) => isForProvider(it) && it.ignoredTypes.includes(type._id))) return false

  // 3. Check per-type user settings
  const typeSetting = (settings.typesByProvider.get(provider._id) ?? []).find(
    (it) => it.type === type._id && it.createdBy !== undefined && socialIds.includes(it.createdBy)
  )

  if (typeSetting !== undefined) return typeSetting.enabled

  // 4. Check provider-level enabled types
  if (providerDefaults.some((it) => isForProvider(it) && it.enabledTypes.includes(type._id))) return true

  // 5. Fall back to type's own default
  if (type === undefined) return false
  return type.defaultEnabled
}

// ---- Internal: Message type matching ----

function getMatchedMessageTypes (client: Client, message: ActivityMessage, doc: Doc): MessageNotificationType[] {
  return client.model
    .findAllSync<MessageNotificationType>(notification.class.MessageNotificationType, {})
    .filter((type) => isMessageTypeMatched(client, message, doc, type))
    .sort((a, b) => (a.priority ?? MAX_NOTIFICATION_TYPE_PRIORITY) - (b.priority ?? MAX_NOTIFICATION_TYPE_PRIORITY))
}

function safeGetBaseClass<T extends Doc> (
  hierarchy: Hierarchy,
  _class: Ref<Class<T>> | undefined
): Ref<Class<T>> | undefined {
  if (_class === undefined) {
    return undefined
  }
  if (!hierarchy.hasClass(_class)) {
    return undefined
  }
  try {
    return hierarchy.getBaseClass(_class)
  } catch (err: any) {
    return undefined
  }
}

function isMessageTypeMatched (
  client: Client,
  message: ActivityMessage,
  doc: Doc,
  type: MessageNotificationType
): boolean {
  const { hierarchy, ctx } = client
  const baseClass = safeGetBaseClass(hierarchy, type.objectClass)
  if (baseClass === undefined) {
    ctx.error('base class not found in hierarchy', { class: type.objectClass, type })
    return false
  }

  if (!hierarchy.isDerived(message._class, type.messageClass)) return false
  if (!isDerivedBase(ctx, hierarchy, message.attachedToClass, type.attachedToClass)) return false

  if (type.match !== undefined) {
    if (matchQuery([message], type.match, message._class, hierarchy, true).length === 0) return false
  }

  // Non-DocUpdateMessage: match by collection field only
  if (!hierarchy.isDerived(message._class, activity.class.DocUpdateMessage)) {
    return type.field === undefined || type.field === message.collection
  }

  // DocUpdateMessage: additional object class and field checks
  const docUpdateMessage = message as DocUpdateMessage
  const docUpdateObjectBase = safeGetBaseClass(hierarchy, docUpdateMessage.objectClass)

  if (docUpdateObjectBase === undefined) {
    ctx.error('base class not found in hierarchy', { class: docUpdateMessage.objectClass, docUpdateMessage })
    return false
  }

  if (!hierarchy.isDerived(docUpdateObjectBase, baseClass)) return false
  if (type.field !== undefined && !isFieldUpdated(type.field, docUpdateMessage, doc)) return false

  return true
}

function isFieldUpdated (field: string, message: DocUpdateMessage, doc: Doc): boolean {
  const { action, attributeUpdates, objectId } = message

  if (action === 'create' && objectId === doc._id) {
    const value = (doc as any)[field]
    return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== ''
  }

  if (action !== 'update' && objectId !== doc._id) {
    return message.updateCollection === field
  }

  return attributeUpdates?.attrKey === field
}

// ---- Internal: Hierarchy & tx helpers ----

/**
 * Checks isDerived between base classes of two class refs.
 */
function isDerivedBase (ctx: MeasureContext, hierarchy: Hierarchy, actual: Ref<Class<Doc>>, expected: Ref<Class<Doc>>): boolean {
  const actualBaseClass = safeGetBaseClass(hierarchy, actual)
  if (actualBaseClass === undefined) {
    ctx.error('base class not found in hierarchy', { _class: actual })
    return false
  }
  const expectedBaseClass = safeGetBaseClass(hierarchy, expected)
  if (expectedBaseClass === undefined) {
    ctx.error('base class not found in hierarchy', { _class: expected })
    return false
  }
  return hierarchy.isDerived(actualBaseClass, expectedBaseClass)
}

/**
 * Resolves the target class of an attribute (handles RefTo, ArrOf, and plain types).
 */
function resolveAttrClass (hierarchy: Hierarchy, attribute: AnyAttribute): Ref<Class<Doc>> {
  if (hierarchy.isDerived(attribute.type._class, core.class.RefTo)) {
    return (attribute.type as RefTo<Doc>).to
  }

  if (hierarchy.isDerived(attribute.type._class, core.class.ArrOf)) {
    const of = (attribute.type as ArrOf<AttachedDoc>).of
    return of._class === core.class.RefTo ? (of as RefTo<Doc>).to : of._class
  }

  return attribute.type._class
}

/**
 * Extracts field names affected by a transaction's operations,
 * including fields nested under $push and $pull operators.
 */
function extractTxFields (tx: TxCUD<Doc>): string[] {
  const ops = getTxOperations(tx)
  const fields: string[] = []

  for (const key of Object.keys(ops)) {
    if (key === '$push' || key === '$pull') {
      fields.push(...Object.keys(ops[key] ?? {}))
    } else {
      fields.push(key)
    }
  }

  return fields
}
