<!--
// Copyright © 2024 Hardcore Engineering Inc.
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
  import { taskTypeStore } from '@hcengineering/task-resources'
  import { Issue, IssueStatus, Project } from '@hcengineering/tracker'
  import { IconSize } from '@hcengineering/ui'
  import { getTaskTypeStates, TaskType } from '@hcengineering/task'
  import { statusStore } from '@hcengineering/view-resources'
  import { Ref } from '@hcengineering/core'

  import IssueStatusIcon from './IssueStatusIcon.svelte'

  export let value: Issue | undefined = undefined
  export let kind: Ref<TaskType> | undefined = undefined
  export let status: Ref<IssueStatus> | undefined = undefined
  export let space: Ref<Project> | undefined = undefined
  export let size: IconSize = 'small'

  $: _kind = value?.kind ?? kind
  $: _status = value?.status ?? status
  $: _space = value?.space ?? space

  $: statuses = _kind != null ? getTaskTypeStates(_kind, $taskTypeStore, $statusStore.byId) : []

  $: issueStatus = statuses?.find((status) => status._id === _status) ?? statuses[0]
</script>

{#if issueStatus != null && _kind != null && _space != null}
  <IssueStatusIcon value={issueStatus} taskType={_kind} {size} space={_space} />
{/if}
