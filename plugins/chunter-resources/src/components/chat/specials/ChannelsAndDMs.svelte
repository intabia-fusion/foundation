<!--
// Copyright © 2026 Intabia Fusion.
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
  import { Switcher, TabItem } from '@hcengineering/ui'
  import { Class, Doc, Ref } from '@hcengineering/core'
  import { IntlString } from '@hcengineering/platform'
  import contact from '@hcengineering/contact'
  import { ChunterSpace } from '@hcengineering/chunter'

  import { userSearch } from '../../../index'
  import chunter from '../../../plugin'
  import ChunterSpacesView from './ChunterSpacesView.svelte'

  const localStorageKey = 'channel_and_dms-browser-st__v1'
  const saved = localStorage.getItem(localStorageKey)
  let currentTab: Ref<Class<ChunterSpace>> =
    saved !== null && saved !== '' ? (saved as Ref<Class<ChunterSpace>>) : chunter.class.Channel

  $: localStorage.setItem(localStorageKey, currentTab)

  const tabs: TabItem[] = [
    {
      id: chunter.class.Channel,
      icon: chunter.icon.Hashtag,
      labelIntl: chunter.string.Channels,
      tooltip: chunter.string.Channels
    },
    {
      id: chunter.class.DirectMessage,
      icon: contact.icon.Contacts,
      labelIntl: chunter.string.DirectMessages,
      tooltip: chunter.string.DirectMessages
    }
  ]

  const components: {
    id: Ref<Class<ChunterSpace>>
    label: IntlString
    filterClass?: Ref<Class<Doc>>
    props?: Record<string, any>
  }[] = [
    {
      id: chunter.class.Channel,
      filterClass: chunter.class.Channel,
      label: chunter.string.Channels,
      props: {
        _class: chunter.class.Channel,
        icon: chunter.icon.ChannelBrowser,
        label: chunter.string.Channels,
        createLabel: chunter.string.CreateChannel,
        createComponent: chunter.component.CreateChannel
      }
    },
    {
      id: chunter.class.DirectMessage,
      filterClass: chunter.class.DirectMessage,
      label: chunter.string.DirectMessages,
      props: {
        _class: chunter.class.DirectMessage,
        icon: contact.class.Contact,
        label: chunter.string.DirectMessages,
        createLabel: chunter.string.CreateDirect,
        createComponent: chunter.component.CreateDirectChat
      }
    }
  ]

  $: current = components.find((item) => item.id === currentTab) ?? components[0]
</script>

<ChunterSpacesView bind:search={$userSearch} _class={current.id} label={current.label} {...current.props}>
  <svelte:fragment slot="extra">
    <Switcher
      name={'channels_and_dms'}
      kind={'subtle'}
      selected={currentTab}
      items={tabs}
      on:select={(result) => {
        if (result?.detail.id !== undefined) {
          currentTab = result.detail.id
          $userSearch = ''
        }
      }}
    />
  </svelte:fragment>
</ChunterSpacesView>
