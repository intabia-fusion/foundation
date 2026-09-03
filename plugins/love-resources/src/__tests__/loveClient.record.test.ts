//
// Copyright © 2026 Intabia Fusion.
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

import { RecordingState, type MeetingMinutes } from '@hcengineering/love'
import { LoveClient } from '../loveClient'

jest.mock('@hcengineering/platform', () => ({
  ...jest.requireActual('@hcengineering/platform'),
  getMetadata: jest.fn(() => 'http://love')
}))
jest.mock('@hcengineering/analytics', () => ({ Analytics: { handleError: jest.fn() } }))
jest.mock('@hcengineering/contact', () => ({ getCurrentEmployee: jest.fn() }))
jest.mock('@hcengineering/contact-resources', () => ({ getPersonByPersonRef: jest.fn() }))
jest.mock('svelte/store', () => ({ get: jest.fn(() => undefined) }))
jest.mock('../stores', () => ({ selectedRoomPlace: {} }))
jest.mock('../utils', () => ({ getPlatformToken: jest.fn(() => 'token') }))

function requestedPath (): string {
  return new URL((fetch as unknown as jest.Mock).mock.calls[0][0]).pathname
}

describe('LoveClient.record', () => {
  const client = new LoveClient()
  // Recording is live but the document still lags behind - exactly the stuck-button state.
  const staleMeeting = { _id: 'mm-1', name: 'All hands', recordingState: RecordingState.NotStarted }

  beforeEach(() => {
    globalThis.fetch = jest.fn(async () => ({ ok: true, status: 200 })) as any
  })

  it('stops by the caller state, not by the lagging document (defect: /startRecord answers 409)', async () => {
    await client.record(staleMeeting as unknown as MeetingMinutes, true)

    expect(requestedPath()).toBe('/stopRecord')
  })

  it('starts when nothing is recording', async () => {
    await client.record(staleMeeting as unknown as MeetingMinutes, false)

    expect(requestedPath()).toBe('/startRecord')
  })
})
