import { MeasureContext, Ref, WorkspaceUuid } from '@hcengineering/core'
import { MeetingMinutes, ParticipantMetadata, RoomMetadata } from '@hcengineering/love'
import { decodeToken, Token } from '@hcengineering/server-token'
import { Request, Response } from 'express'
import { IncomingHttpHeaders } from 'http'
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk'
import config from './config'

export function extractToken (header: IncomingHttpHeaders): string | undefined {
  try {
    return header.authorization?.slice(7) ?? ''
  } catch {
    return undefined
  }
}

export function getWorkspaceId (req: Request): WorkspaceUuid | undefined {
  const token = extractToken(req.headers)
  if (token === undefined) {
    return undefined
  }

  let decodedToken: Token | undefined
  try {
    decodedToken = decodeToken(token)
  } catch (e) {
    return undefined
  }

  if (decodedToken === undefined || decodedToken.extra?.readonly === 'true' || decodedToken.extra?.guest === 'true') {
    return undefined
  }
  return decodedToken.workspace
}

function parseJson<T> (raw: string | null | undefined, fallback: T): T {
  if (raw === '' || raw == null) return fallback
  try {
    return JSON.parse(raw) as T
  } catch (e) {
    return fallback
  }
}

export const parseMetadata = (metadata?: string | null): RoomMetadata => parseJson<RoomMetadata>(metadata, {})

export const parseParticipantMetadata = (metadata?: string | null): ParticipantMetadata =>
  parseJson<ParticipantMetadata>(metadata, {})

export function getRoomName (workspaceId: WorkspaceUuid, meetingId: Ref<MeetingMinutes>): string {
  return `${workspaceId}_${meetingId}`
}

export function decodeMeetingToken (
  req: Request<any>,
  res: Response<any>
): { workspaceId?: WorkspaceUuid, meetingId?: Ref<MeetingMinutes> } {
  const meetingId: Ref<MeetingMinutes> = req.body.meetingId
  if (typeof meetingId !== 'string') {
    res.status(400).send()
    return {}
  }

  const workspaceId = getWorkspaceId(req)
  if (workspaceId === undefined) {
    res.status(401).send()
    return {}
  }
  return { meetingId, workspaceId }
}

export async function createToken (
  roomName: string,
  _id: string,
  participantName: string,
  metadata?: string
): Promise<string> {
  const at = new AccessToken(config.ApiKey, config.ApiSecret, {
    identity: _id,
    name: participantName,
    metadata,
    // token to expire after 10 minutes
    ttl: '10m'
  })
  at.addGrant({
    roomJoin: true,
    room: roomName
  })

  return await at.toJwt()
}

// `updateRoomMetadata` replaces the whole blob: read it back every time, a local cache
// would let one replica merge over a snapshot another has moved past and drop a flag.
export async function updateMetadata (
  ctx: MeasureContext,
  roomClient: RoomServiceClient,
  roomName: string,
  metadata: Partial<RoomMetadata>
): Promise<void> {
  const room = (await roomClient.listRooms([roomName]))[0]
  if (room === undefined) {
    ctx.warn(`Cannot update metadata: room "${roomName}" does not exist`)
    return
  }
  const currentMetadata = parseMetadata(room.metadata)

  await roomClient.updateRoomMetadata(roomName, JSON.stringify({ ...currentMetadata, ...metadata }))
}
