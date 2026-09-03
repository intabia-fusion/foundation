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
    AnyAttribute,
    Association,
    AssociationQuery,
    Class,
    Doc,
    Ref,
    TxOperations,
    Type
  } from '@hcengineering/core'
  import { Asset, getEmbeddedLabel, IntlString, translate } from '@hcengineering/platform'
  import { createQuery, getAttributePresenterClass, getClient, hasResource } from '@hcengineering/presentation'
  import { DropdownLabelsIntl, Label, Loading, resizeObserver, ToggleWithLabel } from '@hcengineering/ui'
  import { BuildModelKey, DescendantAttribute, Viewlet, ViewletPreference } from '@hcengineering/view'
  import { deepEqual } from 'fast-equals'
  import { createEventDispatcher, onDestroy } from 'svelte'

  import view from '../plugin'
  import { buildConfigLookup, canResolveAttribute, getKeyLabel } from '../utils'
  import ViewletClassSettings from './ViewletClassSettings.svelte'

  export let viewlet: Viewlet
  export let defaultConfig: (BuildModelKey | string)[] | undefined = undefined

  const dispatch = createEventDispatcher()

  let preferences: ViewletPreference[] = []
  const preferenceQuery = createQuery()

  let selected = viewlet._id

  let viewlets: Viewlet[] = []

  $: client
    .findAll(view.class.Viewlet, {
      attachTo: {
        $in: client
          .getHierarchy()
          .getDescendants(viewlet.attachTo)
          .filter((it) => !client.getHierarchy().isMixin(it) || it === viewlet.attachTo)
      },
      variant: viewlet.variant ? viewlet.variant : { $exists: false },
      descriptor: viewlet.descriptor
    })
    .then((res) => {
      viewlets = res
    })

  $: if (viewlet && viewlets.length > 0) {
    preferenceQuery.query(
      view.class.ViewletPreference,
      {
        space: core.space.Workspace,
        attachedTo: { $in: Array.from(viewlets.map((it) => it._id)) }
      },
      (res) => {
        preferences = res
        loading = false
      }
    )
  } else {
    preferenceQuery.unsubscribe()
  }

  const client = getClient()
  const hierarchy = client.getHierarchy()
  let loading = true

  interface Config {
    value: string | BuildModelKey | undefined
    type: 'divider' | 'attribute'
  }

  interface AttributeConfig extends Config {
    type: 'attribute'
    enabled: boolean
    label: IntlString
    _class: Ref<Class<Doc>>
    icon: Asset | undefined
    order?: number
  }

  function getObjectConfig (_class: Ref<Class<Doc>>, param: string): AttributeConfig {
    const clazz = hierarchy.getClass(_class)
    return {
      type: 'attribute',
      value: param,
      label: clazz.label,
      enabled: true,
      icon: clazz.icon,
      _class
    }
  }

  function getAssociationLabel (client: TxOperations, param: string): IntlString {
    return getKeyLabel(client, viewlet.attachTo, param, undefined)
  }

  function getBaseConfig (viewlet: Viewlet): Config[] {
    const config = defaultConfig ?? viewlet.config
    const lookup = buildConfigLookup(hierarchy, viewlet.attachTo, config, viewlet.options?.lookup)
    const result: Config[] = []
    const clazz = hierarchy.getClass(viewlet.attachTo)
    let wasOptional = false

    for (const param of config) {
      if (typeof param === 'string') {
        if (viewlet.configOptions?.hiddenKeys?.includes(param)) continue
        if (param.length === 0) {
          result.push(getObjectConfig(viewlet.attachTo, param))
        } else if (param.startsWith('$associations.')) {
          const assocConfig: AttributeConfig = {
            type: 'attribute',
            value: param,
            enabled: true,
            label: getAssociationLabel(client, param),
            _class: viewlet.attachTo,
            icon: clazz.icon
          }
          result.push(assocConfig)
        } else {
          if (!canResolveAttribute(hierarchy, viewlet.attachTo, param, lookup)) continue
          const paramValue = param.startsWith('custom') ? { key: param, displayProps: { optional: true } } : param
          const attrCfg: AttributeConfig = {
            type: 'attribute',
            value: paramValue,
            enabled: true,
            label: getKeyLabel(client, viewlet.attachTo, param, lookup),
            _class: viewlet.attachTo,
            icon: clazz.icon
          }
          result.push(attrCfg)
        }
      } else {
        if (viewlet.configOptions?.hiddenKeys?.includes(param.key)) continue
        if (param.displayProps?.grow === true) {
          result.push({
            type: 'divider',
            value: param
          })
        } else {
          if (param.displayProps?.optional === true && !wasOptional) {
            wasOptional = true
            result.push({
              type: 'divider',
              value: ''
            })
          }
          if (!canResolveAttribute(hierarchy, viewlet.attachTo, param.key, lookup)) continue
          const attrCfg: AttributeConfig = {
            type: 'attribute',
            value: param,
            label: param.label ?? getKeyLabel(client, viewlet.attachTo, param.key, lookup),
            enabled: true,
            _class: viewlet.attachTo,
            icon: clazz.icon
          }
          result.push(attrCfg)
        }
      }
    }
    return result
  }

  function getValue (name: string, type: Type<any>, attrClass: Ref<Class<Doc>>): string {
    const presenter = hierarchy.classHierarchyMixin(attrClass, view.mixin.AttributePresenter)?.presenter
    if (presenter !== undefined) {
      return name
    }
    if (hierarchy.isDerived(type._class, core.class.RefTo)) {
      return '$lookup.' + name
    }
    return name
  }

  function processAttribute (attribute: AnyAttribute, result: Config[], useMixinProxy = false): void {
    if (attribute.hidden === true || attribute.label === undefined) return
    // Custom attributes have a dedicated CUSTOM ATTRIBUTES section, skip here to avoid duplicates.
    if (attribute.isCustom === true) return
    if (viewlet.configOptions?.hiddenKeys?.includes(attribute.name)) return
    if (hierarchy.isDerived(attribute.type._class, core.class.Collection)) return
    const { attrClass, category } = getAttributePresenterClass(hierarchy, attribute.type)
    const value = getValue(attribute.name, attribute.type, attrClass)
    const proxiedValue = attribute.attributeOf + '.' + attribute.name
    for (const res of result) {
      const key = getKey(res.value)
      if (key === undefined) continue
      if (key === attribute.name || key === value || key === proxiedValue) return
      if (key === '' && isAttribute(res) && res.label === attribute.label) return
    }
    const mixin =
      category === 'object'
        ? view.mixin.ObjectPresenter
        : category === 'collection'
          ? view.mixin.CollectionPresenter
          : view.mixin.AttributePresenter
    const presenter = hierarchy.classHierarchyMixin(
      attrClass,
      mixin,
      (m) => hasResource(m.presenter) ?? false
    )?.presenter
    if (presenter === undefined) return
    const clazz = hierarchy.getClass(attribute.attributeOf)
    const extraProps = viewlet.configOptions?.extraProps
    if (useMixinProxy) {
      const newValue: AttributeConfig = {
        type: 'attribute',
        value: attribute.attributeOf + '.' + attribute.name,
        label: attribute.label,
        enabled: false,
        _class: attribute.attributeOf,
        icon: clazz.icon
      }
      if (!isExist(result, newValue)) {
        result.push(newValue)
      }
    } else {
      const isCustomAttribute = attribute.name.startsWith('custom')
      const attributeValue = isCustomAttribute ? { key: value, displayProps: { optional: true } } : value

      const newValue: AttributeConfig = {
        type: 'attribute',
        value: extraProps != null ? { ...extraProps, key: value } : attributeValue,
        label: attribute.label,
        enabled: false,
        _class: attribute.attributeOf,
        icon: clazz.icon
      }
      if (!isExist(result, newValue)) {
        result.push(newValue)
      }
    }
  }

  function isAttribute (val: Config): val is AttributeConfig {
    return val.type === 'attribute'
  }

  function getKey (value: string | BuildModelKey | undefined): string | undefined {
    if (value === undefined) return undefined
    if (typeof value === 'string') return value

    if (value.displayProps?.key !== undefined && value.displayProps.key.length > 0) {
      return value.displayProps.key
    }
    if (value.key !== undefined && value.key.length > 0) {
      return value.key
    }

    return value.key
  }

  function getAttributeKey (key: string): string {
    if (key.startsWith('$lookup.')) {
      return key.slice('$lookup.'.length)
    }
    const dotIndex = key.lastIndexOf('.')
    return dotIndex === -1 ? key : key.slice(dotIndex + 1)
  }

  function isSourceAttribute (sourceClass: Ref<Class<Doc>>, key: string): boolean {
    return hierarchy.getAllAttributes(sourceClass).has(getAttributeKey(key))
  }

  function syncConfigOrder (
    sourceClass: Ref<Class<Doc>>,
    previousSourceConfig: Array<BuildModelKey | string>,
    sourceConfig: Array<BuildModelKey | string>,
    targetConfig: Array<BuildModelKey | string>
  ): Array<BuildModelKey | string> {
    const sourceKeys = new Set(sourceConfig.map(getKey).filter((it): it is string => it !== undefined))
    const previousSourceKeys = new Set(previousSourceConfig.map(getKey).filter((it): it is string => it !== undefined))
    const targetByKey = new Map<string, Array<{ item: BuildModelKey | string, index: number }>>()
    for (const [index, item] of targetConfig.entries()) {
      const key = getKey(item)
      if (key === undefined) continue
      const items = targetByKey.get(key) ?? []
      items.push({ item, index })
      targetByKey.set(key, items)
    }

    const sourceItems: Array<BuildModelKey | string> = []
    const usedIndexes = new Set<number>()
    for (const sourceItem of sourceConfig) {
      const key = getKey(sourceItem)
      if (key === undefined) continue

      const targetItem = targetByKey.get(key)?.shift()
      sourceItems.push(targetItem?.item ?? sourceItem)
      if (targetItem !== undefined) {
        usedIndexes.add(targetItem.index)
      }
    }

    const synced = [...sourceItems]
    for (const [index, targetItem] of targetConfig.entries()) {
      if (usedIndexes.has(index)) continue

      const key = getKey(targetItem)
      if (
        key !== undefined &&
        !sourceKeys.has(key) &&
        (previousSourceKeys.has(key) || isSourceAttribute(sourceClass, key))
      ) {
        continue
      }

      synced.splice(Math.min(index, synced.length), 0, targetItem)
    }

    return synced
  }

  function isExist (result: Config[], newValue: Config): boolean {
    if (!isAttribute(newValue)) return false
    const newValueKey = getKey(newValue.value)
    if (newValueKey === undefined) return false

    for (const res of result) {
      if (!isAttribute(res)) {
        continue
      }
      if (getKey(res.value) === newValueKey) {
        return true
      }
      if (newValueKey === '' && res.label === newValue.label) {
        return true
      }
    }
    return false
  }

  function getParentsString (parents: AssociationQuery[]): string {
    return parents.map(([assocId, direction]) => `$associations.${assocId}_${direction === 1 ? 'a' : 'b'}`).join('.')
  }

  async function processAssociation (
    association: Association,
    direction: 'a' | 'b',
    result: Config[],
    preference: ViewletPreference | undefined,
    parents: AssociationQuery[]
  ): Promise<void> {
    const associationName = `$associations.${association._id}_${direction}`
    const resultName = parents.length > 0 ? `${getParentsString(parents)}.${associationName}` : associationName

    const name = direction === 'a' ? association.nameA : association.nameB
    const targetClass = direction === 'a' ? association.classA : association.classB

    if (name.trim().length === 0) return
    const model = client.getModel()

    const resultLabels = parents
      .map((r) => {
        const assoc = model.findObject(r[0])
        if (assoc === undefined) return ''
        return r[1] === 1 ? assoc.nameA : assoc.nameB
      })
      .filter((it) => it.length > 0)
    resultLabels.push(name)
    const fullLabel = resultLabels.join(' › ')

    const clazz = hierarchy.getClass(targetClass)
    const newValue: AttributeConfig = {
      type: 'attribute',
      value: resultName,
      label: getEmbeddedLabel(fullLabel),
      enabled: false,
      _class: targetClass,
      icon: clazz.icon
    }

    if (!isExist(result, newValue)) {
      result.push(newValue)
    }

    if (preference === undefined) return
    const exists = preference.config.find((p) => {
      const key = getKey(p)
      return key === resultName
    })
    if (exists) {
      addAssociations(result, targetClass, preference, [...parents, [association._id, direction === 'a' ? 1 : -1]])
      await addAssociationAttributes(result, targetClass, resultName, fullLabel)
    }
  }

  async function addAssociationAttributes (
    result: Config[],
    targetClass: Ref<Class<Doc>>,
    associationKey: string,
    associationLabel: string
  ): Promise<void> {
    const allAttributes = Array.from(hierarchy.getAllAttributes(targetClass).values())
    const tasks = allAttributes.map(async (attribute) => {
      if (attribute.hidden || attribute.label === undefined) return null
      if (hierarchy.isDerived(attribute.type._class, core.class.Collection)) return null
      const { attrClass, category } = getAttributePresenterClass(hierarchy, attribute.type)
      const mixin =
        category === 'object'
          ? view.mixin.ObjectPresenter
          : category === 'collection'
            ? view.mixin.CollectionPresenter
            : view.mixin.AttributePresenter
      const presenter = hierarchy.classHierarchyMixin(
        attrClass,
        mixin,
        (m) => hasResource(m.presenter) ?? false
      )?.presenter
      if (presenter === undefined) return null

      const fieldKey = `${associationKey}.${attribute.name}`
      const fieldLabel = getAssociationLabel(client, fieldKey)
      const translatedLabel = await translate(fieldLabel, {})
      const clazz = hierarchy.getClass(targetClass)
      return {
        type: 'attribute' as const,
        value: fieldKey,
        label: getEmbeddedLabel(associationLabel + ' > ' + translatedLabel),
        enabled: false,
        _class: targetClass,
        icon: clazz.icon
      }
    })

    const items = await Promise.all(tasks)
    for (const newValue of items) {
      if (newValue != null && !isExist(result, newValue)) {
        result.push(newValue)
      }
    }
  }

  async function getConfig (viewlet: Viewlet, preference: ViewletPreference | undefined): Promise<Config[]> {
    const result = getBaseConfig(viewlet)

    if (viewlet.configOptions?.strict !== true) {
      const allAttributes = hierarchy.getAllAttributes(viewlet.attachTo)
      for (const [, attribute] of allAttributes) {
        processAttribute(attribute, result)
      }

      const desc = hierarchy.getDescendants(viewlet.attachTo)
      for (const d of desc) {
        if (!hierarchy.isMixin(d)) continue
        hierarchy.getOwnAttributes(d).forEach((attr) => {
          processAttribute(attr, result, true)
        })
      }

      await addAssociations(result, viewlet.attachTo, preference)
    }

    return preference === undefined ? result : setStatus(result, preference)
  }

  async function updatePreference (viewletId: Ref<Viewlet>, changes: Partial<ViewletPreference>): Promise<void> {
    const preference =
      preferences.find((p) => p.attachedTo === viewletId) ??
      (await client.findOne(view.class.ViewletPreference, { space: core.space.Workspace, attachedTo: viewletId }))
    if (preference !== undefined) {
      await client.update(preference, changes)
    } else {
      const vl = viewlets.find((it) => it._id === viewletId)
      await client.createDoc(view.class.ViewletPreference, core.space.Workspace, {
        attachedTo: viewletId,
        config: vl?.config ?? [],
        ...changes
      })
    }
  }

  async function syncChildViewletPreferences (
    sourceViewlet: Viewlet,
    previousSourceConfig: Array<BuildModelKey | string>,
    sourceConfig: Array<BuildModelKey | string>
  ): Promise<void> {
    const descendants = new Set(
      hierarchy.getDescendants(sourceViewlet.attachTo).filter((it) => it !== sourceViewlet.attachTo)
    )
    const childTasks: Promise<void>[] = []
    for (const childViewlet of viewlets) {
      if (!descendants.has(childViewlet.attachTo)) continue

      const preference = preferences.find((p) => p.attachedTo === childViewlet._id)
      const targetConfig = preference?.config ?? childViewlet.config
      const config = syncConfigOrder(sourceViewlet.attachTo, previousSourceConfig, sourceConfig, targetConfig)
      if (deepEqual(targetConfig, config)) continue

      childTasks.push(updatePreference(childViewlet._id, { config }))
    }
    if (childTasks.length > 0) {
      await Promise.all(childTasks)
    }
  }

  async function addAssociations (
    result: Config[],
    _class: Ref<Class<Doc>>,
    preference: ViewletPreference | undefined,
    parents: AssociationQuery[] = []
  ): Promise<void> {
    const ancestors = new Set(hierarchy.getAncestors(_class))
    const parent = hierarchy.getParentClass(_class)
    const parentMixins = hierarchy
      .getDescendants(parent)
      .map((p) => hierarchy.getClass(p))
      .filter((p) => hierarchy.isMixin(p._id) && ancestors.has(hierarchy.getBaseClass(p._id)))

    parentMixins.forEach((it) => {
      hierarchy.getOwnAttributes(it._id).forEach((attr) => {
        processAttribute(attr, result, true)
      })
    })

    const allClasses = [...ancestors, ...parentMixins.map((it) => it._id)]

    const associationsB = client.getModel().findAllSync(core.class.Association, { classA: { $in: allClasses } })
    const associationsA = client.getModel().findAllSync(core.class.Association, { classB: { $in: allClasses } })

    for (const a of associationsB) {
      await processAssociation(a, 'b', result, preference, parents)
    }
    for (const a of associationsA) {
      await processAssociation(a, 'a', result, preference, parents)
    }
  }

  interface CustomAttributeItem {
    key: string
    label: IntlString
    enabled: boolean
  }

  interface DescendantAttributeSection {
    _class: Ref<Class<Doc>>
    label: IntlString
    attrs: {
      label: IntlString
      enabled: boolean
      key: string
    }[]
  }

  function getDescendantAttributes (
    selectedViewlet: Viewlet,
    preference: ViewletPreference | undefined
  ): DescendantAttributeSection[] {
    const d = hierarchy
      .getDescendants(viewlet.attachTo)
      .filter((it) => !hierarchy.isMixin(it) && it !== selectedViewlet.attachTo)
    const mixins = hierarchy.getDescendants(viewlet.attachTo).filter((it) => hierarchy.isMixin(it))

    return d
      .map((it) => {
        const clazz = hierarchy.getClass(it)

        const enabled = new Set(
          (preference?.descendantAttributes?.filter((da) => da._class === it) ?? []).map((da) => da.key)
        )
        const seen = new Set<string>()
        const attrs: DescendantAttributeSection['attrs'] = []

        const addAttr = (attr: AnyAttribute, useMixinProxy: boolean): void => {
          if (attr.hidden === true || attr.label === undefined) return
          if (hierarchy.isDerived(attr.type._class, core.class.Collection)) return
          const key = useMixinProxy ? `${attr.attributeOf}.${attr.name}` : attr.name
          if (seen.has(key)) return
          seen.add(key)
          attrs.push({ key, label: attr.label, enabled: enabled.has(key) })
        }

        for (const [, attr] of hierarchy.getOwnAttributes(it)) {
          addAttr(attr, false)
        }

        for (const d of hierarchy.getDescendants(it)) {
          if (!hierarchy.isMixin(d) || mixins.includes(d)) continue
          hierarchy.getOwnAttributes(d).forEach((attr) => {
            addAttr(attr, true)
          })
        }

        return {
          _class: it,
          label: clazz.label,
          attrs
        }
      })
      .filter((it) => it.attrs.length > 0)
  }

  function getCustomAttributes (
    selectedViewlet: Viewlet,
    preference: ViewletPreference | undefined
  ): CustomAttributeItem[] {
    const enabled = new Set(preference?.customAttributes ?? [])
    const seen = new Set<string>()
    const result: CustomAttributeItem[] = []

    const addAttr = (attr: AnyAttribute, useMixinProxy: boolean): void => {
      if (attr.isCustom !== true) return
      if (attr.hidden === true || attr.label === undefined) return
      if (hierarchy.isDerived(attr.type._class, core.class.Collection)) return
      const key = useMixinProxy ? `${attr.attributeOf}.${attr.name}` : attr.name
      if (seen.has(key)) return
      seen.add(key)
      result.push({ key, label: attr.label, enabled: enabled.has(key) })
    }

    for (const [, attr] of hierarchy.getAllAttributes(selectedViewlet.attachTo)) {
      addAttr(attr, false)
    }
    for (const d of hierarchy.getDescendants(selectedViewlet.attachTo)) {
      if (!hierarchy.isMixin(d)) continue
      hierarchy.getOwnAttributes(d).forEach((attr) => {
        addAttr(attr, true)
      })
    }
    // Parent-side mixins (mixins on ancestors, not descendants of attachTo) - matches
    // getConfig/addAssociations coverage so every custom attribute lands in this section.
    const ancestors = new Set(hierarchy.getAncestors(selectedViewlet.attachTo))
    const parent = hierarchy.getParentClass(selectedViewlet.attachTo)
    for (const p of hierarchy.getDescendants(parent)) {
      const cls = hierarchy.getClass(p)
      if (!hierarchy.isMixin(p) || cls.extends === undefined || !ancestors.has(cls.extends)) continue
      hierarchy.getOwnAttributes(p).forEach((attr) => {
        addAttr(attr, true)
      })
    }
    return result
  }

  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let pendingUpdates: Partial<ViewletPreference> | undefined
  let saveChain: Promise<void> = Promise.resolve()

  onDestroy(() => {
    if (saveTimer !== undefined) {
      clearTimeout(saveTimer)
      saveTimer = undefined
    }
    void flushPendingSave()
  })

  async function flushPendingSave (): Promise<void> {
    if (saveTimer !== undefined) {
      clearTimeout(saveTimer)
      saveTimer = undefined
    }
    if (pendingUpdates !== undefined) {
      const updates = pendingUpdates
      pendingUpdates = undefined
      const viewletId = selected
      const selectedV = selectedViewlet
      const previousSourceConfig =
        preferences.find((p) => p.attachedTo === viewletId)?.config ?? selectedV?.config ?? []

      saveChain = saveChain
        .then(async () => {
          await updatePreference(viewletId, updates)
          if (updates.config !== undefined && selectedV !== undefined) {
            await syncChildViewletPreferences(selectedV, previousSourceConfig, updates.config)
          }
        })
        .catch((err) => {
          console.error('Failed to save viewlet preference', err)
        })
      await saveChain
    }
  }

  function scheduleSave (changes: Partial<ViewletPreference>, delayMs = 150): void {
    pendingUpdates = {
      ...pendingUpdates,
      ...changes
    }
    if (saveTimer !== undefined) {
      clearTimeout(saveTimer)
    }
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      void flushPendingSave()
    }, delayMs)
  }

  function saveCustomAttributes (viewletId: Ref<Viewlet>, items: CustomAttributeItem[]): void {
    const customAttributes = items.filter((i) => i.enabled).map((i) => i.key)
    lastSavedCustomAttributes = customAttributes
    scheduleSave({ customAttributes })
  }

  function extractDescendantAttributes (groups: DescendantAttributeSection[]): DescendantAttribute[] {
    const result: DescendantAttribute[] = []
    for (const group of groups) {
      for (const attr of group.attrs) {
        if (attr.enabled) {
          result.push({ _class: group._class, key: attr.key })
        }
      }
    }
    return result
  }

  function saveDescendantAttributes (viewletId: Ref<Viewlet>, descendantAttributes: DescendantAttributeSection[]): void {
    const res = extractDescendantAttributes(descendantAttributes)
    lastSavedDescendantAttributes = res
    scheduleSave({ descendantAttributes: res })
  }

  function save (viewletId: Ref<Viewlet>, items: Array<Config | AttributeConfig>): void {
    const configValues = items.filter(
      (p) =>
        p.value !== undefined &&
        ((p.type === 'divider' && typeof p.value === 'object' && p.value.displayProps?.grow) ||
          (p.type === 'attribute' && (p as AttributeConfig).enabled))
    )
    const config = configValues.map((p) => {
      const value = p.value as string | BuildModelKey
      if (typeof value === 'string' && value.startsWith('custom')) {
        return { key: value, displayProps: { optional: true } }
      }
      return value
    })
    lastSavedConfig = config
    scheduleSave({ config })
  }

  function restoreDefault (viewletId: Ref<Viewlet>): void {
    if (saveTimer !== undefined) {
      clearTimeout(saveTimer)
      saveTimer = undefined
    }
    pendingUpdates = undefined
    lastSavedConfig = undefined
    lastSavedCustomAttributes = undefined
    lastSavedDescendantAttributes = undefined

    saveChain = saveChain
      .then(async () => {
        const preference =
          preferences.find((p) => p.attachedTo === viewletId) ??
          (await client.findOne(view.class.ViewletPreference, { space: core.space.Workspace, attachedTo: viewletId }))
        if (preference !== undefined) {
          await client.remove(preference)
        }
        if (selectedViewlet) {
          configLoading = true
          citems = await getConfig(selectedViewlet, undefined)
          customItems = getCustomAttributes(selectedViewlet, undefined)
          sections = getDescendantAttributes(selectedViewlet, undefined)
          configLoading = false
        }
      })
      .catch((err) => {
        console.error('Failed to restore defaults for viewlet preference', err)
      })
  }

  function setStatus (result: Config[], preference: ViewletPreference): Config[] {
    const orderMap = new Map<string, number>()
    preference.config.forEach((p, idx) => {
      const key = getKey(p)
      if (key !== undefined) orderMap.set(key, idx)
    })

    for (const key of result) {
      if (!isAttribute(key)) continue
      const itemKey = getKey(key.value)
      const index = itemKey !== undefined ? orderMap.get(itemKey) : undefined
      key.enabled = index !== undefined
      key.order = index
    }
    if (viewlet.configOptions?.sortable != null) {
      result.sort((a, b) => {
        if (!isAttribute(a) || !isAttribute(b)) return 0
        if (a.order === undefined && b.order === undefined) return 0
        if (a.order === undefined) return 1
        if (b.order === undefined) return -1
        return a.order - b.order
      })
    }
    return result
  }

  let citems: Config[] = []
  let customItems: CustomAttributeItem[] = []
  let sections: DescendantAttributeSection[] = []
  let configLoading = true
  let loadedSelected: Ref<Viewlet> | undefined
  let lastSavedConfig: Array<BuildModelKey | string> | undefined
  let lastSavedCustomAttributes: string[] | undefined
  let lastSavedDescendantAttributes: DescendantAttribute[] | undefined

  let lastSelected: Ref<Viewlet> | undefined

  $: if (selected !== lastSelected) {
    lastSelected = selected
    loadedSelected = undefined
    lastSavedConfig = undefined
    lastSavedCustomAttributes = undefined
    lastSavedDescendantAttributes = undefined
  }

  function updateCustomAndDescendants (selectedV: Viewlet, pref: ViewletPreference | undefined): void {
    const isNewViewlet = loadedSelected !== selectedV._id
    if (isNewViewlet || lastSavedCustomAttributes === undefined) {
      customItems = getCustomAttributes(selectedV, pref)
    }

    if (isNewViewlet || lastSavedDescendantAttributes === undefined) {
      sections = getDescendantAttributes(selectedV, pref)
    }
  }

  async function loadConfig (selectedV: Viewlet, pref: ViewletPreference | undefined): Promise<void> {
    const isNewViewlet = loadedSelected !== selectedV._id

    if (!isNewViewlet && lastSavedConfig !== undefined) {
      return
    }

    if (isNewViewlet) {
      configLoading = true
    }
    const result = await getConfig(selectedV, pref)
    citems = result
    loadedSelected = selectedV._id
    configLoading = false
  }

  $: selectedViewlet = viewlets.find((it) => it._id === selected)
  $: selectedPreferece = preferences.find((it) => it.attachedTo === selected)

  $: if (selectedViewlet && !loading) {
    void loadConfig(selectedViewlet, selectedPreferece)
    updateCustomAndDescendants(selectedViewlet, selectedPreferece)
  }
