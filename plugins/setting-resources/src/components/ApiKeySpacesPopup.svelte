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
  import core, { type Doc, type Ref, type Space } from '@hcengineering/core'
  import { Label } from '@hcengineering/ui'
  import { ObjectPopup, getClient } from '@hcengineering/presentation'
  import settingsRes from '../plugin'
  import { isApiKeyPickableSpace } from '../utils'

  export let selectedObjects: Ref<Space>[] = []

  const hierarchy = getClient().getHierarchy()

  function isPickable (doc: Doc): boolean {
    return isApiKeyPickableSpace(hierarchy, doc)
  }
</script>

<ObjectPopup
  _class={core.class.Space}
  {selectedObjects}
  multiSelect
  placeholder={settingsRes.string.ApiKeySpacesPlaceholder}
  filter={isPickable}
  on:close
  on:update
  on:changeContent
>
  <svelte:fragment slot="item" let:item>
    <div class="flex-row-center flex-gap-2 flex-grow overflow-label">
      <span class="overflow-label">{item.name}</span>
      <span class="classLabel"><Label label={hierarchy.getClass(item._class).label} /></span>
    </div>
  </svelte:fragment>
</ObjectPopup>

<style lang="scss">
  .classLabel {
    color: var(--theme-dark-color);
    font-size: 0.75rem;
    flex-shrink: 0;
  }
</style>
