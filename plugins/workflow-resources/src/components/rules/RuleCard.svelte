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
// See the License for the specific language governing permissions and
// limitations under the License.
-->
<script lang="ts">
  import { IntlString } from '@hcengineering/platform'
  import { Icon, IconComponent, Label } from '@hcengineering/ui'

  import plugin from '../../plugin'

  export let title: IntlString
  export let description: IntlString
  export let icon: IconComponent | undefined = undefined
</script>

<!-- svelte-ignore a11y-no-static-element-interactions -->
<!-- svelte-ignore a11y-click-events-have-key-events -->
<div class="rule-card" on:click>
  <div class="rule-card--header">
    <div class="rule-card--badge">
      <Icon icon={icon ?? plugin.icon.Check} size="small" />
    </div>
    <span class="rule-card--title"><Label label={title} /></span>
  </div>
  <div class="rule-card--description"><Label label={description} /></div>
</div>

<style lang="scss">
  .rule-card {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.875rem 1rem;
    border-radius: var(--medium-BorderRadius, 0.5rem);
    border: 1px solid var(--global-subtle-ui-BorderColor);
    background-color: var(--global-ui-highlight-BackgroundColor);
    cursor: pointer;
    transition:
      border-color 0.15s ease,
      background-color 0.15s ease;

    &:hover {
      border-color: var(--global-subtle-ui-BorderColor);
      background-color: var(--global-ui-active-BackgroundColor);
    }

    &--header {
      display: flex;
      align-items: center;
      gap: 0.625rem;
    }

    &--badge {
      width: 1.75rem;
      height: 1.75rem;
      border-radius: 0.375rem;
      background-color: var(--global-ui-highlight-BackgroundColor);
      color: var(--global-primary-TextColor);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    &--title {
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--global-primary-TextColor);
    }

    &--description {
      font-size: 0.8125rem;
      line-height: 1.125rem;
      color: var(--global-secondary-TextColor);
      margin: 0;
    }
  }
</style>
