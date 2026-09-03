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
  import { getResourceP, Resource } from '@hcengineering/platform'
  import { reduceCalls } from '@hcengineering/presentation'
  import { TaskType } from '@hcengineering/task'
  import { AnySvelteComponent } from '@hcengineering/ui'
  import { WorkflowRule, WorkflowRuleConfig } from '@hcengineering/workflow'

  export let config: WorkflowRuleConfig
  export let taskType: TaskType
  export let rule: WorkflowRule | undefined = undefined

  let presenterCtor: AnySvelteComponent | undefined = undefined

  const loadPresenter = reduceCalls(async (resource?: Resource<AnySvelteComponent>): Promise<void> => {
    if (resource != null) {
      presenterCtor = await getResourceP(resource)
    } else {
      presenterCtor = undefined
    }
  })

  $: void loadPresenter(rule?.presenter)
</script>

{#if presenterCtor}
  <svelte:component
    this={presenterCtor}
    {config}
    {taskType}
    {rule}
    validator={rule}
    request={rule}
    postFunction={rule}
  />
{/if}
