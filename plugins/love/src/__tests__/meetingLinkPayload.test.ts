import { buildMeetingLinkPayload, parseMeetingLinkPayload } from '../utils'

const payload = { eventId: 'E1', workspace: 'ws-1', linkVersion: 2 }

describe('meeting link payload', () => {
  it('round-trips', () => {
    expect(parseMeetingLinkPayload(buildMeetingLinkPayload(payload))).toEqual({ ...payload, kind: 'event' })
  })

  it('round-trips a permanent meeting', () => {
    const permanent = { ...payload, kind: 'meeting' as const }
    expect(parseMeetingLinkPayload(buildMeetingLinkPayload(permanent))).toEqual(permanent)
  })

  it('keeps the pre-F4 serialisation for events', () => {
    // `kind` is omitted for events, so every link minted before F4 keeps its short id.
    expect(buildMeetingLinkPayload(payload)).toEqual(buildMeetingLinkPayload({ ...payload, kind: 'event' }))
    expect(buildMeetingLinkPayload(payload)).not.toContain('kind')
  })

  it('tells a permanent meeting apart from an event with the same id', () => {
    expect(buildMeetingLinkPayload(payload)).not.toEqual(buildMeetingLinkPayload({ ...payload, kind: 'meeting' }))
  })

  it('serialises the same string for the same meeting', () => {
    // The account service deduplicates short links by the exact payload string, so a stable
    // serialisation is what keeps one meeting on one URL.
    const a = buildMeetingLinkPayload({ eventId: 'E1', workspace: 'ws-1', linkVersion: 2 })
    const b = buildMeetingLinkPayload({ linkVersion: 2, workspace: 'ws-1', eventId: 'E1' } as any)
    expect(a).toEqual(b)
  })

  it('reads an unknown kind as an event', () => {
    const parsed = parseMeetingLinkPayload(JSON.stringify({ eventId: 'E1', workspace: 'ws-1', kind: 'nonsense' }))
    expect(parsed?.kind).toEqual('event')
  })

  it('reports the old JWT form as not a payload', () => {
    expect(parseMeetingLinkPayload('header.body.signature')).toBeUndefined()
  })

  it('rejects malformed or incomplete payloads', () => {
    expect(parseMeetingLinkPayload('{ not json')).toBeUndefined()
    expect(parseMeetingLinkPayload(JSON.stringify({ workspace: 'ws-1' }))).toBeUndefined()
    expect(parseMeetingLinkPayload(JSON.stringify({ eventId: 'E1' }))).toBeUndefined()
    expect(parseMeetingLinkPayload(JSON.stringify({ eventId: '', workspace: 'ws-1' }))).toBeUndefined()
  })

  it('defaults a missing version to the first one', () => {
    const parsed = parseMeetingLinkPayload(JSON.stringify({ eventId: 'E1', workspace: 'ws-1' }))
    expect(parsed).toEqual({ eventId: 'E1', workspace: 'ws-1', linkVersion: 1, kind: 'event' })
  })
})
