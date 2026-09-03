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
  import { AnyAttribute, Class, Doc, generateId, Mixin, notEmpty, Ref } from '@hcengineering/core'
  import presentation, { getAttributeEditor, getClient, reduceCalls } from '@hcengineering/presentation'
  import { TaskType } from '@hcengineering/task'
  import {
    AnySvelteComponent,
    DropdownTextItem,
    eventToHTMLElement,
    languageStore,
    ModernButton,
    showPopup
  } from '@hcengineering/ui'
  import {
    CollectionOperation,
    UpdateFieldValueConfig,
    UpdateFieldValuePostFnConfig,
    UpdateFieldValueProps,
    WorkflowFieldValue,
    WorkflowTransformCall,
    WorkflowValueFunction
  } from '@hcengineering/workflow'
  import { getEmbeddedLabel } from '@hcengineering/platform'

  import { DisplayAttribute, getDisplayAttributes } from '../../../utils'
  import ContextSubmenuPopup from './update-field/ContextSubmenuPopup.svelte'
  import Row from './update-field/Row.svelte'
  import { ContextOption, FieldRow, TransformOption } from './update-field/types'
  import {
    ensureFieldValue,
    EXCLUDED_FIELDS,
    EXCLUDED_TYPES,
    getContextOptions,
    getTransformOptions,
    isCollectionAttribute
  } from './update-field/utils'

  export let taskType: TaskType
  export let config: UpdateFieldValuePostFnConfig | undefined = undefined
  export let canSave = false

  const dispatch = createEventDispatcher<{ update: UpdateFieldValueProps }>()
  const client = getClient()

  let resultFields: UpdateFieldValueConfig[] = []
  let displayAttributes: DisplayAttribute[] = []
  let items: DropdownTextItem[] = []
  let rows: FieldRow[] = initRows()

  const updateItems = reduceCalls(async (ofClass: Ref<Class<Doc>>, lang: string): Promise<void> => {
    const displayAttributeGroups = await getDisplayAttributes(
      ofClass,
      lang,
      Array.from(EXCLUDED_FIELDS),
      Array.from(EXCLUDED_TYPES)
    )

    const _items: DropdownTextItem[] = []
    const _displayAttrs: DisplayAttribute[] = []

    displayAttributeGroups.forEach((group, groupIdx) => {
      const processAttr = (attr: DisplayAttribute, idx: number, isRegular: boolean): void => {
        _displayAttrs.push(attr)
        const isFirstInGroup = groupIdx > 0 && idx === 0 && isRegular
        const isFirstCollection = group.regular.length > 0 && !isRegular && idx === 0
        _items.push({
          id: attr.id,
          label: attr.label,
          icon: attr.icon,
          iconProps: attr.iconProps,
          separatorBefore: isFirstInGroup || isFirstCollection,
          separatorLabel: isFirstInGroup ? getEmbeddedLabel(group.classLabel) : undefined
        })
      }

      group.regular.forEach((attr: DisplayAttribute, idx: number) => {
        processAttr(attr, idx, true)
      })
      group.collection.forEach((attr, idx) => {
        processAttr(attr, idx, false)
      })
    })

    displayAttributes = _displayAttrs
    items = _items
    await syncRows(rows)
  })

  const syncRows = reduceCalls(async (currentRows: FieldRow[]): Promise<void> => {
    for (const row of currentRows) {
      if (row.fieldKey === '') continue
      if (row.editor === undefined || row.attribute === undefined) {
        await loadRowEditor(row.id, row.fieldKey, row.mixin)
      }
    }
  })

  $: void updateItems(taskType.targetClass, $languageStore)
  $: void syncRows(rows)

  $: resultFields = rows
    .filter((r) => r.fieldKey.trim() !== '' && r.attribute != null)
    .map<UpdateFieldValueConfig>((r) => ({
    attribute: (r.attribute?._id ?? '') as Ref<AnyAttribute>,
    fieldKey: r.fieldKey,
    value: r.value,
    operation: r.operation,
    mixin: r.mixin
  }))

  $: canSave = resultFields.length > 0
  $: dispatch('update', { fields: resultFields })

  $: usedAttributes = new Set(
    rows
      .filter((r) => {
        if (r.attribute != null) {
          return !isCollectionAttribute(client.getHierarchy(), r.attribute)
        }
        return false
      })
      .map((r) => r.attribute?._id)
      .filter(notEmpty)
  )

  function getRowAvailableItems (
    currentRow: FieldRow,
    used: Set<Ref<AnyAttribute>>,
    items: DropdownTextItem[]
  ): DropdownTextItem[] {
    if (used.size === 0) return items
    const currentAttrId = currentRow.attribute?._id

    return items.filter((item) => item.id === currentAttrId || !used.has(item.id as Ref<AnyAttribute>))
  }

  function createRow (
    fieldKey = '',
    value: unknown = { type: 'const', value: '' },
    mixin?: Ref<Class<Mixin<Doc>>>,
    operation?: CollectionOperation
  ): FieldRow {
    return {
      id: generateId(),
      fieldKey,
      value: ensureFieldValue(value),
      mixin,
      operation
    }
  }

  function initRows (): FieldRow[] {
    const props = config?.props
    if (props?.fields != null && (props?.fields?.length ?? 0) > 0) {
      return props.fields.map((it) => createRow(it.fieldKey, it.value, it.mixin, it.operation))
    }
    return [createRow()]
  }

  function addRow (): void {
    rows = [...rows, createRow()]
  }

  function removeRow (rowId: string): void {
    rows = rows.length > 1 ? rows.filter((r) => r.id !== rowId) : [createRow()]
  }

  async function loadRowEditor (rowId: string, key: string, mixin?: Ref<Class<Mixin<Doc>>>): Promise<void> {
    if (key === '') return

    const targetClass = mixin ?? taskType?.targetClass
    const hierarchy = client.getHierarchy()
    const attr = hierarchy.findAttribute(targetClass, key)

    if (attr == null) return

    const ed: AnySvelteComponent | undefined = await getAttributeEditor(client, targetClass, attr.name)

    const row = rows.find((r) => r.id === rowId)
    if (row != null && row.fieldKey === key) {
      let changed = false
      if (row.attribute !== attr) {
        row.attribute = attr
        changed = true
      }
      if (row.editor !== ed) {
        row.editor = ed
        changed = true
      }
      if (isCollectionAttribute(hierarchy, attr) && row.operation == null) {
        row.operation = 'set'
        changed = true
      }
      if (changed) {
        rows = [...rows]
      }
    }
  }

  async function onSelectField (rowId: string, fieldId: string): Promise<void> {
    if (fieldId === '') return
    const attr = displayAttributes.find((it) => it.id === fieldId)
    if (attr == null) return
    const row = rows.find((r) => r.id === rowId)
    if (row != null) {
      const targetClass = attr.mixin ?? taskType?.targetClass
      const hierarchy = client.getHierarchy()
      const foundAttr = hierarchy.findAttribute(targetClass, attr.key)

      row.fieldKey = attr.key
      row.mixin = attr.mixin
      row.attribute = foundAttr
      row.editor = undefined
      row.operation = attr.collection ? 'add' : undefined
      row.value = { type: 'const', value: attr.collection ? [] : '' }
      rows = [...rows]
      await loadRowEditor(row.id, attr.key, attr.mixin)
    }
  }

  function onRowOperationChange (rowId: string, op: CollectionOperation): void {
    const row = rows.find((r) => r.id === rowId)
    if (row != null) {
      row.operation = op
      rows = [...rows]
    }
  }

  function onRowValueChange (rowId: string, val: WorkflowFieldValue): void {
    const row = rows.find((r) => r.id === rowId)
    if (row != null) {
      const functions = val.functions ?? row.value?.functions
      row.value = {
        ...val,
        ...(functions != null && functions.length > 0 ? { functions } : {})
      }
      rows = [...rows]
    }
  }

  function selectContext (rowId: string, e: MouseEvent): void {
    const row = rows.find((r) => r.id === rowId)
    if (row?.attribute == null) return
    const options = getContextOptions(client, taskType, row.attribute)
    if (options.length === 0) return

    showPopup(
      ContextSubmenuPopup,
      {
        options,
        onSelect: (selectedOpt: ContextOption) => {
          if (selectedOpt.value != null) {
            onRowValueChange(rowId, selectedOpt.value)
          }
        }
      },
      eventToHTMLElement(e)
    )
  }

  function selectTransform (rowId: string, e: MouseEvent): void {
    const row = rows.find((r) => r.id === rowId)
    if (row?.attribute == null) return
    const options = getTransformOptions(client, row.attribute)
    if (options.length === 0) return

    showPopup(
      ContextSubmenuPopup,
      {
        options,
        onSelect: (selectedOpt: TransformOption) => {
          if (selectedOpt.funcRef != null) {
            const funcRef = selectedOpt.funcRef
            const fnDoc = client.getModel().getObject<WorkflowValueFunction>(funcRef)

            if (fnDoc?.editor != null) {
              showPopup(fnDoc.editor, { func: fnDoc }, eventToHTMLElement(e), (propsRes) => {
                if (propsRes != null) {
                  appendTransform(rowId, { func: funcRef, props: propsRes })
                }
              })
            } else {
              appendTransform(rowId, { func: funcRef })
            }
          }
        }
      },
      eventToHTMLElement(e)
    )
  }

  function appendTransform (rowId: string, transformCall: WorkflowTransformCall): void {
    const row = rows.find((r) => r.id === rowId)
    if (row?.value?.type == null) return

    const _functions = row.value.functions ?? []
    row.value = {
      ...row.value,
      functions: [..._functions, transformCall]
    }
    rows = [...rows]
  }

  function editTransform (rowId: string, transformCall: WorkflowTransformCall, e: MouseEvent): void {
    const funcRef = transformCall?.func
    if (funcRef == null) return
    const fnDoc = client.getModel().getObject<WorkflowValueFunction>(funcRef)
    if (fnDoc?.editor == null) return

    showPopup(fnDoc.editor, { func: fnDoc, props: transformCall.props ?? {} }, eventToHTMLElement(e), (propsRes) => {
      if (propsRes != null) {
        updateTransformPropsInRow(rowId, transformCall, propsRes)
      }
    })
  }

  function updateTransformPropsInRow (
    rowId: string,
    transformCall: WorkflowTransformCall,
    newProps: Record<string, any>
  ): void {
    const row = rows.find((r) => r.id === rowId)
    if (row?.value?.type == null) return
    const _functions = row.value.functions ?? []
    if (_functions != null) {
      const newFuncs = _functions.map((fn) => {
        if (fn === transformCall) {
          return typeof fn === 'object' ? { ...fn, props: newProps } : { func: fn, props: newProps }
        }
        return fn
      })
      row.value = {
        ...row.value,
        functions: newFuncs
      }
      rows = [...rows]
    }
  }
