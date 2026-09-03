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
  import { onDestroy } from 'svelte'
  import { Class, Doc, Ref, WithLookup } from '@hcengineering/core'
  import { Asset, getEmbeddedLabel, translate } from '@hcengineering/platform'
  import { createQuery, getClient, IconWithEmoji, MessageBox, reduceCalls } from '@hcengineering/presentation'
  import { Task } from '@hcengineering/task'
  import { taskTypeStore } from '@hcengineering/task-resources'
  import ui, {
    ButtonIcon,
    DropdownIntlItem,
    EditBox,
    IconDelete,
    languageStore,
    Loading,
    ModernButton,
    ModernDropdown,
    Scroller,
    showPopup,
    TextArea,
    tooltip
  } from '@hcengineering/ui'
  import view from '@hcengineering/view'
  import {
    addScreenTab,
    Screen,
    ScreenField,
    ScreenProps,
    ScreenTab,
    Workflow,
    WorkflowTransition
  } from '@hcengineering/workflow'
  import tracker from '@hcengineering/tracker'

  import { navigateToScreen } from '../../location'
  import plugin from '../../plugin'
  import { DisplayAttribute, DisplayAttributeGroup, getDisplayAttributes } from '../../utils'
  import ScreenTabEditor from './ScreenTabEditor.svelte'
  import ScreenUsedWorkflows from './ScreenUsedWorkflows.svelte'

  export let objectId: Ref<Screen>
  export let name: string | undefined = undefined
  export let icon: Asset | undefined = undefined
  export let readonly = false

  const client = getClient()
  const screenQuery = createQuery()
  const fieldsQuery = createQuery()
  const workflowsQuery = createQuery()

  let screen: Screen | undefined
  let tabs: ScreenTab[] = []
  let allFields: ScreenField[] = []
  let displayAttributeGroups: DisplayAttributeGroup[] = []
  let displayAttributes: DisplayAttribute[] = []
  let isScreenLoading = true

  let workflows: WithLookup<Workflow>[] = []

  let localName = ''
  let localDescription = ''
  let loadedScreenId: Ref<Screen> | undefined = undefined

  $: screenQuery.query(
    plugin.class.Screen,
    { _id: objectId },
    (res) => {
      const r = res.shift()
      screen = r
      tabs = (r?.$lookup?.tabs ?? []) as ScreenTab[]
      isScreenLoading = false
    },
    {
      lookup: {
        _id: {
          tabs: plugin.class.ScreenTab
        }
      }
    }
  )

  $: if (screen != null && screen._id !== loadedScreenId) {
    loadedScreenId = screen._id
    localName = screen.name ?? ''
    localDescription = screen.description ?? ''
  }

  $: tabIds = tabs.map((t) => t._id)

  $: fieldsQuery.query(plugin.class.ScreenField, { attachedTo: { $in: tabIds } }, (res) => {
    allFields = res
  })

  $: taskTypes = Array.from($taskTypeStore.values()).filter((t) => t.parent === screen?.projectType)

  $: if (screen?.projectType != null) {
    workflowsQuery.query(
      plugin.class.Workflow,
      { projectType: screen.projectType },
      (res) => {
        workflows = res
      },
      {
        lookup: {
          _id: {
            transitions: plugin.class.WorkflowTransition
          }
        }
      }
    )
  }

  $: usedWorkflows = workflows.filter((wf) => {
    const transitions = (wf.$lookup?.transitions ?? []) as WorkflowTransition[]
    return transitions.some((t) =>
      t.requests?.some((r) => r.id === plugin.request.ScreenRequest && (r.props as ScreenProps)?.screen === objectId)
    )
  })

  $: hasUsedWorkflows = usedWorkflows.length > 0
  $: usedWorkflowNames = usedWorkflows
    .map((w) => w.name)
    .filter((n): n is string => Boolean(n))
    .join(', ')

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

  $: name = localName
  $: icon = plugin.icon.Screens
  $: usedFields = new Set(allFields.map((f) => f.attribute))

  $: sortedTabs = [...tabs].sort((a: ScreenTab, b: ScreenTab) => {
    const rankA = a.rank ?? ''
    const rankB = b.rank ?? ''
    return rankA < rankB ? -1 : rankA > rankB ? 1 : 0
  })

  const updateDisplayAttributes = reduceCalls(
    async (_class: Ref<Class<Task>> | undefined, lang: string): Promise<void> => {
      if (_class == null) {
        displayAttributeGroups = []
        displayAttributes = []
        return
      }

      const skipRegular = ['status', 'modifiedOn', 'modifiedBy', 'createdOn', 'createdBy']
      const skipCollections = ['reports', 'subIssues', 'blockedBy', 'relations', 'parents']
      const res = await getDisplayAttributes(_class, lang, [...skipRegular, ...skipCollections])
      displayAttributeGroups = res

      const regular = res.flatMap((it) => it.regular)
      const collection = res.flatMap((it) => it.collection)

      displayAttributes = [...regular, ...collection]
    }
  )

  $: void updateDisplayAttributes(screen?.targetClass, $languageStore)

  async function handleClassSelect (
    event: CustomEvent<DropdownIntlItem['id'] | Array<DropdownIntlItem['id']> | undefined>
  ): Promise<void> {
    const id = event.detail
    if (id == null) return
    const newClass = (Array.isArray(id) ? id[0] : id) as Ref<Class<Doc>> | undefined

    if (screen != null && newClass != null && newClass !== screen.targetClass) {
      await client.update(screen, { targetClass: newClass })
    }
  }

  async function saveName (): Promise<void> {
    if (screen != null) {
      const trimmed = localName.trim()
      if (trimmed !== '' && trimmed !== screen.name) {
        await client.update(screen, { name: trimmed })
      }
    }
  }

  async function saveDescription (): Promise<void> {
    if (screen != null) {
      const trimmed = localDescription.trim()
      const val = trimmed.length > 0 ? trimmed : undefined
      if (val !== screen.description) {
        await client.update(screen, { description: val })
      }
    }
  }

  onDestroy(() => {
    void saveName()
    void saveDescription()
  })

  let isDeleteLoading = false

  async function handleRemoveScreen (): Promise<void> {
    if (screen == null || isDeleteLoading) return
    isDeleteLoading = true
    try {
      showPopup(MessageBox, {
        label: plugin.string.DeleteScreen,
        message: plugin.string.DeleteScreenConfirm,
        params: { name: screen.name },
        component: usedWorkflows.length > 0 ? ScreenUsedWorkflows : undefined,
        componentProps: { workflows: usedWorkflows },
        dangerous: true,
        action: async () => {
          if (screen != null) {
            await client.remove(screen)
            navigateToScreen(undefined, false)
          }
        }
      })
    } finally {
      isDeleteLoading = false
    }
  }

  async function addTab (): Promise<void> {
    if (screen == null) return
    const tabName = await translate(plugin.string.TabNumbered, { num: tabs.length + 1 }, $languageStore)
    await addScreenTab(client, screen._id, tabName)
  }

  const skipRegular = ['status', 'modifiedOn', 'modifiedBy', 'createdOn', 'createdBy']

  $: availableAttributeGroups = displayAttributeGroups
    .map((group) => ({
      ...group,
      regular: group.regular
        .filter((it) => !skipRegular.includes(it.key) && !usedFields.has(it.id))
        .sort((a, b) => a.label.localeCompare(b.label, $languageStore)),
      collection: group.collection
        .filter((it) => !usedFields.has(it.id))
        .sort((a, b) => a.label.localeCompare(b.label, $languageStore))
    }))
    .filter((group) => group.regular.length > 0 || group.collection.length > 0)

  $: availableAttributes = availableAttributeGroups.flatMap((group) => [...group.regular, ...group.collection])
