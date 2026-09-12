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
  import { apiKeyOperations, type ApiKeyOperation } from '@hcengineering/account-client'
  import { SelectPopup, type SelectPopupValueType } from '@hcengineering/ui'
  import { createEventDispatcher } from 'svelte'

  export let selected: ApiKeyOperation[] = []

  const dispatch = createEventDispatcher()

  // Toggle-and-stay-open list, like LanguagesPopup/LanguagesArrayEditor - `items` re-derives from `selected`
  // on each toggle, so the checkmark updates without closing the popup.
  $: items = apiKeyOperations.map<SelectPopupValueType>((op) => ({
    id: op,
    text: op,
    isSelected: selected.includes(op)
  }))

  function toggle (id: SelectPopupValueType['id']): void {
    if (id == null) return
    const value = id as ApiKeyOperation
    selected = selected.includes(value) ? selected.filter((o) => o !== value) : [...selected, value]
    dispatch('update', selected)
  }
</script>

<SelectPopup value={items} onSelect={toggle} on:close={() => dispatch('close', selected)} />
