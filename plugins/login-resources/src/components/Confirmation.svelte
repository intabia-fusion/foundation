<!--
// Copyright © 2023 Hardcore Engineering Inc.
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
  import platform, { OK, Severity, Status, unknownError } from '@hcengineering/platform'
  import { getCurrentLocation } from '@hcengineering/ui'
  import { logIn } from '@hcengineering/workbench'

  import login from '../plugin'
  import { confirm, getAccount, goTo, resolveConfirmToken } from '../utils'
  import Form from './Form.svelte'
  import Label from './internal/Label.svelte'
  import StatusControl from './StatusControl.svelte'

  export let status: Status<any> = OK

  type Outcome = 'checking' | 'alreadyRegistered' | 'invalidLink' | 'expired' | 'failed'
  let outcome: Outcome = 'checking'

  async function check (): Promise<void> {
    const id = getCurrentLocation().query?.id
    if (id == null || id === '') {
      goTo('login')
      return
    }
    status = new Status(Severity.INFO, login.status.ConnectingToServer, {})

    let token: string | null
    try {
      token = await resolveConfirmToken(id)
    } catch (err: any) {
      status = unknownError(err)
      outcome = 'failed'
      return
    }

    if (token == null) {
      // No such short link: either a mistyped id or already confirmed with OTP code.
      status = OK
      outcome = 'invalidLink'
      return
    }

    const [loginStatus, result] = await confirm(token)

    if (result != null) {
      await logIn(result)
      goTo('registered', true)
      return
    }

    if (loginStatus.code === platform.status.SocialIdAlreadyConfirmed) {
      status = OK
      outcome = 'alreadyRegistered'
      return
    }

    status = loginStatus
    // An expired link fails token verification, which the server reports as Unauthorized.
    outcome = loginStatus.code === platform.status.Unauthorized ? 'expired' : 'failed'
  }

  const continueAction = {
    i18n: login.string.Continue,
    func: async () => {
      goTo((await getAccount(false))?.token != null ? 'selectWorkspace' : 'login')
    }
  }

  const logInAction = {
    i18n: login.string.LogIn,
    func: async () => {
      goTo('login')
    }
  }

  onMount(() => {
    void check()
  })
</script>

{#if outcome === 'checking'}
  <div class="flex-center h-full p-10 caption-color">
    <div class="flex-col-center text-center">
      <Label label={login.string.CheckingLink} />
      <StatusControl {status} />
    </div>
  </div>
{:else if outcome === 'alreadyRegistered'}
  <Form caption={login.string.AlreadyRegistered} {status} fields={[]} object={{}} action={continueAction} />
{:else if outcome === 'invalidLink'}
  <Form caption={login.string.InvalidLink} {status} fields={[]} object={{}} action={logInAction} />
{:else if outcome === 'expired'}
  <Form caption={login.string.ExpiredLink} {status} fields={[]} object={{}} action={logInAction} />
{:else}
  <Form caption={login.string.ConfirmationFailed} {status} fields={[]} object={{}} action={logInAction} />
{/if}
