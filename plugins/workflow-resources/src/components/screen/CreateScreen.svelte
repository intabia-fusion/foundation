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
// See the License for the specific language governing permissions and
// limitations under the License.
-->
<script lang="ts">
  import core, { Class, Doc, Ref } from '@hcengineering/core'
  import { getEmbeddedLabel, translate } from '@hcengineering/platform'
  import presentation, { getClient, IconWithEmoji } from '@hcengineering/presentation'
  import { clearSettingsStore } from '@hcengineering/setting-resources'
  import tracker from '@hcengineering/tracker'
  import { ProjectType } from '@hcengineering/task'
  import { taskTypeStore } from '@hcengineering/task-resources'
  import ui, {
    DropdownIntlItem,
    Label,
    languageStore,
    Modal,
    ModernDropdown,
    ModernEditbox,
    TextArea
  } from '@hcengineering/ui'
  import view from '@hcengineering/view'
  import { addScreenTab } from '@hcengineering/workflow'

  import plugin from '../../plugin'

  export let type: ProjectType

  const client = getClient()

  let name = ''
  let description = ''
  let selected: Ref<Class<Doc>> | undefined = undefined

  $: taskTypes = Array.from($taskTypeStore.values()).filter((t) => t.parent === type._id)

  $: canSave = name.trim().length > 0 && name.length <= 100 && description.length <= 500 && selected != null

  // Task type classes all inherit the "Issue" label, so name them by their task type.
  $: classItems = [
    {
      id: tracker.class.Issue,
      icon: tracker.icon.Issue,
      label: plugin.string.AnyTaskType
    },
    ...taskTypes
      .filter((t) => t.targetClass !== tracker.class.Issue)
      .map((t): DropdownIntlItem => {
        const _clazz = client.getHierarchy().getClass(t.targetClass)
        return {
          id: t.targetClass,
          icon: t.icon === view.ids.IconWithEmoji ? IconWithEmoji : (t.icon ?? _clazz.icon),
          iconProps: t.icon === view.ids.IconWithEmoji ? { icon: t.color } : {},
          label: getEmbeddedLabel(t.name)
        }
      })
  ]

  $: if (selected === undefined) {
    selected = tracker.class.Issue
  }

  async function save (): Promise<void> {
    if (!canSave) return
    if (selected == null) return

    const descTrimmed = description.trim()
    const screenId = await client.createDoc(plugin.class.Screen, core.space.Workspace, {
      name: name.trim(),
      description: descTrimmed.length > 0 ? descTrimmed : undefined,
      projectType: type._id,
      targetClass: selected
    })

    // Create initial default tab for the screen
    const defaultTabName = await translate(plugin.string.General, {}, $languageStore)
    await addScreenTab(client, screenId, defaultTabName)

    clearSettingsStore()
  }
</script>

<Modal
  label={plugin.string.Screen}
  type="type-aside"
  okAction={save}
  {canSave}
  okLabel={presentation.string.Create}
  on:changeContent
  onCancel={() => {
    clearSettingsStore()
  }}
>
  <div class="hulyModal-content__titleGroup">
    <ModernEditbox bind:value={name} label={plugin.string.Name} size="large" kind="ghost" autoFocus limit={100} />
  </div>
  <div class="hulyModal-content__settingsSet">
    <div class="hulyModal-content__settingsSet-line flex-col description-line">
      <span class="label desc-label">
        <Label label={plugin.string.Description} />
      </span>
      <TextArea
        bind:value={description}
        placeholder={plugin.string.Description}
        width="100%"
        height="4.5rem"
        wrap="soft"
        noFocusBorder
      />
    </div>
    {#if taskTypes.length > 0}
      <div class="hulyModal-content__settingsSet-line">
        <span class="label">
          <Label label={core.string.Class} />
        </span>
        <ModernDropdown
          items={classItems}
          bind:selected
          size="medium"
          placeholder={ui.string.NotSelected}
          autoSelect={true}
          withSearch={false}
          showDropdownIcon
        />
      </div>
    {/if}
  </div>
</Modal>

<style lang="scss">
  .description-line {
    align-items: flex-start;

    .desc-label {
      margin-bottom: 0.5rem;
    }
  }
</style>