</script>

<div class="update-field-value">
  {#each rows as row (row.id)}
    <Row
      {row}
      _class={taskType.targetClass}
      canRemove={rows.length > 1}
      dropdownItems={getRowAvailableItems(row, usedAttributes, items)}
      contextOptions={getContextOptions(client, taskType, row.attribute)}
      on:select={(e) => {
        void onSelectField(row.id, String(e.detail))
      }}
      on:context={(e) => {
        selectContext(row.id, e.detail)
      }}
      on:transform={(e) => {
        selectTransform(row.id, e.detail)
      }}
      on:editTransform={(e) => {
        editTransform(row.id, e.detail.fn, e.detail.event)
      }}
      on:remove={() => {
        removeRow(row.id)
      }}
      on:clear={() => {
        const isCollection = row.attribute != null && isCollectionAttribute(client.getHierarchy(), row.attribute)
        onRowValueChange(row.id, { type: 'const', value: isCollection ? [] : '' })
      }}
      on:operation={(e) => {
        onRowOperationChange(row.id, e.detail)
      }}
      on:value={(e) => {
        onRowValueChange(row.id, e.detail)
      }}
    />
  {/each}

  <div class="update-field-value__add-row">
    <ModernButton label={presentation.string.Add} kind="secondary" size="small" on:click={addRow} />
  </div>
</div>

<style lang="scss">
  .update-field-value {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;

    &__add-row {
      display: flex;
      justify-content: flex-start;
      margin-top: 0.25rem;
    }
  }
</style>
