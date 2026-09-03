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
  import aiBot, { type AIRequest } from '@hcengineering/ai-bot'
  import { type Doc } from '@hcengineering/core'
  import { createQuery, getClient } from '@hcengineering/presentation'
  import ui, { Button } from '@hcengineering/ui'

  export let object: Doc

  const client = getClient()
  const query = createQuery()

  let request: AIRequest | undefined = undefined

  $: query.query(
    aiBot.class.AIRequest,
    { objectId: object._id, status: 'processing' },
    (res) => {
      request = res[0]
    },
    { limit: 1 }
  )

  async function cancel (): Promise<void> {
    if (request === undefined) return
    await client.update(request, { status: 'cancelled' })
  }

  function short (n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`
  }
</script>

{#if request !== undefined}
  <span class="root">
    <span class="tokens">
      ↑{short(request.promptTokens)} ↓{short(request.completionTokens)}
      {#if (request.iteration ?? 0) > 1}· {request.iteration}{/if}
    </span>
    <Button label={ui.string.Cancel} kind="ghost" size="small" on:click={cancel} />
  </span>
{/if}

<style lang="scss">
  .root {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.75rem;
    color: var(--theme-halfcontent-color);
  }
  .tokens {
    font-variant-numeric: tabular-nums;
  }
</style>
