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
  import { LoginInfo } from '@hcengineering/account-client'

  import OtpForm from './OtpForm.svelte'
  import login from '../plugin'
  import Form from './Form.svelte'
  import Label from './internal/Label.svelte'
  import { OtpLoginSteps, goTo, loginOtp } from '../index'
  import type { BottomAction } from '../index'
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
    }
  ]
  const formData = {
    username: email ?? fetchMetadataLocalStorage(login.metadata.AuthEmail) ?? ''
  }

  $: if (email !== undefined && email !== '' && formData.username === '') {
    formData.username = email
  }

  let status = OK
  let step = OtpLoginSteps.Email
  let otpRetryOn = 0

  const action = {
    i18n: caption,
    func: async () => {
      status = new Status(Severity.INFO, login.status.ConnectingToServer, {})
      const [otpStatus, result] = await loginOtp(formData.username)
      status = otpStatus

      if (result?.sent === true && otpStatus === OK) {
        step = OtpLoginSteps.Otp
        otpRetryOn = result.retryOn
      }
    }
  }

  function handleStep (event: CustomEvent<OtpLoginSteps>): void {
    step = event.detail
  }

  onDestroy(() => {
    setMetadataLocalStorage(login.metadata.AuthEmail, formData.username ?? '')
  })
</script>

{#if step === OtpLoginSteps.Email}
  <Form
    {caption}
    {subtitle}
    {status}
    {fields}
    object={formData}
    {action}
    {signUpDisabled}
    bottomActions={extraBottomActions}
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
{/if}

{#if step === OtpLoginSteps.Otp && formData.username !== ''}
  <OtpForm
    email={formData.username}
    {navigateUrl}
    retryOn={otpRetryOn}
    {onLogin}
    canChangeEmail={email === undefined || email === ''}
    on:step={handleStep}
  />
{/if}

<style lang="scss">
  .signed-in {
    grid-column-start: 1;
    grid-column-end: 3;
    text-align: center;
    margin-bottom: -0.75rem;
    color: var(--login-label-color, var(--login-content-color, var(--theme-content-color)));
  }
</style>
