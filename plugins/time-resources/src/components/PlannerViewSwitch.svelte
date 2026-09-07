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
  import { ButtonIcon, DropdownLabelsIntl } from '@hcengineering/ui'
  import { PlannerCalendarMode } from '..'
  import time from '../plugin'

  export let calMode: PlannerCalendarMode
  export let showToDos: boolean

  const items = [
    { id: 'personal', label: time.string.Schedule },
    { id: 'team-calendar', label: time.string.Calendar },
    { id: 'team', label: time.string.Team }
  ]

  $: localStorage.setItem('planner_calendar_mode', calMode)
</script>

<ButtonIcon
  icon={time.icon.All}
  size={'small'}
  kind={'tertiary'}
  pressed={showToDos}
  tooltip={{ label: time.string.ToDos }}
  on:click={() => {
    showToDos = !showToDos
    localStorage.setItem(`planner_show_todos_${calMode}`, showToDos ? 'true' : 'false')
  }}
/>
<DropdownLabelsIntl {items} bind:selected={calMode} kind={'regular'} size={'medium'} dataId={'planner-mode'} />
