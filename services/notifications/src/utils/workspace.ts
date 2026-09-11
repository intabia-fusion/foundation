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

import { getAccountClient } from '@hcengineering/server-client'
import { type Class, concatLink, Doc, Ref, WorkspaceInfoWithStatus } from '@hcengineering/core'
import {
  ContextNotification,
  DocNotifyContext,
  getNotificationMessageId,
  notificationId
} from '@hcengineering/notification'
import { getMetadata } from '@hcengineering/platform'
import serverCore from '@hcengineering/server-core'

import { Client } from '../types'

// ---- Constants ----

const externalRegions = process.env.EXTERNAL_REGIONS?.split(';') ?? []
const RETRYABLE_ERROR_CODES = ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND']

// ---- Workspace info ----

/**
 * Connects to the accounts service and retrieves workspace info.
 * Retries indefinitely on transient connection errors.
 */
export async function getWorkspaceInfo (
  token: string
): Promise<(WorkspaceInfoWithStatus & { endpoint: string }) | undefined> {
  const accountClient = getAccountClient(token, 30000)

  while (true) {
    try {
      const workspaceInfo = await accountClient.selectWorkspace('', 'internal', externalRegions)
      if (workspaceInfo === undefined) {
        throw new Error('Workspace not found')
      }

      const infoWithStatus = await accountClient.getWorkspaceInfo(false)

      if (infoWithStatus.isDisabled === true) return undefined
      if (infoWithStatus.mode !== 'active') return undefined
      return { ...infoWithStatus, endpoint: workspaceInfo.endpoint }
    } catch (err: any) {
      if (RETRYABLE_ERROR_CODES.includes(err?.cause?.code)) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1000))
      } else {
        throw err
      }
    }
  }
}

export function getTransactorApiEndpoint (ws: { endpoint: string }): string {
  return ws.endpoint.replace('wss://', 'https://').replace('ws://', 'http://')
}

// ---- Notification URLs ----

export function getNotificationUrl (
  client: Client,
  contextId: Ref<DocNotifyContext>,
  notification: ContextNotification,
  objectId: Ref<Doc>,
  objectClass: Ref<Class<Doc>>
): string {
  const frontUrl = getFrontUrl(client)
  const { path, query } = getNotificationLocation(client, contextId, notification, objectId, objectClass)

  let url = concatLink(frontUrl, path.join('/'))
  if (query != null) {
    url += `?${new URLSearchParams(query).toString()}`
  }
  return url
}

export function getNotificationLocation (
  client: Client,
  contextId: Ref<DocNotifyContext>,
  notification: ContextNotification,
  objectId: Ref<Doc>,
  objectClass: Ref<Class<Doc>>
): { path: string[], query: Record<string, string> } {
  const objectEncoded = encodeURIComponent(`${objectId}|${objectClass}`)
  const messageId = getNotificationMessageId(notification)
  const path = ['workbench', client.workspace.url, notificationId, objectEncoded]
  const query: Record<string, string> =
    messageId != null ? { message: messageId, context: contextId } : { context: contextId }
  return { path, query }
}

export function getDomain (client: Client): string {
  return concatLink(getFrontUrl(client), `workbench/${client.workspace.url}`)
}

// ---- Internal ----

function getFrontUrl (client: Client): string {
  return client.branding?.front ?? getMetadata(serverCore.metadata.FrontUrl) ?? ''
}
