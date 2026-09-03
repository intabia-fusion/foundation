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
  import { Icon, IconSize } from '@hcengineering/ui'
  import workflow from '@hcengineering/workflow'

  export let size: IconSize = 'small'
  export let inline: boolean = false
</script>

<!-- svelte-ignore a11y-click-events-have-key-events -->
<!-- svelte-ignore a11y-no-static-element-interactions -->
<div class="flex-center state-container clear-mins" class:inline on:click>
  <Icon icon={workflow.icon.Workflow} {size} />
</div>

<style lang="scss">
  .state-container {
    flex-shrink: 0;

    &.inline {
      transform: translateY(0.125rem);
    }
  }
</style>
