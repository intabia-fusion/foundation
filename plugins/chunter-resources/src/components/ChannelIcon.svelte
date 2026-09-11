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
  import {
    Button,
    ButtonSize,
    eventToHTMLElement,
    Icon,
    type IconComponent,
    IconSize,
    showPopup
  } from '@hcengineering/ui'
  import chunter, { Channel } from '@hcengineering/chunter'
  import { IconWithEmoji } from '@hcengineering/presentation'
  import view from '@hcengineering/view'
  import { IconPicker } from '@hcengineering/view-resources'
  import { Asset } from '@hcengineering/platform'

  import { toggleChannelIcon } from '../utils'

  export let value: Channel | undefined
  export let asset: Asset | undefined = undefined
  export let emoji: number | number[] | undefined = undefined

  export let size: IconSize = 'small'
  export let buttonSize: ButtonSize = 'small'
  export let fill: string | undefined = 'currentColor'
  export let editable: boolean = false

  $: _editable = editable && value != null

  async function chooseIcon (ev: MouseEvent): Promise<void> {
    if (value === undefined) return
    const { icon, emoji } = value
    const update = async (result: any): Promise<void> => {
      if (result !== undefined && result !== null && value !== undefined) {
        await toggleChannelIcon(value, result.icon, result.color)
      }
    }
    showPopup(IconPicker, { icon, color: emoji }, eventToHTMLElement(ev), update, update)
  }

  function getIconInfo (
    doc: Channel | undefined,
    _asset?: Asset,
    _emoji?: number | number[]
  ): { icon: IconComponent, props: Record<string, any> } {
    const fallback = doc?.private === true ? chunter.icon.Lock : chunter.icon.Hashtag
    const emoji = doc?.emoji ?? _emoji
    const asset = doc == null ? _asset : doc.icon

    return emoji != null ? { icon: IconWithEmoji, props: { icon: emoji } } : { icon: asset ?? fallback, props: {} }
  }

  $: iconData = getIconInfo(value, asset, emoji)
</script>

{#if _editable}
  <Button
    size={buttonSize}
    kind={'ghost'}
    noFocus
    icon={iconData.icon}
    iconProps={{ ...iconData.props, size }}
    showTooltip={{ label: view.string.Icon, direction: 'bottom' }}
    on:click={chooseIcon}
  />
{:else}
  <Icon icon={iconData.icon} iconProps={iconData.props} {size} />
{/if}
