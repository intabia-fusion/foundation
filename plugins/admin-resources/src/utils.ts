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

import { Analytics } from '@hcengineering/analytics'
import {
  getClient as getAccountClientRaw,
  type AccountClient,
  type RegionInfo,
  type RegistrationStats,
  type WorkspaceActivityPoint,
  type WorkspacesPagedQuery,
  type WorkspacesPagedResult,
  type WorkspacesSummary,
  type PaymentOperation,
  type PaymentOperationFilter,
  type PaymentOperationStats,
  type PaymentMonthlyStats,
  type SubscriptionInfo
} from '@hcengineering/account-client'
import billing from '@hcengineering/billing'
import { getClient as getBillingClientRaw, type BillingClient } from '@hcengineering/billing-client'
import { type WorkspaceInfoWithStatus, type WorkspaceUserOperation } from '@hcengineering/core'
import login, { loginId } from '@hcengineering/login'
import { getMetadata, PlatformError } from '@hcengineering/platform'
import presentation from '@hcengineering/presentation'
import { navigate, showPopup } from '@hcengineering/ui'

import AdminOtpDialog from './components/AdminOtpDialog.svelte'

export type WorkspaceInfo = WorkspaceInfoWithStatus & {
  processingAttempts: number
  billingPlan?: string
  billingStatus?: string
  billingPeriodEnd?: number
}

/** Account client under the current session token (admin panel is rendered only when a token exists). */
export function getAccountClient (
  token: string | undefined | null = getMetadata(presentation.metadata.Token)
): AccountClient {
  const accountsUrl = getMetadata(login.metadata.AccountsUrl)
  const frontUrl = getMetadata(presentation.metadata.FrontUrl) ?? window.location.origin

  return getAccountClientRaw(accountsUrl, token !== null ? token : undefined, undefined, frontUrl)
}

// Billing URL may be unconfigured in the admin panel; callers must treat null as best-effort.
export function getBillingClient (): BillingClient | null {
  const billingUrl = getMetadata(billing.metadata.BillingURL) ?? ''
  const token = getMetadata(presentation.metadata.Token) ?? ''
  if (billingUrl === '' || token === '') {
    return null
  }
  const absoluteUrl = billingUrl.startsWith('/') ? window.location.origin + billingUrl : billingUrl
  return getBillingClientRaw(absoluteUrl, token)
}

// Run an account-client call, reporting failures and returning a fallback so the UI degrades gracefully.
async function safe<T> (fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch (err: any) {
    Analytics.handleError(err)
    return fallback
  }
}

/** Returns null on failure so the UI can show an error instead of a fake empty list */
export async function listWorkspacesPaged (query: WorkspacesPagedQuery): Promise<WorkspacesPagedResult | null> {
  if (getMetadata(presentation.metadata.Token) == null) {
    navigate({ path: [loginId] })
    return null
  }
  try {
    return await getAccountClient().listWorkspacesPaged(query)
  } catch (err: any) {
    Analytics.handleError(err)
    return null
  }
}

export async function getWorkspacesSummary (): Promise<WorkspacesSummary | null> {
  return await safe(async () => await getAccountClient().getWorkspacesSummary(), null)
}

export async function getRegistrationStats (from: number, to: number): Promise<RegistrationStats | null> {
  return await safe(async () => await getAccountClient().getRegistrationStats(from, to), null)
}

export async function getWorkspaceActivityStats (workspace: string, from: number): Promise<WorkspaceActivityPoint[]> {
  return await safe(async () => await getAccountClient().getWorkspaceActivityStats(workspace as any, from), [])
}

export async function getPaymentOperations (filter: PaymentOperationFilter): Promise<PaymentOperation[]> {
  return await safe(async () => await getAccountClient().getPaymentOperations(filter), [])
}

export async function getPaymentOperationStats (from: number, to: number): Promise<PaymentOperationStats | null> {
  return await safe(async () => await getAccountClient().getPaymentOperationStats(from, to), null)
}

export async function getPaymentMonthlyStats (from: number, to: number): Promise<PaymentMonthlyStats[]> {
  return await safe(async () => await getAccountClient().getPaymentMonthlyStats(from, to), [])
}

export async function getAllSubscriptions (): Promise<SubscriptionInfo[]> {
  return await safe(async () => await getAccountClient().getAllSubscriptions(), [])
}

export interface PlanOptions {
  keys: string[]
  labels: Record<string, string>
  sections: Record<string, string>
  config: any
}

/** Plan catalog from the payment service, for the admin create-subscription form */
export async function loadPlanOptions (lang: string): Promise<PlanOptions | null> {
  try {
    const paymentUrl = getMetadata(presentation.metadata.PaymentUrl) ?? ''
    const res = await fetch(paymentUrl + '/api/v1/plan-config')
    if (!res.ok) return null
    const config = await res.json()
    const keys = [...Object.keys(config.plans ?? {}), ...Object.keys(config.packages ?? {})]
    const labels: Record<string, string> = {}
    const sections: Record<string, string> = {}
    for (const [k, v] of Object.entries(config.plans ?? {})) {
      sections[k] = 'tier'
      const item = v as any
      labels[k] = typeof item.label === 'object' ? (item.label[lang] ?? item.label.en ?? k) : (item.label ?? k)
    }
    for (const [k, v] of Object.entries(config.packages ?? {})) {
      sections[k] = 'package'
      const item = v as any
      labels[k] =
        typeof item.description === 'object'
          ? (item.description[lang] ?? item.description.en ?? k)
          : (item.description ?? k)
    }
    return { keys, labels, sections, config }
  } catch (err: any) {
    Analytics.handleError(err)
    return null
  }
}

export async function getRegionInfo (): Promise<RegionInfo[] | null> {
  return await safe(async () => await getAccountClient().getRegionInfo(), null)
}

export async function performWorkspaceOperation (
  workspace: string | string[],
  operation: WorkspaceUserOperation,
  ...params: any[]
): Promise<boolean> {
  if (getMetadata(presentation.metadata.Token) == null) {
    navigate({ path: [loginId] })
    return true
  }
  try {
    return (await getAccountClient().performWorkspaceOperation(workspace, operation, ...params)) ?? false
  } catch (err: any) {
    Analytics.handleError(err)
    if (err instanceof PlatformError) {
      throw err
    }
    return false
  }
}

/** Same as performWorkspaceOperation but carries an OTP code (server requires it for destructive events) */
export async function performWorkspaceOperationWithOtp (
  workspace: string | string[],
  operation: WorkspaceUserOperation,
  otpCode: string,
  ...params: any[]
): Promise<boolean> {
  if (getMetadata(presentation.metadata.Token) == null) {
    navigate({ path: [loginId] })
    return true
  }
  try {
    return (
      (await getAccountClient().performWorkspaceOperationWithOtp(workspace, operation, otpCode, ...params)) ?? false
    )
  } catch (err: any) {
    Analytics.handleError(err)
    if (err instanceof PlatformError) {
      throw err
    }
    return false
  }
}

/** Show the admin OTP dialog and resolve with the entered code, or undefined if cancelled */
export async function requestAdminOtpCode (): Promise<string | undefined> {
  return await new Promise<string | undefined>((resolve) => {
    showPopup(AdminOtpDialog, {}, undefined, (code) => {
      resolve(typeof code === 'string' && code.length > 0 ? code : undefined)
    })
  })
}
