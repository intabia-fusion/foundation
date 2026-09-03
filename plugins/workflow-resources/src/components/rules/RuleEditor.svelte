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
  import { Class, generateId, Ref, Status } from '@hcengineering/core'
  import { getResourceP, Resource } from '@hcengineering/platform'
  import { getClient, reduceCalls } from '@hcengineering/presentation'
  import { ProjectType, TaskType } from '@hcengineering/task'
  import { AnySvelteComponent, Label } from '@hcengineering/ui'
  import {
    addRuleConfig,
    updateRuleConfig,
    Workflow,
    WorkflowRule,
    WorkflowRuleConfig,
    WorkflowTransition
  } from '@hcengineering/workflow'

  import plugin from '../../plugin'

  export let value: WorkflowRule
  export let taskType: TaskType
  export let projectType: ProjectType | undefined = undefined
  export let transition: WorkflowTransition
  export let workflow: Workflow | undefined = undefined
  export let config: WorkflowRuleConfig | undefined = undefined
  export let statuses: Status[] = []
  export let canSave = false
  export let isSaving = false

  const client = getClient()

  let editorCtor: AnySvelteComponent | undefined = undefined
  let props: Record<string, any> | undefined = undefined

  const loadEditor = reduceCalls(async (resource?: Resource<AnySvelteComponent>): Promise<void> => {
    if (resource != null) {
      editorCtor = await getResourceP(resource)
    } else {
      editorCtor = undefined
    }
  })

  $: void loadEditor(value?.editor)

  function getCategory (ruleClass: Ref<Class<WorkflowRule>>): 'validators' | 'requests' | 'postFunctions' {
    if (ruleClass === plugin.class.WorkflowValidator) return 'validators'
    if (ruleClass === plugin.class.WorkflowRequest) return 'requests'
    if (ruleClass === plugin.class.WorkflowPostFunction) return 'postFunctions'
    return 'validators'
  }

  export async function save (): Promise<void> {
    if (editorCtor == null || props == null) return
    try {
      isSaving = true
      const category = getCategory(value._class)
      if (config != null) {
        await updateRuleConfig(client, transition.attachedTo, transition._id, category, config.id, { props })
      } else {
        await addRuleConfig(client, transition.attachedTo, transition._id, category, {
          id: generateId(),
          rule: value._id,
          ruleClass: value._class,
          props
        })
      }
    } finally {
      isSaving = false
    }
  }

  function handlePropsUpdate (ev: CustomEvent<Record<string, any>>): void {
    props = ev.detail
  }
</script>

<div class="rule-editor">
  <div class="rule-editor--header">
    <div class="rule-editor--title">
      <Label label={value.label} />
    </div>
    <div class="rule-editor--subtitle">
      <Label label={value.description} />
    </div>
  </div>

  <div class="rule-editor--body">
    {#if editorCtor}
      <svelte:component
        this={editorCtor}
        bind:canSave
        {taskType}
        {projectType}
        {transition}
        {workflow}
        {statuses}
        {config}
        on:update={handlePropsUpdate}
        on:close
      />
    {/if}
  </div>
</div>

<style lang="scss">
  .rule-editor {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    padding: 0.5rem;
    width: 100%;

    &--header {
      display: flex;
      flex-direction: column;
      gap: 0.375rem;
    }

    &--title {
      font-size: 1.125rem;
      font-weight: 600;
      color: var(--global-primary-TextColor);
    }

    &--subtitle {
      font-size: 0.8125rem;
      color: var(--global-secondary-TextColor);
    }

    &--body {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }
  }
</style>
