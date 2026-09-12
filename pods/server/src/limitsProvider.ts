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
import {
  type AccountClient,
  getClient as getAccountClient,
  grantsPlan,
  type Subscription,
  SubscriptionType
} from '@hcengineering/account-client'
import core, {
  type AccountUuid,
  buildSocialIdString,
  type Class,
  type Doc,
  type Ref,
  SocialIdType,
  systemAccountUuid,
  type WorkspaceMemberInfo,
  type WorkspaceUuid
} from '@hcengineering/core'
import { type LimitsProvider, type PlanLimits } from '@hcengineering/server-core'
import { generateToken } from '@hcengineering/server-token'
import chunter from '@hcengineering/chunter'
import pulse from '@hcengineering/pulse'
import preference from '@hcengineering/preference'
import { aiBotAccountEmail } from '@hcengineering/middleware'

const ZERO_LIMITS: PlanLimits = {
  usersLimit: 0,
  storageLimitGB: 0,
  tokenLimit: 0,
  transcriptLimit: 0
}

// System/AI account email social keys. aibot today; add more agent emails here to exclude them
// from seat counting without touching the middleware.
const SYSTEM_ACCOUNT_EMAILS = [aiBotAccountEmail]
const SYSTEM_ACCOUNT_SOCIAL_KEYS = SYSTEM_ACCOUNT_EMAILS.map((value) =>
  buildSocialIdString({ type: SocialIdType.EMAIL, value })
)

/** account-client backed LimitsProvider. Resolves plan limits / payment status / members from the account service. */
export class AccountLimitsProvider implements LimitsProvider {
  // System account uuids are stable across workspaces; resolved once.
  private systemAccounts: Set<AccountUuid> | undefined

  constructor (private readonly accountsUrl: string) {}

  private accountClient (workspace?: WorkspaceUuid): AccountClient {
    const token = generateToken(systemAccountUuid, workspace, { service: 'transactor' })
    return getAccountClient(this.accountsUrl, token)
  }

  private toPlanLimits (l: {
    storageLimitGB?: number
    usersLimit?: number
    tokenLimit?: number
    meetingMinutesLimit?: number
  }): PlanLimits {
    return {
      usersLimit: l.usersLimit ?? 0,
      storageLimitGB: l.storageLimitGB ?? 0,
      tokenLimit: l.tokenLimit ?? 0,
      transcriptLimit: l.meetingMinutesLimit ?? 0
    }
  }

  /** Free fallback limits baked into the tier subscription by payment (if a free plan exists). */
  private freeLimitsOf (tier: Subscription | undefined): PlanLimits | undefined {
    const free = tier?.freeLimits
    return free != null ? this.toPlanLimits(free) : undefined
  }

  /** Tier subscriptions newest-first (by createdOn) — index 0 is the current plan, ignoring superseded ones. */
  private tiersNewestFirst (subs: Subscription[]): Subscription[] {
    return subs.filter((s) => s.type === SubscriptionType.Tier).sort((a, b) => (b.createdOn ?? 0) - (a.createdOn ?? 0))
  }

  async getPlanLimits (workspace: WorkspaceUuid): Promise<PlanLimits> {
    try {
      // activeOnly=false: an unpaid (past_due/canceled) tier still carries the free fallback we need.
      const subs = await this.accountClient(workspace).getSubscriptions(workspace, false)
      const tiers = this.tiersNewestFirst(subs)
      // The current plan is the newest tier that still grants (Active/live-Trialing/in-grace), not just
      // the first Active row — two Active rows can briefly overlap and .find() would pick either one.
      const granting = tiers.find((s) => grantsPlan(s))
      if (granting?.limits !== undefined) return this.toPlanLimits(granting.limits)
      // No granting tier (unpaid/expired trial): fall back to the newest tier's free limits, else unlimited.
      return this.freeLimitsOf(tiers[0]) ?? ZERO_LIMITS
    } catch {
      return ZERO_LIMITS
    }
  }

  async getWorkspaceMembers (workspace: WorkspaceUuid): Promise<WorkspaceMemberInfo[]> {
    try {
      return await this.accountClient(workspace).getWorkspaceMembers()
    } catch {
      return []
    }
  }

  // Read-only members keep direct/chat messaging, the presence signals that make it usable
  // (online status, document presence, typing) and their own per-user preferences (tabs, notification
  // settings, etc. — all derive from Preference). Everything else is denied.
  private readonly readOnlyAllowedClasses = new Set<Ref<Class<Doc>>>([
    chunter.class.DirectMessage,
    chunter.class.ChatMessage,
    chunter.class.ThreadMessage,
    core.class.UserStatus,
    pulse.class.DocumentPresence,
    pulse.class.TypingIndicator,
    preference.class.Preference
  ])

  getReadOnlyAllowedClasses (): Set<Ref<Class<Doc>>> {
    return this.readOnlyAllowedClasses
  }

  async getSystemAccounts (_workspace: WorkspaceUuid): Promise<Set<AccountUuid>> {
    if (this.systemAccounts !== undefined) return this.systemAccounts
    const result = new Set<AccountUuid>()
    try {
      const client = this.accountClient()
      for (const key of SYSTEM_ACCOUNT_SOCIAL_KEYS) {
        const uuid = await client.findPersonBySocialKey(key, true)
        if (uuid != null) result.add(uuid as AccountUuid)
      }
      this.systemAccounts = result
    } catch {
      // leave uncached so a transient failure retries on the next build
      return result
    }
    return this.systemAccounts
  }

  // Not cached: keys are created/revoked at any time, unlike the fixed system account uuids above.
  // The caller (seat-limits middleware) already hits this only when rebuilding the seat set, which
  // is rare, so a plain per-call fetch is enough.
  async getIntegrationAccounts (workspace: WorkspaceUuid): Promise<Set<AccountUuid>> {
    try {
      const accounts = await this.accountClient(workspace).getApiKeyAccounts(workspace)
      return new Set(accounts)
    } catch {
      return new Set()
    }
  }
}
