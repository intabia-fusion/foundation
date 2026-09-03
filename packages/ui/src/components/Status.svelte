<script lang="ts">
  import type { Status } from '@hcengineering/platform'
  import { Severity, translateCB } from '@hcengineering/platform'
  import { themeStore } from '@hcengineering/theme'

  import Info from './icons/Info.svelte'
  import Label from './Label.svelte'

  export let status: Status
  export let overflow: boolean = true

  let params: Record<string, any> = {}

  $: {
    params = { ...(status?.params ?? {}) }
    if (status?.notLocalizedParams != null) {
      for (const [key, intlStr] of Object.entries(status.notLocalizedParams)) {
        translateCB(intlStr, {}, $themeStore.language, (res) => {
          params = { ...params, [key]: res }
        })
      }
    }
  }
</script>

<div class="flex-center container {status.severity}" class:overflow-label={overflow}>
  {#if status.severity !== Severity.OK}
    <Info size={'small'} />
    <span class="text-sm ml-2" class:overflow-label={overflow}>
      <Label label={status.code} {params} />
    </span>
  {/if}
</div>

<style lang="scss">
  .container {
    user-select: none;
    font-size: 14px;
    color: var(--theme-content-color);
    &.WARNING {
      color: yellow;
    }
    &.ERROR {
      color: var(--system-error-color);
    }
  }
</style>
