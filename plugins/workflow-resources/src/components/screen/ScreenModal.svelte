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
// See the License for the specific language governing permissions and
// limitations under the License.
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import core, {
    type Doc,
    type DocumentUpdate,
    getCurrentAccount,
    makeDocCollabId,
    type Mixin,
    type Ref,
    type TxCUD
  } from '@hcengineering/core'
  import { getEmbeddedLabel, getResource, IntlString, translate } from '@hcengineering/platform'
  import { createMarkup, getClient, updateMarkup } from '@hcengineering/presentation'
  import type { Task } from '@hcengineering/task'
  import ui, { Label, languageStore, Modal, type TabBase, TabsControl } from '@hcengineering/ui'
  import { findAttributeApplier } from '@hcengineering/view-resources'
  import workflow, { isEmptyAttribute, type Screen, type ScreenField, type ScreenTab } from '@hcengineering/workflow'

  import ScreenAttributesBar from './ScreenAttributesBar.svelte'
  import { type ScreenModalResult } from '../../types'

  export let screen: Screen
  export let tabs: ScreenTab[] = []
  export let fields: ScreenField[] = []
  export let object: Task

  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
  const dispatch = createEventDispatcher<{ close: ScreenModalResult<Task> | null }>()
  const client = getClient()
  const hierarchy = client.getHierarchy()

  let sortedTabs: ScreenTab[] = []
  let selectedTabIndex = 0
  let updates: DocumentUpdate<Task> = {}
  let errorMessage: { label: IntlString, params?: Record<string, any> } | undefined = undefined

  $: sortedTabs = [...tabs].sort((a, b) => (a.rank ?? '').localeCompare(b.rank ?? ''))

  $: tabModels = sortedTabs.map((t): TabBase => ({ label: getEmbeddedLabel(t.name) }))

  $: activeTabId = sortedTabs[selectedTabIndex]?._id ?? sortedTabs[0]?._id

  $: activeFields = fields.filter((f) => f.attachedTo === activeTabId)
  $: sortedActiveFields = [...activeFields].sort((a, b) => (a.rank ?? '').localeCompare(b.rank ?? ''))
  $: activeFieldKeys = sortedActiveFields.map((f) => [f.mixin, f.fieldKey]) as [undefined | Ref<Mixin<Doc>>, string][]

  function isEqual (a: unknown, b: unknown): boolean {
    if (a === b) return true
    if (a == null || b == null) return a === b
    if (typeof a === 'object' && typeof b === 'object') {
      return JSON.stringify(a) === JSON.stringify(b)
    }
    return false
  }

  function isUpdated (key: string, mixin?: Ref<Mixin<Doc>>): boolean {
    const _object = object as Record<string, any>
    const _updates = updates as Record<string, any>
    const attr = hierarchy.findAttribute(mixin ?? object._class, key)
    if (attr != null) {
      const attrClass = attr.type._class
      if (
        hierarchy.isDerived(attrClass, core.class.TypeCollaborativeDoc) ||
        hierarchy.isDerived(attrClass, core.class.TypeMarkup)
      ) {
        if ((_updates[key] == null || _updates[key] === '') && _object[key] != null) {
          return false
        }
      }
    }
    if (mixin == null) {
      return !isEqual(_updates[key], _object[key])
    } else {
      return !isEqual(_updates[key], _object[mixin]?.[key])
    }
  }

  function isCollectionField (field: ScreenField): boolean {
    const attr =
      field.mixin != null
        ? hierarchy.findAttribute(field.mixin, field.fieldKey)
        : hierarchy.findAttribute(object._class, field.fieldKey)
    if (attr == null) return false
    return attr.type?._class === core.class.Collection || hierarchy.isDerived(attr.type?._class, core.class.Collection)
  }

  async function handleSave (): Promise<void> {
    const missingFields: ScreenField[] = []
    const obj = object as Record<string, any>
    const up = updates as Record<string, any>

    for (const field of fields) {
      if (field.required) {
        const key = field.fieldKey
        let val: any
        if (isCollectionField(field)) {
          val = up[key]
        } else if (key in up) {
          val = up[key]
        } else if (field.mixin != null) {
          val = obj[field.mixin]?.[key]
        } else {
          val = obj[key]
        }

        const attr =
          field.mixin != null
            ? hierarchy.findAttribute(field.mixin, field.fieldKey)
            : hierarchy.findAttribute(object._class, field.fieldKey)

        const isEmpty = attr == null ? true : await isEmptyAttribute(hierarchy, object, attr, val)

        if (isEmpty) {
          missingFields.push(field)
        }
      }
    }

    if (missingFields.length > 0) {
      const lang = $languageStore
      const fieldNamesPromises = missingFields.map(async (f) => {
        const attr =
          f.mixin != null
            ? hierarchy.findAttribute(f.mixin, f.fieldKey)
            : hierarchy.findAttribute(object._class, f.fieldKey)
        if (attr?.label != null) {
          return await translate(attr.label, {}, lang)
        }
        return f.fieldKey
      })
      const fieldNames = await Promise.all(fieldNamesPromises)

      if (fieldNames.length === 1) {
        errorMessage = {
          label: workflow.string.FieldRequiredSingleError,
          params: { field: fieldNames[0] }
        }
      } else {
        errorMessage = {
          label: workflow.string.FieldRequiredMultipleError,
          params: { fields: fieldNames.join(', ') }
        }
      }
      return
    }

    errorMessage = undefined

    const keys = Object.keys(updates)

    const _update: DocumentUpdate<Task> = {}
    const _txes: Array<TxCUD<Doc>> = []

    for (const attrKey of keys) {
      const field = fields.find((f) => f.fieldKey === attrKey)
      if (field == null) {
        console.error(`[${attrKey}] field not found`)
        continue
      }
      if (!isUpdated(attrKey, field.mixin)) continue
      const val = (updates as any)[attrKey]

      const attr =
        field?.mixin != null
          ? hierarchy.findAttribute(field.mixin, attrKey)
          : hierarchy.findAttribute(object._class, attrKey)

      if (attr == null) continue

      const attrClass = attr.type._class
      if (
        hierarchy.isDerived(attrClass, core.class.TypeCollaborativeDoc) ||
        hierarchy.isDerived(attrClass, core.class.TypeMarkup)
      ) {
        if (typeof val === 'string' && val.trim().length > 0) {
          const collabId = makeDocCollabId(object, attrKey)
          try {
            await updateMarkup(collabId, val)
          } catch {
            const refId = await createMarkup(collabId, val)
            if (field.mixin != null) {
              const _u = (_update as Record<string, any>)[field.mixin] ?? {}
              _u[attrKey] = refId
              ;(_update as Record<string, any>)[field.mixin] = _u
            } else {
              ;(_update as any)[attrKey] = refId
            }
          }
        }
        continue
      }

      const applierResource = findAttributeApplier(client, field?.mixin ?? object._class, attrKey)
      if (applierResource != null) {
        const applierFn = await getResource(applierResource)
        if (applierFn != null) {
          const applied = await applierFn(object, val)
          if (applied.update != null) {
            Object.assign(_update, applied.update)
          }
          if (applied.txes != null) {
            _txes.push(...applied.txes)
          }
        }
      } else if (field.mixin != null) {
        const factory = client.txFactory
        const tx = factory.createTxMixin(
          object._id,
          object._class,
          object.space,
          field.mixin,
          { [attrKey]: val },
          Date.now(),
          getCurrentAccount().primarySocialId
        )
        _txes.push(tx)
      } else {
        ;(_update as any)[attrKey] = val
      }
    }

    dispatch('close', { update: _update, txes: _txes })
  }

  function handleCancel (): void {
    dispatch('close', null)
  }
