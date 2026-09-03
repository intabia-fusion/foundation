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
  import { getCurrentEmployee, Person } from '@hcengineering/contact'
  import { AccountRole, Doc, getCurrentAccount, Ref, uniqueNotEmpty } from '@hcengineering/core'
  import { Card } from '@hcengineering/presentation'
  import ui, { Button, Label } from '@hcengineering/ui'
  import { ObjectMention } from '@hcengineering/view-resources'
  import view from '@hcengineering/view-resources/src/plugin'
  import { createEventDispatcher } from 'svelte'
  import { IntlString } from '@hcengineering/platform'

  import { getPersonRefsByPersonIdsCb, PersonRefPresenter } from '..'

  export let object: Doc | Doc[]
  export let deleteAction: () => void | Promise<void>
  export let skipCheck: boolean = false
  export let canDeleteExtra: boolean = true
  export let confirmation: IntlString | undefined = undefined
  export let confirmationParams: Record<string, any> | undefined = undefined
  export let extraConfirmation: IntlString | undefined = undefined
  export let extraConfirmationParams: Record<string, any> | undefined = undefined
  export let extraObjects: Doc[] | undefined = undefined
  export let title: IntlString | undefined = undefined
  export let titleParams: Record<string, any> | undefined = undefined

  const me = getCurrentEmployee()
  const objectArray = Array.isArray(object) ? object : [object]
  const dispatch = createEventDispatcher()
  let creators: Ref<Person>[] | undefined
  $: getPersonRefsByPersonIdsCb(uniqueNotEmpty(objectArray.map((obj) => obj.createdBy)), (refs) => {
    creators = Array.from(refs.values())
  })

  $: canDelete =
    (skipCheck ||
      (creators !== undefined && creators.length === 1 && creators[0] === me) ||
      getCurrentAccount().role === AccountRole.Owner) &&
    canDeleteExtra
  $: label = canDelete ? (title ?? view.string.DeleteObject) : view.string.DeletePopupNoPermissionTitle
</script>

<Card
  {label}
  labelProps={titleParams}
  okAction={canDelete ? deleteAction : () => {}}
  canSave={true}
  okLabel={canDelete ? view.string.LabelYes : ui.string.Ok}
  on:close={() => dispatch('close')}
>
  <svelte:fragment slot="buttons">
    {#if canDelete}
      <Button label={view.string.LabelNo} on:click={() => dispatch('close')} />
    {/if}
  </svelte:fragment>
  <div class="flex-grow flex-col">
    {#if canDelete}
      <div class="mb-2">
        <Label
          label={confirmation ?? view.string.DeleteObjectConfirm}
          params={confirmationParams ?? { count: objectArray.length }}
        />
        <div class="mt-2">
          {#if objectArray.length === 1}
            <ObjectMention object={objectArray[0]} />
          {/if}
        </div>
        {#if extraConfirmation !== undefined}
          <div class="mt-2">
            <Label label={extraConfirmation} params={extraConfirmationParams} />
          </div>
          {#if extraObjects !== undefined && extraObjects.length > 0}
            <div class="flex-col">
              {#each extraObjects as obj (obj._id)}
                <div class="mt-1">
                  <ObjectMention object={obj} />
                </div>
              {/each}
            </div>
          {/if}
        {/if}
      </div>
    {:else}
      <div class="mb-2">
        <Label label={view.string.DeletePopupNoPermissionLabel} />
      </div>
      <div class="mb-2">
        <Label label={view.string.DeletePopupCreatorLabel} />
        {#each creators ?? [] as person}
          <div class="my-2">
            <PersonRefPresenter value={person} />
          </div>
        {/each}
      </div>
      <!-- Fix if really needed? -->
      <!-- <div class="mb-2">
        <Label label={view.string.DeletePopupOwnerLabel} />
        {#each owners as owner}
          <div class="my-2">
            <PersonPresenter value={owner} />
          </div>
        {/each}
      </div> -->
    {/if}
  </div>
  <slot />
</Card>
