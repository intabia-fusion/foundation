<!--
// Copyright © 2026 Hardcore Engineering Inc.
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
  import type { AttachedData } from '@hcengineering/core'
  import type { Issue } from '@hcengineering/tracker'
  import TimePresenter from './TimePresenter.svelte'

  export let value: number | Issue | AttachedData<Issue> | undefined = undefined
  export let object: Issue | undefined = undefined

  function isNumber (v: unknown): v is number {
    return typeof v === 'number' && Number.isFinite(v)
  }

  $: issue = (object ?? (isNumber(value) ? undefined : value)) as Issue | undefined
  $: reported = isNumber(value) ? value : (issue?.reportedTime ?? 0)
</script>

<div class="reported-container">
  <span class="overflow-label label flex-row-center flex-nowrap list">
    <TimePresenter value={reported} />
  </span>
</div>

<style lang="scss">
  .reported-container {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    min-width: 0;

    .label {
      font-size: 0.8125rem;
      color: var(--theme-halfcontent-color);
    }
  }
</style>
