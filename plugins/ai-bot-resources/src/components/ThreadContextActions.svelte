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
  import aiBot, {
    type AIContextMessage,
    type AILevel,
    type AILevelInfo,
    type AISpaceSettings
  } from '@hcengineering/ai-bot'
  import { getResource } from '@hcengineering/platform'
  import { Button, DropdownLabels, type DropdownTextItem, showPopup } from '@hcengineering/ui'
  import { createQuery, getClient, MessageBox } from '@hcengineering/presentation'
  import chunter from '@hcengineering/chunter'
  import view from '@hcengineering/view'
  import { onMount } from 'svelte'

  import plugin from '../plugin'
  import { resetObjectConversation } from '../conversation'
  import { getAILevels } from '../requests'

  // Thread header passes the root message as `value`. Only render for AI context roots.
  export let value: Doc

  const client = getClient()

  $: isAIContext = value._class === aiBot.class.AIContextMessage
  $: root = value as AIContextMessage

  let levelInfos: AILevelInfo[] = []
  // Workspace-wide default level; the button falls back to it when the thread has no explicit pick.
  let spaceLevel: AILevel | undefined = undefined
  const spaceQuery = createQuery()
  spaceQuery.query(aiBot.class.AISpaceSettings, { attachedTo: { $exists: false } }, (res: AISpaceSettings[]) => {
    spaceLevel = res[0]?.level
  })

  // Thread pick wins; otherwise show the space default so the dropdown always reflects a concrete level.
  $: selectedLevel = root.level ?? spaceLevel

  onMount(async () => {
    levelInfos = await getAILevels()
    levelInfos.sort((a, b) => a.order - b.order)
  })

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

  $: levelItems = levelInfos.map((l): DropdownTextItem => ({ id: l.level, label: l.label }))

  function onLevelSelected (e: CustomEvent<AILevel>): void {
    if (e.detail === undefined) return
    void client.update(root, { level: e.detail })
  }
</script>

{#if isAIContext}
  <DropdownLabels
    items={levelItems}
    selected={selectedLevel}
    kind={'ghost'}
    size={'small'}
    showDropdownIcon
    on:selected={onLevelSelected}
  />
  <Button
    icon={view.icon.Add}
    kind={'ghost'}
    size={'small'}
    showTooltip={{ label: plugin.string.NewContextHint }}
    on:click={newContext}
  />
{/if}
