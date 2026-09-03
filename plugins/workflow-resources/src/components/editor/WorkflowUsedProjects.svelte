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
  import { IconWithEmoji } from '@hcengineering/presentation'
  import task from '@hcengineering/task'
  import { Icon, IconOpenedArrow, Label } from '@hcengineering/ui'
  import view, { IconProps } from '@hcengineering/view'
  import { ProjectWorkflow } from '@hcengineering/workflow'

  import plugin from '../../plugin'
  import { navigateToProject } from '../../location'

  export let projects: ProjectWorkflow[] = []

  function toIconProps (p: ProjectWorkflow): IconProps {
    return p as IconProps
  }
</script>

{#if projects.length > 0}
  <div class="workflow-used-projects">
    <div class="workflow-used-projects--header">
      <Label label={plugin.string.UsedInProjects} />
    </div>
    <div class="workflow-used-projects--list">
      {#each projects as project (project._id)}
        {@const iconProps = toIconProps(project)}
        <button
          type="button"
          class="workflow-used-projects--item"
          title={project.name}
          on:click|stopPropagation={() => {
            navigateToProject(project, true)
          }}
        >
          <span class="workflow-used-projects--icon-box">
            <Icon
              icon={iconProps.icon === view.ids.IconWithEmoji ? IconWithEmoji : (iconProps.icon ?? task.icon.Task)}
              iconProps={{ icon: iconProps.color }}
              size="small"
            />
          </span>
          <span class="workflow-used-projects--name">{project.name}</span>
          <span class="workflow-used-projects--arrow">
            <Icon icon={IconOpenedArrow} size="x-small" />
          </span>
        </button>
      {/each}
    </div>
  </div>
{/if}

<style lang="scss">
  .workflow-used-projects {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
    width: 100%;
    margin-top: 0.5rem;

    &--header {
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--global-secondary-TextColor);
      text-align: left;
    }

    &--list {
      display: flex;
      flex-direction: column;
      gap: 0.375rem;
      width: 100%;
    }

    &--item {
      display: flex;
      align-items: center;
      gap: 0.625rem;
      width: 100%;
      padding: 0.5rem 0.625rem;
      border: 1px solid var(--global-subtle-ui-BorderColor);
      border-radius: var(--medium-BorderRadius);
      background-color: var(--global-ui-highlight-BackgroundColor);
      cursor: pointer;
      text-align: left;
      box-sizing: border-box;
      transition:
        background-color 0.15s ease,
        border-color 0.15s ease;

      &:hover {
        background-color: var(--global-ui-active-BackgroundColor);
        border-color: var(--global-subtle-ui-BorderColor);

        .workflow-used-projects--arrow {
          opacity: 1;
          transform: translateX(2px);
        }
      }
    }

    &--icon-box {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 1.5rem;
      height: 1.5rem;
      border-radius: var(--extra-small-BorderRadius);
      background-color: var(--global-subtle-ui-BorderColor);
      color: var(--global-tertiary-TextColor);
      flex-shrink: 0;
    }

    &--name {
      font-size: 0.875rem;
      font-weight: 500;
      color: var(--global-primary-TextColor);
      flex: 1;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    &--arrow {
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--global-tertiary-TextColor);
      opacity: 0.6;
      transition:
        opacity 0.15s ease,
        transform 0.15s ease;
      flex-shrink: 0;
    }
  }
</style>
