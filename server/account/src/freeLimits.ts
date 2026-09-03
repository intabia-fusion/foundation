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

import { getMetadata } from '@hcengineering/platform'
import { accountPlugin } from './plugin'
import { type TierLimits } from './types'

// Free fallback defaults. FREE_PLAN_LIMITS env (JSON, partial) overrides any field.
// storagePerUserGB makes disk scale: storageLimitGB = usersLimit * storagePerUserGB.
const DEFAULT_FREE_PLAN = {
  usersLimit: 5,
  storagePerUserGB: 2,
  tokenLimit: 100000,
  trafficLimitGB: 0,
  meetingMinutesLimit: 0,
  windowMonthLimit: 100000
}

/** Resolve free fallback limits from a partial JSON override merged over the defaults. */
export function parseFreePlanLimits (raw: string | undefined): TierLimits {
  let item: Record<string, any> = DEFAULT_FREE_PLAN
  if (raw !== undefined && raw.trim().length > 0) {
    try {
      item = { ...DEFAULT_FREE_PLAN, ...JSON.parse(raw) }
    } catch (err) {
      console.error('Failed to parse FREE_PLAN_LIMITS, using defaults', err)
    }
  }
  const usersLimit = clampToLicense(item.usersLimit ?? 0)
  const storageLimitGB = item.storagePerUserGB != null ? usersLimit * item.storagePerUserGB : (item.storageLimitGB ?? 0)
  return {
    storageLimitGB,
    trafficLimitGB: item.trafficLimitGB ?? 0,
    meetingMinutesLimit: item.meetingMinutesLimit ?? 0,
    tokenLimit: item.tokenLimit ?? 0,
    usersLimit,
    windowMonthLimit: item.windowMonthLimit ?? 0
  }
}

// Clamp the free-path user cap to the license max. licenseMax=0 (dev / unlimited license) -> no clamp.
// free=0 (config wants unlimited) but licenseMax>0 (community/licensed) -> cap to licenseMax.
function clampToLicense (freeUsers: number): number {
  const licenseMax = getMetadata(accountPlugin.metadata.LicenseMaxUsers) ?? 0
  if (licenseMax <= 0) return freeUsers
  if (freeUsers <= 0) return licenseMax
  return Math.min(freeUsers, licenseMax)
}

const DEFAULT_FREE_LIMITS = parseFreePlanLimits(undefined)

/** Free fallback limits, ALWAYS present: the configured metadata or the built-in defaults. */
export function getFreePlanLimits (): TierLimits {
  return getMetadata(accountPlugin.metadata.FreePlanLimits) ?? DEFAULT_FREE_LIMITS
}
