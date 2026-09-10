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
  import { deepEqual } from 'fast-equals'
  import contact from '@hcengineering/contact'
  import { statusByUserStore } from '@hcengineering/contact-resources'
  import core, { Class, Doc, notEmpty, reduceCalls, Ref, WithLookup } from '@hcengineering/core'
  import { getResource, IntlString, translate } from '@hcengineering/platform'
  import { getClient, isSpace } from '@hcengineering/presentation'
  import ui, {
    Action,
    AnySvelteComponent,
    Icon,
    IconAdd,
    IconMoreH,
    IconSize,
    languageStore,
    Menu,
    ModernButton,
    NavGroup,
    showPopup
  } from '@hcengineering/ui'
  import view from '@hcengineering/view'
  import { getDocIdentifier } from '@hcengineering/view-resources'
  import {
    getNotificationsCount,
    InboxNotificationsClientImpl,
    isActivityNotification,
    isMentionNotification,
    NotifyMarker
  } from '@hcengineering/notification-resources'
  import { Chat } from '@hcengineering/chunter'
  import { DocNotifyContext, InboxNotification } from '@hcengineering/notification'

  import { createEventDispatcher } from 'svelte'
  import chunter from '../../../plugin'
  import { getChannelName, getObjectIcon } from '../../../utils'
  import { getChatNavItemKey } from '../utils'
  import { ChatNavItemModel, SortFnOptions } from '../types'
  import ChatNavItem from './ChatNavItem.svelte'

  export let id: string
  export let _class: Ref<Class<Doc>> = core.class.Doc
  export let header: IntlString
  export let objects: { doc: Doc, chat?: Chat }[]
  export let itemsCount: number
  export let showEmpty: boolean = false
  export let actions: Action[] = []
  export let createAction: Action | undefined
  export let objectId: Ref<Doc> | undefined
  export let pinned: Chat[] = []
  export let sortByScore: boolean = false
  export let sortFn: (items: ChatNavItemModel[], options: SortFnOptions) => ChatNavItemModel[]

  const client = getClient()
  const hierarchy = client.getHierarchy()
  const inboxClient = InboxNotificationsClientImpl.getClient()
  const contextByDocStore = inboxClient.contextByDoc
  const contextsStore = inboxClient.contexts
  const notificationsByContextStore = inboxClient.inboxNotificationsByContext

  let sortedItems: ChatNavItemModel[] = []
  let items: ChatNavItemModel[] = []

  const dispatcher = createEventDispatcher()

  let canShowMore = false

  $: void getChatNavItems(
    objects,
    (res) => {
      items = res
    },
    $languageStore
  )

  function getScore (i: ChatNavItemModel): number {
    const score = (i.chat as WithLookup<Chat>)?.$source?.$score
    if (score != null) return score

    return (i.object as WithLookup<Doc>)?.$source?.$score ?? 0
  }

  $: (() => {
    const newSortedItems = sortByScore
      ? items.sort((a, b) => {
          const scoreDiff = getScore(b) - getScore(a)
          if (scoreDiff !== 0) return scoreDiff
          return (a.title ?? a.identifier).localeCompare(b.title ?? b.identifier)
        })
      : sortFn(items, {
          contextByDoc: $contextByDocStore,
          userStatusByAccount: $statusByUserStore
        })

    // Check if the underlying identifiers (ids) changed order to skip Svelte updates if unnecessary
    const oldIds = sortedItems.map((i) => i.id).join()
    const newIds = newSortedItems.map((i) => i.id).join()

    if (oldIds !== newIds || !deepEqual(sortedItems, newSortedItems)) {
      sortedItems = newSortedItems
    }
  })()
  $: canShowMore = itemsCount > items.length

  const getChatNavItems = reduceCalls(
    async (
      objects: { doc: Doc, chat?: Chat }[],
      handler: (items: ChatNavItemModel[]) => void,
      lang: string
    ): Promise<void> => {
      const items: ChatNavItemModel[] = []

      for (const { doc, chat } of objects) {
        const { _class } = doc
        const iconMixin = hierarchy.classHierarchyMixin(_class, view.mixin.ObjectIcon)
        const titleIntl = client.getHierarchy().getClass(_class).label

        const isPerson = hierarchy.isDerived(_class, contact.class.Person)
        const isDocChat = !hierarchy.isDerived(_class, chunter.class.ChunterSpace)
        const isDirect = hierarchy.isDerived(_class, chunter.class.DirectMessage)

        const iconSize: IconSize = isDirect || isPerson ? 'x-small' : 'small'

        let icon: AnySvelteComponent | undefined = undefined

        if (iconMixin?.component) {
          icon = await getResource(iconMixin.component)
        }

        const showIdentifier = isDocChat && !isPerson
        const identifier = showIdentifier ? await getDocIdentifier(client, doc._id, doc._class, doc) : undefined
        const name = (await getChannelName(doc._id, doc._class, doc, lang)) ?? (await translate(titleIntl, {}, lang))

        items.push({
          id: doc._id,
          object: doc,
          chat,
          identifier,
          title: name,
          subTitle: isSpace(doc) && doc.archived ? `(${await translate(core.string.Archived, {}, lang)})` : undefined,
          icon: icon ?? getObjectIcon(_class),
          iconProps: { showStatus: true },
          iconSize,
          withIconBackground: !isDirect && !isPerson
        })
      }

      handler(items)
    }
  )

  function onShowMore (): void {
    dispatcher('show-more')
  }

  $: visibleItem = sortedItems.find(({ id }) => id === objectId)

  let menuOpened = false

  function handleMenuClicked (ev: MouseEvent): void {
    menuOpened = true
    showPopup(Menu, { actions, ctx: { _id: id } }, ev.target as HTMLElement, () => {
      menuOpened = false
    })
  }

  let count: number = 0
  let contexts: DocNotifyContext[] = []

  $: pinnedIds = pinned.map((it) => it.attachedTo)
  $: contexts =
    _class === core.class.Doc
      ? sortedItems.map((it) => $contextByDocStore.get(it.object._id)).filter(notEmpty)
      : $contextsStore.filter((it) => hierarchy.isDerived(it.objectClass, _class) && !pinnedIds.includes(it.objectId))

  async function calculateNotifications (
    contexts: DocNotifyContext[],
    notificationsByContext: Map<Ref<DocNotifyContext>, InboxNotification[]>
  ): Promise<void> {
    const notifications = contexts
      .flatMap((context) => notificationsByContext.get(context._id) ?? [])
      .filter((n) => {
        if (isActivityNotification(n)) return true

        return isMentionNotification(n) && hierarchy.isDerived(n.mentionedInClass, chunter.class.ChatMessage)
      })

    count = getNotificationsCount(contexts, notifications)
  }

  $: void calculateNotifications(contexts, $notificationsByContextStore)

  $: notify = sortedItems.some((it) => {
    const c = $contextByDocStore.get(it.id)
    return (c?.lastView ?? 0) < (c?.lastUpdate ?? 0) && (c?.lastNotifiedMessage ?? 0) < (c?.lastUpdate ?? 0)
  })
