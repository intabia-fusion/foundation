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

export interface Config {
  Port: number
  Secret: string
  AccountsUrl: string
  DbUrl: string
  StorageConfig: string
  UsageUpdateInterval: number // seconds
  // Recipients of provider-pool threshold alerts (80%/100%); empty disables email.
  AdminEmails: string[]
  QueueRegion: string
  // Per-PAID-USER rolling-window token limit (0 = unlimited). The effective window
  // limit scales with the number of paid seats: limit = perUser * paidSeats. Used to
  // render usage as a percentage; enforcement lives in aibot.
  WindowMonthLimit: number
  // AI token package multiplier (xN) — a purchasable package scales the effective AI
  // token limits (windows + overall). Default 1 = no effect. Placeholder until the
  // purchase flow lands: today it comes from env; later read the workspace's package
  // from its Subscription (Tier.tokenPackageMultiplier baked into Subscription.limits).
  TokenPackageMultiplier: number
  // Upstream cost per 1000 tokens by key, for the admin cost calculator. Keyed by
  // provider_id or model (whatever ai-bot records). Env: PROVIDER_PRICES=key:rub,...
  ProviderPrices: Record<string, number>
}

const parseNumber = (str: string | undefined): number | undefined => (str !== undefined ? Number(str) : undefined)

const config: Config = (() => {
  const params: Partial<Config> = {
    Port: parseNumber(process.env.PORT) ?? 4040,
    Secret: process.env.SECRET,
    AccountsUrl: process.env.ACCOUNTS_URL,
    DbUrl: process.env.DB_URL,
    StorageConfig: process.env.STORAGE_CONFIG,
    UsageUpdateInterval: parseNumber(process.env.USAGE_UPDATE_INTERVAL) ?? 60 * 60,
    AdminEmails: (process.env.PLATFORM_ADMIN_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim())
      .filter((e) => e !== ''),
    QueueRegion: process.env.QUEUE_REGION ?? '',
    WindowMonthLimit: parseNumber(process.env.WINDOW_MONTH_LIMIT) ?? 100000,
    TokenPackageMultiplier: parseNumber(process.env.TOKEN_PACKAGE_MULTIPLIER) ?? 1,
    ProviderPrices: Object.fromEntries(
      (process.env.PROVIDER_PRICES ?? '')
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p !== '')
        .map((p) => {
          const [k, v] = p.split(':')
          return [k.trim(), Number(v)]
        })
        .filter(([, v]) => !isNaN(v as number))
    )
  }

  // AdminEmails/QueueRegion are optional (default applied above) — exclude from the check.
  const required: Array<keyof Config> = [
    'Port',
    'Secret',
    'AccountsUrl',
    'DbUrl',
    'StorageConfig',
    'UsageUpdateInterval'
  ]
  const missingEnv = required.filter((key) => params[key] === undefined)

  if (missingEnv.length > 0) {
    throw Error(`Missing config for attributes: ${missingEnv.join(', ')}`)
  }

  return params as Config
})()

export default config
