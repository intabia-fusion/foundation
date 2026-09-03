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
  import { RecordingState } from '@hcengineering/love'
  import { ButtonBaseSize, ModernButton } from '@hcengineering/ui'
  import { isRecordingAvailable, loveClient } from '../../../utils'
  import love from '../../../plugin'
  import { lkSessionConnected } from '../../../liveKitClient'
  import { currentMeetingMinutes, currentVideoRecording, isCancellingVideoRecording } from '../../../stores'

  export let size: ButtonBaseSize = 'large'
  export let kind: 'primary' | 'secondary' | 'tertiary' | 'negative' = 'secondary'

  // State comes from documents, not from LiveKit room metadata: the metadata flag
  // travels through the event queue and goes stale whenever the queue is degraded.
  $: isVideoRecording =
    $currentVideoRecording !== undefined || $currentMeetingMinutes?.recordingState === RecordingState.Recording
  $: isCancelling = $isCancellingVideoRecording

  // `/startRecord` answers only after the recording really started, so keeping the
  // spinner for the request alone is enough - and it cannot wedge.
  let inFlight = false

  async function toggle (): Promise<void> {
    const mm = $currentMeetingMinutes
    if (mm === undefined || inFlight || isCancelling) return

    inFlight = true
    try {
      await loveClient.record(mm, isVideoRecording)
    } catch (err) {
      console.error('[RecordingButton] toggle failed', err)
    } finally {
      inFlight = false
    }
  }
</script>

{#if hasAccountRole(getCurrentAccount(), AccountRole.User) && $isRecordingAvailable && $currentMeetingMinutes !== undefined}
  <ModernButton
    icon={isVideoRecording ? love.icon.StopRecord : love.icon.Record}
    tooltip={{
      label: isCancelling ? love.string.StoppingRecord : isVideoRecording ? love.string.StopRecord : love.string.Record
    }}
    disabled={!$lkSessionConnected || isCancelling || inFlight}
    loading={isCancelling || inFlight}
    dataId="recording-button"
    {kind}
    {size}
    on:click={() => {
      void toggle()
    }}
  />
{/if}
