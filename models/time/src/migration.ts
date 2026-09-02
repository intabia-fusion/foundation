//
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
//

import calendarPlugin from '@hcengineering/calendar'
import contact, { type Person, type PersonSpace } from '@hcengineering/contact'
import { type Doc, type Ref, TxOperations } from '@hcengineering/core'
import {
  type MigrateOperation,
  type MigrateUpdate,
  type MigrationClient,
  type MigrationDocumentQuery,
  type MigrationUpgradeClient,
  createOrUpdate,
  tryMigrate,
  tryUpgrade,
  createDefaultSpace
} from '@hcengineering/model'
import { DOMAIN_EVENT } from '@hcengineering/model-calendar'
import core, { DOMAIN_SPACE } from '@hcengineering/model-core'
import tags from '@hcengineering/tags'
import { timeId, ToDoPriority, type ToDo, type WorkSlot } from '@hcengineering/time'
import { DOMAIN_TIME } from '.'
import time from './plugin'

async function moveWorkSlotsToTargetSpace (client: MigrationClient): Promise<void> {
  const hierarchy = client.hierarchy
  const workSlotClasses = hierarchy.getDescendants(time.class.WorkSlot)

  // Both lookups are filled per batch and cached across batches: neither todos nor
  // person spaces are loaded wholesale.
  const todoByRef = new Map<Ref<ToDo>, ToDo | null>()
  const spaceByPerson = new Map<Ref<Person>, Ref<PersonSpace> | null>()

  async function resolveBatch (refs: Array<Ref<ToDo>>): Promise<void> {
    const missing = refs.filter((it) => !todoByRef.has(it))
    if (missing.length > 0) {
      const todos = await client.find<ToDo>(
        DOMAIN_TIME,
        { _id: { $in: missing } },
        { projection: { _id: 1, attachedSpace: 1, user: 1 } }
      )
      for (const todo of todos) {
        todoByRef.set(todo._id, todo)
      }
      for (const ref of missing) {
        if (!todoByRef.has(ref)) todoByRef.set(ref, null)
      }
    }

    const persons = refs
      .map((it) => todoByRef.get(it))
      .filter((it): it is ToDo => it != null && it.attachedSpace === undefined)
      .map((it) => it.user)
      .filter((it) => !spaceByPerson.has(it))
    if (persons.length === 0) return
    const spaces = await client.find<PersonSpace>(
      DOMAIN_SPACE,
      { _class: contact.class.PersonSpace, person: { $in: persons } },
      { projection: { _id: 1, person: 1 } }
    )
    for (const ps of spaces) {
      spaceByPerson.set(ps.person, ps._id)
    }
    for (const person of persons) {
      if (!spaceByPerson.has(person)) spaceByPerson.set(person, null)
    }
  }

  client.logger.log('moving work slots to target space', {})

  let processed = 0
  let unresolved = 0
  const unresolvedExamples: Array<Ref<WorkSlot>> = []

  const iterator = await client.traverse<WorkSlot>(DOMAIN_EVENT, {
    _class: { $in: workSlotClasses },
    space: calendarPlugin.space.Calendar
  })

  try {
    while (true) {
      const slots = await iterator.next(200)
      if (slots === null || slots.length === 0) break

      const operations: { filter: MigrationDocumentQuery<Doc>, update: MigrateUpdate<Doc> }[] = []

      await resolveBatch(slots.map((it) => it.attachedTo))

      for (const slot of slots) {
        const todo = todoByRef.get(slot.attachedTo)
        const space = todo?.attachedSpace ?? (todo != null ? (spaceByPerson.get(todo.user) ?? undefined) : undefined)

        if (space === undefined) {
          unresolved++
          if (unresolvedExamples.length < 10) {
            unresolvedExamples.push(slot._id)
          }
          continue
        }

        operations.push({
          filter: { _id: slot._id },
          update: { space }
        })
      }

      if (operations.length > 0) {
        await client.bulk(DOMAIN_EVENT, operations)
      }

      processed += slots.length
      client.logger.log('...processed work slots', { count: processed })
    }
  } finally {
    await iterator.close()
  }

  if (unresolved > 0) {
    client.logger.error('could not resolve target space for work slots, left in calendar space', {
      count: unresolved,
      examples: unresolvedExamples
    })
  }

  client.logger.log('finished moving work slots to target space', { processed, unresolved })
}

async function fillProps (client: MigrationClient): Promise<void> {
  await client.update(
    DOMAIN_TIME,
    { _class: time.class.ProjectToDo, visibility: { $exists: false } },
    { visibility: 'public' }
  )
  await client.update(
    DOMAIN_TIME,
    { _class: time.class.ToDo, visibility: { $exists: false } },
    { visibility: 'private' }
  )
  await client.update(DOMAIN_TIME, { priority: { $exists: false } }, { priority: ToDoPriority.NoPriority })
}

export const timeOperation: MigrateOperation = {
  async migrate (client: MigrationClient, mode): Promise<void> {
    await tryMigrate(mode, client, timeId, [
      {
        state: 'm-time-001',
        mode: 'upgrade',
        func: async (client) => {
          await fillProps(client)
        }
      },
      {
        state: 'move-workslots-to-target-space',
        mode: 'upgrade',
        func: moveWorkSlotsToTargetSpace
      }
    ])
  },
  async upgrade (state: Map<string, Set<string>>, client: () => Promise<MigrationUpgradeClient>, mode): Promise<void> {
    await tryUpgrade(mode, state, client, timeId, [
      {
        state: 'create-defaults-v2',
        func: async (client) => {
          await createDefaultSpace(client, time.space.ToDos, { name: 'Todos', description: 'Space for all todos' })
        }
      },
      {
        state: 'u-time-0001',
        func: async (client) => {
          const tx = new TxOperations(client, core.account.System)
          await createOrUpdate(
            tx,
            tags.class.TagCategory,
            core.space.Workspace,
            {
              icon: tags.icon.Tags,
              label: 'Other',
              targetClass: time.class.ToDo,
              tags: [],
              default: true
            },
            time.category.Other
          )
        }
      }
    ])
  }
}
