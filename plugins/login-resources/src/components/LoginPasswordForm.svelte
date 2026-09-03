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
  import { type IntlString, OK, Severity, Status } from '@hcengineering/platform'
  import { type LoginInfo } from '@hcengineering/account-client'

  import { doLogin, doLoginNavigate, goTo } from '../utils'
  import Form from './Form.svelte'
  import Label from './internal/Label.svelte'
  import { recoveryAction } from '../actions'
  import type { BottomAction } from '../index'
  import login from '../plugin'
  import { fetchMetadataLocalStorage, setMetadataLocalStorage } from '@hcengineering/ui'
  import { onDestroy } from 'svelte'

  export let navigateUrl: string | undefined = undefined
  export let signUpDisabled = false
  export let email: string | undefined = undefined
  export let caption: IntlString = login.string.LogIn
  export let subtitle: string | undefined = undefined
  export let onLogin: ((loginInfo: LoginInfo | null, status: Status) => void | Promise<void>) | undefined = undefined
  export let extraBottomActions: BottomAction[] = []
  export let signedInAs: string | undefined = undefined

  $: fields = [
    {
      id: 'email',
      name: 'username',
      i18n: login.string.Email,
      inputmode: 'email' as const,
      disabled: email !== undefined && email !== ''
    },
    {
      id: 'current-password',
      name: 'password',
      i18n: login.string.Password,
      password: true
    }
  ]

  const object = {
    username: email ?? fetchMetadataLocalStorage(login.metadata.AuthEmail) ?? '',
    password: ''
  }

  $: if (email !== undefined && email !== '' && object.username === '') {
    object.username = email
  }

  let status = OK
  let isLoading = false

  const action = {
    i18n: caption,
    func: async () => {
      isLoading = true
      try {
        status = new Status(Severity.INFO, login.status.ConnectingToServer, {})
        const [loginStatus, result] = await doLogin(object.username, object.password)
        status = loginStatus

        if (result != null) {
          setMetadataLocalStorage(login.metadata.AuthEmail, null)
        }

        if (onLogin !== undefined) {
          void onLogin(result, status)
        } else {
          await doLoginNavigate(
            result,
            (st) => {
              status = st
            },
            navigateUrl
          )
        }
      } finally {
        isLoading = false
      }
    }
  }

  onDestroy(() => {
    setMetadataLocalStorage(login.metadata.AuthEmail, object.username ?? '')
  })
</script>

<Form
  {caption}
  {subtitle}
  {status}
  {fields}
  {object}
  {action}
  {signUpDisabled}
  {isLoading}
  bottomActions={[recoveryAction, ...extraBottomActions]}
  secondaryButtonLabel={signedInAs !== undefined ? login.string.SelectWorkspace : undefined}
  secondaryButtonAction={() => {
    goTo('selectWorkspace')
  }}
  ignoreInitialValidation
  withProviders
>
  <svelte:fragment slot="before-secondary">
    <div class="signed-in">
      <Label label={login.string.SignedInAs} params={{ name: signedInAs ?? '' }} />
    </div>
  </svelte:fragment>
</Form>

<style lang="scss">
  .signed-in {
    grid-column-start: 1;
    grid-column-end: 3;
    text-align: center;
    margin-bottom: -0.75rem;
    color: var(--login-label-color, var(--login-content-color, var(--theme-content-color)));
  }
</style>
