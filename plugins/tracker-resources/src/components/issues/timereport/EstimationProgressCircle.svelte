<!--
// Copyright © 2020 Anticrm Platform Contributors.
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
<script lang="ts" context="module">
  export interface ProgressItem {
    value: number
    min?: number
    max?: number
  }

  interface CircleData {
    radius: number
    circumference: number
    dashOffset: number
    circleColor: string
    hasValue: boolean
  }
</script>

<script lang="ts">
  import { IconSize } from '@hcengineering/ui'

  export let items: ProgressItem[]
  export let size: IconSize = 'small'
  export let primary: boolean = false

  const baseRadius: number = 7
  const strokeWidth: number = 2
  const ringGap: number = 1

  function interpolateColor (
    color1: { r: number, g: number, b: number },
    color2: { r: number, g: number, b: number },
    factor: number
  ): string {
    const r = Math.round(color1.r + (color2.r - color1.r) * factor)
    const g = Math.round(color1.g + (color2.g - color1.g) * factor)
    const b = Math.round(color1.b + (color2.b - color1.b) * factor)
    return `rgb(${r}, ${g}, ${b})`
  }

  function getCircleColor (val: number, maxVal: number): string {

    const percentage = (val / maxVal) * 100

    if (percentage > 100) {
      const factor = (Math.min(percentage, 200) - 100) / 100
      return interpolateColor({ r: 255, g: 0, b: 0 }, { r: 139, g: 0, b: 0 }, factor)
    } else {
      // 0% to 100%: light green to dark green
      const factor = percentage / 100
      return interpolateColor({ r: 144, g: 238, b: 144 }, { r: 0, g: 100, b: 0 }, factor)
    }
  }

  function calculateCircleData (item: ProgressItem, index: number): CircleData {
    const itemMin = item.min ?? 0
    const itemMax = item.max ?? 100
    const itemValue = item.value

    const radius = baseRadius - index * (strokeWidth + ringGap)
    const circumference = Math.PI * (radius * 2) - 1

    let dashOffset = 0
    if (itemMax !== itemMin) {
      const procC = circumference / (itemMax - itemMin)
      dashOffset = (Math.min(itemValue, itemMax) - itemMin) * procC
    }

    const hasValue = itemMax !== itemMin && itemMin !== itemValue

    return {
      radius,
      circumference,
      dashOffset,
      circleColor: primary ? 'var(--primary-bg-color)' : getCircleColor(itemValue, itemMax),
      hasValue
    }
  }

  $: circles = items.map((item, index) => calculateCircleData(item, index))
</script>

<svg class="svg-{size}" fill="none" viewBox="0 0 16 16">
  {#each circles as circle}
    {#if circle.hasValue}
      <circle
        cx={8}
        cy={8}
        r={circle.radius}
        class="progress-circle"
        style:stroke={'var(--theme-caption-color)'}
        style:opacity={'.15'}
        style:transform={`rotate(${-78 + ((circle.dashOffset + 1) * 360) / (circle.circumference + 1)}deg)`}
        style:stroke-dasharray={circle.circumference}
        style:stroke-dashoffset={circle.dashOffset === 0 ? 0 : circle.dashOffset + 3}
      />
      <circle
        cx={8}
        cy={8}
        r={circle.radius}
        class="progress-circle"
        style:stroke={circle.circleColor}
        style:opacity={circle.dashOffset === 0 ? 0 : 1}
        style:transform={'rotate(-82deg)'}
        style:stroke-dasharray={circle.circumference}
        style:stroke-dashoffset={circle.dashOffset === 0
          ? circle.circumference
          : circle.circumference - circle.dashOffset + 1}
      />
    {/if}
  {/each}
</svg>

<style lang="scss">
  .progress-circle {
    stroke-width: 2px;
    stroke-linecap: round;
    transform-origin: center;
    transition:
      transform 0.6s ease 0s,
      stroke-dashoffset 0.6s ease 0s,
      stroke-dasharray 0.6s ease 0s,
      opacity 0.6s ease 0s;
  }
</style>
