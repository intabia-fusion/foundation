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
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

import { Tx, TxOperations, PersonId, SocialIdType, MeasureContext } from '@hcengineering/core'
import { Card } from '@hcengineering/card'
import mail from '@hcengineering/mail'
import { AccountClient } from '@hcengineering/account-client'

import { normalizeEmail } from './utils'
import { MailRecipients } from './types'

export function isNewChannelTx (tx: Tx): boolean {
  return false
}

export async function getChannel (client: TxOperations, email: string): Promise<Card | undefined> {
  const normalizedEmail = normalizeEmail(email)
  return await client.findOne<Card>(mail.tag.MailThread, { title: normalizedEmail })
}

export async function getRecipients (
  ctx: MeasureContext,
  accountClient: AccountClient,
  thread: Card,
  personId: PersonId
): Promise<MailRecipients | undefined> {
  const collaborators: PersonId[] = (thread as any).members ?? []
  if (collaborators.length === 0) {
    return undefined
  }
  const recipients = collaborators.length > 1 ? collaborators.filter((c) => c !== personId) : collaborators
  const mailSocialIds = (await accountClient.findFullSocialIds(recipients)).filter(
    (id) => id.type === SocialIdType.EMAIL
  )
  if (mailSocialIds.length === 0) {
    ctx.warn('No social IDs found for recipients', { recipients })
    return undefined
  }
  const to = mailSocialIds[0].value
  const copy = mailSocialIds.length > 1 ? mailSocialIds.slice(1).map((s) => s.value) : undefined
  return {
    to,
    copy
  }
}
