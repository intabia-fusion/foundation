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
  import { onDestroy } from 'svelte'
  import { AccessLevel, generateEventId } from '@hcengineering/calendar'
  import contact, { getCurrentEmployee } from '@hcengineering/contact'
  import { DocumentUpdate, Ref, getCurrentAccount } from '@hcengineering/core'
  import { createQuery, getClient } from '@hcengineering/presentation'
  import { closePopup, showPopup } from '@hcengineering/ui'
  import { deleteObjects } from '@hcengineering/view-resources'
  import { TimeEvents, ToDo, WorkSlot } from '@hcengineering/time'
  import time from '../plugin'
  import Workslots from './Workslots.svelte'
  import { Analytics } from '@hcengineering/analytics'
  import { findPrimaryCalendar, getWorkSlotSpace } from '../utils'

  export let todo: ToDo

  const client = getClient()
  const query = createQuery()

  let slots: WorkSlot[] = []

  $: query.query(time.class.WorkSlot, { attachedTo: todo._id }, (res) => {
    slots = res
  })

  // TimeInputBox reports every typed digit, so one time edit used to send one update per digit.
  const saveDelay = 400
  let pending: Record<string, DocumentUpdate<WorkSlot>> = {}
  const timers = new Map<Ref<WorkSlot>, ReturnType<typeof setTimeout>>()

  // The rows are rendered from the query result, and while a write is still queued that result is
  // older than what the user just typed. Without this overlay the next keystroke is applied on top
  // of the stale value and the edit before it is lost.
  $: pendingSlots = slots.map((s) => (pending[s._id] !== undefined ? { ...s, ...pending[s._id] } : s))

  function flush (slot: Ref<WorkSlot>): void {
    const update = pending[slot]
    if (update === undefined) return
    const { [slot]: dropped, ...rest } = pending
    pending = rest
    timers.delete(slot)
    const workslot = slots.find((s) => s._id === slot)
    if (workslot !== undefined) {
      void client.update(workslot, update).catch((err) => {
        Analytics.handleError(err)
      })
    }
  }

  function scheduleUpdate (slot: Ref<WorkSlot>, update: DocumentUpdate<WorkSlot>): void {
    clearTimeout(timers.get(slot))
    pending = { ...pending, [slot]: { ...pending[slot], ...update } }
    timers.set(
      slot,
      setTimeout(() => {
        flush(slot)
      }, saveDelay)
    )
  }

  // The panel is usually closed right after an edit - without this the last change never lands.
  onDestroy(() => {
    for (const slot of Object.keys(pending) as Array<Ref<WorkSlot>>) {
      clearTimeout(timers.get(slot))
      flush(slot)
    }
  })

  function change (e: CustomEvent<{ startDate: number, dueDate: number, slot: Ref<WorkSlot> }>): void {
    const { startDate, dueDate, slot } = e.detail
    scheduleUpdate(slot, { date: startDate, dueDate })
  }

  function dueChange (e: CustomEvent<{ dueDate: number, slot: Ref<WorkSlot> }>): void {
    const { dueDate, slot } = e.detail
    scheduleUpdate(slot, { dueDate })
  }

  async function create (): Promise<void> {
    const defaultDuration = 30 * 60 * 1000
    const now = Date.now()
    const date = Math.ceil(now / (30 * 60 * 1000)) * (30 * 60 * 1000)
    const currentAccount = getCurrentAccount()
    const _calendar = await findPrimaryCalendar()
    const dueDate = date + defaultDuration
    await client.addCollection(time.class.WorkSlot, getWorkSlotSpace(todo), todo._id, todo._class, 'workslots', {
      eventId: generateEventId(),
      date,
      dueDate,
      calendar: _calendar,
      description: todo.description,
      participants: [getCurrentEmployee()],
      title: todo.title,
      blockTime: true,
      allDay: false,
      access: AccessLevel.Owner,
      user: currentAccount.primarySocialId,
      visibility: todo.visibility === 'public' ? 'public' : 'freeBusy',
      reminders: []
    })
    Analytics.handleEvent(TimeEvents.ToDoScheduled, { id: todo._id })
  }

  async function remove (e: CustomEvent<{ _id: Ref<WorkSlot> }>): Promise<void> {
    const object = slots.find((p) => p._id === e.detail._id)
    if (object) {
      showPopup(
        contact.component.DeleteConfirmationPopup,
        {
          object,
          deleteAction: async () => {
            const objs = Array.isArray(object) ? object : [object]
            await deleteObjects(getClient(), objs).catch((err) => {
              console.error(err)
            })
            closePopup()
          }
        },
        undefined
      )
    }
  }
</script>

<Workslots
  slots={pendingSlots}
  fixed={'toDo'}
  on:change={change}
  on:dueChange={dueChange}
  on:create={create}
  on:remove={remove}
/>
