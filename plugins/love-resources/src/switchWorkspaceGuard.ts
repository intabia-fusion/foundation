//
// Copyright © 2026 Intabia Fusion
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

import { getCurrentEmployee } from '@hcengineering/contact'
import { isOffice } from '@hcengineering/love'
import { MessageBox } from '@hcengineering/presentation'
import { showPopup } from '@hcengineering/ui'
import { get } from 'svelte/store'

import { lkSessionConnected } from './liveKitClient'
import love from './plugin'
import { currentRoom } from './stores'

/** Leaving the workspace drops the LiveKit session, and in an office it ends the meeting for everyone. */
export async function confirmSwitchWorkspace (): Promise<boolean> {
  if (!get(lkSessionConnected)) return true
  const room = get(currentRoom)
  const endsMeeting = room !== undefined && isOffice(room) && room.person === getCurrentEmployee()
  return await new Promise<boolean>((resolve) => {
    showPopup(
      MessageBox,
      {
        label: love.string.SwitchWorkspaceInMeeting,
        message: endsMeeting ? love.string.SwitchWorkspaceEndsMeeting : love.string.SwitchWorkspaceLeaveMeeting,
        dangerous: endsMeeting
      },
      undefined,
      (result?: boolean) => {
        resolve(result === true)
      }
    )
  })
}
