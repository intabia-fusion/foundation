//
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//

// API-tests for calendar.class.BusySlot: the OnEvent server trigger
// (server-plugins/calendar-resources syncBusySlot/removeBusySlot) mirrors an
// owner's Event into one BusySlot per participant, living in the shared
// calendar.space.Calendar, while the Event itself now lives in the owner's
// (and each participant's) private PersonSpace. That split is exactly what
// these tests assert: BusySlot is world-readable inside the workspace, Event
// is not.

import {
  createRestClient,
  createRestTxOperations,
  getWorkspaceToken,
  loadServerConfig,
  type RestClient,
  type WorkspaceToken
} from '@hcengineering/api-client'
import { getClient as getAccountClient } from '@hcengineering/account-client'
import {
  generateId,
  MeasureMetricsContext,
  pickPrimarySocialId,
  systemAccountUuid,
  type DocumentUpdate,
  type PersonId,
  type Ref,
  type Space,
  type SocialId
} from '@hcengineering/core'
import contact, { ensureEmployee, type Person, type PersonSpace } from '@hcengineering/contact'
import calendar, {
  AccessLevel,
  generateEventId,
  getBusyIntervals,
  type BusySlot,
  type Calendar,
  type Event,
  type ReccuringEvent,
  type RecurringRule,
  type Visibility
} from '@hcengineering/calendar'
import { generateToken } from '@hcengineering/server-token'
import { eventually } from './workflow.fixtures'

const PLATFORM_URL = process.env.PLATFORM_URL ?? 'http://localhost:8083'
const WORKSPACE = 'api-tests'

