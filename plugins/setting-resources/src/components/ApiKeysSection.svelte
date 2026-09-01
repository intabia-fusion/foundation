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
  import { ButtonIcon, Icon, IconAdd, IconDescription, Label, Loading } from '@hcengineering/ui'
  import settingsRes from '../plugin'
  import ApiKeyTable from './ApiKeyTable.svelte'

  export let personal: boolean
  export let keys: ApiKeyInfo[]
  export let used: number
  export let limit: number
  export let loading: boolean
  export let spaceNames: Map<Ref<Space>, string>
  export let statsByKey: Map<string, Map<string, number>>
  export let onCreate: (personal: boolean) => void
  export let onRevoke: (key: ApiKeyInfo) => void
  // Only the section that every member sees carries the request constructor.
  export let onConstruct: (() => void) | undefined = undefined

  $: atLimit = !loading && used >= limit
</script>

<div class="hulyTableAttr-header font-medium-12">
  <Icon icon={settingsRes.icon.Integrations} size="small" />
  <span>
    <Label label={personal ? settingsRes.string.PersonalApiKeys : settingsRes.string.IntegrationApiKeys} />
  </span>
  {#if !loading}
    <div class="usage"><Label label={settingsRes.string.ApiKeysUsage} params={{ used, limit }} /></div>
  {/if}
  <div class="flex-row-center flex-gap-1">
    {#if onConstruct !== undefined}
      <ButtonIcon
        kind="tertiary"
        icon={IconDescription}
        size="small"
        dataId="btnConstructWebhook"
        tooltip={{ label: settingsRes.string.WebhookConstruct }}
        on:click={onConstruct}
      />
    {/if}
    <ButtonIcon
      kind="primary"
      icon={IconAdd}
      size="small"
      dataId={personal ? 'btnAddPersonalKey' : 'btnAddIntegrationKey'}
      disabled={atLimit}
      tooltip={atLimit ? { label: settingsRes.string.ApiKeyLimitReachedError, props: { limit } } : undefined}
      on:click={() => {
        onCreate(personal)
      }}
    />
  </div>
</div>
{#if loading}
  <Loading />
{:else if keys.length === 0}
  <div class="hulyTableAttr-content empty"><Label label={settingsRes.string.NoApiKeys} /></div>
{:else}
  <div class="hulyTableAttr-content">
    <ApiKeyTable {keys} {spaceNames} {onRevoke} {statsByKey} />
  </div>
{/if}

<style lang="scss">
  .usage {
    margin-right: 0.5rem;
    text-transform: none;
    color: var(--theme-dark-color);
  }
  .empty {
    padding: var(--spacing-2);
    color: var(--theme-dark-color);
  }
</style>
