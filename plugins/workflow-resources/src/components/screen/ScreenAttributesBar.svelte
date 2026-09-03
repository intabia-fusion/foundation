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
  import { createEventDispatcher } from 'svelte'
  import core, { AnyAttribute, Class, Doc, DocumentUpdate, Mixin, Ref } from '@hcengineering/core'
  import {
    AttributeBarEditor,
    getClient,
    isCollabAttr,
    isMarkupAttr,
    KeyedAttribute
  } from '@hcengineering/presentation'
  import { Icon, Label } from '@hcengineering/ui'
  import view from '@hcengineering/view'

  import { ChatMessageInputLite } from '@hcengineering/chunter-resources'
  import plugin from '../../plugin'
  import { getAttributeIcon } from '../../utils'

  export let object: Doc | Record<string, any>
  export let _class: Ref<Class<Doc>>
  export let keys: [undefined | Ref<Mixin<Doc>>, string][]
  export let readonly = false
  export let updates: DocumentUpdate<Doc> = {}

  const dispatch = createEventDispatcher<{
    change: DocumentUpdate<Doc>
    update: { key: string | KeyedAttribute, value: any }
  }>()

  const client = getClient()
  const hierarchy = client.getHierarchy()

  function isMarkupOrCollab (key: string, attr?: AnyAttribute): boolean {
    if (attr == null) return false
    const item = { key, attr }
    return isMarkupAttr(hierarchy, item) || isCollabAttr(hierarchy, item)
  }

  function isColumnEditor (key: string): boolean {
    const attr = hierarchy.findAttribute(_class, key)
    if (attr == null) return false
    if (isMarkupOrCollab(key, attr)) return true
    return attr.type?._class === core.class.Collection || hierarchy.isDerived(attr.type?._class, core.class.Collection)
  }

  function handleUpdate (event: CustomEvent<{ key: string | KeyedAttribute, value: any }>): void {
    const { key, value } = event.detail
    const attributeKey = typeof key === 'string' ? key : key.key
    const mixinId = keys.find(([, k]) => k === attributeKey)?.[0]

    ;(updates as Record<string, any>)[attributeKey] = value

    if (mixinId != null) {
      const currentMixinData = (object as Record<string, any>)[mixinId] ?? {}
      ;(object as Record<string, any>)[mixinId] = {
        ...currentMixinData,
        [attributeKey]: value
      }
    } else {
      ;(object as Record<string, any>)[attributeKey] = value
    }
    object = hierarchy.clone(object as Doc)
    updates = { ...updates }
    dispatch('change', updates)
    dispatch('update', event.detail)
  }
</script>

<div class="attributes-bar">
  {#each keys as [mixin, key] (key)}
    {@const attr = hierarchy.findAttribute(mixin ?? _class, key)}
    {@const icon = attr != null ? getAttributeIcon(hierarchy, attr) : undefined}

    {#if isColumnEditor(key)}
      <div class="attributes-bar--block">
        <div class="attributes-bar--label-header">
          <Icon icon={icon?.icon ?? view.icon.Setting} iconProps={icon?.iconProps} size="small" />
          <span class="label">
            <Label label={attr?.label ?? plugin.string.Attribute} />
          </span>
        </div>
        {#if key === 'comments'}
          <ChatMessageInputLite
            clearOnSubmit={false}
            on:update={(e) => {
              handleUpdate(new CustomEvent('update', { detail: { key, value: e.detail } }))
            }}
          />
        {:else if isMarkupOrCollab(key, attr)}
          <div class="attributes-bar--editor-large">
            <AttributeBarEditor
              {key}
              _class={mixin ?? _class}
              {object}
              showHeader={false}
              {readonly}
              draft
              props={{ showNavigate: false, minHeight: '10rem', height: '100%' }}
              on:update={handleUpdate}
            />
          </div>
        {:else}
          <div class="w-full">
            <AttributeBarEditor
              {key}
              _class={mixin ?? _class}
              {object}
              showHeader={false}
              {readonly}
              draft
              props={{ showNavigate: false, placeholder: attr?.label ?? plugin.string.Attribute }}
              on:update={handleUpdate}
            />
          </div>
        {/if}
      </div>
    {:else}
      <div class="attributes-bar--line">
        <div class="attributes-bar--label-header inline">
          <Icon icon={icon?.icon ?? view.icon.Setting} iconProps={icon?.iconProps} size="small" />
          <span class="label">
            <Label label={attr?.label ?? plugin.string.Attribute} />
          </span>
        </div>
        <AttributeBarEditor
          {key}
          _class={mixin ?? _class}
          {object}
          showHeader={false}
          {readonly}
          draft
          props={{ showNavigate: false, placeholder: attr?.label ?? plugin.string.Attribute }}
          on:update={handleUpdate}
        />
      </div>
    {/if}
  {/each}
</div>

<style lang="scss">
  .attributes-bar {
    display: flex;
    flex-direction: column;
    height: 100%;
    flex-shrink: 0;
    padding: 0 1rem;

    &--block {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      width: 100%;
      padding-bottom: var(--spacing-2);
      border-bottom: 1px solid var(--global-subtle-ui-BorderColor);

      &:last-child {
        border-bottom: none;
      }
    }

    &--line {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      flex-shrink: 0;
      padding: var(--spacing-1_5) 0;
      width: 100%;
      min-width: 0;
      min-height: var(--global-max-Size);
      border-bottom: 1px solid var(--global-subtle-ui-BorderColor);

      &:last-child {
        border-bottom: none;
      }
    }

    &--label-header {
      display: flex;
      align-items: center;
      min-width: 8rem;
      font-size: 0.875rem;
      gap: 0.5rem;
      color: var(--global-secondary-TextColor);
      padding-top: 1rem;
      padding-bottom: 0.5rem;

      &.inline {
        padding-top: 0;
        padding-bottom: 0;
        height: 1.75rem;
      }

      .label {
        text-transform: uppercase;
        font-weight: 500;
        font-size: 0.75rem;
        line-height: 1rem;
        color: var(--global-secondary-TextColor);
      }
    }

    &--editor-large {
      min-height: 10rem;
      border: 1px solid var(--global-subtle-ui-BorderColor);
      border-radius: var(--spacing-1);
      padding: 0.5rem;
      background: var(--theme-comp-header-color, var(--global-subtle-ui-BackgroundColor));
      margin: 0;
      width: 100%;
    }
  }
</style>