</script>

<div class="hulyComponent-content__container columns">
  <div class="hulyComponent-content__column content">
    {#if isScreenLoading}
      <Loading />
    {:else if screen}
      <Scroller align="center" padding="var(--spacing-3)" bottomPadding="var(--spacing-3)">
        <div class="hulyComponent-content gap">
          <!-- Screen Header -->
          <div class="header flex flex-col gap-1">
            <div class="flex-between flex-row-center flex-gap-2">
              <div class="flex-grow min-w-0">
                <EditBox
                  bind:value={localName}
                  kind="modern-ghost-large"
                  on:blur={saveName}
                  required
                  fullSize
                  placeholder={plugin.string.Untitled}
                />
              </div>
              <div class="flex-row-center flex-gap-2 flex-shrink-0">
                {#if classItems.length > 0}
                  <div
                    use:tooltip={hasUsedWorkflows
                      ? {
                          label: plugin.string.ScreenClassDisabledUsedInWorkflows,
                          props: { names: usedWorkflowNames }
                        }
                      : undefined}
                  >
                    <ModernDropdown
                      items={classItems}
                      selected={screen.targetClass}
                      on:selected={handleClassSelect}
                      placeholder={ui.string.NotSelected}
                      size="small"
                      disabled={readonly || hasUsedWorkflows}
                    />
                  </div>
                {/if}
                {#if !readonly}
                  <ButtonIcon
                    icon={IconDelete}
                    tooltip={{ label: view.string.Delete, direction: 'bottom' }}
                    size="small"
                    kind="secondary"
                    loading={isDeleteLoading}
                    disabled={readonly || isDeleteLoading}
                    on:click={handleRemoveScreen}
                  />
                {/if}
              </div>
            </div>
            <TextArea
              bind:value={localDescription}
              placeholder={plugin.string.Description}
              disabled={readonly}
              height="4.5rem"
              width="100%"
              wrap="soft"
              noFocusBorder
              on:blur={saveDescription}
            />
          </div>

          <!-- Tabs Editors -->
          {#each sortedTabs as tab (tab._id)}
            <ScreenTabEditor
              {tab}
              {readonly}
              canDelete={tabs.length > 1}
              {displayAttributes}
              {availableAttributes}
              {availableAttributeGroups}
              fields={allFields.filter((it) => it.attachedTo === tab._id)}
            />
          {/each}

          {#if !readonly}
            <div class="add-tab-container">
              <ModernButton
                kind="secondary"
                size="small"
                label={plugin.string.AddTab}
                on:click={() => {
                  void addTab()
                }}
              />
            </div>
          {/if}
        </div>
      </Scroller>
    {/if}
  </div>
</div>

<style lang="scss">
  .header {
    :global(.antiEditBox) {
      margin-left: -1rem;
    }
  }

  .add-tab-container {
    display: flex;
    justify-content: flex-start;
  }
</style>