describe('calendar busy slots (api-tests)', () => {
  let user1Token: WorkspaceToken
  let user2Token: WorkspaceToken
  let user1Rest: RestClient
  let user2Rest: RestClient
  let systemRest: RestClient

  let user1Person: Person
  let user2Person: Person
  let user1Space: PersonSpace
  let user1Primary: PersonId
  let user1Calendar: Ref<Calendar>

  const createdEventIds: Array<Ref<Event>> = []

  beforeAll(async () => {
    const config = await loadServerConfig(PLATFORM_URL)

    user1Token = await getWorkspaceToken(
      PLATFORM_URL,
      { email: 'user1', password: '1234', workspace: WORKSPACE },
      config
    )
    user2Token = await getWorkspaceToken(
      PLATFORM_URL,
      { email: 'user2', password: '1234', workspace: WORKSPACE },
      config
    )

    user1Rest = createRestClient(user1Token.endpoint, user1Token.workspaceId, user1Token.token)
    user2Rest = createRestClient(user2Token.endpoint, user2Token.workspaceId, user2Token.token)
    systemRest = createRestClient(
      user1Token.endpoint,
      user1Token.workspaceId,
      generateToken(systemAccountUuid, user1Token.workspaceId, undefined, 'secret')
    )

    // ensureEmployee is a workbench-resources step the api-client connect() skips;
    // without it neither account has a Person/Employee/PersonSpace/default Calendar yet.
    const ensureFor = async (tok: WorkspaceToken): Promise<PersonId> => {
      const accClient = getAccountClient(config.ACCOUNTS_URL, tok.token)
      const person = await accClient.getPerson()
      const socialIds: SocialId[] = await accClient.getSocialIds(true)
      const primary = pickPrimarySocialId(socialIds)._id
      const txConn = await createRestTxOperations(tok.endpoint, tok.workspaceId, tok.token)
      await ensureEmployee(
        new MeasureMetricsContext('test', {}),
        {
          uuid: tok.info.account,
          role: tok.info.role,
          primarySocialId: primary,
          socialIds: socialIds.map((si) => si._id),
          fullSocialIds: socialIds
        },
        txConn,
        socialIds,
        async () => person
      )
      return primary
    }
    user1Primary = await ensureFor(user1Token)
    await ensureFor(user2Token)

    // Resolve via the system-token client so SpaceSecurityMiddleware doesn't filter
    // out results for a private/PersonSpace-scoped query.
    user1Person = (await systemRest.findAll(contact.class.Person, { personUuid: user1Token.info.account as any }))[0]
    user2Person = (await systemRest.findAll(contact.class.Person, { personUuid: user2Token.info.account as any }))[0]
    expect(user1Person).toBeDefined()
    expect(user2Person).toBeDefined()

    // PersonSpace + the default Calendar are created asynchronously by the
    // OnEmployee trigger chain; ensureEmployee returns before it settles.
    user1Space = await eventually(
      async () => (await systemRest.findAll(contact.class.PersonSpace, { person: user1Person._id }))[0],
      15000
    )
    user1Calendar = `${user1Token.info.account}_calendar` as Ref<Calendar>
    await eventually(async () => await systemRest.findOne(calendar.class.Calendar, { _id: user1Calendar }), 15000)
  }, 30000)

  afterAll(async () => {
    for (const id of createdEventIds) {
      try {
        await removeEvent(id)
      } catch {}
    }
  })

  /** Creates a plain (non-recurring) Event owned by user1 in user1's PersonSpace. */
  async function createEvent (opts: {
    participants: Array<Ref<Person>>
    blockTime?: boolean
    date?: number
    dueDate?: number
    visibility?: Visibility
  }): Promise<{ id: Ref<Event>, eventId: string, date: number, dueDate: number }> {
    const id = generateId<Event>()
    const eventId = generateEventId()
    const date = opts.date ?? Date.now()
    const dueDate = opts.dueDate ?? date + 60 * 60 * 1000
    await user1Rest.addCollection(
      calendar.class.Event,
      user1Space._id as unknown as Ref<Space>,
      calendar.ids.NoAttached,
      calendar.class.Event,
      'events',
      {
        eventId,
        calendar: user1Calendar,
        title: 'busy-slot test event',
        description: '',
        date,
        dueDate,
        allDay: false,
        participants: opts.participants,
        access: AccessLevel.Owner,
        user: user1Primary,
        blockTime: opts.blockTime ?? true,
        visibility: opts.visibility
      },
      id
    )
    createdEventIds.push(id)
    return { id, eventId, date, dueDate }
  }

  /** Event is an AttachedDoc, so it must be updated/removed as a collection member. */
  async function updateEvent (id: Ref<Event>, update: DocumentUpdate<Event>): Promise<void> {
    await user1Rest.updateCollection(
      calendar.class.Event,
      user1Space._id as unknown as Ref<Space>,
      id,
      calendar.ids.NoAttached,
      calendar.class.Event,
      'events',
      update
    )
  }

  /** Creates a recurring master Event (calendar.class.ReccuringEvent) owned by user1. */
  async function createRecurringEvent (opts: {
    participants: Array<Ref<Person>>
    rules: RecurringRule[]
    date?: number
    dueDate?: number
  }): Promise<{ id: Ref<ReccuringEvent>, eventId: string, date: number, dueDate: number }> {
    const id = generateId<ReccuringEvent>()
    const eventId = generateEventId()
    const date = opts.date ?? Date.now()
    const dueDate = opts.dueDate ?? date + 60 * 60 * 1000
    await user1Rest.addCollection(
      calendar.class.ReccuringEvent,
      user1Space._id as unknown as Ref<Space>,
      calendar.ids.NoAttached,
      calendar.class.Event,
      'events',
      {
        eventId,
        calendar: user1Calendar,
        title: 'recurring busy-slot test event',
        description: '',
        date,
        dueDate,
        allDay: false,
        participants: opts.participants,
        access: AccessLevel.Owner,
        user: user1Primary,
        blockTime: true,
        rules: opts.rules,
        exdate: [],
        rdate: [],
        originalStartTime: date,
        timeZone: 'Etc/UTC'
      },
      id
    )
    createdEventIds.push(id as unknown as Ref<Event>)
    return { id, eventId, date, dueDate }
  }

  /** rules/exdate/rdate live on ReccuringEvent, not the base Event, hence a dedicated update helper. */
  async function updateRecurringEvent (id: Ref<ReccuringEvent>, update: DocumentUpdate<ReccuringEvent>): Promise<void> {
    await user1Rest.updateCollection(
      calendar.class.ReccuringEvent,
      user1Space._id as unknown as Ref<Space>,
      id,
      calendar.ids.NoAttached,
      calendar.class.Event,
      'events',
      update
    )
  }

  async function removeEvent (id: Ref<Event>): Promise<void> {
    await user1Rest.removeCollection(
      calendar.class.Event,
      user1Space._id as unknown as Ref<Space>,
      id,
      calendar.ids.NoAttached,
      calendar.class.Event,
      'events'
    )
  }

  async function findSlots (eventId: string): Promise<BusySlot[]> {
    return await systemRest.findAll(calendar.class.BusySlot, { eventId })
  }

  it('blockTime:true creates one BusySlot per participant, mirroring event fields', async () => {
    const { eventId, date, dueDate } = await createEvent({ participants: [user1Person._id, user2Person._id] })

    const slots = await eventually(async () => {
      const found = await findSlots(eventId)
      return found.length === 2 ? found : undefined
    }, 15000)

    const persons = slots.map((s) => s.person).sort()
    expect(persons).toEqual([user1Person._id, user2Person._id].sort())
    for (const slot of slots) {
      expect(slot.eventId).toBe(eventId)
      expect(slot.date).toBe(date)
      expect(slot.dueDate).toBe(dueDate)
      expect(slot.allDay).toBe(false)
    }
  }, 30000)

  it('shifting event time updates the busy slots', async () => {
    const { id, eventId } = await createEvent({ participants: [user1Person._id, user2Person._id] })
    await eventually(async () => {
      const found = await findSlots(eventId)
      return found.length === 2 ? found : undefined
    }, 15000)

    const newDate = Date.now() + 24 * 60 * 60 * 1000
    const newDueDate = newDate + 2 * 60 * 60 * 1000
    await updateEvent(id, { date: newDate, dueDate: newDueDate })

    await eventually(async () => {
      const found = await findSlots(eventId)
      return found.length === 2 && found.every((s) => s.date === newDate && s.dueDate === newDueDate)
        ? found
        : undefined
    }, 15000)
  }, 30000)

  it('blockTime:false removes the busy slots', async () => {
    const { id, eventId } = await createEvent({ participants: [user1Person._id, user2Person._id] })
    await eventually(async () => {
      const found = await findSlots(eventId)
      return found.length === 2 ? found : undefined
    }, 15000)

    await updateEvent(id, { blockTime: false })

    await eventually(async () => {
      const found = await findSlots(eventId)
      return found.length === 0 ? found : undefined
    }, 15000)
  }, 30000)

  it('removing the event removes its busy slots', async () => {
    const { id, eventId } = await createEvent({ participants: [user1Person._id, user2Person._id] })
    await eventually(async () => {
      const found = await findSlots(eventId)
      return found.length === 2 ? found : undefined
    }, 15000)

    await removeEvent(id)

    await eventually(async () => {
      const found = await findSlots(eventId)
      return found.length === 0 ? found : undefined
    }, 15000)
  }, 30000)

  it('removing a participant removes only their busy slot', async () => {
    const { id, eventId } = await createEvent({ participants: [user1Person._id, user2Person._id] })
    await eventually(async () => {
      const found = await findSlots(eventId)
      return found.length === 2 ? found : undefined
    }, 15000)

    await updateEvent(id, {
      participants: [user1Person._id]
    })

    const remaining = await eventually(async () => {
      const found = await findSlots(eventId)
      return found.length === 1 ? found : undefined
    }, 15000)
    expect(remaining[0].person).toBe(user1Person._id)
  }, 30000)

  it('a recurring event yields a single busy slot carrying the recurrence rules', async () => {
    const id = generateId<ReccuringEvent>()
    const eventId = generateEventId()
    const date = Date.now()
    const dueDate = date + 60 * 60 * 1000
    const rules: RecurringRule[] = [{ freq: 'DAILY', count: 5 }]
    await user1Rest.addCollection(
      calendar.class.ReccuringEvent,
      user1Space._id as unknown as Ref<Space>,
      calendar.ids.NoAttached,
      calendar.class.Event,
      'events',
      {
        eventId,
        calendar: user1Calendar,
        title: 'recurring busy-slot test event',
        description: '',
        date,
        dueDate,
        allDay: false,
        participants: [user1Person._id, user2Person._id],
        access: AccessLevel.Owner,
        user: user1Primary,
        blockTime: true,
        rules,
        exdate: [],
        rdate: [],
        originalStartTime: date,
        timeZone: 'Etc/UTC'
      },
      id
    )
    createdEventIds.push(id as unknown as Ref<Event>)

    const slots = await eventually(async () => {
      const found = await findSlots(eventId)
      return found.length === 2 ? found : undefined
    }, 15000)
    for (const slot of slots) {
      expect(slot.rules).toEqual(rules)
    }

    // Occurrences are never persisted: the series is backed by the master event
    // plus one copy per participant, and no ReccuringInstance at all.
    const instances = await systemRest.findAll(calendar.class.ReccuringInstance, { recurringEventId: eventId })
    expect(instances.length).toBe(0)
  }, 30000)

  it('every participant of a recurring event gets their own copy in their own PersonSpace', async () => {
    const rules: RecurringRule[] = [{ freq: 'DAILY', count: 5 }]
    const { eventId } = await createRecurringEvent({ participants: [user1Person._id, user2Person._id], rules })

    await eventually(async () => {
      const found = await findSlots(eventId)
      return found.length === 2 ? found : undefined
    }, 15000)

    const masterEvents = await systemRest.findAll(calendar.class.Event, {
      eventId,
      space: user1Space._id as unknown as Ref<Space>
    })
    expect(masterEvents.length).toBe(1)

    const user2Space = (await systemRest.findAll(contact.class.PersonSpace, { person: user2Person._id }))[0]
    // user2Rest is scoped by SpaceSecurityMiddleware to spaces it belongs to, so this only
    // finds the participant's own copy, never user1's master.
    const user2Copies = await eventually(async () => {
      const found = await user2Rest.findAll(calendar.class.Event, { eventId })
      return found.length === 1 ? found : undefined
    }, 15000)
    expect(user2Copies[0].eventId).toBe(eventId)
    expect(user2Copies[0].space).toBe(user2Space._id)
  }, 30000)

  it('a non-participant cannot read a recurring event but can read its BusySlot, and it carries rules', async () => {
    const rules: RecurringRule[] = [{ freq: 'DAILY', count: 5 }]
    const { eventId } = await createRecurringEvent({ participants: [user1Person._id], rules })

    await eventually(async () => {
      const found = await findSlots(eventId)
      return found.length === 1 ? found : undefined
    }, 15000)

    const eventsSeenByUser2 = await user2Rest.findAll(calendar.class.Event, { eventId })
    expect(eventsSeenByUser2.length).toBe(0)

    const slotsSeenByUser2 = await user2Rest.findAll(calendar.class.BusySlot, { eventId })
    expect(slotsSeenByUser2.length).toBe(1)
    expect(slotsSeenByUser2[0].rules).toEqual(rules)
  }, 30000)

  it('changing the recurrence rules on the master updates the rules on every slot', async () => {
    const initialRules: RecurringRule[] = [{ freq: 'DAILY', count: 5 }]
    const { id, eventId } = await createRecurringEvent({
      participants: [user1Person._id, user2Person._id],
      rules: initialRules
    })
    await eventually(async () => {
      const found = await findSlots(eventId)
      return found.length === 2 ? found : undefined
    }, 15000)

    const newRules: RecurringRule[] = [{ freq: 'WEEKLY', count: 3 }]
    await updateRecurringEvent(id, { rules: newRules })

    await eventually(async () => {
      const found = await findSlots(eventId)
      return found.length === 2 && found.every((s) => JSON.stringify(s.rules) === JSON.stringify(newRules))
        ? found
        : undefined
    }, 15000)
  }, 30000)

  it('adding an exdate to the master propagates to the slots', async () => {
    const rules: RecurringRule[] = [{ freq: 'DAILY', count: 5 }]
    const { id, eventId, date } = await createRecurringEvent({
      participants: [user1Person._id, user2Person._id],
      rules
    })
    await eventually(async () => {
      const found = await findSlots(eventId)
      return found.length === 2 ? found : undefined
    }, 15000)

    const exdate = [date + 24 * 60 * 60 * 1000]
    await updateRecurringEvent(id, { exdate })

    await eventually(async () => {
      const found = await findSlots(eventId)
      return found.length === 2 && found.every((s) => (s.exdate ?? []).length === 1 && s.exdate?.[0] === exdate[0])
        ? found
        : undefined
    }, 15000)
  }, 30000)

  it('removing the master removes the slots of a recurring event too', async () => {
    const rules: RecurringRule[] = [{ freq: 'DAILY', count: 5 }]
    const { id, eventId } = await createRecurringEvent({ participants: [user1Person._id, user2Person._id], rules })
    await eventually(async () => {
      const found = await findSlots(eventId)
      return found.length === 2 ? found : undefined
    }, 15000)

    await removeEvent(id as unknown as Ref<Event>)

    await eventually(async () => {
      const found = await findSlots(eventId)
      return found.length === 0 ? found : undefined
    }, 15000)
  }, 30000)

  it('the stored slot rules round-trip through the server into the expected occurrence count', async () => {
    const rules: RecurringRule[] = [{ freq: 'DAILY', count: 5 }]
    const { eventId, date } = await createRecurringEvent({ participants: [user1Person._id], rules })

    const slots = await eventually(async () => {
      const found = await findSlots(eventId)
      return found.length === 1 ? found : undefined
    }, 15000)

    // Window covers well past the 5-day DAILY rule, so a count mismatch would be a real bug,
    // not a window-clipping artifact.
    const windowFrom = date - 24 * 60 * 60 * 1000
    const windowTo = date + 10 * 24 * 60 * 60 * 1000
    const busy = getBusyIntervals(slots, windowFrom, windowTo)
    expect(busy.get(user1Person._id)?.length).toBe(5)
  }, 30000)

  it('a non-participant cannot read the Event but can read its BusySlot', async () => {
    // user2 is deliberately left out of participants, so the isolation check is real:
    // user1's Event lives in user1's own private PersonSpace either way.
    const { eventId } = await createEvent({ participants: [user1Person._id] })
    await eventually(async () => {
      const found = await findSlots(eventId)
      return found.length === 1 ? found : undefined
    }, 15000)

    const eventsSeenByUser2 = await user2Rest.findAll(calendar.class.Event, { eventId })
    expect(eventsSeenByUser2.length).toBe(0)

    const slotsSeenByUser2 = await user2Rest.findAll(calendar.class.BusySlot, { eventId })
    expect(slotsSeenByUser2.length).toBe(1)
    expect(slotsSeenByUser2[0].person).toBe(user1Person._id)
  }, 30000)

  it('a public event carries its title on every busy slot', async () => {
    const { eventId } = await createEvent({
      participants: [user1Person._id, user2Person._id],
      visibility: 'public'
    })

    const slots = await eventually(async () => {
      const found = await findSlots(eventId)
      return found.length === 2 ? found : undefined
    }, 15000)
    for (const slot of slots) {
      expect(slot.title).toBe('busy-slot test event')
    }
  }, 30000)

  it('a freeBusy event leaves the busy slot title empty', async () => {
    const { eventId } = await createEvent({
      participants: [user1Person._id, user2Person._id],
      visibility: 'freeBusy'
    })

    const slots = await eventually(async () => {
      const found = await findSlots(eventId)
      return found.length === 2 ? found : undefined
    }, 15000)
    for (const slot of slots) {
      expect(slot.title ?? '').toBe('')
    }
  }, 30000)

  it('a private event still creates busy slots but leaves the title empty', async () => {
    const { eventId } = await createEvent({
      participants: [user1Person._id, user2Person._id],
      visibility: 'private'
    })

    // Private time must still show as busy, only the event's content is hidden.
    const slots = await eventually(async () => {
      const found = await findSlots(eventId)
      return found.length === 2 ? found : undefined
    }, 15000)
    for (const slot of slots) {
      expect(slot.title ?? '').toBe('')
    }
  }, 30000)

  it('turning a public event private clears the title on its existing busy slots', async () => {
    const { id, eventId } = await createEvent({
      participants: [user1Person._id, user2Person._id],
      visibility: 'public'
    })
    await eventually(async () => {
      const found = await findSlots(eventId)
      return found.length === 2 && found.every((s) => s.title === 'busy-slot test event') ? found : undefined
    }, 15000)

    await updateEvent(id, { visibility: 'private' })

    // getDiffUpdate skips undefined fields, so clearing the title requires the
    // trigger to write an empty string rather than leaving the old value stuck.
    await eventually(async () => {
      const found = await findSlots(eventId)
      return found.length === 2 && found.every((s) => (s.title ?? '') === '') ? found : undefined
    }, 15000)
  }, 30000)

  it('renaming a public event updates the title on its busy slots', async () => {
    const { id, eventId } = await createEvent({
      participants: [user1Person._id, user2Person._id],
      visibility: 'public'
    })
    await eventually(async () => {
      const found = await findSlots(eventId)
      return found.length === 2 ? found : undefined
    }, 15000)

    await updateEvent(id, { title: 'renamed busy-slot test event' })

    await eventually(async () => {
      const found = await findSlots(eventId)
      return found.length === 2 && found.every((s) => s.title === 'renamed busy-slot test event') ? found : undefined
    }, 15000)
  }, 30000)
})
