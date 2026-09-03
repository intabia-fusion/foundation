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
  import type { SubscriptionData } from '@hcengineering/account-client'
  import type { WorkspaceTokenWindows } from '@hcengineering/billing-client'
  import UsageSection from './UsageSection.svelte'
  import TokenWindows from './TokenWindows.svelte'

  export let usage: UsageStatus
  export let plan: PlanItem | undefined
  export let pkg: PackageItem | undefined = undefined
  export let tierSub: SubscriptionData | undefined = undefined
  export let pkgSub: SubscriptionData | undefined = undefined
  export let windows: WorkspaceTokenWindows | undefined = undefined
</script>

<div class="p-2">
  <UsageSection {usage} {plan} {pkg} {tierSub} {pkgSub} compact />
  <TokenWindows {windows} />
</div>
