<!--
// Copyright © 2023 Hardcore Engineering Inc.
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
  import core, { IdMap, Ref, toIdMap, groupByArray, reduceCalls } from '@hcengineering/core'
  import {
    NotificationType,
    NotificationProvider,
    NotificationGroup,
    NotificationTypeSetting,
    NotificationProviderDefaults,
    NotificationProviderSetting
  } from '@hcengineering/notification'
  import { getResource } from '@hcengineering/platform'
  import { getClient } from '@hcengineering/presentation'
  import { DropdownLabelsIntl, Grid, Label, ModernToggle } from '@hcengineering/ui'

  import notification from '../../plugin'
  import { providersSettings } from '../../stores'

  export let group: Ref<NotificationGroup>
  export let settings: Map<Ref<NotificationType>, NotificationTypeSetting[]>

  const client = getClient()

  const providers: NotificationProvider[] = client
    .getModel()
    .findAllSync(notification.class.NotificationProvider, {})
    .sort((provider1, provider2) => provider1.order - provider2.order)
  const providerDefaults: NotificationProviderDefaults[] = client
    .getModel()
    .findAllSync(notification.class.NotificationProviderDefaults, {})
  const providersMap: IdMap<NotificationProvider> = toIdMap(providers)

  let subGroupId: Ref<NotificationGroup> =
    client.getModel().findAllSync(notification.class.NotificationGroup, { parent: group })[0]?._id ?? group
  let prevGroup: Ref<NotificationGroup> = group

  let allTypes: NotificationType[] = []
  let subGroups: NotificationGroup[] = []

  $: if (prevGroup !== group) {
    subGroupId = client.getModel().findAllSync(notification.class.NotificationGroup, { parent: group })[0]?._id ?? group
    prevGroup = group
  }

  const loadSubGroups = reduceCalls(async (g: Ref<NotificationGroup>): Promise<void> => {
    subGroups = await client.findAll(notification.class.NotificationGroup, { parent: g })
  })

  const loadAllTypes = reduceCalls(async (g: Ref<NotificationGroup>): Promise<void> => {
    allTypes = await client.findAll(notification.class.NotificationType, { group: g, hidden: { $ne: true } })
  })

  $: void loadSubGroups(group)
  $: void loadAllTypes(group)

  $: typesMap = groupByArray(allTypes, (it) => it.subGroup ?? group)
  $: typesById = toIdMap(allTypes)
  $: types = typesMap.get(subGroupId ?? group) ?? []

  $: subGroup = subGroups.find((it) => it._id === subGroupId)

  function getStatus (
    settings: Map<Ref<NotificationType>, NotificationTypeSetting[]>,
    type: Ref<NotificationType>,
    provider: Ref<NotificationProvider>
  ): boolean {
    const setting = getTypeSetting(settings, type, provider)
    if (setting !== undefined) return setting.enabled
    const prov = providersMap.get(provider)
    if (prov === undefined) return false
    const providerEnabled = providerDefaults.some((it) => it.provider === provider && it.enabledTypes.includes(type))
    if (providerEnabled) return true
    const typeValue = typesById.get(type)
    if (typeValue === undefined) return false
    return typeValue.defaultEnabled
  }

  async function onToggle (
    typeId: Ref<NotificationType>,
    providerId: Ref<NotificationProvider>,
    value: boolean
  ): Promise<void> {
    const provider = providersMap.get(providerId)
    if (provider === undefined) return
    const currentSetting = getTypeSetting(settings, typeId, providerId)
    if (currentSetting === undefined) {
      await client.createDoc(notification.class.NotificationTypeSetting, core.space.Workspace, {
        attachedTo: providerId,
        type: typeId,
        enabled: value
      })
    } else {
      await client.update(currentSetting, {
        enabled: value
      })
    }
    if (value && provider?.depends !== undefined) {
      const current = getStatus(settings, typeId, provider.depends)
      if (!current) {
        await onToggle(typeId, provider.depends, true)
      }
    } else if (!value) {
      const dependents = providers.filter(({ depends }) => depends === providerId)
      for (const dependent of dependents) {
        await onToggle(typeId, dependent._id, false)
      }
    }
  }

  function getTypeSetting (
    map: Map<Ref<NotificationType>, NotificationTypeSetting[]>,
    type: Ref<NotificationType>,
    provider: Ref<NotificationProvider>
  ): NotificationTypeSetting | undefined {
    const typeMap = map.get(type)
    if (typeMap === undefined) return
    return typeMap.find((p) => p.attachedTo === provider)
  }

  function isIgnored (type: Ref<NotificationType>, provider: NotificationProvider): boolean {
    const ignored = providerDefaults.some((it) => provider._id === it.provider && it.ignoredTypes.includes(type))

    if (ignored) return true

    if (provider.ignoreAll === true) {
      return !providerDefaults.some((it) => provider._id === it.provider && it.excludeIgnore?.includes(type) === true)
    }

    return false
  }

  async function getFilteredProviders (
    providers: NotificationProvider[],
    types: NotificationType[],
    providersSettings: NotificationProviderSetting[]
  ): Promise<NotificationProvider[]> {
    const result: NotificationProvider[] = []

    for (const provider of providers) {
      const providerSetting = providersSettings.find((p) => p.attachedTo === provider._id)

      if (providerSetting !== undefined && !providerSetting.enabled) continue
      if (providerSetting === undefined && !provider.defaultEnabled) continue

      if (provider.isAvailableFn !== undefined) {
        const isAvailableFn = await getResource(provider.isAvailableFn)
        if (!isAvailableFn()) continue
      }

      if (provider.ignoreAll === true) {
        const ignoreExcluded = providerDefaults
          .map((it) => (provider._id === it.provider && it.excludeIgnore !== undefined ? it.excludeIgnore : []))
          .flat()

        const included = types.some((type) => ignoreExcluded.includes(type._id))
        if (!included) continue
      }

      result.push(provider)
    }

    return result
  }

  let filteredProviders: NotificationProvider[] = []

  $: void getFilteredProviders(providers, typesMap.get(subGroupId) ?? [], $providersSettings).then((result) => {
    filteredProviders = result
  })

  $: column = filteredProviders.length + 1
  $: items = subGroups.map((it) => ({ id: it._id, label: it.label, icon: it.icon }))

  function sortTypes (types: NotificationType[]): NotificationType[] {
    return types.sort((a, b) => {
      const aAttachedTo = a.attachedToClass ?? a.objectClass
      const bAttachedTp = b.attachedToClass ?? b.objectClass

      const aIsCollection = aAttachedTo !== a.objectClass
      const bIsCollection = bAttachedTp !== b.objectClass
      if (aIsCollection && !bIsCollection) return 1
      if (!aIsCollection && bIsCollection) return -1

      return a.label.toLocaleLowerCase().localeCompare(b.label.toLocaleLowerCase())
    })
  }
</script>

<div class="container">
  {#if subGroups.length > 0}
    <DropdownLabelsIntl
      {items}
      kind="regular"
      size="large"
      icon={subGroup?.icon}
      bind:selected={subGroupId}
      label={notification.string.General}
    />
    <span class="flex mb-8" />
  {/if}
  <Grid {column} columnGap={5} rowGap={1.5}>
    {#each sortTypes(types) as type}
      <div class="flex">
        <Label label={type.label} />
      </div>
      {#each filteredProviders as provider (provider._id)}
        {#if !isIgnored(type._id, provider)}
          {@const status = getStatus(settings, type._id, provider._id)}
          <div class="toggle">
            <ModernToggle
              size="small"
              label={provider.label}
              checked={status}
              on:change={() => onToggle(type._id, provider._id, !status)}
            />
          </div>
        {:else}
          <div />
        {/if}
      {/each}
    {/each}
  </Grid>
</div>

<style lang="scss">
  .container {
    width: fit-content;
  }

  .toggle {
    width: fit-content;
  }
</style>
