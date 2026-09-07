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
  import { SelectPopup, type SelectPopupValueType } from '@hcengineering/ui'
  import { createEventDispatcher } from 'svelte'
  import { webhookEventLabels, webhookEventTypes, type WebhookEventType } from '../webhookEvents'

  export let selected: WebhookEventType[] = []

  const dispatch = createEventDispatcher()

  // Toggle-and-stay-open list, same shape as ApiKeyOperationsPopup.
  $: items = webhookEventTypes.map<SelectPopupValueType>((type) => ({
    id: type,
    label: webhookEventLabels[type],
    isSelected: selected.includes(type)
  }))

  function toggle (id: SelectPopupValueType['id']): void {
    if (id == null) return
    const value = id as WebhookEventType
    selected = selected.includes(value) ? selected.filter((t) => t !== value) : [...selected, value]
    dispatch('update', selected)
  }
</script>

<SelectPopup value={items} onSelect={toggle} on:close={() => dispatch('close', selected)} />
