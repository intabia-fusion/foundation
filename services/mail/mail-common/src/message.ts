//
// Copyright © 2025 Hardcore Engineering Inc.
//
// Licensed under the Eclipse Public License, Version 2.0 (the 'License');
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an 'AS IS' BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//
import { Producer } from 'kafkajs'

import { WorkspaceLoginInfo } from '@hcengineering/account-client'
import { type MeasureContext, type TxOperations } from '@hcengineering/core'
import { type KeyValueClient } from '@hcengineering/kvs-client'

import { BaseConfig, SyncOptions, type Attachment } from './types'
import { EmailMessage, MailRecipient } from './types'

/**
 * Creates mail messages in the platform
 *
 * This function processes an email message and creates corresponding chat messages. It handles:
 * - Ensuring persons exist for email addresses
 * - Finding or creating channels for participants
 * - Creating threads for messages
 * - Uploading attachments to storage
 * - Sending message events to Kafka
 *
 * @param {BaseConfig} config - Configuration options including storage and Kafka settings
 * @param {MeasureContext} ctx - Context for logging and performance measurement
 * @param {TxOperations} txClient - Client for database transactions
 * @param {KeyValueClient} keyValueClient - Client for key-value storage operations
 * @param {Producer} producer - Kafka producer for sending message events
 * @param {string} token - Authentication token for API calls
 * @param {WorkspaceLoginInfo} wsInfo - Workspace information including ID and URLs
 * @param {EmailMessage} message - The email message to process
 * @param {Attachment[]} attachments - Array of attachments for the message
 * @param {MailRecipient[]} [recipients] - Optional list of specific persons who should receive the message.
 *                                         If not provided, all existing accounts from email addresses will be used.
 * @returns {Promise<void>} A promise that resolves when all messages have been created
 * @throws Will log errors but not throw exceptions for partial failures
 *
 * @public
 */
export async function createMessages (
  config: BaseConfig,
  ctx: MeasureContext,
  txClient: TxOperations,
  keyValueClient: KeyValueClient,
  producer: Producer,
  token: string,
  wsInfo: WorkspaceLoginInfo,
  message: EmailMessage,
  attachments: Attachment[],
  recipients?: MailRecipient[],
  options?: SyncOptions
): Promise<void> {
  // const { mailId, from, subject, replyTo } = message
  // const tos = [...(message.to ?? []), ...(message.copy ?? [])]
  // ctx.info('Sending message', { mailId, from, to: tos.join(',') })
  //
  // const personCache = PersonCacheFactory.getInstance(ctx, wsInfo)
  // const personSpacesCache = PersonSpacesCacheFactory.getInstance(ctx, txClient, wsInfo.workspace)
  // const channelCache = ChannelCacheFactory.getInstance(ctx, txClient, wsInfo.workspace)
  // const threadLookup = ThreadLookupService.getInstance(ctx, keyValueClient, token)
  //
  // const fromPerson = await personCache.ensurePerson(from)
  //
  // const toPersons: MailRecipient[] = []
  // for (const to of tos) {
  //   const toPerson = await personCache.ensurePerson(to)
  //   if (toPerson === undefined) {
  //     continue
  //   }
  //   toPersons.push({ email: to.email, ...toPerson })
  // }
  // if (toPersons.length === 0) {
  //   ctx.error('Unable to create message without a proper TO', { mailId, from })
  //   return
  // }
  //
  // const modifiedBy = fromPerson.socialId
  // const participants = [fromPerson.socialId, ...toPersons.map((p) => p.socialId)]
  // const content = getMdContent(ctx, message)
  //
  // const attachedBlobs: Attachment[] = []
  // if (config.StorageConfig !== undefined) {
  //   const storageConfig = storageConfigFromEnv(config.StorageConfig)
  //   const storageAdapter = buildStorageFromConfig(storageConfig)
  //   try {
  //     for (const a of attachments ?? []) {
  //       try {
  //         await storageAdapter.put(
  //           ctx,
  //           {
  //             uuid: wsInfo.workspace,
  //             url: wsInfo.workspaceUrl,
  //             dataId: wsInfo.workspaceDataId
  //           },
  //           a.id,
  //           a.data,
  //           a.contentType
  //         )
  //         attachedBlobs.push(a)
  //         ctx.info('Uploaded attachment', { mailId, blobId: a.id, name: a.name, contentType: a.contentType })
  //       } catch (error) {
  //         ctx.error('Failed to upload attachment', { name: a.name, error, mailId })
  //       }
  //     }
  //   } finally {
  //     await storageAdapter.close()
  //   }
  // }
  //
  // const allPersons = [{ ...fromPerson, email: from.email }, ...toPersons]
  // const messageRecipients = recipients != null && recipients.length > 0 ? recipients : allPersons
  //
  // for (const person of messageRecipients) {
  //   try {
  //     let spaces = options?.spaceId != null ? [options.spaceId] : undefined
  //     if (spaces === undefined) {
  //       spaces = (await personSpacesCache.getPersonSpaces(mailId, person.uuid, person.email)).map((s) => s._id)
  //     }
  //     if (spaces.length > 0) {
  //       await saveMessageToSpaces(
  //         config,
  //         ctx,
  //         txClient,
  //         producer,
  //         threadLookup,
  //         wsInfo,
  //         mailId,
  //         spaces,
  //         participants,
  //         modifiedBy,
  //         subject,
  //         content,
  //         attachedBlobs,
  //         person,
  //         message,
  //         channelCache,
  //         replyTo,
  //         options
  //       )
  //     }
  //   } catch (error) {
  //     ctx.error('Failed to save message spaces', { error, mailId, personUuid: person.uuid, email: person.email })
  //   }
  // }
}

