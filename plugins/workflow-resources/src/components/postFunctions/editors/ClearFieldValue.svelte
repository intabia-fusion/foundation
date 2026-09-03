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
  import core, { AnyAttribute, notEmpty, Ref } from '@hcengineering/core'
  import { reduceCalls } from '@hcengineering/presentation'
  import { TaskType } from '@hcengineering/task'
  import ui, { DropdownTextItem, Label, languageStore, ModernDropdownLabels } from '@hcengineering/ui'
  import { ClearFieldValueProps, Field, ClearFieldValuePostFnConfig } from '@hcengineering/workflow'
  import { getEmbeddedLabel } from '@hcengineering/platform'

  import plugin from '../../../plugin'
  import { DisplayAttribute, getDisplayAttributes } from '../../../utils'

  export let taskType: TaskType
  export let config: ClearFieldValuePostFnConfig | undefined = undefined
  export let canSave = false

  const dispatch = createEventDispatcher<{ update: ClearFieldValueProps }>()

  const EXCLUDED_FIELDS = [
    '_class',
    '_id',
    'attachedTo',
    'createdBy',
    'createdOn',
    'identifier',
    'modifiedBy',
    'modifiedOn',
    'number',
    'space',
    'status',
    'title',
    'reportedTime',
    'attachments',
    'comments',
    'reports',
    'subIssues'
  ]
  const EXCLUDED_TYPES = [
    core.class.TypeMarkup,
    core.class.TypeCollaborativeDoc,
    core.class.TypeAny,
    core.class.TypeBlob,
    core.class.TypeIdentifier,
    core.class.TypeRank,
    core.class.TypeRecord,
    core.class.TypeRelation
  ]

  const props: ClearFieldValueProps | undefined = config?.props as ClearFieldValueProps

  let displayAttributes: DisplayAttribute[] = []
  let items: DropdownTextItem[] = []
  let selected: Ref<AnyAttribute>[] = props?.fields?.map((f) => f.attribute) ?? []

  const updateItems = reduceCalls(async (lang: string): Promise<void> => {
    const res = await getDisplayAttributes(taskType.targetClass, lang, EXCLUDED_FIELDS, EXCLUDED_TYPES)

    const _items: DropdownTextItem[] = []
    const _displayAttributes: DisplayAttribute[] = []

    res.forEach((group, groupIdx) => {
      group.regular.forEach((attr, idx) => {
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

      group.collection.forEach((attr, idx) => {
        _displayAttributes.push(attr)
        const isFirstInGroup = groupIdx > 0 && group.regular.length === 0 && idx === 0
        const isFirstCollection = group.regular.length > 0 && idx === 0
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
    fields: selected
      .map((id) => {
        const match = displayAttributes.find((attr) => attr.id === id)
        if (match == null) return undefined
        const item: Field = {
          attribute: match.id,
          fieldKey: match.key,
          mixin: match.mixin
        }
        return item
      })
      .filter(notEmpty)
  })
</script>

<div class="clear-field-value">
  <span class="clear-field-value__label">
    <Label label={plugin.string.ClearFields} />
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
  .clear-field-value {
    display: flex;
    gap: 1rem;

    &__label {
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
