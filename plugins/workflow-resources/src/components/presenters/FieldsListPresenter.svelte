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
  import { AnyAttribute, Ref } from '@hcengineering/core'
  import { Asset, translate } from '@hcengineering/platform'
  import { getClient, reduceCalls } from '@hcengineering/presentation'
  import { TaskType } from '@hcengineering/task'
  import { AnySvelteComponent, Icon, languageStore } from '@hcengineering/ui'

  import { getAllClassAttributes, getAttributeIcon } from '../../utils'

  export let fieldIds: Ref<AnyAttribute>[] | string[] = []
  export let taskType: TaskType

  const client = getClient()

  interface FieldItem {
    id: string
    label: string
    icon?: Asset | AnySvelteComponent
    iconProps?: Record<string, any>
  }

  let fieldItems: FieldItem[] = []

  const updateFields = reduceCalls(async (ids: string[], lang: string): Promise<void> => {
    if (taskType?.targetClass == null || ids.length === 0) {
      fieldItems = []
      return
    }
    const hierarchy = client.getHierarchy()
    const allAttrs = getAllClassAttributes(hierarchy, taskType.targetClass)

    const res: FieldItem[] = []
    for (const id of new Set(ids)) {
      const attr = allAttrs.find((a) => a._id === id || a.name === id)
      if (attr != null) {
        const label = await translate(attr.label, {}, lang)
        const iconInfo = getAttributeIcon(hierarchy, attr)
        res.push({
          id,
          label,
          icon: iconInfo.icon,
          iconProps: iconInfo.iconProps
        })
      } else {
        res.push({ id, label: id })
      }
    }
    fieldItems = res
  })

  $: void updateFields(fieldIds, $languageStore)
</script>

<div class="fields-list-presenter">
  {#each fieldItems as item (item.id)}
    <div class="fields-list-presenter--badge">
      {#if item.icon}
        <Icon icon={item.icon} iconProps={item.iconProps} size="x-small" />
      {/if}
      <span>{item.label}</span>
    </div>
  {/each}
</div>

<style lang="scss">
  .fields-list-presenter {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    align-items: center;

    &--badge {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      padding: 0.2rem 0.5rem;
      border-radius: 0.375rem;
      font-size: 0.75rem;
      font-weight: 500;
      background-color: var(--global-subtle-ui-BorderColor);
      color: var(--global-primary-TextColor);

      :global(svg) {
        flex-shrink: 0;
        opacity: 0.85;
      }
    }
  }
</style>
