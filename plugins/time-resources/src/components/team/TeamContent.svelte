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
  import { Person } from '@hcengineering/contact'
  import { DocumentQuery, Ref } from '@hcengineering/core'
  import { Project } from '@hcengineering/task'
  import { ToDo } from '@hcengineering/time'
  import { Header } from '@hcengineering/ui'
  import { FilterBar, FilterButton } from '@hcengineering/view-resources'
  import { PlannerCalendarMode } from '../..'
  import time from '../../plugin'
  import PlannerViewSwitch from '../PlannerViewSwitch.svelte'
  import Agenda from './agenda/Agenda.svelte'
  import Calendar from './calendar/Calendar.svelte'

  export let calMode: PlannerCalendarMode
  export let showToDos: boolean
  export let currentDate: Date

  // time.class.ToDo declares a strict ClassFilters mixin with exactly two filters:
  // attachedSpace (the project a todo belongs to) and user (its owner).
  let resultQuery: DocumentQuery<ToDo> = {}

  function toRefs (value: any): string[] {
    if (value == null) return []
    if (typeof value === 'object' && Array.isArray(value.$in)) return value.$in
    return [value]
  }

  $: spaces = toRefs(resultQuery.attachedSpace) as Array<Ref<Project>>
  $: filterPersons = toRefs(resultQuery.user) as Array<Ref<Person>>
</script>

<div class="hulyComponent">
  <Header adaptive={'disabled'}>
    <PlannerViewSwitch bind:calMode bind:showToDos />
    <svelte:fragment slot="search">
      <FilterButton _class={time.class.ToDo} />
    </svelte:fragment>
  </Header>
  <FilterBar _class={time.class.ToDo} space={undefined} query={{}} on:change={(e) => (resultQuery = e.detail)} />
  {#if calMode === 'team-calendar'}
    <Calendar {spaces} {filterPersons} bind:currentDate />
  {:else}
    <Agenda {spaces} {filterPersons} bind:currentDate />
  {/if}
</div>
