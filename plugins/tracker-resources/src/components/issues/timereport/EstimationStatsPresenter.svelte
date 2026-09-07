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
  import { AttachedData } from '@hcengineering/core'

  import { Issue, reduceChildInfoTree } from '@hcengineering/tracker'
  import EstimationProgressCircle from './EstimationProgressCircle.svelte'
  import TimePresenter from './TimePresenter.svelte'

  export let value: Issue | AttachedData<Issue>
  export let estimation: number | undefined = undefined
  export let kind: 'normal' | 'list' = 'normal'

  $: _estimation = estimation ?? value.estimation

  $: childInfos = value.childInfo ?? []
  $: treeResult = reduceChildInfoTree(childInfos, 0, 0)
</script>

<!-- svelte-ignore a11y-click-events-have-key-events -->
<!-- svelte-ignore a11y-no-static-element-interactions -->
<div class="estimation-container" on:click>
  <div class="icon">
    <EstimationProgressCircle
      items={[
        { value: value.reportedTime + treeResult.totalReportedTime, max: _estimation },
        ...(kind === 'list' && childInfos.length > 0
          ? [{ value: value.reportedTime + treeResult.totalReportedTime, max: treeResult.totalEstimation }]
          : [])
      ]}
    />
  </div>
  <span class="overflow-label label flex-row-center flex-nowrap {kind}">
    <div
      class="flex flex-nowrap"
      class:showWarning={value.estimation !== 0 && treeResult.totalEstimation > value.estimation}
    >
      <TimePresenter
        value={kind === 'list' ? Math.max(value.estimation, treeResult.totalEstimation) : value.estimation}
      />
    </div>
  </span>
</div>

<style lang="scss">
  .estimation-container {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    min-width: 0;
    cursor: pointer;

    .icon {
      display: flex;
      justify-content: center;
      align-items: center;
      flex-shrink: 0;
      width: 1rem;
      height: 1rem;
      color: var(--theme-dark-color);
    }
    .label {
      font-size: 0.8125rem;
      margin-left: 0.5rem;

      &.normal {
        color: var(--theme-content-color);
      }
      &.list {
        color: var(--theme-halfcontent-color);
      }
    }
    &:hover {
      .icon {
        color: var(--theme-caption-color) !important;
      }
    }

    .showError {
      color: var(--theme-error-color) !important;
    }
    .showWarning {
      color: var(--theme-warning-color) !important;
    }
    .romColor {
      color: var(--theme-content-color) !important;
    }

    .showChild {
      color: var(--theme-code-color) !important;
    }
  }
</style>
