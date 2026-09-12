import { checkMeetingLink } from '../utils'
import { defaultMeetingAccess, type MeetingEventLink } from '../types'

const day = 24 * 60 * 60 * 1000
const now = new Date('2026-03-10T12:00:00Z').getTime()

function link (extra: Partial<MeetingEventLink> = {}): Pick<MeetingEventLink, 'linkVersion' | 'meetingAccess'> {
  return { linkVersion: 1, meetingAccess: defaultMeetingAccess, ...extra }
}

describe('checkMeetingLink', () => {
  it('accepts a link whose version still matches', () => {
    expect(checkMeetingLink(link(), { linkVersion: 1 }, { nextOccurrence: now + day }, now)).toBeUndefined()
  })

  it('rejects a link issued before a revoke', () => {
    // The old short id keeps resolving; it is the version inside its payload that is stale.
    expect(checkMeetingLink(link({ linkVersion: 2 }), { linkVersion: 1 }, { nextOccurrence: now + day }, now)).toEqual(
      'revoked'
    )
  })

  it('treats a missing version on either side as the first one', () => {
    expect(checkMeetingLink(link({ linkVersion: undefined }), {}, {}, now)).toBeUndefined()
    expect(checkMeetingLink(link({ linkVersion: 1 }), {}, {}, now)).toBeUndefined()
  })

  it('keeps a recurring link alive regardless of when the last session ended', () => {
    // Counting afterTtl here would kill a weekly meeting every week.
    const series = { nextOccurrence: now + 5 * day, lastMeetingEnd: now - 30 * day }
    expect(checkMeetingLink(link(), { linkVersion: 1 }, series, now)).toBeUndefined()
  })

  it('never expires a permanent meeting, however long since its last session', () => {
    const stale = { lastMeetingEnd: now - 400 * day, permanent: true }
    expect(checkMeetingLink(link(), { linkVersion: 1 }, stale, now)).toBeUndefined()
  })

  it('still revokes a permanent meeting link', () => {
    const stale = { lastMeetingEnd: now - day, permanent: true }
    expect(checkMeetingLink(link({ linkVersion: 3 }), { linkVersion: 2 }, stale, now)).toEqual('revoked')
  })

  it('expires once the series is over and afterTtl has passed', () => {
    const overSince = { lastMeetingEnd: now - 8 * day }
    expect(checkMeetingLink(link(), { linkVersion: 1 }, overSince, now)).toEqual('expired')
  })

  it('still opens within afterTtl of the last session', () => {
    const overSince = { lastMeetingEnd: now - 6 * day }
    expect(checkMeetingLink(link(), { linkVersion: 1 }, overSince, now)).toBeUndefined()
  })

  it('honours a custom afterTtl', () => {
    const short = link({ meetingAccess: { ...defaultMeetingAccess, afterTtl: day } })
    expect(checkMeetingLink(short, { linkVersion: 1 }, { lastMeetingEnd: now - 2 * day }, now)).toEqual('expired')
    expect(
      checkMeetingLink(short, { linkVersion: 1 }, { lastMeetingEnd: now - 2 * 60 * 60 * 1000 }, now)
    ).toBeUndefined()
  })

  it('accepts a link for a series that has not run yet and has nothing scheduled', () => {
    // No session ever ended, so there is no point to count a lifetime from.
    expect(checkMeetingLink(link(), { linkVersion: 1 }, {}, now)).toBeUndefined()
  })
})
