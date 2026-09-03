<!--
// Copyright © 2022 Hardcore Engineering Inc.
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
  import core, {
    Class,
    ClassifierKind,
    Doc,
    Obj,
    PluginConfiguration,
    Ref,
    isOwnerOrMaintainer
  } from '@hcengineering/core'
  import { Asset, IntlString, getEmbeddedLabel } from '@hcengineering/platform'
  import { createQuery, getClient, IconWithEmoji } from '@hcengineering/presentation'
  import {
    AnySvelteComponent,
    Scroller,
    ButtonIcon,
    IconDescription,
    Label,
    getLocation,
    navigate,
    Header,
    Breadcrumb,
    defineSeparators,
    twoPanelsSeparators,
    Separator,
    NavItem,
    NavGroup
  } from '@hcengineering/ui'
  import { showMenu } from '@hcengineering/view-resources'
  import view from '@hcengineering/view'

  import setting from '../plugin'
  import { filterDescendants } from '../utils'
  import ClassAttributes from './ClassAttributes.svelte'
  import { clearSettingsStore } from '../store'

  export let ofClass: Ref<Class<Obj>> | undefined = undefined
  export let attributeMapper:
  | {
    component: AnySvelteComponent
    label: IntlString
    props: Record<string, any>
  }
  | undefined = undefined
  export let withoutHeader = false
  export let useOfClassAttributes = true

  const canEdit = isOwnerOrMaintainer()

  const loc = getLocation()
  const client = getClient()
  const hierarchy = client.getHierarchy()

  let _class: Ref<Class<Doc>> | undefined = ofClass ?? (loc.query?._class as Ref<Class<Doc>> | undefined)

  // Keep the selected class in the URL for deep-linking.
  $: if (_class !== undefined && ofClass === undefined) {
    const loc = getLocation()
    if (loc.query?._class !== _class) {
      loc.query = { _class }
      navigate(loc, true)
    }
  }

  const clQuery = createQuery()

  let classes: Ref<Class<Doc>>[] = []
  let rawClasses: Class<Doc>[] = []

  clQuery.query(core.class.Class, {}, (res) => {
    rawClasses = res
  })

  // Generated targetClass mixins carry neither UserMixin nor Editable.
  function isGeneratedTargetClass (cls: Class<Doc>): boolean {
    if (cls.kind !== ClassifierKind.MIXIN) return false
    if (hierarchy.hasMixin(cls, setting.mixin.UserMixin)) return false
    return !(hierarchy.hasMixin(cls, setting.mixin.Editable) && hierarchy.as(cls, setting.mixin.Editable).value)
  }

  // Flat list: filterDescendants gives editable roots; expand each root into
  // its editable descendants (classes and mixins, incl. user-created ones).
  function collectEditable (
    roots: Ref<Class<Doc>>[],
    pluginConfigs: Map<string, PluginConfiguration>
  ): Ref<Class<Doc>>[] {
    const kinds = ofClass === undefined ? [ClassifierKind.CLASS] : [ClassifierKind.MIXIN]
    const seen = new Set<Ref<Class<Doc>>>()
    const result: Ref<Class<Doc>>[] = []
    for (const root of roots) {
      for (const cl of hierarchy.getDescendants(root)) {
        if (seen.has(cl)) continue
        const cls = hierarchy.getClass(cl)
        if (
          cls.hidden !== true &&
          cls.label !== undefined &&
          (cl === root || kinds.includes(cls.kind)) &&
          !isGeneratedTargetClass(cls) &&
          (ofClass !== undefined || pluginConfigs.get(pluginOf(cl))?.enabled !== false) &&
          (!hierarchy.hasMixin(cls, setting.mixin.Editable) || hierarchy.as(cls, setting.mixin.Editable).value)
        ) {
          seen.add(cl)
          result.push(cl)
        }
      }
    }
    return result
  }

  $: classes = collectEditable(filterDescendants(hierarchy, ofClass, rawClasses), pluginConfigs)

  // Group classes by owning plugin (id prefix; user mixins inherit the group of their ancestor).
  const pluginQuery = createQuery()
  let pluginConfigs = new Map<string, PluginConfiguration>()
  pluginQuery.query(core.class.PluginConfiguration, {}, (res) => {
    pluginConfigs = new Map(res.map((it) => [it.pluginId, it]))
  })

  function pluginOf (cl: Ref<Class<Doc>>): string {
    for (const anc of [cl, ...hierarchy.getAncestors(cl)]) {
      const idx = anc.indexOf(':')
      if (idx > 0) return anc.substring(0, idx)
    }
    return 'core'
  }

  interface ClassGroup {
    id: string
    label: IntlString
    icon?: Asset
    classes: Ref<Class<Doc>>[]
  }

  function groupClasses (classes: Ref<Class<Doc>>[], pluginConfigs: Map<string, PluginConfiguration>): ClassGroup[] {
    const groups = new Map<string, ClassGroup>()
    for (const cl of classes) {
      const plugin = pluginOf(cl)
      let group = groups.get(plugin)
      if (group === undefined) {
        const cfg = pluginConfigs.get(plugin)
        const label = cfg !== undefined && cfg.label !== setting.string.Configure ? cfg.label : getEmbeddedLabel(plugin)
        group = { id: plugin, label, icon: cfg?.icon, classes: [] }
        groups.set(plugin, group)
      }
      group.classes.push(cl)
    }
    return Array.from(groups.values())
  }

  $: groups = groupClasses(classes, pluginConfigs)

  $: if (ofClass !== undefined && _class !== undefined && !client.getHierarchy().isDerived(_class, ofClass)) {
    _class = ofClass
  }
  defineSeparators('workspaceSettings', twoPanelsSeparators)
