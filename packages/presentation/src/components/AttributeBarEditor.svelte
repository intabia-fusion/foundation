<!--
// Copyright © 2020, 2021 Anticrm Platform Contributors.
// Copyright © 2021 Hardcore Engineering Inc.
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
  import core, {
    reduceCalls,
    type Class,
    type Doc,
    type Ref,
    getAttributeUpdate,
    TxProcessor
  } from '@hcengineering/core'
  import type { AnySvelteComponent, ButtonKind, ButtonSize } from '@hcengineering/ui'
  import { Icon, Label, tooltip } from '@hcengineering/ui'
  import { isEmptyMarkup } from '@hcengineering/text'
  import view from '@hcengineering/view'
  import { createEventDispatcher } from 'svelte'

  import { getAttribute, KeyedAttribute, updateAttribute } from '../attributes'
  import { getAttributeEditor, getClient } from '../utils'

  export let key: KeyedAttribute | string
  export let object: Doc | Record<string, any>
  export let _class: Ref<Class<Doc>>
  export let maxWidth: string | undefined = undefined
  export let focus: boolean = false
  export let showHeader: boolean = true
  export let withIcon: boolean = false
  export let readonly = false
  export let draft = false
  export let identifier: string | undefined = undefined
  export let props: Record<string, any> = {}

  export let kind: ButtonKind = 'link'
  export let size: ButtonSize = 'large'
  export let width: string | undefined = '100%'
  export let justify: 'left' | 'center' = 'left'

  const client = getClient()
  const hierarchy = client.getHierarchy()
  const dispatch = createEventDispatcher()

  interface Resolved {
    editor: AnySvelteComponent
    attribute: ReturnType<typeof hierarchy.getAttribute>
    attributeKey: string
  }
  let resolved: Resolved | undefined

  function onChange (value: any): void {
    if (resolved === undefined) return
    const doc = object as Doc
    const { attribute, attributeKey } = resolved

    dispatch('update', { key, value })

    if (draft) {
      const update = getAttributeUpdate(client, doc, doc._class, { key: attributeKey, attr: attribute }, value)
      TxProcessor.applyUpdate(doc, update)
    } else {
      void updateAttribute(client, doc, doc._class, { key: attributeKey, attr: attribute }, value, false, {
        objectId: identifier ?? doc._id
      })
    }
  }

  function handleEditorUpdate (evt: CustomEvent<{ value: any }>): void {
    const val = evt?.detail?.value
    onChange(val)
  }

  function handleEditorChange (evt: CustomEvent): void {
    const val = evt?.detail
    onChange(val)
  }

  const resolveEditor = reduceCalls(async (_class: Ref<Class<Doc>>, key: KeyedAttribute | string): Promise<void> => {
    const attribute = typeof key === 'string' ? hierarchy.getAttribute(_class, key) : key.attr
    const attributeKey = typeof key === 'string' ? key : key.key
    const editor = await getAttributeEditor(client, _class, key)
    if (editor === undefined) {
      resolved = undefined
      return
    }
    resolved = { editor, attribute, attributeKey }
  })

  $: void resolveEditor(_class, key)

  $: isReadonly = readonly || (resolved?.attribute.readonly ?? false)
  $: icon = resolved?.attribute?.icon ?? resolved?.attribute?.type?.icon
  $: value =
    resolved !== undefined
      ? getAttribute(client, object, { key: resolved.attributeKey, attr: resolved.attribute })
      : undefined
  $: isRequiredAndEmpty =
    (resolved?.attribute?.required ?? false) &&
    (resolved?.attribute?.type?._class === core.class.TypeMarkup
      ? isEmptyMarkup(value)
      : value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0))
</script>

{#if resolved}
  {@const { editor, attribute, attributeKey } = resolved}
  {#if showHeader}
    <span
      class="labelOnPanel"
      class:required-empty={isRequiredAndEmpty}
      use:tooltip={{
        component: Label,
        props: { label: attribute.automationOnly ? view.string.AutomationOnly : attribute.label }
      }}
    >
      {#if attribute.automationOnly || (icon && withIcon)}
        <div class="flex flex-gap-1 items-center">
          <Icon icon={icon ?? view.icon.Setting} size="small" />
          <Label label={attribute.label} />
          {#if attribute.required}
            <span class="required-asterisk">*</span>
          {/if}
        </div>
      {:else}
        <Label label={attribute.label} />
        {#if attribute.required}
          <span class="required-asterisk">*</span>
        {/if}
      {/if}
    </span>
    <div class="flex flex-grow min-w-0">
      <svelte:component
        this={editor}
        readonly={isReadonly}
        editable={!isReadonly}
        disabled={isReadonly}
        label={attribute?.label}
        placeholder={attribute?.label}
        {kind}
        {size}
        {width}
        {justify}
        type={attribute?.type}
        {maxWidth}
        {attribute}
        {attributeKey}
        key={typeof key === 'string' ? { key: attributeKey, attr: attribute } : key}
        {value}
        space={object.space}
        {onChange}
        {focus}
        {object}
        {draft}
        {...props}
        on:update={handleEditorUpdate}
        on:change={handleEditorChange}
      />
    </div>
  {:else}
    <div style="grid-column: 1/3;" class:required-empty={isRequiredAndEmpty}>
      <svelte:component
        this={editor}
        type={attribute?.type}
        {maxWidth}
        {attributeKey}
        key={typeof key === 'string' ? { key: attributeKey, attr: attribute } : key}
        {value}
        readonly={isReadonly}
        disabled={isReadonly}
        space={object.space}
        {onChange}
        {attribute}
        {kind}
        {focus}
        {object}
        {size}
        {draft}
        {...props}
        on:update={handleEditorUpdate}
        on:change={handleEditorChange}
      />
    </div>
  {/if}
{/if}

<style lang="scss">
  .labelOnPanel.required-empty {
    color: var(--theme-error-color, #eb5757) !important;
  }
  .required-asterisk {
    color: var(--theme-error-color, #eb5757);
    margin-left: 2px;
  }
</style>
