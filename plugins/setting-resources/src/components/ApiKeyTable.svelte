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
  import { type ApiKeyInfo } from '@hcengineering/account-client'
  import { type Ref, type Space } from '@hcengineering/core'
  import { Label } from '@hcengineering/ui'
  import settingsRes from '../plugin'
  import ApiKeyRow from './ApiKeyRow.svelte'

  export let keys: ApiKeyInfo[]
  export let spaceNames: Map<Ref<Space>, string>
  export let onRevoke: (key: ApiKeyInfo) => void
  export let statsByKey: Map<string, Map<string, number>>
</script>

<table class="keys">
  <thead>
    <tr>
      <th aria-label="expand" />
      <th><Label label={settingsRes.string.ApiKeyName} /></th>
      <th><Label label={settingsRes.string.ApiKeyColumnKey} /></th>
      <th class="center"><Label label={settingsRes.string.ApiKeyColumnIncoming} /></th>
      <th><Label label={settingsRes.string.ApiKeyColumnRights} /></th>
      <th><Label label={settingsRes.string.ApiKeySpaces} /></th>
      <th><Label label={settingsRes.string.ApiKeyLastUsed} /></th>
      <th />
    </tr>
  </thead>
  <tbody>
    {#each keys as key (key.keyId)}
      <ApiKeyRow apiKey={key} {spaceNames} {onRevoke} stats={statsByKey.get(key.keyId)} />
    {/each}
  </tbody>
</table>

<style lang="scss">
  // Fixed widths, not auto: the personal and integration tables are separate elements and would
  // otherwise size their columns independently and not line up.
  .keys {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
  }
  th:nth-child(1) {
    width: 2rem;
  }
  th:nth-child(2) {
    width: 15%;
  }
  th:nth-child(3) {
    width: 19%;
  }
  th:nth-child(4) {
    width: 8%;
  }
  th:nth-child(5) {
    width: 12%;
  }
  th:nth-child(6) {
    width: 20%;
  }
  th:nth-child(7) {
    width: 16%;
  }
  th:nth-child(8) {
    width: 10%;
  }
  th {
    text-align: left;
    padding: 0 0.75rem 0.5rem;
    font-size: 0.75rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    color: var(--theme-darker-color);
    white-space: nowrap;
  }
  th.center {
    text-align: center;
  }
</style>
