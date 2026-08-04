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
  import core, { getCurrentAccount } from '@hcengineering/core'
  import aiBot, { type AIPersonalData } from '@hcengineering/ai-bot'
  import { createQuery, getClient } from '@hcengineering/presentation'
  import { Label, Scroller, TextArea } from '@hcengineering/ui'
  import AILanguageSelector from './AILanguageSelector.svelte'

  const client = getClient()
  const me = getCurrentAccount().uuid

  let data: AIPersonalData | undefined = undefined
  let personalContext = ''
  let language = ''

  const query = createQuery()
  query.query(aiBot.class.AIPersonalData, { attachedTo: me }, (res) => {
    data = res[0]
    personalContext = data?.personalContext ?? ''
    language = data?.language ?? ''
  })

  async function save (patch: Partial<Pick<AIPersonalData, 'personalContext' | 'language'>>): Promise<void> {
    if (data !== undefined) {
      await client.update(data, patch)
    } else {
      await client.createDoc(aiBot.class.AIPersonalData, core.space.Workspace, {
        attachedTo: me,
        personalContext: '',
        ...patch
      })
    }
  }

  function onLanguageChanged (e: CustomEvent<string>): void {
    language = e.detail
    void save({ language: language !== '' ? language : undefined })
  }
</script>

<Scroller>
  <div class="ac-body p-10 settings-blocks" style:max-width={'48rem'}>
    <div class="flex-col flex-gap-2">
      <span class="fs-title"><Label label={aiBot.string.PersonalContext} /></span>
      <span class="content-dark-color text-sm"><Label label={aiBot.string.PersonalContextHint} /></span>
      <div class="mt-2"><TextArea bind:value={personalContext} on:blur={() => save({ personalContext })} /></div>
    </div>
    <div class="flex-col flex-gap-2">
      <span class="fs-title"><Label label={aiBot.string.Language} /></span>
      <span class="content-dark-color text-sm"><Label label={aiBot.string.LanguageHint} /></span>
      <div class="mt-2"><AILanguageSelector value={language} on:change={onLanguageChanged} /></div>
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
