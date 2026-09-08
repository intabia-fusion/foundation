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
  import { apiKeyOperations, type ApiKeyOperation, type CreatedApiKey } from '@hcengineering/account-client'
  import core, { type Ref, type Space } from '@hcengineering/core'
  import presentation, { createQuery, getClient } from '@hcengineering/presentation'
  import ui, {
    Button,
    ButtonIcon,
    Chip,
    DatePresenter,
    IconAdd,
    Label,
    Modal,
    ModernEditbox,
    NumberInput,
    RadioGroup,
    Spinner,
    Toggle,
    eventToHTMLElement,
    showPopup,
    type RadioItem
  } from '@hcengineering/ui'
  import { createEventDispatcher } from 'svelte'
  import settingsRes from '../plugin'
  import { formatApiKeyError, getAccountClient, isApiKeyPickableSpace } from '../utils'
  import ApiKeyOperationsPopup from './ApiKeyOperationsPopup.svelte'
  import ApiKeySpacesPopup from './ApiKeySpacesPopup.svelte'

  export let personal: boolean = false

  // Mirrors minApiKeyTokenTtlMs/maxApiKeyTokenTtlMs/defaultApiKeyTokenTtlMs in server/account/src/apiKeys.ts
  const minTokenTtlDays = 1
  const maxTokenTtlDays = 90
  const dayMs = 24 * 60 * 60 * 1000

  const hierarchy = getClient().getHierarchy()

  let name = ''
  let ops = new Set<ApiKeyOperation>()
  let spaces: Ref<Space>[] = []
  let expiresOn: number | null = null
  let tokenTtlDays = 7
  let incoming = false
  let loading = false
  let error: string | undefined

  // Same set ApiKeySpacesPopup offers - keeps "Add all" and the picker from ever disagreeing.
  let pickableSpaces: Space[] = []
  const spacesQuery = createQuery()
  spacesQuery.query(core.class.Space, {}, (res) => {
    pickableSpaces = res.filter((s) => isApiKeyPickableSpace(hierarchy, s))
  })
  $: spaceNames = new Map<Ref<Space>, string>(pickableSpaces.map((s) => [s._id, s.name]))

  // Personal key only: 'full' writes with the user's own rights, narrowed by the spaces below.
  // No operations here - a key carrying them writes only through the ops API.
  let personalGrant: 'full' | 'readonly' = 'full'
  const grantItems: RadioItem[] = [
    { id: 'full', labelIntl: settingsRes.string.ApiKeyFullRights, value: 'full' },
    { id: 'readonly', labelIntl: settingsRes.string.ApiKeyReadOnly, value: 'readonly' }
  ]

  $: unrestricted = personal && personalGrant === 'full'
  $: showOps = !personal
  $: showSpaces = !personal || personalGrant === 'full'

  const dispatch = createEventDispatcher()

  // A token must not outlive the key: the expiry date, when set, caps the lifetime.
  $: daysUntilExpiry = expiresOn == null ? maxTokenTtlDays : Math.ceil((expiresOn - Date.now()) / dayMs)
  $: effectiveMaxTtlDays = Math.max(minTokenTtlDays, Math.min(maxTokenTtlDays, daysUntilExpiry))
  $: if (tokenTtlDays > effectiveMaxTtlDays) tokenTtlDays = effectiveMaxTtlDays
  $: validTtl =
    Number.isInteger(tokenTtlDays) && tokenTtlDays >= minTokenTtlDays && tokenTtlDays <= effectiveMaxTtlDays
  $: canSave = !loading && name.trim().length > 0 && validTtl

  function removeOp (op: ApiKeyOperation): void {
    ops.delete(op)
    ops = ops
  }

  function pickOps (event: MouseEvent): void {
    showPopup(
      ApiKeyOperationsPopup,
      { selected: Array.from(ops) },
      eventToHTMLElement(event),
      undefined,
      (result: ApiKeyOperation[] | undefined) => {
        if (result != null) {
          ops = new Set(result)
        }
      }
    )
  }

  function addAllOps (): void {
    ops = new Set(apiKeyOperations)
  }

  function removeSpace (spaceId: Ref<Space>): void {
    spaces = spaces.filter((id) => id !== spaceId)
  }

  function pickSpaces (event: MouseEvent): void {
    // Selection commits via the popup's 'update' event (live, like RoleEditor/ArrayEditor's ObjectBoxPopup usage).
    showPopup(
      ApiKeySpacesPopup,
      { selectedObjects: spaces },
      eventToHTMLElement(event),
      undefined,
      (result: Ref<Space>[] | undefined) => {
        if (result != null) {
          spaces = result
        }
      }
    )
  }

  async function save (): Promise<void> {
    loading = true
    try {
      const result: CreatedApiKey = await getAccountClient().createApiKey({
        name: name.trim(),
        ops: personal ? [] : Array.from(ops),
        spaces: showSpaces ? spaces : [],
        expiresOn: expiresOn ?? undefined,
        tokenTtlMs: tokenTtlDays * dayMs,
        personal,
        unrestricted,
        incoming
      })
      loading = false
      dispatch('close', result)
    } catch (err: any) {
      loading = false
      error = await formatApiKeyError(err)
    }
  }