</script>

<Modal
  type="type-popup"
  width="medium"
  label={getEmbeddedLabel(screen.name)}
  canSave={true}
  okLabel={ui.string.Save}
  okAction={handleSave}
  padding="0 1rem"
  onCancel={handleCancel}
>
  {#if sortedTabs.length > 1}
    <div class="px-4 min-w-0 screen-modal-tabs">
      <TabsControl model={tabModels} size="small" gap="medium" bind:selected={selectedTabIndex} />
    </div>
  {/if}

  <div class="screen-modal-body modal-settings-padding flex flex-col gap-4">
    {#if activeFieldKeys.length > 0}
      <ScreenAttributesBar
        object={hierarchy.clone(object)}
        _class={object._class}
        keys={activeFieldKeys}
        bind:updates
      />
    {/if}
  </div>

  <svelte:fragment slot="footer">
    {#if errorMessage}
      <div class="screen-modal-error text-normal-14 truncate">
        <Label label={errorMessage.label} params={errorMessage.params} />
      </div>
    {/if}
  </svelte:fragment>
</Modal>

<style lang="scss">
  .screen-modal-body {
    min-height: 12rem;
  }

  .screen-modal-error {
    color: var(--global-error-TextColor, #f87171);
    margin-right: auto;
    font-size: 0.875rem;
    line-height: 1.25rem;
    align-self: center;
  }

  .screen-modal-tabs {
    :global(.tabs-container) {
      flex-wrap: wrap !important;
      height: auto !important;
      overflow-x: visible !important;
    }
  }
</style>
