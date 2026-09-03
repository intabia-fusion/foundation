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
  import { onMount } from 'svelte'
  import { OK, Status } from '@hcengineering/platform'
  import { LoginInfo } from '@hcengineering/login'
  import { WorkspaceInfoWithStatus } from '@hcengineering/core'

  import login from '../plugin'
  import { BottomAction } from '..'
  import { getAccount, getAccountDisplayName, getWorkspaces, goTo } from '../utils'
  import Form from './Form.svelte'
  import Label from './internal/Label.svelte'

  const status: Status = OK
  let loginInfo: LoginInfo | null | undefined
  let bottomActions: BottomAction[] = []

  onMount(async () => {
    loginInfo = await getAccount()

    let workspaces: WorkspaceInfoWithStatus[] = []
    try {
      workspaces = await getWorkspaces()
    } catch {
      // Nothing to offer beyond creating a workspace.
    }

    // Offered only when the person was invited by email before signing up.
    if (workspaces.length > 0) {
      bottomActions = [
        {
          caption: login.string.HaveWorkspace,
          i18n: login.string.SelectWorkspace,
          page: 'selectWorkspace',
          func: () => {
            goTo('selectWorkspace')
          }
        }
      ]
    }
  })

  const action = {
    i18n: login.string.CreateWorkspace,
    func: async () => {
      goTo('createWorkspace')
    }
  }
</script>

<Form
  caption={login.string.RegistrationComplete}
  subtitle={loginInfo != null ? getAccountDisplayName(loginInfo) : undefined}
  {status}
  fields={[]}
  object={{}}
  {action}
  {bottomActions}
>
  <svelte:fragment slot="after-fields">
    <div class="hint">
      <Label label={login.string.RegistrationCompleteHint} />
    </div>
  </svelte:fragment>
</Form>

<style lang="scss">
  .hint {
    grid-column-start: 1;
    grid-column-end: 3;
    color: var(--login-content-color, var(--theme-content-color));
  }
</style>
