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
  import core from '@hcengineering/core'
  import aiBot, {
    type AILevel,
    type AILevelInfo,
    type AsrLevel,
    type AsrLevelInfo,
    type AISpaceSettings
  } from '@hcengineering/ai-bot'
  import { createQuery, getClient } from '@hcengineering/presentation'
  import { Label, Scroller, TextArea } from '@hcengineering/ui'
  import { onMount } from 'svelte'

  import { getAILevels, getAsrLevels } from '../requests'
  import AILevelCards from './AILevelCards.svelte'
  import AILanguageSelector from './AILanguageSelector.svelte'

  export let readonly: boolean = false

  const client = getClient()

  let doc: AISpaceSettings | undefined = undefined
  let level: AILevel = ''
  let asrLevel: AsrLevel = ''
  let language: string = ''
  let levelInfos: AILevelInfo[] = []
  let asrLevelInfos: AsrLevelInfo[] = []
  let sharedPrompt: string = ''

  const query = createQuery()
  query.query(aiBot.class.AISpaceSettings, { attachedTo: { $exists: false } }, (res) => {
    doc = res[0]
    level = doc?.level ?? level
    asrLevel = doc?.asrLevel ?? asrLevel
    language = doc?.language ?? ''
    sharedPrompt = doc?.sharedPrompt ?? ''
  })

  onMount(async () => {
    ;[levelInfos, asrLevelInfos] = await Promise.all([getAILevels(), getAsrLevels()])
    levelInfos.sort((a, b) => a.order - b.order)
    asrLevelInfos.sort((a, b) => a.order - b.order)
    if (level === '' && levelInfos.length > 0) {
      level = levelInfos[0].level
    }
    if (asrLevel === '' && asrLevelInfos.length > 0) {
      asrLevel = asrLevelInfos[0].level
    }
  })

  async function save (
    patch: Partial<Pick<AISpaceSettings, 'level' | 'asrLevel' | 'language' | 'sharedPrompt'>>
  ): Promise<void> {
    if (readonly) return
    if (doc !== undefined) {
      await client.update(doc, patch)
    } else {
      await client.createDoc(aiBot.class.AISpaceSettings, core.space.Workspace, {
        level: level !== '' ? level : (levelInfos[0]?.level ?? 'low'),
        ...patch
      })
    }
  }

  function onLevelSelected (e: CustomEvent<string>): void {
    level = e.detail
    void save({ level })
  }

  function onAsrLevelSelected (e: CustomEvent<string>): void {
    asrLevel = e.detail
    void save({ asrLevel })
  }

  function onLanguageChanged (e: CustomEvent<string>): void {
    language = e.detail
    void save({ language: language !== '' ? language : undefined })
  }
</script>

<Scroller>
  <div class="ac-body p-10 settings-blocks" style:max-width={'48rem'}>
    <div class="flex-col flex-gap-2">
      <span class="fs-title"><Label label={aiBot.string.AILevel} /></span>
      <span class="content-dark-color text-sm"><Label label={aiBot.string.AILevelHint} /></span>
      {#if levelInfos.length > 0}
        <div class="mt-2">
          <AILevelCards levels={levelInfos} selected={level} disabled={readonly} on:select={onLevelSelected} />
        </div>
      {/if}
    </div>

    {#if asrLevelInfos.length > 0}
      <div class="flex-col flex-gap-2">
        <span class="fs-title"><Label label={aiBot.string.AsrLevel} /></span>
        <span class="content-dark-color text-sm"><Label label={aiBot.string.AsrLevelHint} /></span>
        <div class="mt-2">
          <AILevelCards levels={asrLevelInfos} selected={asrLevel} disabled={readonly} on:select={onAsrLevelSelected} />
        </div>
      </div>
    {/if}

    <div class="flex-col flex-gap-2">
      <span class="fs-title"><Label label={aiBot.string.Language} /></span>
      <span class="content-dark-color text-sm"><Label label={aiBot.string.LanguageHint} /></span>
      <div class="mt-2">
        <AILanguageSelector value={language} disabled={readonly} on:change={onLanguageChanged} />
      </div>
    </div>

    <div class="flex-col flex-gap-2">
      <span class="fs-title"><Label label={aiBot.string.SharedPrompt} /></span>
      <span class="content-dark-color text-sm"><Label label={aiBot.string.SharedPromptHint} /></span>
      <div class="mt-2">
        <TextArea bind:value={sharedPrompt} disabled={readonly} on:blur={() => save({ sharedPrompt })} />
      </div>
    </div>
  </div>
</Scroller>

<style lang="scss">
  .settings-blocks {
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }
</style>
