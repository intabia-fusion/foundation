<!--
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
-->
<script lang="ts">
  import { Loading, Scroller, formatDuration, formatNumberCompact, themeStore } from '@hcengineering/ui'
  import { getCurrentWorkspaceUuid } from '@hcengineering/presentation'
  import billingPlugin from '@hcengineering/billing'
  import type { DatalakeStatsByType } from '@hcengineering/billing-client'
  import love from '@hcengineering/love'
  import view from '@hcengineering/view'
  import { filesize } from 'filesize'
  import StatsCard from './StatsCard.svelte'
  import drivePlugin from '@hcengineering/drive'
  import Category from './Category.svelte'
  import ChartCard from './ChartCard.svelte'
  import StorageBreakdown from './StorageBreakdown.svelte'
  import { getBillingClient, calculateLimits } from '../utils'
  import { subscriptionStore } from '../stores/subscription'

  const billingClient = getBillingClient()

  let totalDatalakeSize = 0
  let totalDatalakeCount = 0
  let totalEgressDuration = 0
  let egressDurationByDay: { date: number, value: number }[] = []
  let totalTranscriptDuration = 0
  let totalTokensCount = 0
  let totalMeetingMinutes = 0
  let maxParticipants = 0
  let avgMeetingDuration = 0
  let maxMeetingDuration = 0
  let meetingMinutesByDay: { date: number, value: number }[] = []
  let transcriptByDay: { date: number, value: number }[] = []
  let datalakeByType: DatalakeStatsByType[] = []

  async function loadBillingData (): Promise<void> {
    if (billingClient == null) return
    const billingStats = await billingClient.getBillingStats(getCurrentWorkspaceUuid())
    totalDatalakeSize = billingStats.datalakeStats.size
    totalDatalakeCount = billingStats.datalakeStats.count
    datalakeByType = billingStats.datalakeStats.byType ?? []
    totalEgressDuration = billingStats.liveKitStats.egress.reduce((sum, e) => sum + e.minutes, 0) * 60000
    totalTranscriptDuration = billingStats.aiStats.transcript.totalDurationSeconds * 1000
    totalTokensCount = billingStats.aiStats.tokens.reduce((sum, s) => sum + s.totalTokens, 0)

    // Participant daily stats
    const participantDaily = billingStats.participantDailyStats ?? []
    totalMeetingMinutes = participantDaily.reduce((sum, d) => sum + d.totalMinutes, 0)
    maxParticipants = participantDaily.reduce((max, d) => Math.max(max, d.maxParticipants), 0)
    avgMeetingDuration =
      participantDaily.length > 0
        ? participantDaily.reduce((sum, d) => sum + d.avgMeetingDurationMinutes, 0) / participantDaily.length
        : 0
    maxMeetingDuration = participantDaily.reduce((max, d) => Math.max(max, d.maxMeetingDurationMinutes), 0)

    meetingMinutesByDay = participantDaily.map((d) => {
      const date = new Date(Date.parse(d.day))
      date.setHours(0, 0, 0, 0)
      return { date: date.getTime(), value: d.totalMinutes * 60000 }
    })

    // Transcript daily stats
    const transcriptDaily = billingStats.transcriptDailyStats ?? []
    transcriptByDay = transcriptDaily.map((d) => {
      const date = new Date(Date.parse(d.day))
      date.setHours(0, 0, 0, 0)
      return { date: date.getTime(), value: d.totalDurationSeconds * 1000 }
    })

    egressDurationByDay = billingStats.liveKitStats.egress.map((s) => {
      const date = new Date(Date.parse(s.day))
      date.setHours(0, 0, 0, 0)
      return { date: date.getTime(), value: s.minutes * 60000 }
    })
  }
</script>

{#await loadBillingData()}
  <Loading />
{:then _}
  <Scroller align={'center'} padding={'var(--spacing-2)'} bottomPadding={'var(--spacing-2)'}>
    <div class="hulyComponent-content gapV-4">
      <Category icon={drivePlugin.icon.DriveApplication} label={drivePlugin.string.Drive}>
        <div class="row">
          <StatsCard label={billingPlugin.string.DriveSize} text={filesize(totalDatalakeSize, { spacer: ' ' })} />
          <StatsCard label={billingPlugin.string.DriveCount} text={totalDatalakeCount.toString()} />
        </div>
        {#if datalakeByType.length > 0}
          <StorageBreakdown
            byType={datalakeByType}
            totalSize={totalDatalakeSize}
            limit={calculateLimits(
              $subscriptionStore.currentPlan,
              $subscriptionStore.currentPackage,
              $subscriptionStore.currentSubscription,
              $subscriptionStore.currentPackageSubscription
            )?.storageLimit ?? 0}
          />
        {/if}
      </Category>
      <Category icon={view.icon.AiStar} label={billingPlugin.string.AI}>
        <div class="row">
          <StatsCard
            label={billingPlugin.string.TranscriptionTime}
            text={formatDuration(totalTranscriptDuration, $themeStore.language)}
          />
          <StatsCard label={billingPlugin.string.TotalTokens} text={formatNumberCompact(totalTokensCount)} />
        </div>
      </Category>
      <Category icon={love.icon.Love} label={love.string.Office}>
        <div class="row">
          <StatsCard
            label={billingPlugin.string.OfficeSessionsDuration}
            text={formatDuration(totalMeetingMinutes * 60000, $themeStore.language)}
          />
          <StatsCard
            label={billingPlugin.string.OfficeEgressDuration}
            text={formatDuration(totalEgressDuration, $themeStore.language)}
          />
        </div>
        <div class="row">
          <!--<StatsCard label={billingPlugin.string.MaxParticipants} text={maxParticipants.toString()} />-->
          <StatsCard
            label={billingPlugin.string.AvgMeetingDuration}
            text={formatDuration(avgMeetingDuration * 60000, $themeStore.language)}
          />
          <StatsCard
            label={billingPlugin.string.MaxMeetingDuration}
            text={formatDuration(maxMeetingDuration * 60000, $themeStore.language)}
          />
        </div>
        <div class="row">
          <ChartCard
            label={love.string.Office}
            valueFormatter={(v) => formatDuration(v, $themeStore.language)}
            series={[
              {
                label: billingPlugin.string.OfficeSessionsDuration,
                color: 'var(--theme-state-primary-color)',
                data: meetingMinutesByDay
              },
              {
                label: billingPlugin.string.TranscriptionTime,
                color: 'var(--theme-state-positive-color)',
                data: transcriptByDay
              },
              {
                label: billingPlugin.string.OfficeEgressDuration,
                color: 'var(--theme-state-negative-color)',
                data: egressDurationByDay
              }
            ]}
          />
        </div>
      </Category>
    </div>
  </Scroller>
{/await}

<style lang="scss">
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
</style>
