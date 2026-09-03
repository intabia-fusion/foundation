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
import { writable } from 'svelte/store'
import contact, { getFirstName, type Person, type SocialIdentity } from '@hcengineering/contact'
import { createQuery, onClient } from '@hcengineering/presentation'
import { aiBotEmailSocialKey } from '@hcengineering/ai-bot'

// Empty until the query resolves, and empty again if the bot has not been provisioned yet.
export const aiBotSocialIdentityStore = writable<SocialIdentity | undefined>(undefined)
/** First name of the bot as the pod created it (FIRST_NAME), for labels that name the assistant. */
export const aiBotNameStore = writable<string>('')
const identityQuery = createQuery(true)
const personQuery = createQuery(true)

onClient(() => {
  identityQuery.query(contact.class.SocialIdentity, { key: aiBotEmailSocialKey }, (res) => {
    aiBotSocialIdentityStore.set(res[0])
    const person = res[0]?.attachedTo
    if (person === undefined) return
    personQuery.query<Person>(contact.class.Person, { _id: person }, (persons) => {
      aiBotNameStore.set(getFirstName(persons[0]?.name ?? ''))
    })
  })
})
