//
// Copyright © 2025 Hardcore Engineering Inc.
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

import { get, writable, readable } from 'svelte/store'
import core, { SortingOrder, type WithLookup, type PersonId } from '@hcengineering/core'
import attachment, { type SavedAttachments } from '@hcengineering/attachment'
import { createQuery, onClient, getClient } from '@hcengineering/presentation'
import { getAllSocialStringsByPersonRef, getCurrentEmployee } from '@hcengineering/contact'

export const savedAttachmentsStore = writable<Array<WithLookup<SavedAttachments>>>([])
export const isSavedAttachmentsLoaded = writable(false)
export const mySocialStringsStore = readable<Set<PersonId> | undefined>(undefined, (set) => {
  void getMySocialStrings().then((s) => {
    set(s)
  })
})

let mySocialStringsCache: Set<PersonId> | undefined
let mySocialStringsPromise: Promise<Set<PersonId>> | undefined

const savedAttachmentsQuery = createQuery(true)

export function loadSavedAttachments (): void {
  if (get(isSavedAttachmentsLoaded)) {
    return
  }

  onClient(() => {
    savedAttachmentsQuery.query(
      attachment.class.SavedAttachments,
      { space: core.space.Workspace },
      (res) => {
        isSavedAttachmentsLoaded.set(true)
        savedAttachmentsStore.set(res.filter(({ $lookup }) => $lookup?.attachedTo !== undefined))
      },
      { lookup: { attachedTo: attachment.class.Attachment }, sort: { modifiedOn: SortingOrder.Descending } }
    )
  })
}

export async function getMySocialStrings (): Promise<Set<PersonId>> {
  if (mySocialStringsCache !== undefined) return mySocialStringsCache
  mySocialStringsPromise ??= getAllSocialStringsByPersonRef(getClient(), getCurrentEmployee()).then((ids) => {
    mySocialStringsCache = new Set<PersonId>(ids)
    return mySocialStringsCache
  })
  return await mySocialStringsPromise
}
