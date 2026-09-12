<!--
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
-->
<script lang="ts">
  import { type Class, type Doc, type DocumentQuery, type Ref } from '@hcengineering/core'
  import { ObjectPopup } from '@hcengineering/presentation'
  import settingsRes from '../plugin'

  export let _class: Ref<Class<Doc>>
  export let docQuery: DocumentQuery<Doc> | undefined = undefined
  export let searchField: string = 'name'
  export let selected: Ref<Doc> | undefined = undefined

  interface TargetLike extends Doc {
    identifier?: string
    name?: string
    title?: string
  }

  function asTarget (item: Doc): TargetLike {
    return item as TargetLike
  }
</script>

<ObjectPopup
  {_class}
  {docQuery}
  {searchField}
  {selected}
  placeholder={settingsRes.string.WebhookConstructPickTarget}
  on:close
  on:changeContent
>
  <svelte:fragment slot="item" let:item>
    <div class="flex-row-center flex-gap-2 flex-grow overflow-label">
      {#if asTarget(item).identifier !== undefined}
        <span class="identifier">{asTarget(item).identifier}</span>
      {/if}
      <span class="overflow-label">{asTarget(item).name ?? asTarget(item).title ?? ''}</span>
    </div>
  </svelte:fragment>
</ObjectPopup>

<style lang="scss">
  .identifier {
    color: var(--theme-dark-color);
    font-family: monospace;
    flex-shrink: 0;
  }
</style>
