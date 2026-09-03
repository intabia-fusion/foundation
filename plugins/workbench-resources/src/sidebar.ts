//
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
//
import { WorkbenchEvents, type Widget, type WidgetTab } from '@hcengineering/workbench'
import { type Class, type Doc, getCurrentAccount, type Ref } from '@hcengineering/core'
import { get, writable } from 'svelte/store'
import { deviceOptionsStore as deviceInfo } from '@hcengineering/ui'
import { getResource } from '@hcengineering/platform'

import { locationWorkspaceStore } from './utils'
import { Analytics } from '@hcengineering/analytics'

export enum SidebarVariant {
  MINI = 'mini',
  EXPANDED = 'expanded'
}

export interface WidgetState {
  _id: Ref<Widget>
  data?: Record<string, any>
  tabs: WidgetTab[]
  tab?: string
  objectId?: Ref<Doc>
  objectClass?: Ref<Class<Doc>>
  closedByUser?: boolean
  openedByUser?: boolean
}

export interface SidebarState {
  variant: SidebarVariant
  float: boolean
  widgetsState: Map<Ref<Widget>, WidgetState>
  widget?: Ref<Widget>
}

export function getDefaultSidebarState (): SidebarState {
  return {
    variant: SidebarVariant.MINI,
    float: false,
    widgetsState: new Map()
  }
}

export const sidebarStore = writable<SidebarState>(getDefaultSidebarState())

locationWorkspaceStore.subscribe((workspace) => {
  sidebarStore.set(getSidebarStateFromLocalStorage(workspace ?? ''))
})

sidebarStore.subscribe(setSidebarStateToLocalStorage)

export function syncSidebarState (): void {
  const workspace = get(locationWorkspaceStore)
  sidebarStore.set(getSidebarStateFromLocalStorage(workspace ?? ''))
}
function getSideBarLocalStorageKey (workspace: string): string | undefined {
  const me = getCurrentAccount()
  if (me == null || workspace === '') return undefined
  return `workbench.${workspace}.${me.uuid}.sidebar.state.`
}

function getSidebarStateFromLocalStorage (workspace: string): SidebarState {
  const sidebarStateLocalStorageKey = getSideBarLocalStorageKey(workspace)
  if (sidebarStateLocalStorageKey === undefined) return getDefaultSidebarState()
  const state = window.localStorage.getItem(sidebarStateLocalStorageKey)

  if (state == null || state === '') return getDefaultSidebarState()

  try {
    const parsed = JSON.parse(state)
    const device = get(deviceInfo)
    const defaultState = getDefaultSidebarState()

    return {
      ...defaultState,
      ...parsed,
      variant: device.isMobile && device.minWidth ? SidebarVariant.MINI : (parsed.variant ?? defaultState.variant),
      widgetsState: new Map(Object.entries(parsed.widgetsState ?? {}))
    }
  } catch (e) {
    console.error(e)
    setSidebarStateToLocalStorage(getDefaultSidebarState())
    return getDefaultSidebarState()
  }
}

function setSidebarStateToLocalStorage (state: SidebarState): void {
  const workspace = get(locationWorkspaceStore)
  if (workspace == null || workspace === '') return

  const sidebarStateLocalStorageKey = getSideBarLocalStorageKey(workspace)
  if (sidebarStateLocalStorageKey === undefined) return
  const device = get(deviceInfo)
  window.localStorage.setItem(
    sidebarStateLocalStorageKey,
    JSON.stringify({
      ...state,
      variant: device.isMobile && device.minWidth ? SidebarVariant.MINI : state.variant,
      widgetsState: Object.fromEntries(state.widgetsState.entries())
    })
  )
}

export function openWidget (
  widget: Widget,
  data?: Record<string, any>,
  params?: { active: boolean, openedByUser: boolean },
  tabs?: WidgetTab[]
): void {
  const state = get(sidebarStore)
  const widgetsState = new Map(state.widgetsState)
  const widgetState = widgetsState.get(widget._id)
  const active = params?.active ?? true
  const openedByUser = params?.openedByUser ?? false

  widgetsState.set(widget._id, {
    _id: widget._id,
    data: data ?? widgetState?.data,
    tab: widgetState?.tab ?? tabs?.[0]?.id,
    tabs: widgetState?.tabs ?? tabs ?? [],
    openedByUser
  })

  Analytics.handleEvent(WorkbenchEvents.SidebarOpenWidget, { widget: widget._id })
  sidebarStore.set({
    ...state,
    widgetsState,
    variant: SidebarVariant.EXPANDED,
    widget: active ? widget._id : state.widget
  })
}

