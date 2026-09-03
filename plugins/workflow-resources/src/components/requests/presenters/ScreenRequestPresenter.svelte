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
// See the License for the specific language governing permissions and
// limitations under the License.
-->
<script lang="ts">
  import { createQuery } from '@hcengineering/presentation'
  import { Label } from '@hcengineering/ui'
  import { Screen, ScreenRequestConfig } from '@hcengineering/workflow'

  import plugin from '../../../plugin'

  export let config: ScreenRequestConfig

  const screenQuery = createQuery()
  let screen: Screen | undefined

  $: screenId = config?.props?.screen
  $: if (screenId != null) {
    screenQuery.query(plugin.class.Screen, { _id: screenId }, (res) => {
      screen = res.shift()
    })
  }
</script>

<div class="screen-request-presenter font-regular-13 text-secondary w-full min-w-0 overflow-hidden truncate">
  {#if screen}
    <span class="truncate block">
      <Label label={plugin.string.ScreenRequestPresenter} params={{ name: screen.name }} />
    </span>
  {:else}
    <span class="text-secondary">
      <Label label={plugin.string.ScreenNotSelected} />
    </span>
  {/if}
</div>
