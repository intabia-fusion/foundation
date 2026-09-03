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
  import { AccountRole, getCurrentAccount, hasAccountRole } from '@hcengineering/core'
  import { TranscriptionState } from '@hcengineering/love'
  import { isTranscriptionAllowed, startTranscription, stopTranscription } from '../../../utils'
  import { lkSessionConnected } from '../../../liveKitClient'
  import { currentMeetingMinutes } from '../../../stores'
  import love from '../../../plugin'
  import view from '@hcengineering/view'
  import { ButtonBaseSize, ModernButton } from '@hcengineering/ui'

  export let size: ButtonBaseSize = 'large'
  export let kind: 'primary' | 'secondary' | 'tertiary' | 'negative' = 'secondary'

  // Same reasoning as RecordingButton: read the meeting document, not the room metadata.
  $: isTranscribing = $currentMeetingMinutes?.transcriptionState === TranscriptionState.Transcribing

  let inFlight = false

  async function toggle (): Promise<void> {
    const mm = $currentMeetingMinutes
    if (mm === undefined || inFlight) return

    inFlight = true
    try {
      if (isTranscribing) {
        await stopTranscription(mm)
      } else {
        await startTranscription(mm)
      }
    } catch (err) {
      console.error('[TranscriptionButton] toggle failed', err)
    } finally {
      inFlight = false
    }
  }
</script>

{#if hasAccountRole(getCurrentAccount(), AccountRole.User) && isTranscriptionAllowed() && $lkSessionConnected && $currentMeetingMinutes !== undefined}
  <ModernButton
    icon={view.icon.Feather}
    iconProps={isTranscribing ? { fill: 'var(--button-negative-BackgroundColor)' } : {}}
    tooltip={{ label: isTranscribing ? love.string.StopTranscription : love.string.StartTranscription }}
    disabled={inFlight}
    loading={inFlight}
    dataId="transcription-button"
    {kind}
    {size}
    on:click={() => {
      void toggle()
    }}
  />
{/if}
