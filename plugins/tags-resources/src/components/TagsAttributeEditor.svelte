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
  import { AnyAttribute, Class, Doc, getCurrentAccount, IdMap, Ref, toIdMap } from '@hcengineering/core'
  import { IntlString } from '@hcengineering/platform'
  import { createQuery, getClient } from '@hcengineering/presentation'
  import tags, { TagReference, TagsEvents, TagElement } from '@hcengineering/tags'
  import { Icon, Label, getEventPopupPositionElement, showPopup } from '@hcengineering/ui'
  import { getObjectId } from '@hcengineering/view-resources'
  import { Analytics } from '@hcengineering/analytics'

  import { getTagsTargetClass } from '../utils'
  import TagReferencePresenter from './TagReferencePresenter.svelte'
  import TagsEditorPopup from './TagsEditorPopup.svelte'
  import TagIcon from './icons/TagIcon.svelte'

  export let object: Doc
  export let label: IntlString = tags.string.AddLabel
  export let readonly: boolean = false
  export let attr: AnyAttribute | undefined = undefined
  // AttributeBarEditor passes the attribute as `attribute`; scope tags by the attribute's
  // owning class (e.g. lead.mixin.Customer) so mixin labels are shared, not the doc class.
  export let attribute: AnyAttribute | undefined = undefined
  export let targetClass: Ref<Class<Doc>> = (attr ?? attribute)?.attributeOf ?? getTagsTargetClass(object._class)
  export let draft: boolean = false
  export let value: any[] | undefined = undefined
  export let onChange: (value: any[]) => void = () => {}

  let dbItems: TagReference[] = []
  let elements: IdMap<TagElement> = new Map()

  const query = createQuery()
  const tagElements = createQuery()
  const client = getClient()
  const hierarchy = client.getHierarchy()

  $: if (object?._id != null) {
    query.query(tags.class.TagReference, { attachedTo: object._id }, (result) => {
      dbItems = result
    })
  }

  function getTagId (item: any): Ref<TagElement> {
    if (typeof item === 'string') return item as Ref<TagElement>
    if (typeof item === 'object' && item != null && 'tag' in item) return item.tag
    if (typeof item === 'object' && item != null && '_id' in item) return item._id
    return item
  }

  $: dbTagIds = dbItems.map((it) => it.tag)
  $: rawDraftItems = Array.isArray(value) ? value : dbItems
  $: draftTagIds = rawDraftItems.map(getTagId)
  $: tagIds = draft ? draftTagIds : dbTagIds

  $: tagElements.query(tags.class.TagElement, { _id: { $in: tagIds } }, (result) => {
    elements = toIdMap(result)
  })

  $: if (draft && tagIds.length > 0) {
    const missing = tagIds.filter((id) => id != null && !elements.has(id))
    if (missing.length > 0) {
      void client.findAll(tags.class.TagElement, { _id: { $in: missing } }).then((res) => {
        for (const el of res) {
          elements.set(el._id, el)
        }
        elements = new Map(elements)
      })
    }
  }

  $: items = draft
    ? rawDraftItems.map((valItem) => {
      const tagId = getTagId(valItem)
      const dbItem = dbItems.find((it) => it.tag === tagId)
      if (dbItem !== undefined) return dbItem

      if (typeof valItem === 'object' && valItem != null && 'title' in valItem && valItem.title) {
        return {
          _id: tagId as any,
          tag: tagId,
          title: valItem.title,
          color: valItem.color ?? 0,
          attachedTo: object._id,
          attachedToClass: object._class,
          collection: 'labels',
          modifiedOn: Date.now(),
          modifiedBy: getCurrentAccount().primarySocialId,
          space: object.space,
          _class: tags.class.TagReference
        }
      }

      const element = elements.get(tagId)
      return {
        _id: tagId as any,
        tag: tagId,
        title: element?.title ?? '',
        color: element?.color ?? 0,
        attachedTo: object._id,
        attachedToClass: object._class,
        collection: 'labels',
        modifiedOn: Date.now(),
        modifiedBy: getCurrentAccount().primarySocialId,
        space: object.space,
        _class: tags.class.TagReference
      }
    })
    : dbItems

  function handleTagChange (newTagIds: Ref<TagElement>[]): void {
    value = newTagIds
    onChange(value)
  }

  async function tagsHandler (evt: MouseEvent): Promise<void> {
    if (readonly) return
    showPopup(
      TagsEditorPopup,
      {
        object,
        targetClass,
        draft,
        value: tagIds,
        onChange: handleTagChange
      },
      getEventPopupPositionElement(evt),
      undefined,
      undefined,
      {
        refId: 'TagsPopup',
        category: 'popup',
        overlay: true
      }
    )
  }

  async function removeTag (tag: TagReference): Promise<void> {
    if (readonly) return
    if (draft) {
      const next = tagIds.filter((id) => id !== tag.tag)
      handleTagChange(next)
      return
    }
    if (tag !== undefined) {
      await client.remove(tag)
      const id = await getObjectId(object, hierarchy)
      Analytics.handleEvent(TagsEvents.TagRemoved, { object: id })
    }
  }
</script>

{#if items.length}
  <div class="flex-row-center flex-wrap">
    {#each items as value}
      <div class="step-container clear-mins">
        <TagReferencePresenter
          attr={attr ?? attribute}
          {value}
          element={elements.get(value.tag)}
          isEditable={!readonly}
          kind={'list'}
          on:remove={(res) => removeTag(res.detail)}
        />
      </div>
    {/each}
    {#if !readonly}
      <div class="step-container clear-mins">
        <button class="tag-button" on:click|stopPropagation={tagsHandler}>
          <div class="icon"><Icon icon={TagIcon} size={'full'} /></div>
          <span class="overflow-label label"><Label {label} /></span>
        </button>
      </div>
    {/if}
  </div>
{:else if !readonly}
  <button class="tag-button" style="width: min-content" on:click|stopPropagation={tagsHandler}>
    <div class="icon"><Icon icon={TagIcon} size={'full'} /></div>
    <span class="overflow-label label"><Label {label} /></span>
  </button>
{/if}

<style lang="scss">
  .step-container {
    margin: 0.375rem 0.375rem 0 0;
  }
  .tag-button {
    overflow: hidden;
    display: flex;
    align-items: center;
    flex-shrink: 0;
    padding: 0 0.625rem 0 0.5rem;
    height: 2rem;
    min-width: 0;
    min-height: 0;
    color: var(--theme-content-color);
    border: 1px solid transparent;
    border-radius: 1rem;

    .icon {
      flex-shrink: 0;
      width: 1rem;
      height: 1rem;
    }
    .label {
      margin-left: 0.25rem;
    }
    &:hover {
      color: var(--theme-caption-color);
      border-color: var(--theme-divider-color);
    }
  }
</style>
