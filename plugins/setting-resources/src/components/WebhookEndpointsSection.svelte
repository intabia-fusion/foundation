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
  import { type Ref } from '@hcengineering/core'
  import { type WebhookEndpoint } from '@hcengineering/setting'
  import { ButtonIcon, Icon, IconAdd, Label, Loading } from '@hcengineering/ui'
  import settingsRes from '../plugin'

  export let endpoints: WebhookEndpoint[]
  export let loading: boolean
  export let onOpen: (id: Ref<WebhookEndpoint>) => void
  export let onCreate: () => void
</script>

<div class="hulyTableAttr-header font-medium-12">
  <Icon icon={settingsRes.icon.Setting} size="small" />
  <span><Label label={settingsRes.string.WebhookAccess} /></span>
  <ButtonIcon kind="primary" icon={IconAdd} size="small" dataId="btnAddWebhook" on:click={onCreate} />
</div>
{#if loading}
  <Loading />
{:else if endpoints.length === 0}
  <div class="hulyTableAttr-content empty"><Label label={settingsRes.string.NoWebhooks} /></div>
{:else}
  <div class="hulyTableAttr-content">
    {#each endpoints as endpoint (endpoint._id)}
      <button
        type="button"
        class="hulyTableAttr-content__row justify-start"
        data-id="webhook-row"
        on:click|stopPropagation={() => {
          onOpen(endpoint._id)
        }}
      >
        <div class="hulyTableAttr-content__row-label font-medium-14 url" class:dimmed={!endpoint.enabled}>
          {endpoint.url}
        </div>
        <div class="meta">
          {#if !endpoint.enabled}
            <span><Label label={settingsRes.string.WebhookDisabled} /></span>
          {/if}
          {#if endpoint.failureCount > 0}
            <span class="warn">
              <Label label={settingsRes.string.WebhookFailureCount} params={{ count: endpoint.failureCount }} />
            </span>
          {/if}
          <span><Label label={settingsRes.string.WebhookEventsLabel} />: {endpoint.events.length}</span>
        </div>
      </button>
    {/each}
  </div>
{/if}

<style lang="scss">
  .url {
    font-family: monospace;
    word-break: break-all;

    &.dimmed {
      opacity: 0.5;
    }
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-left: auto;
    padding-left: 0.75rem;
    font-size: 0.8125rem;
    color: var(--theme-dark-color);
  }
  .warn {
    color: var(--theme-error-color);
  }
  .empty {
    padding: var(--spacing-2);
    color: var(--theme-dark-color);
  }
</style>
