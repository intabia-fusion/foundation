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
  // Per-paid-user rolling-window token limit (0 = unlimited): limit = perUser * paidSeats.
  WindowMonthLimit: number
  // Upstream cost per 1000 tokens by key, for the admin cost calculator. Keyed by
  // provider_id or model (whatever ai-bot records). Env: PROVIDER_PRICES=key:rub,...
  ProviderPrices: Record<string, number>
  // Endpoints that rewrite a workspace's usage rows (reset/set-used). Destructive, dev/test only.
  AllowTestEndpoints: boolean
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
    ProviderPrices: Object.fromEntries(
      (process.env.PROVIDER_PRICES ?? '')
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p !== '')
        .map((p) => {
          // The price is the last segment, so a key may itself contain ':' (e.g. openai:gpt-4o:12.5).
          const idx = p.lastIndexOf(':')
          const k = idx === -1 ? p : p.slice(0, idx)
          const v = idx === -1 ? '' : p.slice(idx + 1).trim()
          return [k.trim(), v === '' ? NaN : Number(v)]
        })
        .filter(([k, v]) => k !== '' && !isNaN(v as number))
    ),
    AllowTestEndpoints: (process.env.ALLOW_TEST_ENDPOINTS ?? 'false').toLowerCase() === 'true'
  }

  const missingEnv = (Object.keys(params) as Array<keyof Config>).filter((key) => params[key] === undefined)

  if (missingEnv.length > 0) {
    throw Error(`Missing config for attributes: ${missingEnv.join(', ')}`)
  }

  return params as Config
})()

export default config
