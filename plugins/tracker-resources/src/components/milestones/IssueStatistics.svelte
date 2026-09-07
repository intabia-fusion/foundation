<!--
// Copyright © 2022-2023 Hardcore Engineering Inc.
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
  import { Issue } from '@hcengineering/tracker'
  import { floorFractionDigits, Label, tooltip } from '@hcengineering/ui'
  import { FixedColumn } from '@hcengineering/view-resources'
  import tracker from '../../plugin'
  import EstimationProgressCircle from '../issues/timereport/EstimationProgressCircle.svelte'
  import TimePresenter from '../issues/timereport/TimePresenter.svelte'
  export let docs: Issue[] | undefined = undefined
  export let itemsProj: Issue[] | undefined = undefined
  export let capacity: number | undefined = undefined
  export let category: string | undefined = undefined

  $: ids = new Set(docs?.map((it) => it._id) ?? [])

  $: noParents = docs?.filter((it) => !ids.has(it.attachedTo))

  const fallback: Issue[] = [{ reportedTime: 0, childInfo: [], estimation: 0 } as unknown as Issue]

  $: totalEstimation = floorFractionDigits(
    (docs ?? []).reduce((sum, it) => sum + (it.estimation ?? 0), 0),
    3
  )
  $: totalReported = floorFractionDigits(
    (docs ?? []).reduce((sum, it) => sum + (it.reportedTime ?? 0), 0),
    3
  )
</script>

{#if docs !== undefined}
  <FixedColumn key="estimation-editor">
    <!-- <Label label={tracker.string.MilestoneDay} value={}/> -->
    <div class="flex-row-center flex-no-shrink h-6" class:showWarning={totalEstimation > (capacity ?? 0)}>
      {#if docs.length === itemsProj?.length}
        {#if totalEstimation > 0}
          <EstimationProgressCircle items={[{ value: totalReported, max: totalEstimation }]} />
        {/if}
        <div class="w-2 min-w-2" />
        {#if totalReported > 0}
          <TimePresenter value={totalReported} />
          /
        {/if}
        <TimePresenter value={totalEstimation} />
        {#if capacity}
          <Label label={tracker.string.CapacityValue} params={{ value: capacity }} />
        {/if}
      {:else}
        <div class="p-1">
          ({docs.length}/{itemsProj?.length ?? 0})
        </div>
      {/if}
    </div>
  </FixedColumn>
{/if}