export function closeWidget (widget: Ref<Widget>): void {
  const state = get(sidebarStore)
  const widgetsState = new Map(state.widgetsState)

  if (!widgetsState.has(widget) && state.widget !== widget && state.variant === SidebarVariant.MINI) {
    return
  }

  widgetsState.delete(widget)
  Analytics.handleEvent(WorkbenchEvents.SidebarCloseWidget, { widget })
  if (state.widget === widget) {
    sidebarStore.set({
      ...state,
      widgetsState,
      variant: SidebarVariant.MINI,
      widget: undefined
    })
  } else {
    sidebarStore.set({
      ...state,
      widgetsState
    })
  }
}

export async function closeWidgetTab (widget: Widget, tab: string): Promise<void> {
  const currentState = get(sidebarStore)
  const currentWidgetState = currentState.widgetsState.get(widget._id)

  if (currentWidgetState === undefined) return

  const closedTab = currentWidgetState.tabs.find((it) => it.id === tab)

  Analytics.handleEvent(WorkbenchEvents.SidebarCloseWidget, { widget: widget._id, tab: closedTab?.name })

  if (widget.onTabClose !== undefined && closedTab !== undefined) {
    try {
      const fn = await getResource(widget.onTabClose)
      void fn(closedTab)
    } catch (e) {
      console.error(e)
    }
  }

  sidebarStore.update((state) => {
    const widgetsState = new Map(state.widgetsState)
    const widgetState = widgetsState.get(widget._id)

    if (widgetState === undefined) return state

    const tabs = widgetState.tabs
    const newTabs = tabs.filter((it) => it.id !== tab)

    if (newTabs.length === tabs.length) return state

    if (newTabs.length === 0) {
      if (widget.closeIfNoTabs === true) {
        widgetsState.delete(widget._id)
        return { ...state, widgetsState, variant: SidebarVariant.MINI }
      } else {
        widgetsState.set(widget._id, { ...widgetState, tabs: [], tab: undefined })
        return { ...state, widgetsState }
      }
    }

    const shouldReplace = widgetState.tab === tab

    if (!shouldReplace) {
      widgetsState.set(widget._id, { ...widgetState, tabs: newTabs })
    } else {
      const index = tabs.findIndex((it) => it.id === widgetState.tab)
      const newTab = index === -1 ? newTabs[0] : (tabs[index + 1] ?? tabs[index - 1] ?? newTabs[0])

      widgetsState.set(widget._id, { ...widgetState, tabs: newTabs, tab: newTab.id })
    }

    return { ...state, widgetsState }
  })
}

export function openWidgetTab (widget: Ref<Widget>, tab: string): void {
  const state = get(sidebarStore)
  const widgetsState = new Map(state.widgetsState)
  const widgetState = widgetsState.get(widget)

  if (widgetState === undefined) return

  const newTab = widgetState.tabs.find((it) => it.id === tab)
  if (newTab === undefined) return

  widgetsState.set(widget, { ...widgetState, tab })
  Analytics.handleEvent(WorkbenchEvents.SidebarOpenWidget, { widget, tab: newTab?.name })
  sidebarStore.set({
    ...state,
    widget,
    variant: SidebarVariant.EXPANDED,
    widgetsState
  })
}

export function isPreviewTab (tab: WidgetTab | undefined): tab is WidgetTab {
  return tab !== undefined && tab.isPinned !== true && tab.isKept !== true
}

export function createWidgetTab (widget: Widget, tab: WidgetTab): void {
  const state = get(sidebarStore)
  const widgetsState = new Map(state.widgetsState)
  const widgetState = widgetsState.get(widget._id)
  const currentTabs = widgetState?.tabs ?? []
  const opened = currentTabs.some(({ id }) => id === tab.id) ?? false

  let newTabs: WidgetTab[]

  if (opened) {
    newTabs = currentTabs.map((it) => (it.id === tab.id ? { ...tab, isPinned: it.isPinned, isKept: it.isKept } : it))
  } else {
    // At most one preview tab per widget: it gets replaced, kept and pinned ones are never touched.
    const active = currentTabs.find(({ id }) => id === widgetState?.tab)
    const replaced = isPreviewTab(active) ? active : currentTabs.find(isPreviewTab)

    newTabs =
      replaced !== undefined ? currentTabs.map((it) => (it.id === replaced.id ? tab : it)) : [...currentTabs, tab]
  }

  widgetsState.set(widget._id, {
    ...widgetState,
    _id: widget._id,
    tabs: newTabs,
    tab: tab.id
  })

  Analytics.handleEvent(WorkbenchEvents.SidebarOpenWidget, { widget: widget._id, tab: tab.name })
  sidebarStore.set({
    ...state,
    widget: widget._id,
    widgetsState,
    variant: SidebarVariant.EXPANDED
  })
}

