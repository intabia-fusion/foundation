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
  import { AnyAttribute, Doc, Ref } from '@hcengineering/core'
  import { getEmbeddedLabel } from '@hcengineering/platform'
  import { getClient, MessageBox } from '@hcengineering/presentation'
  import {
    ButtonIcon,
    DropdownIntlItem,
    EditBox,
    Icon,
    IconDelete,
    IconMoreV2,
    Label,
    languageStore,
    ModernCheckbox,
    ModernPopup,
    showPopup,
    tooltip
  } from '@hcengineering/ui'
  import { SortableDocListStatic } from '@hcengineering/view-resources'
  import { addScreenField, removeScreenField, removeScreenTab, ScreenField, ScreenTab } from '@hcengineering/workflow'

  import plugin from '../../plugin'
  import { DisplayAttribute, DisplayAttributeGroup } from '../../utils'

  export let tab: ScreenTab
  export let readonly = false
  export let canDelete = true
  export let fields: ScreenField[] = []
  export let displayAttributes: DisplayAttribute[] = []
  export let availableAttributes: DisplayAttribute[] = []
  export let availableAttributeGroups: DisplayAttributeGroup[] = []

  const client = getClient()

  let localName = ''
  let loadedTabId: Ref<ScreenTab> | undefined = undefined

  $: if (tab != null && tab._id !== loadedTabId) {
    loadedTabId = tab._id
    localName = tab.name ?? ''
  }

  function toScreenField (doc: Doc): ScreenField {
    return doc as ScreenField
  }

  async function saveTabName (): Promise<void> {
    if (tab != null) {
      const trimmed = localName.trim()
      if (trimmed.length > 0 && trimmed !== tab.name) {
        await client.update(tab, { name: trimmed })
      }
    }
  }

  onDestroy(() => {
    void saveTabName()
  })

  async function removeTab (): Promise<void> {
    if (fields.length > 0) {
      showPopup(MessageBox, {
        label: plugin.string.DeleteScreenTab,
        message: plugin.string.DeleteScreenTabConfirm,
        params: { name: tab.name },
        dangerous: true,
        action: async () => {
          await removeScreenTab(client, tab.attachedTo, tab._id)
        }
      })
    } else {
      await removeScreenTab(client, tab.attachedTo, tab._id)
    }
  }

  async function addField (attribute: Ref<AnyAttribute>): Promise<void> {
    if (fields.some((f) => f.attribute === attribute)) return // prevent duplicates
    const attr = availableAttributes.find((it) => it.id === attribute)
    if (attr == null) return
    await addScreenField(client, tab._id, {
      attribute,
      fieldKey: attr.key,
      mixin: attr.mixin,
      required: true
    })
  }

  async function removeField (field: ScreenField): Promise<void> {
    await removeScreenField(client, field.attachedTo, field._id)
  }

  async function toggleRequired (field: ScreenField): Promise<void> {
    await client.update(field, { required: !field.required })
  }

  let labelEl: HTMLElement | undefined

  function openAddFieldPopup (target: HTMLElement | undefined): void {
    if (availableAttributes.length === 0 || target == null) return

    const popupItems: DropdownIntlItem[] = []

    if (availableAttributeGroups.length > 0) {
      availableAttributeGroups.forEach((group, groupIdx) => {
        const regular = group.regular
        const collection = group.collection

        regular.forEach((f, idx) => {
          const isFirstInGroup = groupIdx > 0 && idx === 0
          popupItems.push({
            id: f.id,
            label: getEmbeddedLabel(f.label),
            icon: f.icon,
            iconProps: f.iconProps,
            separatorBefore: isFirstInGroup,
            separatorLabel: isFirstInGroup ? getEmbeddedLabel(group.classLabel) : undefined
          })
        })

        collection.forEach((f, idx) => {
          const isFirstInGroup = groupIdx > 0 && regular.length === 0 && idx === 0
          const isFirstCollection = regular.length > 0 && idx === 0
          popupItems.push({
            id: f.id,
            label: getEmbeddedLabel(f.label),
            icon: f.icon,
            iconProps: f.iconProps,
            separatorBefore: isFirstInGroup || isFirstCollection,
            separatorLabel: isFirstInGroup ? getEmbeddedLabel(group.classLabel) : undefined
          })
        })
      })
    } else {
      const regular = availableAttributes
        .filter((f) => !f.collection)
        .sort((a, b) => a.label.localeCompare(b.label, $languageStore))
      const collection = availableAttributes
        .filter((f) => f.collection)
        .sort((a, b) => a.label.localeCompare(b.label, $languageStore))

      popupItems.push(
        ...regular.map((f) => ({
          id: f.id,
          label: getEmbeddedLabel(f.label),
          icon: f.icon,
          iconProps: f.iconProps
        })),
        ...collection.map((f, idx) => ({
          id: f.id,
          label: getEmbeddedLabel(f.label),
          icon: f.icon,
          iconProps: f.iconProps,
          separatorBefore: idx === 0 && regular.length > 0
        }))
      )
    }

    showPopup(ModernPopup, { items: popupItems }, target, (result) => {
      if (result != null) {
        void addField(result)
      }
    })
  }
