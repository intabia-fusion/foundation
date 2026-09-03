<!--
// Copyright © 2026 Intabia Fusion
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
  import { type Doc } from '@hcengineering/core'
  import aiBot, { type AIContextMessage } from '@hcengineering/ai-bot'
  import { getResource } from '@hcengineering/platform'
  import { Button, IconDownOutline, showPopup } from '@hcengineering/ui'
  import { MessageBox } from '@hcengineering/presentation'
  import chunter from '@hcengineering/chunter'
  import view from '@hcengineering/view'

  import plugin from '../plugin'
  import { resetObjectConversation } from '../conversation'
  import { downloadMdx, exportConversationMdx } from '../exportChat'
  import { fetchConversationExport } from '../requests'

  // Thread header passes the root message as `value`. Only render for AI context roots.
  export let value: Doc

  $: root = value as AIContextMessage
  // A draft thread is reset from the create-issue dialog, which owns the draft; not from here.
  $: isAIContext = value._class === aiBot.class.AIContextMessage && root.purpose !== 'issue-draft'

  function newContext (): void {
    showPopup(MessageBox, {
      label: plugin.string.NewContext,
      message: plugin.string.NewContextConfirm,
      action: async () => {
        const started = await resetObjectConversation(root, '')
        if (started === undefined) return
        const openThread = await getResource(chunter.function.OpenThreadInSidebar)
        await openThread(started.messageId, undefined, started.direct)
      }
    })
  }

  async function exportChat (): Promise<void> {
    // The pod's own file is the better source: it carries the tool calls the chat never shows.
    // Falls back to the visible messages when nothing has been written for this thread yet.
    const mdx = (await fetchConversationExport(root._id)) ?? (await exportConversationMdx(root, root.objectId))
    downloadMdx(`yulia-${root._id}.mdx`, mdx)
  }
</script>

{#if isAIContext}
  <Button
    icon={view.icon.Add}
    kind={'ghost'}
    size={'small'}
    dataId={'btnAiNewContext'}
    showTooltip={{ label: plugin.string.NewContextHint }}
    disabled={(root.replies ?? 0) === 0}
    on:click={newContext}
  />
  <Button
    icon={IconDownOutline}
    kind={'ghost'}
    size={'small'}
    dataId={'btnAiExportChat'}
    showTooltip={{ label: plugin.string.ExportChatHint }}
    on:click={() => {
      void exportChat()
    }}
  />
{/if}
