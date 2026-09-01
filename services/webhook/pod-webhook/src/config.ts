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
import { config as dotenvConfig } from 'dotenv'

dotenvConfig()

export interface Config {
  Port: number
  Secret: string
  AccountsUrl: string

  // Per key and per source IP. Deliberately well below the transactor's own limits (1500/30s a user,
  // 300/30s an API key) - this pod is the outer, less trusted door.
  RateLimitMax: number
  RateLimitWindowMs: number

  // A key presented in the URL (/k/:key) leaks whole into proxy/access logs and is meant for
  // narrow-scoped integrations only - rate-limited tighter than the same key in an Authorization header.
  RateLimitPathMax: number

  // Outgoing delivery (TSK-025..028, 061). https-only unless this is set - meant for local dev only.
  AllowInsecureWebhookHttp: boolean
  /** Dev stands only: hosts exempt from the private-range block, e.g. the webhook mock in the compose
   * network. Cluster-internal names stay blocked regardless of what is listed here. */
  DevAllowedWebhookHosts: string[]
  /** Added to the built-in cluster-internal denylist, which no setting can lift. */
  BlockedWebhookHosts: string[]
  WebhookDeliveryTimeoutMs: number
  WebhookMaxResponseBytes: number
  // Consecutive delivery failures (each already a full retry-exhausted or permanent failure, not a
  // single HTTP attempt) before an endpoint auto-disables and its owner is notified.
  WebhookDisableAfterFailures: number
  /** Cap on one `/api/v1/ops` call. Without it a stalled transactor holds a consumer handler forever. */
  TransactorTimeoutMs: number
}

const parseNumber = (str: string | undefined, defaultVal: number): number =>
  str !== undefined ? Number(str) : defaultVal

const parseBool = (str: string | undefined, defaultVal: boolean): boolean =>
  str !== undefined ? str === 'true' : defaultVal

const parseHosts = (str: string | undefined): string[] =>
  (str ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== '')

const config: Config = (() => {
  const params: Config = {
    Port: parseNumber(process.env.PORT, 4043),
    Secret: process.env.SECRET as string,
    AccountsUrl: process.env.ACCOUNTS_URL as string,
    RateLimitMax: parseNumber(process.env.RATE_LIMIT_MAX, 60),
    RateLimitWindowMs: parseNumber(process.env.RATE_LIMIT_WINDOW_MS, 60000),
    RateLimitPathMax: parseNumber(process.env.RATE_LIMIT_PATH_MAX, 20),
    AllowInsecureWebhookHttp: parseBool(process.env.ALLOW_INSECURE_WEBHOOK_HTTP, false),
    DevAllowedWebhookHosts: parseHosts(process.env.DEV_ALLOWED_WEBHOOK_HOSTS),
    BlockedWebhookHosts: parseHosts(process.env.BLOCKED_WEBHOOK_HOSTS),
    WebhookDeliveryTimeoutMs: parseNumber(process.env.WEBHOOK_DELIVERY_TIMEOUT_MS, 10000),
    WebhookMaxResponseBytes: parseNumber(process.env.WEBHOOK_MAX_RESPONSE_BYTES, 65536),
    WebhookDisableAfterFailures: parseNumber(process.env.WEBHOOK_DISABLE_AFTER_FAILURES, 3),
    TransactorTimeoutMs: parseNumber(process.env.TRANSACTOR_TIMEOUT_MS, 30000)
  }

  const requiredKeys: Array<keyof Config> = ['Secret', 'AccountsUrl']
  const missingEnv = requiredKeys.filter((key) => params[key] === undefined)
  if (missingEnv.length > 0) {
    throw Error(`Missing config for attributes: ${missingEnv.join(', ')}`)
  }

  return params
})()

export default config