</script>

<div class="selectPopup" use:resizeObserver={() => dispatch('changeContent')}>
  <div class="menu-space" />
  <div class="scroll">
    <div class="box">
      {#if loading}
        <Loading />
      {:else}
        {#if viewlets.length > 1}
          <div class="p-1">
            <DropdownLabelsIntl
              kind={'ghost'}
              items={viewlets.map((it) => ({ id: it._id, label: hierarchy.getClass(it.attachTo).label }))}
              {selected}
              on:selected={(evt) => {
                selected = evt.detail
              }}
              width={'100%'}
            />
          </div>
        {/if}

        {#if selectedViewlet}
          {#if configLoading}
            <Loading />
          {:else}
            <ViewletClassSettings
              {viewlet}
              items={citems}
              on:restoreDefaults={() => {
                restoreDefault(selected)
              }}
              on:save={(evt) => {
                save(selected, evt.detail)
              }}
            />
          {/if}
          {#if customItems.length > 0}
            <div class="antiDivider" />
            <div class="menu-group__header">
              <Label label={view.string.CustomAttributes} />
            </div>
            {#each customItems as item}
              <div class="menu-item flex-row-center">
                <ToggleWithLabel
                  bind:on={item.enabled}
                  label={item.label}
                  on:change={(e) => {
                    saveCustomAttributes(selected, customItems)
                  }}
                />
              </div>
            {/each}
          {/if}
          {#if sections.length > 0}
            {#each sections as s}
              <div class="antiDivider" />
              <div class="menu-group__header">
                <Label label={s.label} />
              </div>
              {#each s.attrs as attr}
                <div class="menu-item flex-row-center">
                  <ToggleWithLabel
                    bind:on={attr.enabled}
                    label={attr.label}
                    on:change={(e) => {
                      saveDescendantAttributes(selected, sections)
                    }}
                  />
                </div>
              {/each}
            {/each}
          {/if}
        {/if}
      {/if}
    </div>
  </div>
  <div class="menu-space" />
</div>
