/**
  Copyright © 2026 Intabia Fusion.

  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License. You may
  obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

  See the License for the specific language governing permissions and
  limitations under the License.
*/

import { type ServerConfig } from '@hcengineering/api-client'
import { getClient as getAccountClient, type AccountClient } from '@hcengineering/account-client'

export const STAND_URL = 'http://localhost:8083'
export const TRANSACTOR_URL = `${STAND_URL}/_tr`
export const STATS_URL = `${STAND_URL}/_stats`
export const DEV_OTP = '000000'
export const WRONG_OTP = '999999'

/** Raw RPC result: account returns HTTP 200 with `{ error: Status }` for handled failures. */
export interface RpcResult<T = any> {
  status: number
  result?: T
  error?: { code?: string, params?: Record<string, any> }
}

/**
 * Account RPC without the typed client: admin-gates asserts on methods that do not exist yet,
 * so a compile-time surface would fail the whole file instead of the individual test.
 */
export async function rpc<T = any> (
  config: ServerConfig,
  token: string | undefined,
  method: string,
  params: Record<string, any> = {}
): Promise<RpcResult<T>> {
  const res = await fetch(config.ACCOUNTS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ method, params })
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, result: body.result, error: body.error }
}

export function statusCode (r: RpcResult): string | undefined {
  return r.error?.code
}

export function isForbidden (r: RpcResult): boolean {
  return statusCode(r) === 'platform:status:Forbidden'
}

export function isInvalidOtp (r: RpcResult): boolean {
  return statusCode(r) === 'platform:status:InvalidOtp'
}

/** Any refusal: Forbidden, InvalidOtp, BadRequest or an unimplemented method. */
export function isRefused (r: RpcResult): boolean {
  return r.error != null
}

export function payloadOf (token: string): Record<string, any> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf-8'))
}

/**
 * Account client acting as the stand's human admin with an open `/admin` session.
 * Machine tokens cannot pass admin mutations any more, so tests must log in as a person.
 */
export async function adminSessionClient (config: ServerConfig): Promise<AccountClient> {
  const login = await rpc(config, undefined, 'login', { email: 'admin', password: '1234' })
  if (login.error != null) throw new Error(`admin login failed: ${JSON.stringify(login.error)}`)
  const session = await rpc(config, login.result.token, 'verifyAdminSession', { otpCode: DEV_OTP })
  if (session.error != null) throw new Error(`admin session failed: ${JSON.stringify(session.error)}`)
  return getAccountClient(config.ACCOUNTS_URL, session.result.token)
}
