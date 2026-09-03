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
  import { getMetadata, type IntlString } from '@hcengineering/platform'
  import ui, { type DropdownIntlItem, DropdownLabelsIntl } from '@hcengineering/ui'
  import { createEventDispatcher } from 'svelte'

  import aiBot from '../plugin'

  export let value: string = ''
  export let disabled: boolean = false

  const dispatch = createEventDispatcher()

  // Reuse the platform's configured UI languages + their localized names (ui.string.*).
  const allLangs: Array<{ id: string, label: IntlString }> = [
    { id: 'ru', label: ui.string.Russian },
    { id: 'en', label: ui.string.English },
    { id: 'pt', label: ui.string.Portuguese },
    { id: 'pt-br', label: ui.string.PortugueseBrazil },
    { id: 'es', label: ui.string.Spanish },
    { id: 'zh', label: ui.string.Chinese },
    { id: 'fr', label: ui.string.French },
    { id: 'it', label: ui.string.Italian },
    { id: 'cs', label: ui.string.Czech },
    { id: 'de', label: ui.string.German },
    { id: 'ja', label: ui.string.Japanese },
    { id: 'tr', label: ui.string.Turkish }
  ]

  const enabled = new Set(getMetadata(ui.metadata.Languages) ?? [])
  $: langs = allLangs.filter((l) => enabled.size === 0 || enabled.has(l.id))

  // DropdownLabelsIntl ignores empty-string ids, so the "Auto" option uses a
  // non-empty id and is mapped to/from the persisted empty value at the boundary.
  const AUTO = 'auto'

  let selected: string | number = value === '' ? AUTO : value
  $: selected = value === '' ? AUTO : value

  let items: DropdownIntlItem[] = []
  $: items = [{ id: AUTO, label: aiBot.string.LanguageAuto }, ...langs.map((l) => ({ id: l.id, label: l.label }))]

  function onSelected (id: string | number): void {
    if (disabled) return
    dispatch('change', id === AUTO ? '' : String(id))
  }
</script>

<DropdownLabelsIntl
  {items}
  {disabled}
  kind="regular"
  size="large"
  bind:selected
  label={aiBot.string.Language}
  on:selected={(e) => {
    onSelected(e.detail)
  }}
/>
