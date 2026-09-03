//
// Copyright © 2025 Hardcore Engineering Inc.
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
import { existsSync, readFileSync } from 'fs'
import * as yaml from 'js-yaml'

dotenvConfig()

export interface Config {
  Port: number
  Secret: string
  AccountsUrl: string
  FrontUrl: string
  Provider: string
  PlanConfig: string
  UseSandbox?: boolean

  // Polar.sh configuration
  PolarAccessToken?: string
  PolarWebhookSecret?: string
  PolarOrganizationId?: string
  PolarSubscriptionPlans?: string

  // Stripe configuration
  StripeApiKey?: string
  StripeWebhookSecret?: string
  StripeSubscriptionPlans?: string

  // TBank configuration
  TbankSubscriptionsUrl?: string

  ReconciliationIntervalMinutes?: number

  // Hour (UTC) of the nightly expired-trial sweep
  TrialExpiryHourUtc?: number

  // Dev override: sweep every N minutes instead of once a night
  TrialExpiryIntervalMinutes?: number

  // Explicit opt-in for the mock provider (activates plans without payment) — never set in production
  AllowMockProvider?: boolean

  // One-shot backfill of the baked AI window on old subscriptions; enable for a single deploy.
  RunWindowBackfill?: boolean

  // Per-IP cap on subscription mutations per 15-min window (raise on test stands that run many in a row)
  SubscriptionRateLimitMax?: number

  // Per-IP cap on plan-config reads per 15-min window (raise on test stands: every browser behind
  // the same NAT counts as one client)
  PlanConfigRateLimitMax?: number
}

// An unset var in docker-compose arrives as an empty string, and Number('') is 0 — treat it as absent.
const parseNumber = (str: string | undefined): number | undefined =>
  str !== undefined && str !== '' ? Number(str) : undefined

/**
 * `windowMonthLimit` 0 means "unlimited", and a missing key resolves to 0.
 * Require it explicitly.
 */
function validatePlanConfig (path: string): void {
  if (!existsSync(path)) {
    throw Error(`Plan config file not found: ${path}`)
  }
  const parsed = yaml.load(readFileSync(path, 'utf-8')) as any
  const noWindow = Object.entries<any>(parsed?.plans ?? {})
    .filter(([, plan]) => plan?.windowMonthLimit == null)
    .map(([name]) => name)
  if (noWindow.length > 0) {
    throw Error(
      `Plan config: windowMonthLimit missing for plans: ${noWindow.join(', ')}. Set 0 explicitly for unlimited.`
    )
  }
  // A trial without its own window inherits the plan's per-seat one times the trial seat cap.
  if (parsed?.trial != null && parsed.trial.windowMonthLimit == null) {
    throw Error('Plan config: trial.windowMonthLimit missing. Set 0 explicitly for unlimited.')
  }
}

const config: Config = (() => {
  const params: Partial<Config> = {
    Port: parseNumber(process.env.PORT) ?? 4040,
    Secret: process.env.SECRET,
    AccountsUrl: process.env.ACCOUNTS_URL,
    FrontUrl: process.env.FRONT_URL,
    Provider: process.env.PROVIDER,
    PlanConfig: process.env.PLAN_CONFIG,
    UseSandbox: process.env.USE_SANDBOX === 'true',
    PolarAccessToken: process.env.POLAR_ACCESS_TOKEN,
    PolarWebhookSecret: process.env.POLAR_WEBHOOK_SECRET,
    PolarOrganizationId: process.env.POLAR_ORGANIZATION_ID,
    PolarSubscriptionPlans: process.env.POLAR_SUBSCRIPTION_PLANS,
    StripeApiKey: process.env.STRIPE_API_KEY,
    StripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    StripeSubscriptionPlans: process.env.STRIPE_SUBSCRIPTION_PLANS,
    TbankSubscriptionsUrl: process.env.TBANK_SUBSCRIPTIONS_URL,
    ReconciliationIntervalMinutes: parseNumber(process.env.RECONCILIATION_INTERVAL_MINUTES),
    TrialExpiryHourUtc: parseNumber(process.env.TRIAL_EXPIRY_HOUR_UTC),
    TrialExpiryIntervalMinutes: parseNumber(process.env.TRIAL_EXPIRY_INTERVAL_MINUTES),
    AllowMockProvider: process.env.ALLOW_MOCK_PROVIDER === 'true',
    RunWindowBackfill: process.env.RUN_WINDOW_BACKFILL === 'true',
    SubscriptionRateLimitMax: parseNumber(process.env.SUBSCRIPTION_RATE_LIMIT_MAX),
    PlanConfigRateLimitMax: parseNumber(process.env.PLAN_CONFIG_RATE_LIMIT_MAX)
  }

  const requiredKeys: Array<keyof Config> = ['Port', 'Secret', 'AccountsUrl', 'FrontUrl', 'Provider', 'PlanConfig']
  const missingEnv = requiredKeys.filter((key) => params[key] === undefined)

  if (missingEnv.length > 0) {
    throw Error(`Missing config for attributes: ${missingEnv.join(', ')}`)
  }

  validatePlanConfig(params.PlanConfig as string)

  return params as Config
})()

export default config
