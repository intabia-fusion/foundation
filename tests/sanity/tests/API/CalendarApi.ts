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
import { type Class, type Doc, type Ref } from '@hcengineering/core'

import { connectTracker } from './TrackerApi'
import { PlatformUser, PlatformUserSecond, PlatformWs } from '../utils'

// Literal class ref: the calendar plugin is not a test-package dependency. Recurring events
// derive from it, so one findAll covers them too.
const eventClass = 'calendar:class:Event' as Ref<Class<Doc & { title: string }>>

/**
 * Drops the events left by earlier runs of a calendar spec, in both accounts it uses. The widget
 * shows one day, so ~20 leftover hours leave `clickFreeCellInWidget` with no free cell at all.
 * Prefixes must belong to the calling spec: the calendar specs run in parallel on separate workers.
 */
export async function dropStaleCalendarEvents (titlePrefixes: string[]): Promise<void> {
  for (const user of [PlatformUser, PlatformUserSecond]) {
    const { client } = await connectTracker(PlatformWs, user)
    for (const event of await client.findAll(eventClass, {})) {
      if (titlePrefixes.some((prefix) => (event.title ?? '').startsWith(prefix))) {
        await client.remove(event)
      }
    }
  }
}
