import { type PersonId, type Ref } from '@hcengineering/core'
import { type Contact } from '@hcengineering/contact'
import { AccessLevel } from '..'
import { collectRsvp, rsvpPending } from '../utils'

const alice = 'alice' as PersonId
const bob = 'bob' as PersonId
const carol = 'carol' as PersonId

// Shaped like a real copy (`{ ...master, calendar, access, user }`): `participants` is the
// master's list, identical everywhere, and only `user` tells two copies apart.
const participants = ['alice-person', 'bob-person', 'carol-person'] as Array<Ref<Contact>>

function copy (who: PersonId, rsvp?: string): any {
  return { access: AccessLevel.Reader, participants, user: who, rsvp }
}

describe('collectRsvp', () => {
  it('counts nothing when nobody answered', () => {
    expect(collectRsvp([])).toEqual({ accepted: 0, declined: 0, tentative: 0 })
  })

  it('splits the answers it has', () => {
    const copies = [copy(alice, 'accepted'), copy(bob, 'declined'), copy(carol, 'tentative')]
    expect(collectRsvp(copies)).toEqual({ accepted: 1, declined: 1, tentative: 1 })
  })

  it('skips a copy without an answer', () => {
    expect(collectRsvp([copy(alice, 'accepted'), copy(bob)])).toMatchObject({ accepted: 1, declined: 0 })
  })

  it('ignores the master row', () => {
    // The organiser's own document is not an answer, and counting it would invent one.
    const master = { access: AccessLevel.Owner, participants, user: alice, rsvp: 'accepted' } as any
    expect(collectRsvp([master])).toEqual({ accepted: 0, declined: 0, tentative: 0 })
  })

  it('keeps one answer per person when copies duplicate', () => {
    expect(collectRsvp([copy(alice, 'declined'), copy(alice, 'accepted')])).toMatchObject({
      accepted: 1,
      declined: 0
    })
  })
})

describe('rsvpPending', () => {
  it('treats silence as pending, not as a refusal', () => {
    expect(rsvpPending(3, { accepted: 1, declined: 0, tentative: 0 })).toBe(2)
  })

  it('counts everyone pending before the first answer', () => {
    expect(rsvpPending(3, undefined)).toBe(3)
  })

  it('never goes negative when more answered than are invited', () => {
    // Someone dropped from the event keeps their copy until the trigger removes it.
    expect(rsvpPending(1, { accepted: 2, declined: 0, tentative: 0 })).toBe(0)
  })
})
