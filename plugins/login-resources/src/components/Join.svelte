<!--
// Copyright © 2022 Hardcore Engineering Inc.
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
  import platform, { getMetadata, setMetadata, OK, Severity, Status } from '@hcengineering/platform'
  import { Analytics } from '@hcengineering/analytics'
  import { type LoginInfo, type WorkspaceLoginInfo } from '@hcengineering/account-client'
  import presentation from '@hcengineering/presentation'
  import { type Location, getCurrentLocation, navigate, setMetadataLocalStorage } from '@hcengineering/ui'
  import { logIn, workbenchId } from '@hcengineering/workbench'
  import { onMount } from 'svelte'

  import { getAccount, getInviteInfo, joinByInvite, setLoginInfo } from '../utils'
  import { LoginMethods } from '../index'
  import type { BottomAction } from '../index'
  import login from '../plugin'
  import Label from './internal/Label.svelte'
  import FormButton from './internal/FormButton.svelte'
  import SignupForm from './SignupForm.svelte'
  import LoginPasswordForm from './LoginPasswordForm.svelte'
  import LoginOtpForm from './LoginOtpForm.svelte'
  import StatusControl from './StatusControl.svelte'

  const location = getCurrentLocation()
  const useOTP = getMetadata(presentation.metadata.UseOTP) === true
  Analytics.handleEvent('invite_link_activated', { invite_id: location.query?.inviteId })

  // Step management
  type JoinStep = 'initial' | 'signup' | 'login'
  let step: JoinStep = 'initial'
  let hasExistingAccount = false
  let existingAccountEmail = ''
  let existingAccountName = ''
  let workspaceName = ''
  let joiningWithCurrentAccount = false
  let invitationExpired = false

  // Login method for existing account
  let loginMethod: LoginMethods = LoginMethods.Password

  let status = OK

  async function handleLoginSuccess (result: WorkspaceLoginInfo): Promise<void> {
    await logIn(result)
    setLoginInfo(result)

    if (location.query?.navigateUrl != null) {
      try {
        const loc = JSON.parse(decodeURIComponent(location.query.navigateUrl)) as Location
        if (loc.path[1] === result.workspaceUrl) {
          navigate(loc)
          return
        }
      } catch (err: any) {
        // Json parse error could be ignored
      }
    }

    navigate({ path: [workbenchId, result.workspaceUrl] })
  }

  async function handleJoinAfterAuth (loginInfo: LoginInfo | null): Promise<void> {
    if (loginInfo == null) {
      return
    }

    // After successful auth (signup, password login, or OTP), join the workspace
    status = new Status(Severity.INFO, login.status.ConnectingToServer, {})
    setMetadata(presentation.metadata.Token, loginInfo.token)
    setMetadataLocalStorage(login.metadata.LoginAccount, loginInfo.account)

    try {
      const inviteId = location.query?.inviteId ?? ''
      const [joinStatus, joinResult] = await joinByInvite(inviteId)
      if (joinResult != null) {
        await handleLoginSuccess(joinResult)
      } else {
        status = joinStatus !== OK ? joinStatus : new Status(Severity.ERROR, login.status.JoinWorkspaceError, {})
      }
    } catch (err: any) {
      Analytics.handleError(err)
      status = new Status(Severity.ERROR, login.status.JoinWorkspaceError, {})
    }
  }

  async function joinWithCurrentAccount (): Promise<void> {
    if (!hasExistingAccount) return

    joiningWithCurrentAccount = true
    status = new Status(Severity.INFO, login.status.ConnectingToServer, {})

    try {
      const inviteId = location.query?.inviteId ?? ''
      const [joinStatus, joinResult] = await joinByInvite(inviteId)
      if (joinResult != null) {
        await handleLoginSuccess(joinResult)
      } else {
        status = joinStatus !== OK ? joinStatus : new Status(Severity.ERROR, login.status.JoinWorkspaceError, {})
        joiningWithCurrentAccount = false
      }
    } catch (err: any) {
      Analytics.handleError(err)
      status = new Status(Severity.ERROR, login.status.JoinWorkspaceError, {})
      joiningWithCurrentAccount = false
    }
  }

  onMount(() => {
    void loadWorkspaceInfo()
    void checkExistingAccount()
  })

  async function loadWorkspaceInfo (): Promise<void> {
    const inviteId = location.query?.inviteId
    if (inviteId != null) {
      const [inviteStatus, info] = await getInviteInfo(inviteId)
      if (inviteStatus.code === platform.status.ExpiredLink) {
        invitationExpired = true
        return
      }
      if (info?.name != null) {
        workspaceName = info.name
      }
    }
  }

  async function checkExistingAccount (): Promise<void> {
    try {
      // getAccount will use token from metadata or cookie
      const loginInfo = await getAccount(false)
      if (loginInfo != null) {
        hasExistingAccount = true
        existingAccountName = loginInfo.name ?? ''
        // socialId format is "type:value", extract the value part (email)
        existingAccountEmail = loginInfo.socialId != null ? loginInfo.socialId.split(':').slice(1).join(':') : ''
        setMetadata(presentation.metadata.Token, loginInfo.token)
        setMetadataLocalStorage(login.metadata.LoginAccount, loginInfo.account)
      }
    } catch (err: any) {
      // Token expired or invalid, user will need to log in again
      hasExistingAccount = false
    }
  }

  function goToSignup (): void {
    step = 'signup'
  }

  function goToLogin (method: LoginMethods = LoginMethods.Password): void {
    step = 'login'
    loginMethod = method
  }

  function goBackToInitial (): void {
    step = 'initial'
    status = OK
    loginMethod = LoginMethods.Password
  }

  const switchToPasswordAction: BottomAction = {
    i18n: login.string.LoginWithPassword,
    func: () => {
      loginMethod = LoginMethods.Password
    }
  }

  const switchToOtpAction: BottomAction = {
    i18n: login.string.LoginWithCode,
    func: () => {
      loginMethod = LoginMethods.Otp
    }
  }
