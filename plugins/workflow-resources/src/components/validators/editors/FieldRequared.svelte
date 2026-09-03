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
  import { createEventDispatcher } from 'svelte'
  import { reduceCalls } from '@hcengineering/presentation'
  import ui, { DropdownTextItem, Label, languageStore, ModernDropdownLabels } from '@hcengineering/ui'
  import { FieldRequiredProps, FieldRequiredValidatorConfig } from '@hcengineering/workflow'
  import { TaskType } from '@hcengineering/task'
  import { AnyAttribute, Ref } from '@hcengineering/core'
  import { getEmbeddedLabel } from '@hcengineering/platform'

  import plugin from '../../../plugin'
  import { DisplayAttribute, getDisplayAttributes } from '../../../utils'

  export let taskType: TaskType
  export let config: FieldRequiredValidatorConfig | undefined = undefined
  export let canSave = false

  const SKIP_FIELDS = ['createdBy', 'modifiedBy', 'createdOn', 'modifiedOn', 'status', 'title', 'reports']
  const dispatch = createEventDispatcher<{ update: FieldRequiredProps }>()

  const props: FieldRequiredProps | undefined = config?.props

  let items: DropdownTextItem[] = []
  let selected: Ref<AnyAttribute>[] = props?.fields?.map((it) => it.attribute) ?? []

  let displayAttributes: DisplayAttribute[] = []

  const updateItems = reduceCalls(async (lang: string): Promise<void> => {
    const res = await getDisplayAttributes(taskType.targetClass, lang, SKIP_FIELDS)

    const _items: DropdownTextItem[] = []
    const _displayAttributes: DisplayAttribute[] = []
    res.forEach((group, groupIdx) => {
      const regular = group.regular
      const collection = group.collection

      regular.forEach((attr, idx) => {
        _displayAttributes.push(attr)
        const isFirstInGroup = groupIdx > 0 && idx === 0
        _items.push({
          id: attr.id,
          label: attr.label,
          icon: attr.icon,
          iconProps: attr.iconProps,
          separatorBefore: isFirstInGroup,
          separatorLabel: isFirstInGroup ? getEmbeddedLabel(group.classLabel) : undefined
        })
      })

      collection.forEach((attr, idx) => {
        _displayAttributes.push(attr)
        const isFirstInGroup = groupIdx > 0 && regular.length === 0 && idx === 0
        const isFirstCollection = regular.length > 0 && idx === 0
        _items.push({
          id: attr.id,
          label: attr.label,
          icon: attr.icon,
          iconProps: attr.iconProps,
          separatorBefore: isFirstInGroup || isFirstCollection,
          separatorLabel: isFirstInGroup ? getEmbeddedLabel(group.classLabel) : undefined
        })
      })
    })

    displayAttributes = _displayAttributes
    items = _items
  })

  $: void updateItems($languageStore)
  $: canSave = selected.length > 0
  $: dispatch('update', {
    fields: displayAttributes
      .filter((it) => selected.includes(it.id))
      .map((it) => ({
        attribute: it.id,
        fieldKey: it.key,
        mixin: it.mixin
      }))
  })
</script>

<div class="field-required">
  <span class="field-required--label">
    <Label label={plugin.string.FieldRequiredValidator} />
  </span>
  <ModernDropdownLabels
    {items}
    bind:selected
    multiselect={true}
    wrap={true}
    autoSelect={false}
    placeholder={ui.string.NotSelected}
    justify="left"
    width="100%"
  />
</div>

<style lang="scss">
  .field-required {
    display: flex;
    gap: 1rem;

    &--label {
      display: flex;
      align-items: center;
      white-space: nowrap;
      height: 2.375rem;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--global-secondary-TextColor);
    }
  }
</style>
