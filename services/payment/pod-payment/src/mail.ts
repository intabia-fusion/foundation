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

import { type AccountUuid, type WorkspaceUuid, SocialIdType } from '@hcengineering/core'
import { type AccountClient } from '@hcengineering/account-client'
import {
  type BillingMailContext,
  type BillingMailStorage,
  type Lang,
  type MailSender,
  DEFAULT_CURRENCY
} from '@hcengineering/billing-mail'

import type { Config } from './config'

/**
 * The three lookups the shared mail package needs, over this pod's account client.
 * Mirrors SubscriptionStorage in pod-tbank-subscriptions — same calls, different host.
 */
export function createMailStorage (accountClient: AccountClient): BillingMailStorage {
  return {
    async getAccountContact (accountUuid: AccountUuid) {
      const personInfo = await accountClient.getPersonInfo(accountUuid)
      const emailSocialId = personInfo.socialIds.find((s) => s.type === SocialIdType.EMAIL && s.isDeleted !== true)

      let locale: string | null = null
      try {
        const accountInfo = await accountClient.getAccountInfo(accountUuid)
        locale = accountInfo.locale ?? null
      } catch {
        // Locale is optional — the caller falls back to the default language.
      }

      const name = personInfo.name !== undefined && personInfo.name !== '' ? personInfo.name : null
      return { name, email: emailSocialId?.value ?? null, locale }
    },

    async getWorkspaceInfo (workspaceUuid: WorkspaceUuid) {
      try {
        const [info] = await accountClient.getWorkspacesInfo([workspaceUuid])
        if (info === undefined) return null
        return { name: info.name, url: info.url }
      } catch {
        return null
      }
    },

    async getWorkspaceUrl (workspaceUuid: WorkspaceUuid) {
      try {
        const [info] = await accountClient.getWorkspacesInfo([workspaceUuid])
        return info?.url ?? null
      } catch {
        return null
      }
    }
  }
}

/**
 * Plan label straight out of the in-memory plan-config this pod already owns.
 * Never throws: an unknown plan falls back to its raw id so a mail is never blocked.
 */
export function createPlanLabelResolver (planConfig: any) {
  return async (plan: string, type: string, lang: Lang): Promise<string> => {
    try {
      const name =
        type === 'package'
          ? planConfig?.packages?.[plan]?.description
          : type === 'purchase'
            ? planConfig?.purchasables?.[plan]?.description
            : planConfig?.plans?.[plan]?.label
      return name?.[lang] ?? name?.ru ?? plan
    } catch {
      return plan
    }
  }
}

/** Display currency of the plan/package, mirroring `currencyOf` in @hcengineering/billing. */
export function createPlanCurrencyResolver (planConfig: any) {
  return async (plan: string, type: string): Promise<string> => {
    try {
      const item =
        type === 'package'
          ? planConfig?.packages?.[plan]
          : type === 'purchase'
            ? planConfig?.purchasables?.[plan]
            : planConfig?.plans?.[plan]
      const currency = item?.currency
      return currency != null && currency !== '' ? currency : DEFAULT_CURRENCY
    } catch {
      return DEFAULT_CURRENCY
    }
  }
}

/** Assemble the mail context this pod passes to the shared notify* functions. */
export function createMailContext (
  accountClient: AccountClient,
  config: Config,
  planConfig: any,
  send: MailSender
): BillingMailContext {
  return {
    storage: createMailStorage(accountClient),
    send,
    planLabel: createPlanLabelResolver(planConfig),
    planCurrency: createPlanCurrencyResolver(planConfig),
    frontUrl: config.FrontUrl,
    supportEmail: config.SupportEmail,
    supportUrl: config.SupportUrl
  }
}
