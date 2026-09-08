import {
  MeasureContext,
  readOnlyGuestAccountUuid,
  Ref,
  systemAccountUuid,
  type WorkspaceUuid,
  concatLink
} from '@hcengineering/core'
import {
  buildMeetingLinkPayload,
  checkMeetingLink,
  defaultMeetingAccess,
  type MeetingLinkKind,
  MeetingMinutes,
  MeetingStatus,
  ParticipantMetadata,
  parseMeetingLinkPayload
} from '@hcengineering/love'
import { RoomServiceClient } from 'livekit-server-sdk'
import { ResolveSessionResult, WorkspaceClient } from './workspaceClient'
import { isWorkspaceLoginInfo, WorkspaceLoginInfo } from '@hcengineering/account-client'
import { decodeToken, generateToken, Token } from '@hcengineering/server-token'
import config from './config'
import { Request, Response } from 'express'
import { createToken, decodeMeetingToken, extractToken, getRoomName } from './utils'
import { getAccountClient } from '@hcengineering/server-client'
import { combineName } from '@hcengineering/contact'
import { verifyGuestPassword } from './passwords'

// Guest password brute-force guard: 10 misses per link per IP lock out the rest of a 15min window.
const PASSWORD_ATTEMPTS_WINDOW_MS = 15 * 60 * 1000
const PASSWORD_ATTEMPTS_MAX = 10

interface PasswordAttempts {
  count: number
  windowStart: number
}

export class GuestManager {
  // ponytail: unbounded map, keys never expire on their own - fine at guest-link scale, add a
  // size cap or periodic sweep if this ever becomes a lot of distinct links.
  private readonly passwordAttempts = new Map<string, PasswordAttempts>()

  constructor (
    readonly ctx: MeasureContext,
    readonly roomClient: RoomServiceClient
  ) {}

  private isRateLimited (key: string): boolean {
    const state = this.passwordAttempts.get(key)
    if (state === undefined) return false
    if (Date.now() - state.windowStart >= PASSWORD_ATTEMPTS_WINDOW_MS) {
      this.passwordAttempts.delete(key)
      return false
    }
    return state.count >= PASSWORD_ATTEMPTS_MAX
  }

  private recordFailedAttempt (key: string): void {
    const now = Date.now()
    const state = this.passwordAttempts.get(key)
    if (state === undefined || now - state.windowStart >= PASSWORD_ATTEMPTS_WINDOW_MS) {
      this.passwordAttempts.set(key, { count: 1, windowStart: now })
    } else {
      state.count++
    }
  }

  private resetAttempts (key: string): void {
    this.passwordAttempts.delete(key)
  }

