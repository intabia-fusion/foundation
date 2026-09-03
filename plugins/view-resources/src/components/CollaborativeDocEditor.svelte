<!--
// Copyright © 2023 Hardcore Engineering Inc.
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
  import contact from '@hcengineering/contact'
  import { Blob, Doc, makeDocCollabId, Ref } from '@hcengineering/core'
  import { getResource } from '@hcengineering/platform'
  import { getAttribute, getClient, getMarkup, KeyedAttribute } from '@hcengineering/presentation'
  import { CollaborativeAttributeSectionBox, StyledTextBox } from '@hcengineering/text-editor-resources'
  import { AnySvelteComponent } from '@hcengineering/ui'
  import { getCollaborationUser } from '../utils'

  export let object: Doc
  export let key: KeyedAttribute
  export let draft = false
  export let onChange: ((val: any) => void) | undefined = undefined

  const client = getClient()

  let markupContent: string | undefined = undefined

  $: rawValue = getAttribute(client, object, key)

  $: if (draft) {
    if (rawValue != null && rawValue !== '') {
      if (typeof rawValue === 'string' && rawValue.startsWith('{')) {
        markupContent = rawValue
      } else {
        void getMarkup(makeDocCollabId(object, key.key), rawValue as Ref<Blob>).then((res) => {
          markupContent = res ?? ''
        })
      }
    } else {
      markupContent = ''
    }
  }

  const user = getCollaborationUser()
  let userComponent: AnySvelteComponent | undefined
  void getResource(contact.component.CollaborationUserAvatar).then((component) => {
    userComponent = component
  })

  function handleValueChange (evt: CustomEvent<string | null>): void {
    const val = evt.detail === null ? undefined : evt.detail
    markupContent = val ?? ''
    if (onChange) {
      onChange(val)
    }
  }
</script>

{#if draft}
  <StyledTextBox
    content={markupContent ?? ''}
    alwaysEdit
    focusable
    mode={2}
    hideExtraButtons
    maxHeight="none"
    isScrollable={false}
    on:value={handleValueChange}
    on:changeContent={handleValueChange}
  />
{:else}
  {#key object._id}
    {#key key.key}
      <CollaborativeAttributeSectionBox {object} {key} {user} {userComponent} label={key.attr.label} />
    {/key}
  {/key}
{/if}

<style lang="scss">
  .no-header {
    :global(.antiSection-header) {
      display: none !important;
    }
    :global(.antiSection) {
      padding-top: 0 !important;
      margin-top: 0 !important;
    }
  }
</style>