</script>

<div class="hulyTableAttr-container editor">
  <div class="hulyTableAttr-header font-medium-12">
    <Icon icon={plugin.icon.ScreenTab} size="small" />
    <div class="flex-grow min-w-0 px-2">
      <EditBox
        bind:value={localName}
        kind="ghost"
        placeholder={plugin.string.TabName}
        disabled={readonly}
        on:blur={saveTabName}
      />
    </div>
    <div class="buttons-group">
      {#if !readonly && canDelete}
        <ButtonIcon
          icon={IconDelete}
          kind="tertiary"
          size="small"
          on:click={() => {
            void removeTab()
          }}
        />
      {/if}
    </div>
  </div>

  {#if fields.length > 0}
    <div class="hulyTableAttr-content screen field-list-wrapper">
      <SortableDocListStatic _class={plugin.class.ScreenField} items={fields}>
        <svelte:fragment slot="object" let:value>
          {@const field = toScreenField(value)}
          {@const displayAttr = displayAttributes.find((f) => f.id === field.attribute)}
          <div class="hulyTableAttr-content__row w-full flex-between flex-row-center">
            <div class="flex-row-center flex-gap-2 min-w-0 flex-grow">
              <div class="hulyTableAttr-content__row-dragMenu">
                <IconMoreV2 size="small" />
              </div>
              {#if displayAttr?.icon}
                <div class="hulyTableAttr-content__row-icon">
                  <Icon icon={displayAttr.icon} size="small" />
                </div>
              {/if}
              <div class="hulyTableAttr-content__row-label font-medium-14 text-primary truncate">
                {#if displayAttr?.label}
                  {displayAttr.label}
                {:else}
                  {field.fieldKey}
                {/if}
              </div>
            </div>

            <div class="flex-row-center flex-gap-2 flex-shrink-0">
              <ModernCheckbox
                labelIntl={plugin.string.Required}
                checked={field.required}
                disabled={readonly}
                on:change={() => {
                  void toggleRequired(field)
                }}
              />

              {#if !readonly}
                <div class="delete-btn">
                  <ButtonIcon
                    icon={IconDelete}
                    kind="tertiary"
                    size="small"
                    on:click={() => {
                      void removeField(field)
                    }}
                  />
                </div>
              {/if}
            </div>
          </div>
        </svelte:fragment>
      </SortableDocListStatic>
    </div>
  {/if}

  {#if !readonly}
    <button
      type="button"
      class="add-field-btn font-normal-14 text-secondary"
      disabled={availableAttributes.length === 0}
      use:tooltip={availableAttributes.length === 0 ? { label: plugin.string.NoAvailableFields } : undefined}
      on:click={() => {
        openAddFieldPopup(labelEl)
      }}
    >
      <span bind:this={labelEl} class="font-normal-14 text-secondary flex-center">
        <Label label={plugin.string.AddField} />
      </span>
    </button>
  {/if}
</div>

<style lang="scss">
  .hulyTableAttr-container.editor {
    overflow: hidden;
  }

  .field-list-wrapper {
    width: 100%;
    padding: var(--spacing-1);

    :global(.sortable-list),
    :global(.item),
    :global(.hulyTableAttr-content__row) {
      width: 100%;
    }

    :global(.flex-gap-1) {
      gap: 0 !important;
    }

    .hulyTableAttr-content__row {
      width: 100%;
      gap: var(--spacing-1);
      padding: var(--spacing-1) var(--spacing-2) var(--spacing-1) var(--spacing-1);
      border-radius: var(--small-BorderRadius) !important;
      border-bottom: none;
      min-height: var(--global-large-Size);
      align-items: center;

      :global(.checkbox-container) {
        align-items: center;
      }

      :global(.hulyTableAttr-content__row-dragMenu) {
        color: var(--global-secondary-TextColor);
        transition: color 0.15s ease;
      }

      &:hover :global(.hulyTableAttr-content__row-dragMenu) {
        color: var(--global-primary-TextColor);
      }

      .delete-btn {
        display: flex;
        align-items: center;
        opacity: 0;
        transition: opacity 0.15s ease-in-out;
      }

      &:hover {
        background-color: var(--theme-button-hovered);
        .delete-btn {
          opacity: 1;
        }
      }
    }
  }

  .add-field-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    padding: var(--spacing-2);
    background: transparent;
    border: none;
    border-top: 1px solid var(--theme-divider-color);
    border-radius: 0 0 var(--large-BorderRadius) var(--large-BorderRadius);
    cursor: pointer;
    transition: background-color 0.15s ease-in-out;

    &:hover:not(:disabled) {
      background-color: var(--theme-table-header-color);
    }

    &:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }
  }
</style>