export function pinWidgetTab (widget: Widget, tabId: string): void {
  const state = get(sidebarStore)
  const widgetsState = new Map(state.widgetsState)
  const widgetState = widgetsState.get(widget._id)

  if (widgetState === undefined) return

  const tabs = widgetState.tabs
    .map((it) => (it.id === tabId ? { ...it, isPinned: true, isKept: true } : it))
    .sort((a, b) => (a.isPinned === b.isPinned ? 0 : a.isPinned === true ? -1 : 1))

  widgetsState.set(widget._id, { ...widgetState, tabs })

  sidebarStore.set({
    ...state,
    widgetsState
  })
}

export function unpinWidgetTab (widget: Widget, tabId: string): void {
  const state = get(sidebarStore)
  const widgetsState = new Map(state.widgetsState)
  const widgetState = widgetsState.get(widget._id)

  if (widgetState === undefined) return

  // Unpin drops to "kept", not back to preview - the tab would otherwise vanish on the next open.
  const tabs = widgetState.tabs
    .map((it) => (it.id === tabId ? { ...it, isPinned: false, isKept: true } : it))
    .sort((a, b) => (a.isPinned === b.isPinned ? 0 : a.isPinned === true ? -1 : 1))

  widgetsState.set(widget._id, { ...widgetState, tabs })

  sidebarStore.set({
    ...state,
    widgetsState
  })
}

/** Promote a preview tab so the next opened object no longer replaces it. */
export function keepWidgetTab (widget: Widget, tabId: string): void {
  const state = get(sidebarStore)
  const widgetsState = new Map(state.widgetsState)
  const widgetState = widgetsState.get(widget._id)

  if (widgetState === undefined) return
  if (!isPreviewTab(widgetState.tabs.find((it) => it.id === tabId))) return

  widgetsState.set(widget._id, {
    ...widgetState,
    tabs: widgetState.tabs.map((it) => (it.id === tabId ? { ...it, isKept: true } : it))
  })

  sidebarStore.set({
    ...state,
    widgetsState
  })
}

function isDescendant (parent: HTMLElement, child: HTMLElement): boolean {
  let node = child.parentNode
  while (node != null) {
    if (node === parent) {
      return true
    }
    node = node.parentNode
  }
  return false
}

export function isElementFromSidebar (element: HTMLElement): boolean {
  const sidebarElement = document.getElementById('sidebar')
  if (sidebarElement == null) {
    return false
  }

  return isDescendant(sidebarElement, element)
}

export function minimizeSidebar (closedByUser = false): void {
  const state = get(sidebarStore)
  const widgetsState = new Map(state.widgetsState)
  const { widget } = state
  const widgetState = widget == null ? undefined : widgetsState.get(widget)

  if (widget !== undefined && widgetState !== undefined && closedByUser) {
    widgetsState.set(widget, { ...widgetState, closedByUser })
  }

  sidebarStore.set({ ...state, widgetsState, widget: undefined, variant: SidebarVariant.MINI })
}

export function updateTabData (widget: Ref<Widget>, tabId: string, data: Record<string, any>): void {
  const state = get(sidebarStore)
  const widgetsState = new Map(state.widgetsState)
  const widgetState = widgetsState.get(widget)

  if (widgetState === undefined) return

  const tabs = widgetState.tabs.map((it) => (it.id === tabId ? { ...it, data: { ...it.data, ...data } } : it))

  widgetsState.set(widget, { ...widgetState, tabs })

  sidebarStore.set({
    ...state,
    widgetsState
  })
}

export function updateWidgetState (widget: Ref<Widget>, newState: Partial<WidgetState>): void {
  const state = get(sidebarStore)
  const widgetsState = new Map(state.widgetsState)
  const widgetState = widgetsState.get(widget)

  if (widgetState === undefined) return

  widgetsState.set(widget, { ...widgetState, ...newState })

  sidebarStore.set({
    ...state,
    widgetsState
  })
}

export function getSidebarObject (): Partial<Pick<Doc, '_id' | '_class'>> {
  const state = get(sidebarStore)
  if (state.variant !== SidebarVariant.EXPANDED || state.widget == null) {
    return {}
  }
  const { widgetsState } = state
  const widgetState = widgetsState.get(state.widget)
  if (widgetState == null) {
    return {}
  }

  const tab = widgetState.tabs.find((it) => it.id === widgetState.tab)

  return {
    _id: tab?.objectId ?? widgetState.objectId,
    _class: tab?.objectClass ?? widgetState.objectClass
  }
}