</script>

<div class="hulyComponent">
  {#if !withoutHeader}
    <Header adaptive={'disabled'}>
      <Breadcrumb icon={setting.icon.Clazz} label={setting.string.ClassSetting} size={'large'} isCurrent />
    </Header>
  {/if}
  <div class="hulyComponent-content__container columns">
    <div class="hulyComponent-content__column">
      <div class="hulyComponent-content__navHeader divide">
        <div class="hulyComponent-content__navHeader-menu">
          <ButtonIcon kind={'tertiary'} icon={IconDescription} size={'small'} inheritColor />
        </div>
        <div class="hulyComponent-content__navHeader-hint paragraph-regular-14">
          <Label label={setting.string.ClassSettingHint} />
        </div>
      </div>
      <Scroller>
        {#each groups as group (group.id)}
          <NavGroup
            label={group.label}
            categoryName={group.id}
            highlighted={_class !== undefined && group.classes.includes(_class)}
            noDivider
            isFold
          >
            {#each group.classes as cl}
              {@const clazz = hierarchy.getClass(cl)}
              <NavItem
                _id={clazz._id}
                icon={clazz.icon === view.ids.IconWithEmoji ? IconWithEmoji : (clazz.icon ?? setting.icon.Clazz)}
                iconProps={clazz.icon === view.ids.IconWithEmoji ? { icon: clazz.color ?? 0 } : {}}
                label={clazz.label}
                selected={cl === _class}
                on:click={() => {
                  _class = cl
                  clearSettingsStore()
                }}
                on:contextmenu={(evt) => {
                  showMenu(evt, { object: clazz })
                }}
              />
            {/each}
          </NavGroup>
        {/each}
      </Scroller>
    </div>
    <Separator name={'workspaceSettings'} index={0} color={'var(--theme-divider-color)'} />
    <div class="hulyComponent-content__column content">
      <Scroller align={'center'} padding={'var(--spacing-3)'} bottomPadding={'var(--spacing-3)'}>
        <div class="hulyComponent-content">
          {#if _class !== undefined}
            <ClassAttributes
              {_class}
              {ofClass}
              {attributeMapper}
              showHierarchy
              showMixins={ofClass === undefined}
              disabled={!canEdit}
            />
          {/if}
        </div>
      </Scroller>
    </div>
  </div>
</div>
