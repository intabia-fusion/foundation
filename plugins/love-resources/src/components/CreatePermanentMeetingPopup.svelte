<!--
// Copyright © 2026 Intabia Fusion.
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
  import { AccountArrayEditor } from '@hcengineering/contact-resources'
  import core, { getCurrentAccount, type AccountUuid } from '@hcengineering/core'
  import { RoomType } from '@hcengineering/love'
  import { Card, getClient } from '@hcengineering/presentation'
  import { EditBox, Label, ModernToggle, RadioButton } from '@hcengineering/ui'
  import { createEventDispatcher } from 'svelte'
  import love from '../plugin'

  const dispatch = createEventDispatcher()
  const client = getClient()

  const me = getCurrentAccount()

  let name: string = ''
  let type: RoomType.Video | RoomType.Audio = RoomType.Video
  let startWithRecording = false
  let startWithTranscription = false
  let members: AccountUuid[] = [me.uuid]

  // The author stays a member whatever the editor is left with - a meeting nobody could open is junk.
  function membersChanged (value: AccountUuid[]): void {
    members = value.includes(me.uuid) ? value : [me.uuid, ...value]
  }

  async function create (): Promise<void> {
    await client.createDoc(love.class.PermanentMeeting, core.space.Space, {
      name,
      type,
      language: 'en',
      startWithRecording,
      startWithTranscription,
      private: true,
      members,
      owners: [me.uuid],
      archived: false,
      description: '',
      descriptionRef: null
    })
  }
</script>

<Card label={love.string.NewMeeting} okAction={create} canSave={name.trim() !== ''} on:close={() => dispatch('close')}>
  <div class="antiGrid">
    <div class="antiGrid-row">
      <div class="antiGrid-row__header">
        <Label label={core.string.Name} />
      </div>
      <EditBox
        bind:value={name}
        placeholder={love.string.PermanentMeeting}
        kind={'large-style'}
        autoFocus
        focusIndex={1}
      />
    </div>
    <div class="antiGrid-row">
      <div class="antiGrid-row__header">
        <Label label={love.string.RoomType} />
      </div>
      <div class="flex-row-center flex-gap-4">
        <RadioButton
          bind:group={type}
          value={RoomType.Video}
          labelIntl={love.string.Video}
          action={() => (type = RoomType.Video)}
        />
        <RadioButton
          bind:group={type}
          value={RoomType.Audio}
          labelIntl={love.string.Audio}
          action={() => (type = RoomType.Audio)}
        />
      </div>
    </div>
    <div class="antiGrid-row">
      <div class="antiGrid-row__header">
        <Label label={core.string.Members} />
      </div>
      <AccountArrayEditor
        value={members}
        label={core.string.Members}
        onChange={membersChanged}
        kind={'regular'}
        size={'large'}
      />
    </div>
    <div class="antiGrid-row">
      <div class="antiGrid-row__header">
        <Label label={love.string.StartWithRecording} />
      </div>
      <ModernToggle
        size="small"
        checked={startWithRecording}
        on:change={() => (startWithRecording = !startWithRecording)}
      />
    </div>
    <div class="antiGrid-row">
      <div class="antiGrid-row__header">
        <Label label={love.string.StartWithTranscription} />
      </div>
      <ModernToggle
        size="small"
        checked={startWithTranscription}
        on:change={() => (startWithTranscription = !startWithTranscription)}
      />
    </div>
  </div>
</Card>
