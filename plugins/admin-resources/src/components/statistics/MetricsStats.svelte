<script lang="ts">
  import { getMetadata } from '@hcengineering/platform'
  import presentation, { type ServiceStatistics } from '@hcengineering/presentation'
  import { ticker } from '@hcengineering/ui'
  import { MetricsInfo } from '@hcengineering/view-resources'
  import { fetchStatsJson } from './statsFetch'

  export let serviceName: string
  export let sortOrder: 'ops' | 'avg' | 'total'

  const endpoint = getMetadata(presentation.metadata.StatsUrl)

  async function fetchStats (time: number): Promise<void> {
    try {
      data = await fetchStatsJson<ServiceStatistics>(endpoint + `/api/v1/statistics?name=${serviceName}`)
    } catch (err) {
      console.error(err)
    }
  }
  let data: ServiceStatistics | undefined

  $: void fetchStats($ticker)
  $: metricsData = data?.stats
</script>

<div class="flex-column p-3 h-full" style:overflow="auto">
  {#if metricsData !== undefined}
    <MetricsInfo metrics={metricsData} {sortOrder} />
  {/if}
</div>

<style lang="scss">
  .greyed {
    color: rgba(black, 0.5);
  }
</style>
