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
  import { getCurrentAccount } from '@hcengineering/core'
  import { getMetadata } from '@hcengineering/platform'
  import { getClient } from '@hcengineering/presentation'
  import aiBot from '@hcengineering/ai-bot'
  import { getBotAccount } from '@hcengineering/ai-bot-resources'
  import view from '@hcengineering/view'
  import { AppItem } from '@hcengineering/workbench-resources'
  import chunter, { createAndGetDirect } from '@hcengineering/chunter'

  import { openChannelInSidebar } from '../navigation'

  // No ai-bot endpoint configured -> no assistant, no button.
  $: enabled = (getMetadata(aiBot.metadata.EndpointURL) ?? '') !== ''

  async function openAIChat (): Promise<void> {
    const botAccount = await getBotAccount()
    if (botAccount === undefined) return
    const direct = await createAndGetDirect(getClient(), [getCurrentAccount().uuid, botAccount])
    if (direct === undefined) return
    await openChannelInSidebar(direct._id, chunter.class.DirectMessage, direct)
  }
</script>

{#if enabled}
  <AppItem
    icon={view.icon.AiStar}
    label={chunter.string.TalkToYulia}
    size="small"
    on:click={() => {
      void openAIChat()
    }}
  />
{/if}