</script>

{#if sortedItems.length > 0 || showEmpty}
  <NavGroup
    _id={id}
    label={header}
    categoryName={id}
    {actions}
    highlighted={items.some((it) => it.id === objectId)}
    isFold
    empty={sortedItems.length === 0}
    visible={visibleItem !== undefined}
    noDivider
    noPadding
    headerClickType="toggle"
    contextClickType="menu"
    showMenu={menuOpened}
    testid={`section-${id}`}
  >
    {#each sortedItems as item (getChatNavItemKey(item))}
      {@const context = $contextByDocStore.get(item.id)}
      <ChatNavItem {context} isSelected={objectId === item.id} {item} type={'type-object'} on:select />
    {/each}
    {#if canShowMore}
      <div class="showMore">
        <ModernButton label={ui.string.ShowMore} kind="tertiary" inheritFont size="extra-small" on:click={onShowMore} />
      </div>
    {:else}
      <span class="freeSpace" />
    {/if}
    <svelte:fragment slot="visible" let:isOpen>
      {#if visibleItem !== undefined && !isOpen}
        {@const context = $contextByDocStore.get(visibleItem.id)}
        <ChatNavItem {context} isSelected item={visibleItem} type={'type-object'} on:select />
      {/if}
    </svelte:fragment>

    <svelte:fragment slot="actions">
      {#if createAction}
        <button
          class="action"
          on:click|preventDefault|stopPropagation={(e) => createAction.action({}, e)}
          data-testid={`action-create-${id}`}
        >
          <Icon icon={IconAdd} size="small" />
        </button>
      {/if}
      {#if actions.length > 0}
        <button
          class="action"
          class:pressed={menuOpened}
          on:click|preventDefault|stopPropagation={handleMenuClicked}
          data-testid={`action-menu-${id}`}
        >
          <IconMoreH size={'small'} />
        </button>
      {/if}
    </svelte:fragment>
    <svelte:fragment slot="after" let:isOpen>
      {#if !isOpen}
        {#if count > 0}
          <div class="antiHSpacer" />
          <div class="notify">
            <NotifyMarker {count} />
          </div>
          <div class="antiHSpacer" />
        {:else if notify}
          <div class="antiHSpacer" />
          <div class="notify">
            <NotifyMarker count={0} kind="simple" size="xx-small" color="gray" />
          </div>
          <div class="antiHSpacer" />
        {/if}
      {/if}
    </svelte:fragment>
  </NavGroup>
{/if}

<style lang="scss">
  .showMore {
    margin: 0.25rem 0.5rem;
    font-size: 0.75rem;
  }

  .freeSpace {
    height: 0.25rem;
  }

  .action {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    padding: var(--spacing-0_5);
    color: var(--global-tertiary-TextColor);
    border: none;
    border-radius: var(--extra-small-BorderRadius);
    outline: none;

    &:hover,
    &.pressed {
      color: var(--global-primary-TextColor);
      background-color: var(--global-ui-highlight-BackgroundColor);
    }
  }
</style>
