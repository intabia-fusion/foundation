<!--
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
  import { type WorkspaceDataId, type WorkspaceUuid } from '@hcengineering/core'
  import { getMetadata } from '@hcengineering/platform'
  import { Card } from '@hcengineering/presentation'
  import setting from '@hcengineering/setting'
  import { Button, Label } from '@hcengineering/ui'
  import { createEventDispatcher } from 'svelte'

  import login from '../plugin'

  export let uuid: WorkspaceUuid
  export let dataId: WorkspaceDataId | undefined = undefined
  export let deleteOn: number
  // Workspace-scoped token: the backup service authorizes downloads with it.
  export let token: string

  const dispatch = createEventDispatcher()
  const backupUrl = getMetadata(setting.metadata.BackupUrl) ?? ''
  const backupLink = `${backupUrl}/${dataId ?? uuid}/index.html`

  let copiedLink = false
  let copiedToken = false

  function copy (value: string, mark: (v: boolean) => void): void {
    void navigator.clipboard.writeText(value).then(() => {
      mark(true)
      setTimeout(() => {
        mark(false)
      }, 2500)
    })
  }
</script>

<Card
  label={login.string.ScheduledForDeletion}
  labelProps={{ date: new Date(deleteOn).toLocaleDateString() }}
  okLabel={login.string.CancelWorkspaceDeletion}
  canSave={true}
  okAction={() => {
    dispatch('close', 'cancel')
  }}
  on:close={() => dispatch('close', undefined)}
>
  <div class="flex-col">
    <div class="mb-4">
      <Label
        label={login.string.WorkspaceDeletionScheduledDesc}
        params={{ date: new Date(deleteOn).toLocaleDateString() }}
      />
    </div>
    {#if backupUrl !== ''}
      <div class="flex-row-center flex-between mb-2">
        <div class="wrap">
          <Label label={setting.string.BackupLinkInfo} />
          <div class="select-text anti-component p-3 border-b-1 border-divider-color">{backupLink}</div>
        </div>
        <Button
          label={copiedLink ? login.string.Copied : login.string.CopyToClipboard}
          on:click={() => {
            copy(backupLink, (v) => (copiedLink = v))
          }}
        />
      </div>
      <div class="flex-row-center flex-between">
        <Label label={setting.string.BackupBearerTokenInfo} />
        <Button
          label={copiedToken ? login.string.Copied : login.string.CopyToClipboard}
          on:click={() => {
            copy(token, (v) => (copiedToken = v))
          }}
        />
      </div>
    {/if}
  </div>
</Card>
