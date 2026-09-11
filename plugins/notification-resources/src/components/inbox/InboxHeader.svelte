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
  import activity from '@hcengineering/activity'
  import { Class, Doc, getCurrentAccount, Ref } from '@hcengineering/core'
  import { createQuery, getClient } from '@hcengineering/presentation'
  import { Label, languageStore, Loading, TabItem, TabList } from '@hcengineering/ui'
  import chunter from '@hcengineering/chunter'
  import { translate } from '@hcengineering/platform'

  import notification from '../../plugin'
  import { InboxFilter } from '../../types'
  import InboxMenuButton from './InboxMenuButton.svelte'
  import SettingsButton from './SettingsButton.svelte'
  import { NotificationClientImpl } from '../../client'

  const INBOX_FILTER_KEY = 'inbox-filter'

  export let filter: InboxFilter = (localStorage.getItem(INBOX_FILTER_KEY) as InboxFilter) ?? 'all'
  export let selectedTabId: string = 'all'

  const client = getClient()
  const hierarchy = client.getHierarchy()
  const notificationClient = NotificationClientImpl.getClient()
  const clearingAllStore = notificationClient.clearingAllInbox
  const readingAllStore = notificationClient.readingAllInbox
  const account = getCurrentAccount()
  const classesQuery = createQuery()

  let classes = new Set<Ref<Class<Doc>>>()

  const allTab: TabItem = {
    id: 'all',
    labelIntl: notification.string.All
  }

  const messagesTab = {
    id: activity.class.ActivityMessage,
    labelIntl: chunter.string.Threads
  } as const

  let tabItems: TabItem[] = []

  $: classesQuery.query(
    notification.class.DocNotifyContext,
    {
      user: account.uuid,
      latestNotifications: { $size: { $gt: 0 } },
      ...(filter === 'unread' ? { unreadCount: { $gt: 0 } } : {})
    },
    (res) => {
      classes = new Set(res.map((it) => it.objectClass))
    },
    {
      projection: { objectClass: 1 }
    }
  )

  $: void updateTabItems(classes, $languageStore)

  async function updateTabItems (classes: Set<Ref<Class<Doc>>>, lang: string): Promise<void> {
    const _classes = Array.from(classes)
    const tabs: TabItem[] = []

    let pushMessagesTab = false

    for (const _class of _classes) {
      if (hierarchy.isDerived(_class, activity.class.ActivityMessage)) {
        pushMessagesTab = true
        continue
      }

      const clazz = hierarchy.getClass(_class)
      const intlLabel = clazz.pluralLabel ?? clazz.label ?? _class
      tabs.push({
        id: _class,
        label: await translate(intlLabel, {}, lang)
      })
    }

    if (pushMessagesTab) {
      tabs.push({
        id: messagesTab.id,
        label: await translate(messagesTab.labelIntl, {}, lang)
      })
    }

    tabItems = [allTab].concat(tabs.sort((a, b) => (a.label ?? '').localeCompare(b.label ?? '')))
  }

  function selectTab (event: CustomEvent): void {
    if (event.detail !== undefined) {
      selectedTabId = event.detail.id
    }
  }

  function toggleUnread (): void {
    filter = filter === 'unread' ? 'all' : 'unread'
    localStorage.setItem(INBOX_FILTER_KEY, filter)
  }

  $: items = [
    {
      id: 'unread',
      on: filter === 'unread',
      label: notification.string.Unreads,
      onToggle: toggleUnread
    }
  ]
</script>

<div class="hulyNavPanel-header withButton small">
  <span class="overflow-label"><Label label={notification.string.Inbox} /></span>
  <div class="flex-row-center flex-gap-2">
    {#if $clearingAllStore}
      <Loading size="small">
        <span class="loading-label uppercase">
          <Label label={notification.string.Clearing} />
        </span>
      </Loading>
    {:else if $readingAllStore}
      <Loading size="small">
        <span class="loading-label uppercase">
          <Label label={notification.string.Reading} />
        </span>
      </Loading>
    {/if}
    <SettingsButton {items} />
    <InboxMenuButton />
  </div>
</div>

<div class="tabs">
  <TabList items={tabItems} selected={selectedTabId} on:select={selectTab} padding={'var(--spacing-1) 0'} />
</div>

<style lang="scss">
  .tabs {
    display: flex;
    align-items: center;
    padding: var(--spacing-0_5) var(--spacing-1_5);
    border-bottom: 1px solid var(--theme-navpanel-border);
  }

  .loading-label {
    color: var(--global-secondary-TextColor);
    font-weight: 500;
    font-size: 0.625rem;
    margin-left: 0.25rem;
  }
</style>
