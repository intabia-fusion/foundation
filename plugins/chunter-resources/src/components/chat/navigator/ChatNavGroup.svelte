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
  import core, { Class, Doc, getCurrentAccount, reduceCalls, Ref, SortingOrder, WithLookup } from '@hcengineering/core'
  import { IntlString } from '@hcengineering/platform'
  import { createQuery, getClient, LiveQuery } from '@hcengineering/presentation'
  import { Chat, DirectMessage } from '@hcengineering/chunter'
  import { Employee } from '@hcengineering/contact'
  import { onDestroy } from 'svelte'

  import chunter from '../../../plugin'
  import { ChatNavGroupModel } from '../types'
  import ChatNavSection from './ChatNavSection.svelte'
  import {
    createFakeDirectFromEmployee,
    getDirectByAccountMap,
    getNavGroupClasses,
    shouldPushObjectInNavigator
  } from '../utils'

  export let object: Doc | undefined
  export let chat: Chat | undefined
  export let pinned: Chat[] = []
  export let model: ChatNavGroupModel
  export let search: string = ''
  export let employees: Employee[] = []

  interface Section {
    id: string
    _class?: Ref<Class<Doc>>
    label: IntlString
    objects: { doc: Doc, chat?: Chat }[]
    count: number
  }

  const client = getClient()
  const hierarchy = client.getHierarchy()
  const objectsQueryByClass = new Map<Ref<Class<Doc>>, { query: LiveQuery, limit?: number }>()

  const me = getCurrentAccount()
  let objectsByClass = new Map<Ref<Class<Doc>>, { docs: { doc: Doc, chat: Chat }[], total: number }>()

  let shouldPushObject = false
  let sections: Section[] = []

  const fakeDirectsHistory = new Map<string, any>()
  let lastSearch = search
  $: if (search !== lastSearch) {
    lastSearch = search
    fakeDirectsHistory.clear()
  }

  $: shouldPushObject = shouldPushObjectInNavigator(model, object, chat, Array.from(objectsByClass.keys()))
  $: pushObj = shouldPushObject && object != null ? { object, chat } : undefined

  function loadObjects (model: ChatNavGroupModel, pinned: Chat[], search: string): void {
    const classes = getNavGroupClasses(model, pinned)

    for (const _class of classes) {
      const { query, limit } = objectsQueryByClass.get(_class) ?? {
        query: createQuery(),
        limit: model.maxSectionItems
      }

      if (!objectsQueryByClass.has(_class)) {
        objectsQueryByClass.set(_class, { query, limit })
      }

      const searchQuery =
        search !== ''
          ? {
              $search: search !== '' ? `*${search}*` : undefined,
              $searchStrict: true
            }
          : {
              hidden: false
            }

      const isSpace = hierarchy.isDerived(_class, core.class.Space)
      query.query(
        chunter.class.Chat,
        {
          ...model.query,
          account: me.uuid,
          attachedToClass: { $in: hierarchy.getDescendants(_class) },
          ...searchQuery,
          ...(isSpace ? { '$lookup.attachedTo.archived': false } : {}),
          '$lookup.attachedTo._id': { $exists: true }
        },
        (res) => {
          const docs: { doc: Doc, chat: Chat }[] = res.map((it) => ({ doc: it.$lookup?.attachedTo as Doc, chat: it }))
          objectsByClass = objectsByClass.set(_class, { docs, total: res.total })
        },
        {
          total: true,
          limit,
          lookup: {
            attachedTo: _class
          },
          sort: {
            '$lookup.attachedTo.modifiedOn': SortingOrder.Descending
          }
        }
      )
    }

    for (const [classRef, query] of objectsQueryByClass.entries()) {
      if (!classes.includes(classRef)) {
        query.query.unsubscribe()
        objectsQueryByClass.delete(classRef)
        objectsByClass.delete(classRef)
      }
    }
    objectsByClass = objectsByClass
  }

  $: loadObjects(model, pinned, search)

  onDestroy(() => {
    for (const { query } of objectsQueryByClass.values()) {
      query.unsubscribe()
    }
  })

  const getSections = reduceCalls(
    async (
      objectsByClass: Map<Ref<Class<Doc>>, { docs: { doc: Doc, chat: Chat }[], total: number }>,
      model: ChatNavGroupModel,
      pushObject: { object: Doc, chat?: Chat } | undefined,
      employees: Employee[],
      handler: (result: Section[]) => void
    ): Promise<void> => {
      const result: Section[] = []
      if (!model.wrap) {
        result.push({
          id: model.id,
          objects: Array.from(objectsByClass.values()).flatMap((it) => it.docs),
          label: model.label ?? chunter.string.Channels,
          count: Array.from(objectsByClass.values()).reduce((sum, it) => sum + it.total, 0)
        })

        handler(result)
        return
      }

      let isObjectPushed = false

      const docIds = new Set(objectsByClass.values().flatMap((it) => it.docs.map((o) => o.doc._id)))
      if (pushObject != null && docIds.has(pushObject?.object._id)) {
        isObjectPushed = true
      }

      for (const [_class, { docs, total }] of objectsByClass.entries()) {
        const clazz = hierarchy.getClass(_class)
        const sectionObjects: { doc: Doc, chat?: Chat }[] = [...docs]

        if (!isObjectPushed && _class === pushObject?.object._class) {
          isObjectPushed = true
          sectionObjects.push({ doc: pushObject.object, chat: pushObject.chat })
        }

        if (model.id === 'direct' && _class === chunter.class.DirectMessage) {
          for (const it of sectionObjects) {
            const direct = it.doc as DirectMessage
            if (direct.type !== 'person') continue
            const other = direct.members.find((m) => m !== me.uuid) ?? direct.members.find((m) => m === me.uuid)
            if (other != null) {
              const historySource = fakeDirectsHistory.get(other)
              if (historySource != null) {
                ;(direct as WithLookup<DirectMessage>).$source = historySource
                if (it.chat != null) {
                  const chat = it.chat as WithLookup<Chat>
                  chat.$source = historySource
                }
              }
            }
          }

          const directByPerson = getDirectByAccountMap(sectionObjects.map((it) => it.doc as DirectMessage))
          for (const employee of employees) {
            if (sectionObjects.length >= 10) break
            if (employee.personUuid == null) continue
            const direct = directByPerson.get(employee.personUuid)
            if (direct != null) continue
            const fakeDirect = createFakeDirectFromEmployee(employee)
            if (fakeDirect == null) continue
            fakeDirectsHistory.set(employee.personUuid, (employee as WithLookup<Employee>).$source)
            sectionObjects.push({ doc: fakeDirect, chat: undefined })
          }
        }

        result.push({
          id: _class,
          _class,
          objects: sectionObjects,
          label: clazz.pluralLabel ?? clazz.label,
          count: sectionObjects.length > docs.length ? total + 1 : total
        })
      }

      if (!isObjectPushed && pushObject !== undefined) {
        const clazz = hierarchy.getClass(pushObject.object._class)

        result.push({
          id: pushObject.object._id,
          _class: pushObject.object._class,
          objects: [{ doc: pushObject.object, chat: pushObject.chat }],
          label: clazz.pluralLabel ?? clazz.label,
          count: 1
        })
      }

      handler(result.sort((s1, s2) => s1.label.localeCompare(s2.label)))
    }
  )

  $: void getSections(objectsByClass, model, pushObj, employees, (res) => {
    sections = res
  })
</script>

{#each sections as section (section.id)}
  <ChatNavSection
    id={section.id}
    _class={section._class ?? core.class.Doc}
    objects={section.objects}
    objectId={object?._id}
    header={section.label}
    actions={model.actionsFn()}
    createAction={model.createAction}
    sortFn={model.sortFn}
    showEmpty={model.showEmpty}
    itemsCount={section.count}
    {pinned}
    sortByScore={search !== ''}
    on:show-more={() => {
      if (section._class !== undefined) {
        const query = objectsQueryByClass.get(section._class)
        if (query?.limit != null) {
          query.limit += 50
          loadObjects(model, pinned, search)
        }
      }
    }}
    on:select
  />
{/each}
