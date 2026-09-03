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

import { type AccountDB, getAccountDB } from '@hcengineering/account'
import { SocialIdType } from '@hcengineering/core'

/**
 * Direct access to the account database, the same way dev/tool's withAccountDatabase gets it.
 *
 * OTP codes are only ever emailed, and the stand has no mail consumer, so tests read them here
 * instead. Deliberately not an account API: an endpoint handing out live codes would be an account
 * takeover the moment it reached production.
 */
const ACCOUNT_DB_URL = process.env.ACCOUNT_DB_URL ?? 'postgres://postgres:postgres@localhost:5433/postgres'

let opened: [AccountDB, () => void] | undefined

async function getDb (): Promise<AccountDB> {
  if (opened === undefined) {
    opened = await getAccountDB(ACCOUNT_DB_URL, process.env.ACCOUNT_DB_NS)
  }
  return opened[0]
}

export async function closeAccountDb (): Promise<void> {
  if (opened !== undefined) {
    opened[1]()
    opened = undefined
  }
}

/**
 * Latest live OTP code for an email. Retries: the code row is written after the mail is queued, so a
 * fast test can look before it lands.
 */
export async function getOtpCode (email: string, timeoutMs = 10000): Promise<string> {
  const db = await getDb()
  const normalized = email.toLowerCase().trim()
  const deadline = Date.now() + timeoutMs

  while (true) {
    const socialId = await db.socialId.findOne({ type: SocialIdType.EMAIL, value: normalized })
    if (socialId != null) {
      const otp = (await db.otp.find({ socialId: socialId._id }, { createdOn: 'descending' }, 1))[0]
      if (otp != null && otp.expiresOn > Date.now()) {
        return otp.code
      }
    }

    if (Date.now() > deadline) {
      throw new Error(`No live OTP code for ${email}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

/** Drops every OTP for an email so the next request cannot reuse a still-valid code. */
export async function clearOtpCodes (email: string): Promise<void> {
  const db = await getDb()
  const socialId = await db.socialId.findOne({ type: SocialIdType.EMAIL, value: email.toLowerCase().trim() })

  if (socialId != null) {
    await db.otp.deleteMany({ socialId: socialId._id })
  }
}