</script>

{#if invitationExpired}
  <div class="initial-container">
    <div class="title mb-2">
      <Label label={login.string.ExpiredLink} />
    </div>
    <div class="description"><Label label={login.string.ExpiredLinkDescription} /></div>
  </div>
{:else if step === 'initial'}
  <div class="initial-container">
    <div class="title"><Label label={login.string.Join} /></div>
    {#if workspaceName !== ''}
      <div class="workspace-name">{workspaceName}</div>
    {/if}

    <div class="actions">
      {#if hasExistingAccount}
        <FormButton
          label={login.string.JoinAs}
          params={{ name: existingAccountName || existingAccountEmail }}
          kind="contrast"
          shape="round"
          size="x-large"
          width="100%"
          loading={joiningWithCurrentAccount}
          on:click={joinWithCurrentAccount}
        />
      {/if}

      <FormButton
        label={login.string.CreateNewAccount}
        kind={hasExistingAccount ? 'default' : 'contrast'}
        shape="round"
        size="x-large"
        width="100%"
        on:click={goToSignup}
      />

      <FormButton
        label={login.string.AlreadySignedIn}
        kind="default"
        shape="round"
        size="x-large"
        width="100%"
        on:click={() => {
          goToLogin()
        }}
      />
    </div>
  </div>
{:else if step === 'signup'}
  <div class="form-container">
    <div class="back-row">
      <FormButton type="button" kind="ghost" size="small" shape="round" on:click={goBackToInitial}>
        <Label label={login.string.BackLabel} />
      </FormButton>
    </div>

    {#if status !== OK}
      <div class="status">
        <StatusControl {status} />
      </div>
    {/if}

    <SignupForm
      caption={login.string.SignUpAndJoin}
      subtitle={workspaceName !== '' ? workspaceName : undefined}
      onSignUp={handleJoinAfterAuth}
      {useOTP}
    />
  </div>
{:else if step === 'login'}
  <div class="form-container">
    <div class="back-row">
      <FormButton type="button" kind="ghost" size="small" shape="round" on:click={goBackToInitial}>
        <Label label={login.string.BackLabel} />
      </FormButton>
    </div>

    {#if status !== OK}
      <div class="status">
        <StatusControl {status} />
      </div>
    {/if}

    {#if loginMethod === LoginMethods.Otp}
      <LoginOtpForm
        caption={login.string.LogInAndJoin}
        subtitle={workspaceName !== '' ? workspaceName : undefined}
        onLogin={handleJoinAfterAuth}
        extraBottomActions={[switchToPasswordAction]}
      />
    {:else}
      <LoginPasswordForm
        caption={login.string.LogInAndJoin}
        subtitle={workspaceName !== '' ? workspaceName : undefined}
        onLogin={handleJoinAfterAuth}
        extraBottomActions={[switchToOtpAction]}
      />
    {/if}
  </div>
{/if}

<style lang="scss">
  .initial-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 2rem;
    color: var(--login-content-color, var(--theme-content-color));
  }

  .form-container {
    display: flex;
    flex-direction: column;
    color: var(--login-content-color, var(--theme-content-color));
  }

  .back-row {
    display: flex;
    align-items: center;
    padding: 0.5rem;
  }

  .title {
    font-weight: var(--login-title-font-weight, 500);
    font-size: var(--login-title-font-size, 1.25rem);
    color: var(--login-caption-color, var(--theme-caption-color));
    text-align: center;
  }

  .workspace-name {
    font-size: 1.5rem;
    font-weight: 600;
    color: var(--login-caption-color, var(--theme-caption-color));
    margin-bottom: 1.5rem;
    text-align: center;
  }

  .actions {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    width: 100%;
    max-width: 300px;
    margin-top: 1rem;
  }

  .description {
    text-align: center;
  }

  .status {
    margin: 0 2rem;
  }
</style>
