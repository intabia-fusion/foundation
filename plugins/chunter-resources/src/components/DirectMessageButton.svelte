<!--
// Copyright © 2024 Hardcore Engineering Inc.
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
  import { ModernButton } from '@hcengineering/ui'
  import view from '@hcengineering/view'
  import { Employee } from '@hcengineering/contact'
  import { Asset } from '@hcengineering/platform'

  import chunter from '../plugin'
  import { openDirectForPerson } from '../utils'

  export let employee: Employee
  export let kind: 'primary' | 'secondary' | 'tertiary' | 'negative' = 'secondary'
  export let icon: Asset | undefined = undefined
  export let type: 'type-button' | 'type-button-icon' = 'type-button'

  async function openDirect (): Promise<void> {
    await openDirectForPerson(employee, true)
  }
</script>

<div class="button-container">
  <ModernButton
    label={type === 'type-button-icon' ? undefined : chunter.string.Message}
    icon={icon ?? view.icon.Bubble}
    size="small"
    iconSize="small"
    {type}
    {kind}
    on:click={openDirect}
  />
</div>

<style lang="scss">
  .button-container {
    border-radius: var(--small-BorderRadius);
    display: flex;
    background-color: var(--theme-button-container-color);
  }
</style>
