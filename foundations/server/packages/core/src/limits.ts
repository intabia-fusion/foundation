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
  type AccountUuid,
  type Class,
  type Doc,
  type Ref,
  type WorkspaceMemberInfo,
  type WorkspaceUuid
} from '@hcengineering/core'

/** Snapshot of plan limits. 0 = unlimited. */
export interface PlanLimits {
  usersLimit: number
  storageLimitGB: number
  tokenLimit: number
  transcriptLimit: number
}

/** Abstraction for fetching limits/payment status without depending on account-client. Concrete impl injected by the host (pods/server). */
export interface LimitsProvider {
  getPlanLimits: (workspace: WorkspaceUuid) => Promise<PlanLimits>
  /** Workspace members with roles — used by seat enforcement to count privileged seats. */
  getWorkspaceMembers: (workspace: WorkspaceUuid) => Promise<WorkspaceMemberInfo[]>
  /**
   * Account uuids that are system/AI identities for this workspace (aibot today; multiple AI
   * agents later). They never occupy a seat and never reduce the seat budget. Set so the call
   * site stays unchanged when more than one agent account exists.
   */
  getSystemAccounts: (workspace: WorkspaceUuid) => Promise<Set<AccountUuid>>
  /**
   * Account uuids holding an API-key integration in this workspace. Unlike getSystemAccounts this
   * ONLY exempts them from seat counting — every other enforcement (quotas, unpaid mode) still applies.
   */
  getIntegrationAccounts: (workspace: WorkspaceUuid) => Promise<Set<AccountUuid>>
  /**
   * Doc classes a read-only (seatless) member may still create/update —
   * direct messages and chat. The host names them so the middleware needs no chunter dependency.
   */
  getReadOnlyAllowedClasses?: () => Set<Ref<Class<Doc>>>
}
