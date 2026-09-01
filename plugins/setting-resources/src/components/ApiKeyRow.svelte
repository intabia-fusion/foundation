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
  import { Button, Label } from '@hcengineering/ui'
  import settingsRes from '../plugin'

  export let apiKey: ApiKeyInfo
  export let spaceNames: Map<Ref<Space>, string>
  export let onRevoke: (key: ApiKeyInfo) => void
  // Operation -> received count for this key, e.g. { 'issue:create': 12 }. Undefined/empty = no traffic yet.
  export let stats: Map<string, number> | undefined = undefined

  let expanded = false

  function formatDate (timestamp: number): string {
    return new Date(timestamp).toLocaleString()
  }

  const dayMs = 24 * 60 * 60 * 1000
  // Mirrors defaultApiKeyTokenTtlMs in server/account/src/apiKeys.ts, for keys created before the field existed.
  const defaultTokenTtlDays = 7

  function tokenTtlDays (key: ApiKeyInfo): number {
    return Math.round((key.tokenTtlMs ?? defaultTokenTtlDays * dayMs) / dayMs)
  }

  $: revoked = apiKey.revokedOn !== undefined
  $: spacesLabel = apiKey.spaces.map((id) => spaceNames.get(id) ?? id).join(', ')
</script>

<tr class="row" class:revoked>
  <td class="chevronCell">
    <button
      class="chevron"
      class:open={expanded}
      type="button"
      aria-expanded={expanded}
      aria-label={apiKey.name}
      on:click={() => {
        expanded = !expanded
      }}
    >
      ▸
    </button>
  </td>
  <td class="nameCell">
    <span class="name">{apiKey.name}</span>
    {#if revoked}
      <span class="badge"><Label label={settingsRes.string.ApiKeyRevoked} /></span>
    {/if}
  </td>
  <td class="masked">{apiKey.masked}</td>
  <td class="center">
    {#if apiKey.incoming === true}
      <span class="yes">✓</span>
    {:else}
      <span class="no">-</span>
    {/if}
  </td>
  <td>
    {#if apiKey.unrestricted === true}
      <Label label={settingsRes.string.ApiKeyFullRights} />
    {:else if apiKey.ops.length === 0}
      <Label label={settingsRes.string.ApiKeyReadOnly} />
    {:else}
      <Label label={settingsRes.string.ApiKeyOpsCount} params={{ count: apiKey.ops.length }} />
    {/if}
  </td>
  <td class="truncate">
    {#if apiKey.spaces.length === 0}
      <Label label={settingsRes.string.ApiKeyAllSpaces} />
    {:else}
      {spacesLabel}
    {/if}
  </td>
  <td class="dim">
    {#if apiKey.lastUsed !== undefined}
      {formatDate(apiKey.lastUsed)}
    {:else}
      <Label label={settingsRes.string.ApiKeyNeverUsed} />
    {/if}
  </td>
  <td class="actions">
    {#if !revoked}
      <Button
        label={settingsRes.string.RevokeApiKey}
        kind="dangerous"
        size="small"
        on:click={() => {
          onRevoke(apiKey)
        }}
      />
    {/if}
  </td>
</tr>
{#if expanded}
  <tr class="detail" class:revoked>
    <td colspan="8">
      <div class="meta">
        {#if apiKey.ops.length > 0 && apiKey.unrestricted !== true}
          <span><Label label={settingsRes.string.ApiKeyOperations} />: {apiKey.ops.join(', ')}</span>
        {/if}
        <span><Label label={settingsRes.string.ApiKeyCreatedOn} />: {formatDate(apiKey.createdOn)}</span>
        {#if apiKey.expiresOn !== undefined}
          <span><Label label={settingsRes.string.ApiKeyExpiresOn} />: {formatDate(apiKey.expiresOn)}</span>
        {/if}
        <span>
          <Label label={settingsRes.string.ApiKeyTokenTtl} />:
          <Label label={settingsRes.string.ApiKeyTokenTtlDays} params={{ days: tokenTtlDays(apiKey) }} />
        </span>
      </div>
      {#if stats !== undefined && stats.size > 0}
        <div class="meta">
          <span><Label label={settingsRes.string.ApiKeyOperationCounts} />:</span>
          {#each Array.from(stats.entries()) as [op, count]}
            <span class="statBadge">{op}: {count}</span>
          {/each}
        </div>
      {/if}
    </td>
  </tr>
{/if}

<style lang="scss">
  .row td {
    padding: 0.5rem 0.75rem;
    border-top: 1px solid var(--theme-divider-color);
    vertical-align: middle;
  }
  .row.revoked td,
  .detail.revoked td {
    opacity: 0.5;
  }
  .chevronCell {
    width: 1.5rem;
    padding-right: 0 !important;
  }
  .chevron {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--theme-dark-color);
    padding: 0;
    transition: transform 0.1s;

    &.open {
      transform: rotate(90deg);
    }
  }
  .nameCell {
    white-space: nowrap;
  }
  .name {
    font-weight: 500;
  }
  .masked {
    font-family: monospace;
    color: var(--theme-dark-color);
    white-space: nowrap;
  }
  .center {
    text-align: center;
  }
  .yes {
    color: var(--theme-won-color);
  }
  .no {
    color: var(--theme-darker-color);
  }
  .dim {
    color: var(--theme-dark-color);
    white-space: nowrap;
  }
  .truncate {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .actions {
    text-align: right;
    white-space: nowrap;
  }
  .badge {
    margin-left: 0.5rem;
    font-size: 0.75rem;
    padding: 0.125rem 0.5rem;
    border-radius: 0.5rem;
    background: var(--theme-error-color);
    color: white;
  }
  .statBadge {
    font-size: 0.75rem;
    padding: 0.125rem 0.5rem;
    border-radius: 0.5rem;
    background: var(--theme-button-default);
    color: var(--theme-dark-color);
  }
  .detail td {
    padding: 0 0.75rem 0.75rem 2.25rem;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    font-size: 0.8125rem;
    color: var(--theme-dark-color);
  }
</style>
