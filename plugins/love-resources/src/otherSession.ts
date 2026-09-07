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

import { type Ref } from '@hcengineering/core'
import { type MeetingMinutes, type ParticipantInfo } from '@hcengineering/love'
import { get } from 'svelte/store'

import { myLastSessionSid } from './liveKitClient'
import { meetings, myInfos } from './stores'

/**
 * A seat of mine in another live meeting: another tab or device is still connected there, holding
 * that room open for everyone else. `infos` collapses both rows of one person into the newest, so
 * this reads the raw list.
 *
 * Kept free of `@hcengineering/ui` so `meetings.ts` can call it: that package pulls `.svelte`,
 * which jest cannot parse, and importing it there breaks every test of this module.
 */
export function findOtherLiveSession (
  target: Ref<MeetingMinutes>,
  ownTab: Ref<MeetingMinutes> | undefined
): ParticipantInfo | undefined {
  const mySid = get(myLastSessionSid)
  const live = get(meetings)
  return get(myInfos).find(
    (it) =>
      it.meeting !== target &&
      it.meeting !== ownTab &&
      // This tab left a moment ago and the webhook has not removed its row yet.
      (mySid === undefined || it.sessionId !== mySid) &&
      // `meetings` excludes Finished, so a row pointing outside it is a leftover nobody is in.
      live.some((m) => m._id === it.meeting)
  )
}
