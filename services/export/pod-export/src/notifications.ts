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
// See the License for the specific language governing permissions and
// limitations under the License.
//

import { getClient } from '@hcengineering/account-client'
import core, {
  AccountRole,
  type AccountUuid,
  type Class,
  type Doc,
  generateId,
  MeasureContext,
  type Ref,
  systemAccountUuid,
  type TxOperations,
  WorkspaceIds,
  WorkspaceUuid
} from '@hcengineering/core'
import exportPlugin from '@hcengineering/export'
import { generateToken } from '@hcengineering/server-token'
import notification from '@hcengineering/notification'
import contact from '@hcengineering/contact'

import envConfig from './config'

export async function sendExportCompletionNotification (
  ctx: MeasureContext,
  account: AccountUuid,
  targetTxOps: TxOperations,
  targetWorkspace: WorkspaceUuid,
  targetWsIds: WorkspaceIds,
  exportedDocuments: Array<{ docId: Ref<Doc>, name: string }>,
  sourceWsIds: WorkspaceIds,
  objectClass: Ref<Class<Doc>>
): Promise<void> {
  try {
    const count = exportedDocuments.length
    const resultId = generateId<Doc>()

    await targetTxOps.createDoc(
      exportPlugin.class.ExportResultRecord,
      core.space.Space,
      {
        sourceWorkspace: sourceWsIds.url,
        targetWorkspace: targetWsIds.url,
        exportedCount: count,
        exportedDocumentIds: exportedDocuments.map((d) => d.docId),
        objectClass
      },
      resultId
    )
    const type = await targetTxOps.findOne(notification.class.TxNotificationType, {
      _id: exportPlugin.ids.ImportedDocumentsNotification
    })
    if (type == null) return

    const targetWsToken = generateToken(systemAccountUuid, targetWorkspace, { service: 'export' })
    const targetAccountClient = getClient(envConfig.AccountsUrl, targetWsToken)
    const members = await targetAccountClient.getWorkspaceMembers()
    const owners = members.filter((m: { role: string }) => m.role === AccountRole.Owner) as Array<{
      person: AccountUuid
    }>

    if (owners.length === 0) {
      ctx.warn('No workspace owners found for export notification', { targetWorkspace })
      return
    }
    const senderSocialIds = ((await targetAccountClient.getPersonInfo(account))?.socialIds ?? []).map((it) => it._id)
    const spaces = await targetTxOps.findAll(contact.class.PersonSpace, {
      account: { $in: owners.map((it) => it.person) }
    })

    for (const owner of owners) {
      try {
        const space = spaces.find((it) => it.account === owner.person)
        if (space == null) continue

        const socialIds = ((await targetAccountClient.getPersonInfo(owner.person))?.socialIds ?? []).map((it) => it._id)
        if (socialIds.length === 0) continue

        await targetTxOps.createDoc(
          notification.class.CreateNotificationAction,
          space._id,
          {
            attachedTo: resultId,
            attachedToClass: exportPlugin.class.ExportResultRecord,
            account: owner.person,
            type: type._id,
            notification: {
              icon: exportPlugin.icon.Export,
              messageIntl: exportPlugin.string.ImportToWorkspaceNotificationMessage,
              header: {
                titleIntl: exportPlugin.string.ImportCompleted
              }
            },
            intl: {
              intlParams: { count, sourceWorkspace: sourceWsIds.uuid }
            }
          },
          undefined,
          undefined,
          senderSocialIds[0]
        )
      } catch (err) {
        ctx.error('Failed to create export notification for owner', { owner: owner.person, err })
      }
    }
  } catch (err) {
    ctx.error('Failed to send export completion notification', { err })
  }
}
