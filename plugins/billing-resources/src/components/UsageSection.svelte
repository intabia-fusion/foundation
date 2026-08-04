<!--
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
-->
<script lang="ts">
  import { type PlanItem, type PackageItem } from '@hcengineering/billing'
  import { UsageStatus } from '@hcengineering/core'
  import { Label } from '@hcengineering/ui'
  import type { SubscriptionData } from '@hcengineering/account-client'
  import plugin from '../plugin'
  import UsageProgress from './UsageProgress.svelte'
  import { calculateLimits } from '../utils'

  export let usage: UsageStatus | null
  export let plan: PlanItem | undefined
  export let pkg: PackageItem | undefined = undefined
  export let tierSub: SubscriptionData | undefined = undefined
  export let pkgSub: SubscriptionData | undefined = undefined
  // compact = the status-bar popup: storage only (AI token windows are shown separately there).
  export let compact: boolean = false

  $: storageUsedBytes = usage?.usage?.storageBytes ?? 0
  $: meetingMinutes = usage?.usage?.meetingMinutes ?? 0
  $: tokensUsage = usage?.usage?.tokens ?? 0
  $: membersCount = usage?.usage?.membersCount ?? 0
  $: limits = calculateLimits(plan, pkg, tierSub, pkgSub)
</script>

{#if limits != null}
  <div class="flex-col flex-gap-2" data-id="billingUsageSection">
    <div class="fs-bold">
      <Label label={plugin.string.Usage} />
    </div>

    <UsageProgress label={plugin.string.StorageUsage} value={storageUsedBytes} limit={limits.storageLimit} />

    {#if !compact}
      <UsageProgress
        label={plugin.string.MeetingMinutesUsage}
        value={meetingMinutes}
        limit={limits.meetingMinutesLimit}
        kind={'minutes'}
      />

      <UsageProgress label={plugin.string.TotalTokens} value={tokensUsage} limit={limits.tokenLimit} kind={'items'} />

      <UsageProgress label={plugin.string.MembersUsage} value={membersCount} limit={limits.usersLimit} kind={'items'} />
    {/if}
  </div>
{/if}
