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

import { parseEnvInt } from '@hcengineering/account'
import { type RateLimitInfo, SlidingWindowRateLimitter } from '@hcengineering/rpc'
import { type IncomingHttpHeaders } from 'http'

// loginWithApiKey needs no caller token, so it is the one method a stranger can hammer. Keyed per
// client, not per key: the key it presents is attacker-chosen and would grow the map without bound.
export const apiKeyLoginLimiter = new SlidingWindowRateLimitter(
  parseEnvInt(process.env.API_KEY_LOGIN_RATE_LIMIT, 30),
  parseEnvInt(process.env.API_KEY_LOGIN_RATE_WINDOW_MS, 60 * 1000)
)

/** First hop of x-forwarded-for, since the account koa app runs behind an ingress without `app.proxy`. */
export function clientKey (headers: IncomingHttpHeaders, ip: string): string {
  const fwd = headers['x-forwarded-for']
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim()
  return first !== undefined && first !== '' ? first : ip
}

/** Undefined = let the call through; a RateLimitInfo = answer 429 with it. */
export function apiKeyLoginRateLimit (
  method: string,
  headers: IncomingHttpHeaders,
  ip: string
): RateLimitInfo | undefined {
  if (method !== 'loginWithApiKey') return undefined
  const info = apiKeyLoginLimiter.checkRateLimit(clientKey(headers, ip))
  return info.remaining === 0 ? info : undefined
}
