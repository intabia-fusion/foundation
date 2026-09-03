<!--
// Copyright © 2020, 2021 Anticrm Platform Contributors.
// Copyright © 2021 Hardcore Engineering Inc.
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
  import type { IntlString } from '@hcengineering/platform'
  import type { ButtonSize } from '@hcengineering/ui'
  import { Label, showPopup, eventToHTMLElement, Button } from '@hcengineering/ui'
  import TimePresenter from './TimePresenter.svelte'
  import { Issue, reduceChildInfoTree } from '@hcengineering/tracker'
  import EditEstimationPopup from './EditEstimationPopup.svelte'

  export let placeholder: IntlString
  export let value: number | undefined
  export let object: Issue
  export let onChange: (value: number | undefined) => void
  export let kind: 'no-border' | 'link' | 'button' = 'no-border'
  export let readonly = false
  export let size: ButtonSize = 'small'
  export let justify: 'left' | 'center' = 'left'
  export let width: string | undefined = '100%'
  export let attributeKey: string

  $: childInfos = object?.childInfo ?? []
  $: treeResult = reduceChildInfoTree(childInfos, 0, 0)

  function openEditor (ev: MouseEvent): void {
    ev.stopPropagation()
    showPopup(EditEstimationPopup, { value: value ?? 0 }, eventToHTMLElement(ev), (res) => {
      if (typeof res === 'number') {
        value = res
        onChange(res)
      }
    })
  }
</script>

<!-- svelte-ignore a11y-click-events-have-key-events -->
<!-- svelte-ignore a11y-no-static-element-interactions -->
<div
  class="link-container antiButton link {size} flex-grow flex-between"
  class:readonly
  on:click={readonly ? undefined : openEditor}
>
  {#if value != null}
    <span class="flex-row-center">
      {#if childInfos.length > 0 && attributeKey === 'estimation'}
        <TimePresenter {value} /><span>/</span>
        <TimePresenter value={treeResult.totalEstimation} />
      {:else}
        <TimePresenter {value} />
      {/if}
    </span>
  {:else}
    <span class="content-dark-color"><Label label={placeholder} /></span>
  {/if}
</div>

<style lang="scss">
  .link-container {
    padding: 0px 0.75rem;
    border-radius: 0.375rem;

    &:not(.readonly) {
      cursor: pointer;
    }
  }
</style>
