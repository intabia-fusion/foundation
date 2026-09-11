<!--
// Copyright © 2024 Hardcore Engineering Inc.
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
  import { IconSize } from '@hcengineering/ui'
  import { IdMap, Ref } from '@hcengineering/core'

  import { getPersonByPersonRefStore } from '../index'

  import Avatar from './Avatar.svelte'

  export let value: Person | undefined
  export let _id: Ref<Person> | undefined
  export let size: IconSize = 'small'
  export let showStatus: boolean = false

  let _person: Person | undefined = undefined

  $: personByRefStore = getPersonByPersonRefStore(_id ? [_id] : [])

  $: loadPerson(value, _id, $personByRefStore)
  function loadPerson (value: Person | undefined, personId: Ref<Person> | undefined, personById: IdMap<Person>): void {
    if (value != null) {
      _person = value
    } else if (personId != null) {
      _person = personById.get(personId)
    } else {
      _person = undefined
    }
  }
</script>

{#if _person}
  <Avatar person={_person} {size} name={_person.name} {showStatus} />
{/if}
