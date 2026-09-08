<!--
  Copyright © 2026 Intabia Fusion.

  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License. You may
  obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

  See the License for the specific language governing permissions and
  limitations under the License.
-->
<script lang="ts">
  import platform, { getMetadata, type Asset, type Metadata } from '@hcengineering/platform'
  import { Icon, PreviewControls } from '@hcengineering/ui'
  import { onMount } from 'svelte'

  // Check if we're in development mode
  const isDevelopment = getMetadata(platform.metadata.DevModel)

  if (!isDevelopment) {
    console.warn('Theme Preview is only intended for development use.')
  }

  // Define all accent themes
  const accents = [
    { id: 'intabia', name: 'Intabia', color: '#cf13a2' },
    { id: 'intabia2', name: 'Intabia2', color: '#6b3ad3' },
    { id: 'huly', name: 'Huly', color: '#3364e2' },
    { id: 'blue', name: 'Blue', color: '#3478f6' },
    { id: 'purple', name: 'Purple', color: '#8a4292' },
    { id: 'pink', name: 'Pink', color: '#e45c9c' },
    { id: 'red', name: 'Red', color: '#ce4745' },
    { id: 'orange', name: 'Orange', color: '#e8883a' },
    { id: 'yellow', name: 'Yellow', color: '#f6c94e' },
    { id: 'green', name: 'Green', color: '#78b856' },
    { id: 'graphite', name: 'Graphite', color: '#989898' }
  ]

  // Tracker icons overview (dev page): resolved by metadata id to avoid a tracker dependency
  interface IconInfo {
    name: string
    desc: string
    unused?: boolean
  }
  const trackerIcons: Record<string, IconInfo[]> = {
    'Navigation / application': [
      { name: 'TrackerApplication', desc: 'Tracker application icon' },
      { name: 'MyIssues', desc: 'My Issues navigation item' },
      { name: 'Issues', desc: 'Issues panel, classic project icon' },
      { name: 'Components', desc: 'Components navigation item, IconComponent' },
      { name: 'Labels', desc: 'LabelsView, Labels navigation item' },
      { name: 'Milestone', desc: 'Milestone presenters, navigation' },
      { name: 'IssueTemplates', desc: 'issue templates, CreateIssue' },
      { name: 'Inbox', desc: '', unused: true },
      { name: 'Views', desc: '', unused: true },
      { name: 'Project', desc: '', unused: true },
      { name: 'Magnifier', desc: '', unused: true }
    ],
    'Issues and hierarchy': [
      { name: 'Issue', desc: 'issue icon: RelationsPopup, RelatedIssues, GitHub' },
      { name: 'Subissue', desc: 'add existing sub-issue (SubIssues, action)' },
      { name: 'Parent', desc: 'parent selector in CreateIssue, Set parent action' },
      { name: 'UnsetParent', desc: 'unset parent in EditIssue, Unset parent action' },
      { name: 'NewIssue', desc: 'new issue actions' },
      { name: 'Relations', desc: 'related issues: actions, settings' },
      { name: 'Component', desc: 'ComponentPresenter/Selector/Browser' },
      { name: 'DueDate', desc: 'EstimationEditor, Set due date action' },
      { name: 'Estimation', desc: 'estimation editor' },
      { name: 'TimeReport', desc: 'time report' },
      { name: 'CopyBranch', desc: 'Copy branch name' },
      { name: 'Duplicate', desc: 'Duplicate issue action' },
      { name: 'Home', desc: 'default for project/component/milestone' },
      { name: 'Start', desc: '', unused: true },
      { name: 'Stop', desc: '', unused: true },
      { name: 'RedCircle', desc: '', unused: true },
      { name: 'ComponentsList', desc: '', unused: true }
    ],
    'Status categories': [
      { name: 'CategoryBacklog', desc: 'Move to Backlog action' },
      { name: 'CategoryUnstarted', desc: '', unused: true },
      { name: 'CategoryStarted', desc: '', unused: true },
      { name: 'CategoryCompleted', desc: '', unused: true },
      { name: 'CategoryCanceled', desc: '', unused: true }
    ],
    Priorities: [
      { name: 'PriorityNoPriority', desc: 'No priority' },
      { name: 'PriorityUrgent', desc: 'Urgent' },
      { name: 'PriorityHigh', desc: 'High' },
      { name: 'PriorityMedium', desc: 'Medium' },
      { name: 'PriorityLow', desc: 'Low' }
    ],
    'Milestone statuses': [
      { name: 'MilestoneStatusPlanned', desc: 'Planned' },
      { name: 'MilestoneStatusInProgress', desc: 'In Progress' },
      { name: 'MilestoneStatusPaused', desc: '', unused: true },
      { name: 'MilestoneStatusCompleted', desc: 'Completed' },
      { name: 'MilestoneStatusCanceled', desc: 'Canceled' }
    ]
  }

  function trackerIcon (name: string): Asset | undefined {
    const id = `tracker:icon:${name}` as Metadata<Asset>
    return getMetadata(id) !== undefined ? id : undefined
  }

  onMount(() => {
    document.documentElement.setAttribute('class', '')
  })
</script>

{#if isDevelopment}
  <div class="theme-preview-container">
    <h1>Tracker icons</h1>
    {#each Object.entries(trackerIcons) as [group, icons]}
      <h2>{group}</h2>
      <div class="icon-grid">
        {#each icons as info}
          {@const asset = trackerIcon(info.name)}
          <div class="icon-cell" class:unused={info.unused}>
            {#if asset}
              <span class="icon-sample"><Icon icon={asset} size={'small'} /></span>
              <span class="icon-sample"><Icon icon={asset} size={'medium'} /></span>
              <span class="icon-sample"><Icon icon={asset} size={'large'} /></span>
            {:else}
              <span class="icon-sample">?</span>
            {/if}
            <div class="icon-info">
              <b>{info.name}</b>
              <span>{info.unused ? 'unused' : info.desc}</span>
            </div>
          </div>
        {/each}
      </div>
    {/each}
    {#each accents as accent}
      <div class="accent-group flex flex-row-center">
        <!-- Light theme version -->
        <div class="theme-section">
          <h2>{accent.name}-Light Theme</h2>
          <div
            class="p-1 accent-container theme-light accent-{accent.id} accent-light-{accent.id}"
            style:background-color="var(--theme-drawing-bg-color)"
          >
            <PreviewControls {accent} />
          </div>
        </div>

        <div class="theme-section">
          <h2>{accent.name}-Dark Theme</h2>
          <div
            class="p-1 accent-container theme-dark accent-{accent.id} accent-dark-{accent.id}"
            style:background-color="var(--theme-drawing-bg-color)"
          >
            <PreviewControls {accent} />
          </div>
        </div>
      </div>
    {/each}
  </div>
{:else}
  <div class="development-only-message">
    <h1>Theme Preview</h1>
    <p>This application is only available in development mode.</p>
    <p>Please use development environment to access this feature.</p>
  </div>
{/if}

<style lang="scss">
  .theme-preview-container {
    padding: 2rem;
    overflow: auto;
  }
  .icon-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr));
    gap: 0.5rem;
    margin-bottom: 1rem;
  }
  .icon-cell {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem;
    border: 1px solid var(--theme-divider-color);
    border-radius: 0.375rem;

    &.unused {
      opacity: 0.5;
    }
  }
  .icon-sample {
    display: flex;
    align-items: center;
    color: var(--theme-content-color);
  }
  .icon-info {
    display: flex;
    flex-direction: column;
    font-size: 0.75rem;

    span {
      color: var(--theme-dark-color);
    }
  }
</style>
