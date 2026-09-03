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
  import { Ref } from '@hcengineering/core'
  import { getEmbeddedLabel } from '@hcengineering/platform'
  import { TaskType } from '@hcengineering/task'
  import { ButtonMenu, Label } from '@hcengineering/ui'
  import view from '@hcengineering/view'
  import { IconWithEmoji } from '@hcengineering/presentation'

  export let selected: Ref<TaskType> | undefined
  export let types: TaskType[]
  export let readonly = false
  export let buttonKind: 'primary' | 'secondary' | 'tertiary' | 'negative' = 'secondary'
  export let buttonSize: 'large' | 'medium' | 'small' = 'small'
  export let loading = false

  const dispatch = createEventDispatcher<{ change: Ref<TaskType> }>()
  $: items = types.map((it) => ({
    id: it._id,
    icon: it.icon === view.ids.IconWithEmoji ? IconWithEmoji : it.icon,
    iconProps: { icon: it.color },
    label: getEmbeddedLabel(it.name)
  }))
  $: _selected = items.find((it) => it.id === selected)
</script>

<ButtonMenu
  {selected}
  {items}
  icon={_selected?.icon}
  iconProps={_selected?.iconProps}
  label={_selected?.label}
  kind={buttonKind}
  size={buttonSize}
  {loading}
  disabled={readonly}
  on:selected={(evt) => {
    if (evt.detail != null) {
      selected = evt.detail
      dispatch('change', evt.detail)
    }
  }}
/>
