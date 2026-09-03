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

import { type MeasureContext, systemAccountUuid } from '@hcengineering/core'
import platform, { PlatformError, Severity, Status } from '@hcengineering/platform'
import {
  ADMIN_SESSION_TTL_SEC,
  decodeTokenVerbose,
  hasAdminSession,
  isHumanAdmin,
  type Token
} from '@hcengineering/server-token'

import { type AccountDB } from './types'
import { getAdminEmailSocialId, logAdminAction, verifyAdminOtp } from './utils'

const OTP_FAIL_WINDOW_SEC = 300
const OTP_FAIL_LIMIT = 5

function forbidden (): PlatformError {
  return new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
}

/**
 * An admin (or read-only billing admin) signed in as a person. Machine tokens are excluded even when
 * they carry `admin: 'true'`, the same rule `isHumanAdmin` applies to mutations.
 */
export function isHumanAdminLogin ({ account, extra }: Token): boolean {
  const isAdminEmail = extra?.admin === 'true' || extra?.billingAdmin === 'true'
  return isAdminEmail && account !== systemAccountUuid && extra?.service === undefined
}

/**
 * Every `/admin` entry point, read or write. Requires an admin (or read-only billing admin) token
 * whose second factor is still fresh: `verifyAdminSession` stamps `extra.mfaAt`, and a plain login
 * token - or one older than ADMIN_SESSION_TTL_SEC - is refused.
 */
export function requireAdminSession (ctx: MeasureContext, token: string): Token {
  const decoded = decodeTokenVerbose(ctx, token)
  if (!isHumanAdminLogin(decoded)) {
    throw forbidden()
  }
  if (!hasAdminSession(decoded, ADMIN_SESSION_TTL_SEC)) {
    throw forbidden()
  }
  return decoded
}

/**
 * Consumes an admin OTP with a per-code attempt limit. Hitting the limit drops the outstanding
 * code, so a burst of guesses cannot be resumed - the admin has to request a new one, and issuing
 * one is itself throttled by OTP_RETRY_DELAY.
 */
export async function verifyAdminOtpLimited (
  ctx: MeasureContext,
  db: AccountDB,
  token: string,
  otpCode: string
): Promise<void> {
  const { account } = decodeTokenVerbose(ctx, token)
  const since = Date.now() - OTP_FAIL_WINDOW_SEC * 1000
  const recent = await db.adminAction.find({ actor: account, createdOn: { $gt: since } })
  // A freshly issued code starts its own budget: guesses against the previous one do not carry over.
  const issuedOn = recent.reduce((ts, a) => (a.action === 'otp_issued' ? Math.max(ts, a.createdOn) : ts), 0)
  const failures = recent.filter((a) => a.action === 'otp_failed' && a.createdOn > issuedOn)

  if (failures.length >= OTP_FAIL_LIMIT) {
    // Drop the outstanding code as well: guessing must not be resumable within the same window.
    const sid = await getAdminEmailSocialId(ctx, db, token).catch(() => undefined)
    if (sid !== undefined) {
      await db.otp.deleteMany({ socialId: sid._id })
    }
    throw forbidden()
  }

  try {
    await verifyAdminOtp(ctx, db, token, otpCode)
  } catch (err: any) {
    await logAdminAction(ctx, db, token, 'otp_failed', undefined, undefined, {
      attempts: failures.length + 1
    })
    throw err
  }
}

/**
 * The single gate in front of every admin mutation: human admin, fresh session, rate-limited OTP.
 * Callers keep their own `logAdminAction` success entry - this only records refusals.
 */
export async function requireAdminOp (
  ctx: MeasureContext,
  db: AccountDB,
  token: string,
  action: string,
  otpCode: string,
  target?: string
): Promise<Token> {
  const decoded = decodeTokenVerbose(ctx, token)
  if (!isHumanAdmin(decoded)) {
    await logAdminAction(ctx, db, token, 'forbidden', target, undefined, { attempted: action })
    throw forbidden()
  }
  requireAdminSession(ctx, token)
  await verifyAdminOtpLimited(ctx, db, token, otpCode)
  return decoded
}
