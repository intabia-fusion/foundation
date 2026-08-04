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
  import { AccountRole, getCurrentAccount, hasAccountRole } from '@hcengineering/core'
  import { type Asset, type IntlString } from '@hcengineering/platform'
  import {
    type AnySvelteComponent,
    Breadcrumb,
    Component,
    Header,
    type Location,
    NavItem,
    Scroller,
    Separator,
    defineSeparators,
    getCurrentResolvedLocation,
    navigate,
    resolvedLocationStore,
    twoPanelsSeparators
  } from '@hcengineering/ui'
  import view from '@hcengineering/view'
  import { onDestroy } from 'svelte'

  import aiBot from '../plugin'
  import AISpaceSettingsEditor from './AISpaceSettingsEditor.svelte'
  import AIPersonalDataSettings from './AIPersonalDataSettings.svelte'

  // Basic (workspace) settings are editable by Owner only.
  const readonly = !hasAccountRole(getCurrentAccount(), AccountRole.Owner)

  interface SettingGroup {
    key: string
    icon: Asset
    label: IntlString
    component: AnySvelteComponent
    props?: Record<string, unknown>
  }

  const groups: SettingGroup[] = [
    {
      key: 'basic',
      icon: view.icon.AiStar,
      label: aiBot.string.BasicTab,
      component: AISpaceSettingsEditor,
      props: { readonly }
    },
    {
      key: 'personal',
      icon: view.icon.AiStar,
      label: aiBot.string.PersonalTab,
      component: AIPersonalDataSettings
    }
  ]

  let currentGroupKey = groups[0].key
  let currentGroup: SettingGroup = groups[0]

  const unsubscribeLocation = resolvedLocationStore.subscribe((loc: Location) => {
    const key = loc.path[4]
    currentGroup = groups.find((g) => g.key === key) ?? groups[0]
    currentGroupKey = currentGroup.key
  })

  onDestroy(() => {
    unsubscribeLocation()
  })

  defineSeparators('aiSettings', twoPanelsSeparators)
</script>

<div class="hulyComponent">
  <Header adaptive={'disabled'}>
    <Breadcrumb icon={view.icon.AiStar} label={aiBot.string.AISettings} size={'large'} isCurrent />
  </Header>
  <div class="hulyComponent-content__container columns">
    <div class="hulyComponent-content__column navigation py-2">
      <Scroller shrink>
        {#each groups as group}
          <NavItem
            icon={group.icon}
            label={group.label}
            selected={group.key === currentGroupKey}
            on:click={() => {
              currentGroupKey = group.key
              currentGroup = group
              const loc = getCurrentResolvedLocation()
              loc.path[4] = group.key
              loc.path.length = 5
              navigate(loc)
            }}
          />
        {/each}
      </Scroller>
    </div>

    <Separator name="aiSettings" index={0} color={'var(--theme-divider-color)'} />

    <div class="hulyComponent-content__column content">
      <Component is={currentGroup.component} props={currentGroup.props ?? {}} />
    </div>
  </div>
</div>
