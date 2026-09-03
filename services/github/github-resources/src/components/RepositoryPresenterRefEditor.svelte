<!--
//
// Copyright © 2023 Hardcore Engineering Inc.
// Copyright © 2026 Intabia Fusion.
//
-->
<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import { Doc, Ref } from '@hcengineering/core'
  import { IntlString, getEmbeddedLabel } from '@hcengineering/platform'
  import {
    Button,
    ButtonKind,
    ButtonSize,
    IconChevronDown,
    LabelAndProps,
    SelectPopup,
    SelectPopupValueType,
    eventToHTMLElement,
    showPopup
  } from '@hcengineering/ui'
  import { HyperlinkEditor } from '@hcengineering/view-resources'
  import { GithubIntegrationRepository, GithubProject } from '@hcengineering/github'
  import github from '../plugin'
  import { integrationRepositories } from './utils'

  export let value: Ref<GithubIntegrationRepository> | undefined = undefined
  export let space: Ref<GithubProject> | undefined = undefined
  export let object: Doc | undefined = undefined
  export let kind: ButtonKind | undefined = undefined
  export let size: ButtonSize = 'small'
  export let justify: 'left' | 'center' = 'center'
  export let width: string | undefined = 'fit-content'
  export let onChange: ((value: Ref<GithubIntegrationRepository> | undefined) => void) | undefined = undefined
  export let disabled: boolean = false
  export let readonly: boolean = false
  export let draft: boolean = false
  export let popupPlaceholder: IntlString = github.string.Repository
  export let focusIndex: number | undefined = undefined
  export let showTooltip: LabelAndProps | undefined = undefined
  export let label: IntlString = github.string.AssignRepository
  export let showIcon: boolean = false

  $: targetSpace = space ?? (object?.space as Ref<GithubProject> | undefined)

  $: repository = value != null ? $integrationRepositories.get(value) : undefined

  let selectedRepository: GithubIntegrationRepository | undefined

  $: rawComponents = Array.from($integrationRepositories.values()).filter(
    (it) => targetSpace == null || it.githubProject === targetSpace
  )

  const handleSelectedRepositoryIdUpdated = async (
    newRepositoryId: Ref<GithubIntegrationRepository> | null | undefined,
    components: GithubIntegrationRepository[]
  ): Promise<void> => {
    if (newRepositoryId === null || newRepositoryId === undefined) {
      selectedRepository = undefined

      return
    }
    selectedRepository = components.find((it) => it._id === newRepositoryId)
  }

  $: void handleSelectedRepositoryIdUpdated(value, rawComponents)

  function getRepositoryInfo (
    rawComponents: GithubIntegrationRepository[],
    sp: GithubIntegrationRepository | undefined
  ): SelectPopupValueType[] {
    return [
      ...rawComponents.map((p) => ({
        id: p._id,
        icon: github.icon.Github,
        label: getEmbeddedLabel(p.name),
        props: {
          value: p
        }
      }))
    ]
  }

  let components: SelectPopupValueType[] = []
  $: components = getRepositoryInfo(rawComponents, selectedRepository)

  function handleSelect (newValue: Ref<GithubIntegrationRepository> | undefined): void {
    value = newValue
    if (draft && object != null) {
      ;(object as any).repository = newValue
    }
    onChange?.(newValue)
  }

  const handleRepositoryEditorOpened = async (event: MouseEvent): Promise<void> => {
    event.stopPropagation()
    if (disabled || readonly) {
      return
    }

    showPopup(
      SelectPopup,
      { value: components, placeholder: popupPlaceholder, searchable: false },
      eventToHTMLElement(event),
      (res: any) => {
        if (res !== undefined) {
          handleSelect(res as Ref<GithubIntegrationRepository> | undefined)
        }
      }
    )
  }
</script>

{#if value == null || draft}
  <Button
    {kind}
    {justify}
    {size}
    {focusIndex}
    {showTooltip}
    disabled={disabled || readonly}
    label={(selectedRepository?.name ?? repository?.name) ? undefined : label}
    icon={showIcon || selectedRepository || repository ? github.icon.Github : undefined}
    iconRight={disabled || readonly ? undefined : IconChevronDown}
    on:click={handleRepositoryEditorOpened}
  >
    <svelte:fragment slot="content">
      {#if selectedRepository !== undefined || repository !== undefined}
        {(selectedRepository ?? repository)?.name}
      {/if}
    </svelte:fragment>
  </Button>
{:else}
  <HyperlinkEditor
    value={repository?.htmlURL ?? ''}
    placeholder={getEmbeddedLabel(repository?.name ?? '')}
    title={repository?.name ?? ''}
    readonly
    icon={github.icon.Github}
    {kind}
    {size}
    {justify}
    {width}
  />
{/if}
