<!--
// Copyright © 2025 Hardcore Engineering Inc.
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
-->
<script lang="ts">
  import core, { AccountUuid, Collaborator, Doc } from '@hcengineering/core'
  import { createQuery, getClient } from '@hcengineering/presentation'

  import { AccountArrayEditor } from '../../index'

  export let object: Doc
  export let value: AccountUuid[] = []
  export let onChange: (value: AccountUuid[]) => void = () => {}
  export let draft = false
  export let width: string | undefined = undefined

  let collaborators: Collaborator[] = []

  const query = createQuery()
  const client = getClient()

  $: if (object?._id != null) {
    query.query(
      core.class.Collaborator,
      {
        attachedTo: object._id
      },
      (res) => {
        collaborators = res
      }
    )
  }

  $: dbAccounts = Array.isArray(collaborators) ? collaborators.map((c) => c.collaborator) : []
  $: accounts = draft ? (Array.isArray(value) ? value : dbAccounts) : dbAccounts

  async function change (res: AccountUuid[]): Promise<void> {
    if (draft) {
      value = res
      onChange(value)
      return
    }

    const toAdd: AccountUuid[] = Array.from(new Set(res.filter((a) => !accounts.includes(a))))
    const toRemove: Collaborator[] = Array.from(new Set(collaborators.filter((a) => !res.includes(a.collaborator))))
    for (const account of toAdd) {
      await client.addCollection(core.class.Collaborator, object.space, object._id, object._class, 'collaborators', {
        collaborator: account
      })
    }
    for (const collaborator of toRemove) {
      await client.removeCollection(
        core.class.Collaborator,
        collaborator.space,
        collaborator._id,
        collaborator.attachedTo,
        collaborator.attachedToClass,
        'collaborators'
      )
    }
  }
</script>

<AccountArrayEditor label={core.string.Collaborators} value={accounts} onChange={change} {width} />
