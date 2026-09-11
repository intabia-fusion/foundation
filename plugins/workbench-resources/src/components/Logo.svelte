<!--
// Copyright © 2022 Hardcore Engineering Inc.
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
  import { createQuery, getCurrentWorkspaceUuid, getFileSrcSet, getFileUrl } from '@hcengineering/presentation'
  import { WorkspaceLogo } from '@hcengineering/ui'
  import setting, { WorkspaceSetting } from '@hcengineering/setting'

  import { workspacesStore } from '../utils'
  import { crossWorkspaceNotificationStore } from '../workbench'

  export let mini: boolean = false
  export let workspace: string

  const currentWorkspaceUuid = getCurrentWorkspaceUuid()

  const wsSettingQuery = createQuery()

  let workspaceSetting: WorkspaceSetting | undefined = undefined
  wsSettingQuery.query(setting.class.WorkspaceSetting, {}, (res) => {
    workspaceSetting = res[0]
  })
  $: url = workspaceSetting?.icon != null ? getFileUrl(workspaceSetting.icon) : undefined
  $: srcset = workspaceSetting?.icon != null ? getFileSrcSet(workspaceSetting.icon, 128) : undefined

  $: workspacesNotification = $crossWorkspaceNotificationStore

  $: notify = $workspacesStore.some(
    (it) => it.uuid !== currentWorkspaceUuid && workspacesNotification?.[it.uuid] === true
  )
</script>

<WorkspaceLogo name={workspace ?? ''} {mini} logoUrl={url} logoSrcset={srcset} accent {notify} />
