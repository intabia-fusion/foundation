import { concatLink } from '@hcengineering/core'
import love, { type MeetingMinutes, type Room } from '@hcengineering/love'
import { getMetadata } from '@hcengineering/platform'
import { getPlatformToken } from './utils'
import { getCurrentEmployee } from '@hcengineering/contact'
import { getPersonByPersonRef } from '@hcengineering/contact-resources'
import { Analytics } from '@hcengineering/analytics'
import { selectedRoomPlace } from './stores'
import { get } from 'svelte/store'

export function getLoveClient (): LoveClient {
  return new LoveClient()
}

export class LoveServiceError extends Error {
  constructor (
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'LoveServiceError'
  }
}

export class LoveClient {
  async getRoomToken (meetingMinutes: MeetingMinutes): Promise<string> {
    return await this.refreshRoomToken(meetingMinutes)
  }

  async updateSessionLanguage (mm: MeetingMinutes, room: Room): Promise<void> {
    try {
      const endpoint = this.getLoveEndpoint()
      const token = getPlatformToken()

      await fetch(concatLink(endpoint, '/language'), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          meetingId: mm._id,
          language: room.language
        })
      })
    } catch (err: any) {
      Analytics.handleError(err)
      console.error(err)
    }
  }

  // `isRecording` comes from the caller: the server treats a live PendingRecording as running
  // long before `recordingState` flips, so deciding on the flag alone sends start into a 409.
  async record (mm: MeetingMinutes, isRecording: boolean): Promise<void> {
    try {
      const endpoint = this.getLoveEndpoint()
      const token = getPlatformToken()
      const path = isRecording ? '/stopRecord' : '/startRecord'
      const res = await fetch(concatLink(endpoint, path), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          meetingId: mm._id,
          title: mm.name
        })
      })
      // 409 means somebody else already flipped it, or the flip is still settling - the
      // document carries the real state, so surface it instead of failing silently.
      if (!res.ok) {
        throw new LoveServiceError(res.status, `${path} failed: ${res.status}`)
      }
    } catch (err: any) {
      Analytics.handleError(err)
      console.error(err)
      throw err
    }
  }

  private getLoveEndpoint (): string {
    const endpoint = getMetadata(love.metadata.ServiceEndpoint)
    if (endpoint === undefined) {
      throw new Error('Love service endpoint not found')
    }

    return endpoint
  }

  private async refreshRoomToken (meetingMinutes: MeetingMinutes): Promise<string> {
    const endpoint = this.getLoveEndpoint()
    if (endpoint === undefined) {
      throw new Error('Love service endpoint not found')
    }
    const myPerson = await getPersonByPersonRef(getCurrentEmployee())
    if (myPerson == null) {
      throw new Error('Cannot find current person')
    }
    const platformToken = getPlatformToken()

    const place = get(selectedRoomPlace)

    let x: number | undefined
    let y: number | undefined

    if (meetingMinutes.roomId === place?._id && place != null) {
      x = place.x
      y = place.y
    }

    const res = await fetch(concatLink(endpoint, '/getToken'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${platformToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        meetingId: meetingMinutes._id,
        _id: myPerson._id,
        participantName: myPerson.name,
        x,
        y
      })
    })
    if (!res.ok) {
      // Surface the status — callers (auto-join after knock-accept) need to
      // distinguish a transient 403 (membership propagation race) from a
      // permanent denial. Returning the response body as the token would
      // otherwise be passed straight into LiveKit and fail opaquely.
      const text = await res.text().catch(() => '')
      throw new LoveServiceError(res.status, `getToken failed: ${res.status} ${text}`)
    }
    return await res.text()
  }

  async getGuestToken (mm: MeetingMinutes): Promise<string> {
    const res = await fetch(concatLink(this.getLoveEndpoint(), '/guestToken'), {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + getPlatformToken(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ meetingId: mm._id })
    })

    if (!res.ok) {
      console.error('Failed to create guest token', { status: res.status })
      return ''
    }

    const data = await res.json()
    return data?.token ?? data
  }
}
