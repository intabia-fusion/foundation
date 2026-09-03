<!--
// Copyright © 2022 Hardcore Engineering Inc.
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
  import { DocumentQuery, Ref, SortingOrder } from '@hcengineering/core'
  import { IntlString } from '@hcengineering/platform'
  import { createQuery } from '@hcengineering/presentation'
  import { Component } from '@hcengineering/tracker'
  import type { ButtonKind, ButtonSize, LabelAndProps, SelectPopupValueType } from '@hcengineering/ui'
  import { Button, ButtonShape, eventToHTMLElement, showPopup, PopupResult } from '@hcengineering/ui'
  import tracker from '../../plugin'
  import ComponentPresenter from './ComponentPresenter.svelte'
  import ComponentSelectorPopup from './ComponentSelectorPopup.svelte'

  export let value: Ref<Component> | null | undefined
  export let space: DocumentQuery<Component>['space'] | undefined = undefined
  export let query: DocumentQuery<Component> = {}
  // export let shouldShowLabel: boolean = true
  export let isEditable: boolean = true
  export let onChange: ((newComponentId: Ref<Component> | undefined) => void) | undefined = undefined
  export let popupPlaceholder: IntlString = tracker.string.AddToComponent
  export let kind: ButtonKind = 'no-border'
  export let size: ButtonSize = 'small'
  export let shape: ButtonShape = undefined
  export let justify: 'left' | 'center' = 'center'
  export let width: string | undefined = 'min-content'
  export let maxLabelWidth: string | undefined = undefined
  // export let onlyIcon: boolean = false
  export let enlargedText: boolean = false
  export let short: boolean = false
  export let focusIndex: number | undefined = undefined
  export let isAction: boolean = false
  export let isAllowUnset = true

  export let showTooltip: LabelAndProps | undefined = undefined
  let selectedComponent: Component | undefined

  const queryQuery = createQuery()
  let rawComponents: Component[] = []
  $: queryQuery.query(
    tracker.class.Component,
    { ...query, ...(space ? { space } : {}) },
    (res) => {
      rawComponents = res
    },
    {
      sort: { modifiedOn: SortingOrder.Ascending }
    }
  )

  const handleSelectedComponentIdUpdated = (
    newComponentId: Ref<Component> | null | undefined,
    components: Component[]
  ): void => {
    if (newComponentId === null || newComponentId === undefined) {
      selectedComponent = undefined

      return
    }

    selectedComponent = components.find((it) => it._id === newComponentId)
  }

  $: handleSelectedComponentIdUpdated(value, rawComponents)

  function getComponentInfo (rawComponents: Component[], sp: Component | undefined): SelectPopupValueType[] {
    return [
      ...(isAllowUnset
        ? [
            {
              id: null,
              icon: tracker.icon.Component,
              label: tracker.string.NoComponent,
              isSelected: sp === undefined
            }
          ]
        : []),
      ...rawComponents.map((p) => ({
        id: p._id,
        icon: tracker.icon.Component,
        text: p.label,
        isSelected: sp ? p._id === sp._id : false,
        component: ComponentPresenter,
        props: {
          value: p
        }
      }))
    ]
  }

  let components: SelectPopupValueType[] = []
  $: components = getComponentInfo(rawComponents, selectedComponent)

  let selectPopupResult: PopupResult | undefined

  $: popupSpace = typeof space === 'string' ? space : undefined

  // We need update SelectPopup when it active
  $: selectPopupResult?.update({ value: components })

  const handleComponentEditorOpened = async (event: MouseEvent): Promise<void> => {
    event.stopPropagation()
    if (!isEditable) {
      return
    }

    selectPopupResult = showPopup(
      ComponentSelectorPopup,
      {
        value: components,
        placeholder: popupPlaceholder,
        space: popupSpace
      },
      eventToHTMLElement(event),
      (result: any) => {
        if (result !== undefined) {
          onChange?.(result)
        }
        selectPopupResult = undefined
      }
    )
  }
</script>

{#if isAction}
  <ComponentSelectorPopup
    value={components}
    placeholder={popupPlaceholder}
    space={popupSpace}
    on:close={(evt) => {
      if (evt.detail !== undefined && onChange !== undefined) onChange(evt.detail)
    }}
  />
{:else}
  <Button
    {focusIndex}
    {kind}
    {size}
    {shape}
    {width}
    {justify}
    {showTooltip}
    icon={tracker.icon.Component}
    disabled={!isEditable}
    notSelected={!value}
    {short}
    on:click={handleComponentEditorOpened}
  >
    <svelte:fragment slot="content">
      <span
        class="label {enlargedText ? 'text-base' : 'text-md'} overflow-label pointer-events-none"
        style:max-width={maxLabelWidth}
      >
        <svelte:component this={ComponentPresenter} value={selectedComponent} shouldShowAvatar={false} />
      </span>
    </svelte:fragment>
  </Button>
{/if}
