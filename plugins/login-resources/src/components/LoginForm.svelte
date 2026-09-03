<!--
// Copyright © 2020, 2021 Anticrm Platform Contributors.
// Copyright © 2021, 2022 Hardcore Engineering Inc.
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
  import { type IntlString, Severity, Status } from '@hcengineering/platform'
  import { signupStore } from '@hcengineering/analytics-providers'
  import { onMount } from 'svelte'

  import {
    type BottomAction,
    doLoginAsGuest,
    doLoginNavigate,
    getAccountClient,
    getAccountDisplayName,
    LoginMethods,
    restoreSession
  } from '../index'
  import LoginPasswordForm from './LoginPasswordForm.svelte'
  import LoginOtpForm from './LoginOtpForm.svelte'
  import BottomActionComponent from './BottomAction.svelte'
  import login from '../plugin'
  import { LoginInfo } from '@hcengineering/account-client'

  export let navigateUrl: string | undefined = undefined
  export let signUpDisabled = false
  export let useOTP = true
  export let email: string | undefined = undefined
  export let caption: IntlString | undefined = undefined
  export let subtitle: string | undefined = undefined
  export let onLogin: ((loginInfo: LoginInfo | null, status: Status) => void | Promise<void>) | undefined = undefined

  const LOGIN_METHOD_STORAGE_KEY = 'login-method'

  let method: LoginMethods = LoginMethods.Password

  // Persist chosen login method to localStorage
  function platformTestingEnabled (): boolean {
    try {
      // Use optional chaining to safely access localStorage in all environments
      return window?.localStorage?.getItem('#platform.testing.enabled') === 'true'
    } catch {
      return false
    }
  }

  function setMethod (m: LoginMethods): void {
    method = m
    try {
      // Only persist preference when platform testing flag is not enabled
      if (!platformTestingEnabled() && window?.localStorage != null) {
        localStorage.setItem(LOGIN_METHOD_STORAGE_KEY, m)
      }
    } catch {
      // ignore localStorage errors
    }
  }

  // Landing here with a live session is a dead end otherwise: nothing on the form leads back.
  let signedInAs: string | undefined

  onMount(async () => {
    const account = await restoreSession()
    if (account?.token != null) {
      signedInAs = getAccountDisplayName(account)
    }
  })

  onMount(() => {
    signupStore.setSignUpFlow(false)

    // Try to load persisted login method preference from localStorage if not in testing mode
    try {
      if (!platformTestingEnabled() && window?.localStorage != null) {
        const stored = localStorage.getItem(LOGIN_METHOD_STORAGE_KEY)
        if (stored === LoginMethods.Password || stored === LoginMethods.Otp) {
          method = stored as LoginMethods
          return
        }
      }
    } catch {
      // ignore localStorage errors
    }

    // Fallback to prop if nothing persisted or in testing mode
    method = useOTP ? LoginMethods.Otp : LoginMethods.Password
  })

  function changeMethod (event: CustomEvent<LoginMethods>): void {
    setMethod(event.detail)
  }

  const loginWithPasswordAction: BottomAction = {
    i18n: login.string.LoginWithPassword,
    func: () => {
      setMethod(LoginMethods.Password)
    }
  }

  const loginWithCodeAction: BottomAction = {
    i18n: login.string.LoginWithCode,
    func: () => {
      setMethod(LoginMethods.Otp)
    }
  }

  async function guestLogin (): Promise<void> {
    let status = new Status(Severity.INFO, login.status.ConnectingToServer, {})
    const [loginStatus, result] = await doLoginAsGuest()
    status = loginStatus

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
  }

  const loginAsGuest: BottomAction = {
    i18n: login.string.LoginAsGuest,
    func: () => {
      void guestLogin()
    }
  }

  let allowReadonlyGuests = false

  void getAccountClient()
    .isAllowReadOnlyGuests()
    .then(({ allowed }) => {
      allowReadonlyGuests = allowed
    })
</script>

{#if method === LoginMethods.Otp}
  <LoginOtpForm
    {navigateUrl}
    {signUpDisabled}
    {email}
    {caption}
    {subtitle}
    {onLogin}
    {signedInAs}
    on:change={changeMethod}
  />
{:else}
  <LoginPasswordForm
    {navigateUrl}
    {signUpDisabled}
    {email}
    {caption}
    {subtitle}
    {onLogin}
    {signedInAs}
    on:change={changeMethod}
  />
{/if}

<div class="actions">
  <BottomActionComponent action={method === LoginMethods.Otp ? loginWithPasswordAction : loginWithCodeAction} />

  {#if allowReadonlyGuests}
    <div class="login-as-guest">
      <BottomActionComponent action={loginAsGuest} />
    </div>
  {/if}
</div>

<style lang="scss">
  .actions {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin: 0;
    color: var(--login-label-color, var(--login-content-color, var(--theme-content-color)));
  }

  .login-as-guest {
    margin-top: 1rem;
    color: var(--login-label-color, var(--login-content-color, var(--theme-content-color)));
  }
</style>