  private async createShortLink (guestToken: string, workspaceId: string): Promise<string | null> {
    try {
      const sysToken = generateToken(systemAccountUuid, workspaceId as WorkspaceUuid, { service: 'love' })
      const res = await fetch(concatLink(config.AccountsURL, '/api/v1/createShortLink'), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + sysToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ payload: guestToken, workspaceId })
      })

      if (!res.ok) {
        this.ctx.error('[createShortLink] account-service returned error', { status: res.status })
        return null
      }

      const data = await res.json()
      return data?.shortId ?? null
    } catch (err: any) {
      this.ctx.error('[createShortLink] failed', { err })
      return null
    }
  }

  async handleGuestToken (req: Request, res: Response): Promise<void> {
    const { meetingId, workspaceId } = decodeMeetingToken(req, res)
    if (meetingId == null || workspaceId == null) {
      return
    }

    try {
      // We also need workspace info to generate guest token with proper workspace claims, so validate token and workspace access first
      const token = extractToken(req.headers)
      const wsLoginInfo = await getAccountClient(token).getLoginInfoByToken()
      if (!isWorkspaceLoginInfo(wsLoginInfo)) {
        res.status(401).send()
        return
      }
      res.status(200).send({
        token: await this.createGuestToken(meetingId, wsLoginInfo)
      })
    } catch (e) {
      console.error(e)
      res.status(500).send()
    }
  }

  async createGuestToken (meetingId: Ref<MeetingMinutes>, wsLoginInfo: WorkspaceLoginInfo): Promise<string> {
    const wsClient = await WorkspaceClient.create(wsLoginInfo.workspace, this.ctx)
    const meetingDoc = await wsClient.findMeetingById(meetingId)
    if (meetingDoc === undefined) {
      throw new Error('Meeting not found')
    }

    const workspaceUrl = wsLoginInfo.workspaceUrl ?? ''
    const guestToken = generateToken(
      readOnlyGuestAccountUuid,
      wsLoginInfo.workspace,
      { meetingId, workspaceUrl },
      config.ApiSecret
    )

    const shortId = await this.createShortLink(guestToken, wsLoginInfo.workspace)
    if (shortId === null) {
      this.ctx.error('[createGuestToken] failed to create short link, falling back to raw token', { meetingId })
      return guestToken
    }

    return shortId
  }

  /**
   * Resolves whatever a guest link carries into a workspace and a session. New links carry a
   * pointer, old ones a signed JWT - unbounded in lifetime, so that path cannot be removed (§11).
   */
  private async resolveGuestLink (
    raw: string,
    create: boolean,
    password?: string
  ): Promise<
    | {
      workspace: WorkspaceUuid
      workspaceUrl: string | null
      wsClient: WorkspaceClient
      session: ResolveSessionResult
      eventId?: string
      kind?: MeetingLinkKind
    }
    // The link needs a password and this call did not carry a verified one - used by /guestInfo,
    // which must never resolve the session (or anything else) before the password is checked.
    | { workspace: WorkspaceUuid, workspaceUrl: string | null, guestPasswordRequired: true }
    | { status: number, error: string }
    > {
    const pointer = parseMeetingLinkPayload(raw)
    if (pointer !== undefined) {
      const workspace = pointer.workspace as WorkspaceUuid
      const wsClient = await WorkspaceClient.create(workspace, this.ctx)
      const kind = pointer.kind ?? 'event'
      const target = await wsClient.findMeetingTarget(pointer.eventId, kind)
      if (target === undefined) return { status: 404, error: 'Meeting not found' }

      const rejection = checkMeetingLink(target.link ?? {}, pointer, {
        ...target,
        permanent: target.kind === 'meeting'
      })
      if (rejection !== undefined) {
        return {
          status: 403,
          error: rejection === 'revoked' ? 'Link has been revoked.' : 'Link has expired.'
        }
      }

      // Gate goes before anything else is resolved: a wrong guess must not learn about the
      // meeting, and `create: false` (the lobby) must never verify or peek past the flag itself.
      const guestPassword = target.link?.meetingAccess?.guestPassword
      if (guestPassword !== undefined) {
        if (!create) return { workspace, workspaceUrl: null, guestPasswordRequired: true }
        if (password === undefined || !verifyGuestPassword(password, guestPassword)) {
          return { status: 401, error: 'Wrong password' }
        }
      }

      // `start: 'link'` makes the meeting a permanent room - whoever holds the link may open a
      // session outside an occurrence. With `members` only participants can, so a guest waits.
      const openOnLink = (target.link?.meetingAccess ?? defaultMeetingAccess).start === 'link'

      // workspaceUrl is not in the pointer - the client falls back to the workspace uuid.
      return {
        workspace,
        workspaceUrl: null,
        wsClient,
        session: await wsClient.resolveSession(pointer.eventId, Date.now(), create && openOnLink, kind),
        eventId: pointer.eventId,
        kind
      }
    }

    let decoded: Token
    try {
      decoded = decodeToken(raw, true, config.ApiSecret)
    } catch (err) {
      return { status: 401, error: 'Invalid or expired token' }
    }
    const workspace = decoded.workspace
    if (typeof workspace !== 'string') return { status: 400, error: 'Invalid token payload' }

    const wsClient = await WorkspaceClient.create(workspace, this.ctx)
    return {
      workspace,
      workspaceUrl: decoded.extra?.workspaceUrl ?? null,
      wsClient,
      session: await this.resolveGuestSession(wsClient, decoded, create)
    }
  }

  /**
   * The session a guest token points at. An old token names one session; if it belongs to a
   * series, the guest moves onto the series so the link outlives the first occurrence (§11).
   */
  /**
   * The shareable link of a series. Account service deduplicates by payload, so one meeting always
   * yields one URL and nothing is stored here; bumping `linkVersion` mints a different one.
   */
  async createMeetingLink (
    eventId: string,
    workspace: WorkspaceUuid,
    linkVersion: number,
    kind: MeetingLinkKind = 'event'
  ): Promise<string | null> {
    return await this.createShortLink(buildMeetingLinkPayload({ eventId, workspace, linkVersion, kind }), workspace)
  }

  private async resolveGuestSession (
    wsClient: WorkspaceClient,
    decoded: Token,
    create: boolean
  ): Promise<ResolveSessionResult> {
    const eventId = decoded.extra?.eventId
    if (typeof eventId === 'string' && eventId !== '') {
      return await wsClient.resolveSession(eventId, Date.now(), create)
    }

    const meetingId: Ref<MeetingMinutes> = decoded.extra?.meetingId
    if (typeof meetingId !== 'string') return { error: 'not-found' }

    const meeting = await wsClient.findMeetingById(meetingId)
    if (meeting === undefined) return { error: 'not-found' }
    if (meeting.eventId !== undefined) {
      return await wsClient.resolveSession(meeting.eventId, Date.now(), create)
    }
    return { meeting }
  }

  async handleGuestInfo (req: Request, res: Response): Promise<void> {
    const guestToken = req.body.token

    if (typeof guestToken !== 'string') {
      res.status(400).send()
      return
    }

    try {
      // `create: false` - a lobby must never start the meeting just by being opened.
      const link = await this.resolveGuestLink(guestToken, false)
      if ('status' in link) {
        res.status(link.status).send({ error: link.error })
        return
      }
      if ('guestPasswordRequired' in link) {
        // Nothing else - no title, no mode, no meetingId: the link's content stays behind the password.
        res.status(200).send({
          passwordRequired: true,
          workspace: link.workspace,
          workspaceUrl: link.workspaceUrl,
          now: Date.now()
        })
        return
      }
      const { workspace, workspaceUrl } = link
      const resolved = link.session
      if (!('meeting' in resolved)) {
        if (resolved.error === 'not-found') {
          res.status(404).send({ error: 'Meeting not found' })
        } else {
          // No session between occurrences - the lobby shows the meeting's name and when to return.
          const occurrence =
            resolved.error === 'not-started'
              ? resolved.occurrence
              : resolved.error === 'no-occurrence'
                ? resolved.nextOccurrence
                : undefined
          const target =
            link.eventId !== undefined
              ? await link.wsClient.findMeetingTarget(link.eventId, link.kind ?? 'event')
              : undefined
          // `past: 'none'` gives the link nothing but the fact that a meeting was here - for a
          // recurring series with outside guests, even a name is a leak once it is over.
          const past = (target?.link?.meetingAccess ?? defaultMeetingAccess).past
          // A permanent meeting is never over: with no occurrence it is simply not running yet.
          const isOver = occurrence === undefined && target?.kind !== 'meeting'
          res.status(200).send({
            workspace,
            workspaceUrl,
            now: Date.now(),
            // No session yet: either the meeting is still ahead, or the series is over for good.
            mode: isOver ? 'after' : 'before',
            nextOccurrence: occurrence,
            title: isOver && past === 'none' ? undefined : target?.title,
            roomFound: false
          })
        }
        return
      }
      const meetingDoc = resolved.meeting
      const meetingId = meetingDoc._id
      const meetingStatus = meetingDoc.status
      const roomName = getRoomName(workspace, meetingId)
      let roomFound = false
      try {
        const rooms = await this.roomClient.listRooms([roomName])
        roomFound = !(rooms === undefined || rooms.length === 0)
      } catch (e) {
        this.ctx.warn('[guestInfo] Failed to check LiveKit room, assuming not found', { roomName })
        roomFound = false
      }

      res.status(200).send({
        meetingId,
        workspace,
        workspaceUrl,
        now: Date.now(),
        // A session with no LiveKit room behind it is not joinable yet - the lobby waits for it.
        mode: meetingStatus === MeetingStatus.Finished ? 'after' : roomFound ? 'live' : 'before',
        meetingEnd: meetingDoc.meetingEnd,
        title: meetingDoc.name,
        meetingStatus,
        roomFound
      })
    } catch (e) {
      console.error(e)
      res.status(500).send()
    }
  }

  async handleGuestJoin (req: Request, res: Response): Promise<void> {
    const guestToken = req.body.token
    const firstName = req.body.firstName
    const lastName = req.body.lastName
    const personToken = req.body.personToken
    const password = typeof req.body.password === 'string' ? req.body.password : undefined

    if (typeof guestToken !== 'string') {
      res.status(400).send()
      return
    }

    // Rate-limit key is the link itself (not the raw token, which carries a linkVersion that
    // changes on revoke) + the caller's IP. Behind a proxy every guest shares one socket address,
    // so the counter is effectively per link - stricter, and not spoofable the way X-Forwarded-For
    // would be. A legacy JWT link never carries a password to guess.
    const pointer = parseMeetingLinkPayload(guestToken)
    const attemptsKey = pointer !== undefined ? `${pointer.workspace}:${pointer.eventId}:${req.ip}` : undefined
    if (attemptsKey !== undefined && this.isRateLimited(attemptsKey)) {
      res.status(429).send({ error: 'Too many attempts' })
      return
    }

    try {
      // Whether joining may open a session is the meeting's policy: `start: 'link'` makes it a
      // permanent room, `members` keeps the guest waiting for a participant to start it.
      const link = await this.resolveGuestLink(guestToken, true, password)
      if ('status' in link) {
        if (link.status === 401 && attemptsKey !== undefined) {
          this.recordFailedAttempt(attemptsKey)
        }
        res.status(link.status).send({ error: link.error })
        return
      }
      if ('guestPasswordRequired' in link) {
        // Unreachable with create: true - resolveGuestLink only returns this for the lobby path.
        res.status(401).send({ error: 'Wrong password' })
        return
      }
      if (attemptsKey !== undefined) this.resetAttempts(attemptsKey)
      const { workspace, wsClient } = link
      const resolved = link.session
      if (!('meeting' in resolved)) {
        if (resolved.error === 'not-found') {
          res.status(404).send({ error: 'Meeting not found' })
        } else if (resolved.error === 'no-occurrence') {
          res.status(403).send({ error: 'Meeting is over.', nextOccurrence: resolved.nextOccurrence })
        } else {
          res.status(403).send({ error: 'Meeting has not started yet.' })
        }
        return
      }
      const meetingDoc = resolved.meeting
      const meetingId = meetingDoc._id

      const roomName = getRoomName(workspace, meetingId)

      if (meetingDoc.status === MeetingStatus.Finished) {
        res.status(403).send({
          error: 'Meeting has already finished.'
        })
        return
      }

      // Ensure LiveKit room exists
      const room = await this.roomClient.listRooms([roomName])
      if (room === undefined || room.length === 0) {
        this.ctx.info('No room found guest join, not possible to join', { roomName })
        res.status(404).send({
          error: 'Meeting room not found.'
        })
        return
      }
      // Try finding an existing person by name to avoid duplicates
      const personRef = await wsClient.ensurePersonByName(personToken, firstName, lastName)

      if (personRef === undefined) {
        // Repeated failures while creating a Person - do not fallback to ephemeral identity.
        this.ctx.error('[guestJoin] Failed to create Person for guest join after retries', { firstName, lastName })
        res.status(500).send({ error: 'Failed to create guest identity' })
        return
      }

      // Use the person's document id as LiveKit identity so webhooks can resolve the person
      this.ctx.info('[guestJoin] Using identity', { identity: personRef })
      // Mark this participant as a guest in the token metadata
      const guestMetadata = JSON.stringify({ isGuest: true } satisfies ParticipantMetadata)
      const roomToken = await createToken(roomName, personRef, combineName(firstName, lastName), guestMetadata)

      res.status(200).send({
        token: roomToken,
        roomName,
        person: personRef
      })
    } catch (e) {
      console.error(e)
      res.status(500).send()
    }
  }
}