</script>

<Modal
  label={personal ? settingsRes.string.CreatePersonalApiKey : settingsRes.string.CreateIntegrationApiKey}
  type="type-popup"
  width="medium"
  okLabel={presentation.string.Create}
  okAction={save}
  {canSave}
  showCancelButton={false}
  onCancel={() => {
    dispatch('close')
  }}
>
  <div class="flex-col-stretch flex-gap-4">
    <ModernEditbox bind:value={name} label={settingsRes.string.ApiKeyName} size="medium" autoFocus />

    {#if personal}
      <RadioGroup items={grantItems} bind:selected={personalGrant} gap="large" />
      <div class="hint">
        <Label
          label={personalGrant === 'full'
            ? settingsRes.string.PersonalApiKeyHint
            : settingsRes.string.PersonalApiKeyReadOnlyHint}
        />
      </div>
    {/if}

    {#if showOps}
      <div class="flex-col flex-gap-2">
        <div class="flex-row-center flex-between">
          <Label label={settingsRes.string.ApiKeyOperations} />
          <div class="flex-row-center flex-gap-1">
            <ButtonIcon
              kind="tertiary"
              size="small"
              icon={IconAdd}
              tooltip={{ label: presentation.string.Add }}
              on:click={pickOps}
            />
            <Button
              kind="ghost"
              size="small"
              label={settingsRes.string.ApiKeyAddAll}
              disabled={ops.size === apiKeyOperations.length}
              on:click={addAllOps}
            />
          </div>
        </div>
        <div class="hint"><Label label={settingsRes.string.ApiKeyOperationsHint} /></div>
        {#if ops.size > 0}
          <div class="chips opChips">
            {#each Array.from(ops) as op (op)}
              <Chip
                label={op}
                isRemovable
                on:remove={() => {
                  removeOp(op)
                }}
              />
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    {#if showSpaces}
      <div class="flex-col flex-gap-2">
        <div class="flex-row-center flex-between">
          <Label label={settingsRes.string.ApiKeySpaces} />
          <ButtonIcon
            kind="tertiary"
            size="small"
            icon={IconAdd}
            tooltip={{ label: presentation.string.Add }}
            on:click={pickSpaces}
          />
        </div>
        <div class="hint"><Label label={settingsRes.string.ApiKeySpacesHint} /></div>
        {#if spaces.length > 0}
          <div class="chips">
            {#each spaces as spaceId (spaceId)}
              <Chip
                label={spaceNames.get(spaceId) ?? spaceId}
                isRemovable
                on:remove={() => {
                  removeSpace(spaceId)
                }}
              />
            {/each}
            <Button
              kind="ghost"
              size="small"
              label={ui.string.Clear}
              on:click={() => {
                spaces = []
              }}
            />
          </div>
        {/if}
      </div>
    {/if}

    <div class="settingsGroup">
      <div class="settingsRow">
        <div class="flex-col flex-gap-1">
          <Label label={settingsRes.string.ApiKeyTokenTtl} />
          <div class="hint">
            <Label
              label={settingsRes.string.ApiKeyTokenTtlHint}
              params={{ min: minTokenTtlDays, max: effectiveMaxTtlDays }}
            />
          </div>
        </div>
        <NumberInput
          bind:value={tokenTtlDays}
          minValue={minTokenTtlDays}
          maxValue={effectiveMaxTtlDays}
          maxWidth="4rem"
          focusable
        />
      </div>
      <div class="settingsRow">
        <Label label={settingsRes.string.ApiKeyExpiresOn} />
        <DatePresenter bind:value={expiresOn} editable kind="regular" size="medium" />
      </div>
      <div class="settingsRow">
        <div class="flex-col flex-gap-1">
          <Label label={settingsRes.string.ApiKeyAllowIncoming} />
          <div class="hint"><Label label={settingsRes.string.ApiKeyAllowIncomingHint} /></div>
        </div>
        <Toggle bind:on={incoming} />
      </div>
    </div>

    {#if error}
      <div class="errorMsg">{error}</div>
    {/if}
  </div>
  <svelte:fragment slot="buttons">
    {#if loading}
      <Spinner size="medium" />
    {/if}
  </svelte:fragment>
</Modal>

<style lang="scss">
  .hint {
    color: var(--theme-dark-color);
    font-size: 0.8125rem;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
  }
  .settingsGroup {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--theme-divider-color);
    border-radius: 0.5rem;
  }
  .settingsRow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.75rem;

    & + .settingsRow {
      border-top: 1px solid var(--theme-divider-color);
    }
  }
  .opChips :global(.chip-label) {
    font-family: monospace;
  }
  .errorMsg {
    color: var(--theme-error-color);
  }
</style>
