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
  import { type TaskType } from '@hcengineering/task'
  import { TaskTypeIcon } from '@hcengineering/task-resources'
  import { type IconSize } from '@hcengineering/ui'

  export let value: TaskType | undefined
  export let size: IconSize = 'small'
</script>

{#if value !== undefined}
  <div class="flex-row-center flex-no-shrink">
    <div class="flex-center flex-no-shrink square-4">
      <TaskTypeIcon {value} {size} />
    </div>
    <span class="ml-1-5 overflow-label disabled">{value.name}</span>
  </div>
{/if}
