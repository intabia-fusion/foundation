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
  import attachment from '@hcengineering/attachment'
  import { FileBrowser } from '@hcengineering/attachment-resources'
  import { Scroller, Switcher } from '@hcengineering/ui'
  import type { AnySvelteComponent } from '@hcengineering/ui'
  import { FilterBar, FilterButton } from '@hcengineering/view-resources'
  import { Class, Doc, DocumentQuery, Ref } from '@hcengineering/core'
  import { IntlString } from '@hcengineering/platform'

  import { userSearch } from '../../../index'
  import { SearchType } from '../../../utils'
  import chunter from '../../../plugin'
  import Header from '../../Header.svelte'
  import MessagesBrowser from './MessagesBrowser.svelte'

  let userSearch_: string = ''
  userSearch.subscribe((v) => (userSearch_ = v))

  const localStorageKey = 'chunter-browser-st__v2'

  let searchType: SearchType = initSearchType()
  $: localStorage.setItem(localStorageKey, searchType.toString())

  const tabs = [
    {
      id: SearchType.Messages,
      icon: chunter.icon.Messages,
      labelIntl: chunter.string.Messages,
      tooltip: chunter.string.Messages
    },
    {
      id: SearchType.Files,
      icon: attachment.icon.FileBrowser,
      labelIntl: attachment.string.Files,
      tooltip: attachment.string.Files
    }
  ]

  const components: {
    component: AnySvelteComponent
    searchType: SearchType
    label: IntlString
    filterClass?: Ref<Class<Doc>>
    props?: Record<string, any>
  }[] = [
    {
      searchType: SearchType.Messages,
      component: MessagesBrowser,
      label: chunter.string.Messages
    },
    {
      searchType: SearchType.Files,
      component: FileBrowser,
      label: attachment.string.Files,
      props: {
        requestedSpaceClasses: [chunter.class.Channel, chunter.class.DirectMessage]
      }
    }
  ]

  let searchValue: string = ''
  let filterQuery: DocumentQuery<Doc> = {}

  function initSearchType (): SearchType {
    const saved = localStorage.getItem(localStorageKey)
    const parsed = Number(saved)

    if (Object.values(SearchType).includes(parsed)) {
      return parsed
    }

    return SearchType.Messages
  }
</script>

<Header
  icon={chunter.icon.ChannelBrowser}
  intlLabel={chunter.string.ChunterBrowser}
  titleKind={'breadcrumbs'}
  bind:searchValue
  adaptive={'freezeActions'}
  focusSearch
>
  <svelte:fragment slot="search">
    <FilterButton _class={components[searchType].filterClass} />
  </svelte:fragment>
  <svelte:fragment slot="actions">
    <Switcher
      name={'browser_group'}
      kind={'subtle'}
      selected={searchType}
      items={tabs}
      on:select={(result) => {
        if (result?.detail.id !== undefined) searchType = result.detail.id
      }}
    />
  </svelte:fragment>
</Header>
{#if components[searchType].filterClass !== undefined}
  <FilterBar
    _class={components[searchType].filterClass}
    space={undefined}
    query={{ $search: searchValue }}
    hideSaveButtons
    on:change={(e) => {
      filterQuery = e.detail
      filterQuery.$search = undefined
    }}
  />
{/if}

{#if components[searchType].component}
  <Scroller>
    <svelte:component
      this={components[searchType].component}
      withHeader={false}
      search={userSearch_}
      {filterQuery}
      {...components[searchType].props}
    />
  </Scroller>
{/if}
