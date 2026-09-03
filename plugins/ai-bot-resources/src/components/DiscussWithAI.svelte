<!--
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
-->
<script lang="ts">
  import { type Doc } from '@hcengineering/core'
  import { Button, type ButtonKind, type ButtonSize } from '@hcengineering/ui'
  import { getClient } from '@hcengineering/presentation'
  import view from '@hcengineering/view'
  import { getDocIdentifier, getDocTitle } from '@hcengineering/view-resources'
  import chunter from '@hcengineering/chunter'
  import { getResource, translate } from '@hcengineering/platform'

  import plugin from '../plugin'
  import { openOrStartObjectConversation } from '../conversation'

  // Header extension passes the edited object as `value`.
  export let value: Doc
  export let kind: ButtonKind = 'icon'
  export let size: ButtonSize = 'medium'

  const client = getClient()

  async function discuss (): Promise<void> {
    const label = await getObjectLabel(value)
    const firstMessage = await translate(plugin.string.DiscussFirstMessage, { label })
    const started = await openOrStartObjectConversation(
      { objectId: value._id, objectClass: value._class, label },
      firstMessage
    )
    if (started === undefined) return
    // Reuse chunter's sidebar thread view — no custom chat UI.
    const openThread = await getResource(chunter.function.OpenThreadInSidebar)
    await openThread(started.messageId, undefined, started.direct)
  }

  // Platform's own providers: the identifier when the class has one (FUSIO-123), else the title.
  async function getObjectLabel (doc: Doc): Promise<string> {
    const named =
      (await getDocIdentifier(client, doc._id, doc._class, doc)) ??
      (await getDocTitle(client, doc._id, doc._class, doc))
    return named ?? (await translate(client.getHierarchy().getClass(doc._class).label, {}))
  }
</script>

<Button
  icon={view.icon.AiStar}
  iconProps={{ size }}
  {kind}
  {size}
  dataId={'btnDiscussWithAI'}
  showTooltip={{ label: plugin.string.DiscussWithAI }}
  on:click={discuss}
/>
