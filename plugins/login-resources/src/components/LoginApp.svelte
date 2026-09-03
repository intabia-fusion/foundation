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
  import { getMetadata } from '@hcengineering/platform'
  import presentation from '@hcengineering/presentation'
  import {
    Location,
    deviceOptionsStore as deviceInfo,
    fetchMetadataLocalStorage,
    getCurrentLocation,
    location,
    navigate,
    desktopPlatform
  } from '@hcengineering/ui'
  import { onDestroy, onMount } from 'svelte'
  import Auth from './Auth.svelte'
  import Confirmation from './Confirmation.svelte'
  import ConfirmationSend from './ConfirmationSend.svelte'
  import Registered from './Registered.svelte'
  import CreateWorkspaceForm from './CreateWorkspaceForm.svelte'
  import Join from './Join.svelte'
  import AutoJoin from './AutoJoin.svelte'
  import LoginForm from './LoginForm.svelte'
  import ProvidersOnlyForm from './ProvidersOnlyForm.svelte'
  import PasswordRequest from './PasswordRequest.svelte'
  import PasswordRestore from './PasswordRestore.svelte'
  import SelectWorkspace from './SelectWorkspace.svelte'
  import SignupForm from './SignupForm.svelte'
  import SelectDownloads from './SelectDownloads.svelte'
  import { Pages, pages } from '..'
  import { goTo, restoreSession } from '../utils'
  import login from '../plugin'
  import LoginAppBase from './LoginAppBase.svelte'

  // Resolve static asset URLs at runtime to avoid requiring image module declarations
  // (prevents TypeScript / diagnostics errors when module types are missing)

  import ChangePassword from './ChangePassword.svelte'

  import BottomAction from './BottomAction.svelte'

  export let page: Pages = 'signup'

  const signUpDisabled = getMetadata(login.metadata.DisableSignUp) ?? false
  const localLoginHidden = getMetadata(login.metadata.HideLocalLogin) ?? false
  const useOTP = getMetadata(presentation.metadata.UseOTP) === true
  let navigateUrl: string | undefined

  onDestroy(location.subscribe(updatePageLoc))

  function updatePageLoc (loc: Location): void {
    // The admin panel moved to its own /admin route — redirect old /login/admin bookmarks.
    if (loc.path[1] === 'admin') {
      navigate({ path: ['admin'] }, true)
      return
    }
    const token = getMetadata(presentation.metadata.Token)
    page = (loc.path[1] as Pages) ?? (token != null ? 'selectWorkspace' : 'login')
    if (page === 'join' && loc.query?.autoJoin !== undefined) {
      page = 'autoJoin'
    }

    const allowedUnauthPages: Pages[] = [
      'login',
      'signup',
      'password',
      'recovery',
      'join',
      'autoJoin',
      'confirm',
      'confirmationSend',
      'auth',
      'downloads'
    ]
    if (token === undefined ? !allowedUnauthPages.includes(page) : !pages.includes(page)) {
      const account = fetchMetadataLocalStorage(login.metadata.LastAccount)
      page = account != null ? 'login' : 'signup'
    }

    navigateUrl = loc.query?.navigateUrl ?? undefined
  }

  async function chooseToken (): Promise<void> {
    if (page === 'auth') {
      // token handled by auth page
      return
    } else if (page === 'autoJoin') {
      // there's a separate workflow for auto join
      return
    }

    if (getMetadata(presentation.metadata.Token) == null) {
      try {
        // Was gated on LastAccount, so a cookie-only session left `selectWorkspace`
        // unroutable while the form already showed "Signed in as".
        await restoreSession()
        if (getMetadata(presentation.metadata.Token) != null) {
          updatePageLoc(getCurrentLocation())
        }
      } catch (err: any) {
        // do nothing
      }
    }
  }

  onMount(() => {
    // Preserve existing login initialization behavior
    void chooseToken()
  })
</script>

<LoginAppBase>
  <svelte:fragment slot="form-content">
    {#if page === 'login'}
      {#if localLoginHidden}
        <ProvidersOnlyForm />
      {:else}
        <LoginForm {navigateUrl} {signUpDisabled} {useOTP} />
      {/if}
    {:else if page === 'signup'}
      <SignupForm {navigateUrl} {signUpDisabled} {localLoginHidden} {useOTP} />
    {:else if page === 'createWorkspace'}
      <CreateWorkspaceForm />
    {:else if page === 'password'}
      <PasswordRequest {signUpDisabled} />
    {:else if page === 'recovery'}
      <PasswordRestore />
    {:else if page === 'selectWorkspace'}
      <SelectWorkspace {navigateUrl} />
    {:else if page === 'downloads'}
      <SelectDownloads />
    {:else if page === 'join'}
      <Join />
    {:else if page === 'autoJoin'}
      <AutoJoin />
    {:else if page === 'confirm'}
      <Confirmation />
    {:else if page === 'confirmationSend'}
      <ConfirmationSend />
    {:else if page === 'registered'}
      <Registered />
    {:else if page === 'auth'}
      <Auth />
    {:else if page === 'changePassword'}
      <ChangePassword />
    {/if}
  </svelte:fragment>
  <svelte:fragment slot="extra-form-content">
    {#if !desktopPlatform && page !== 'downloads' && page !== 'join'}
      {@const desktopUrl = getMetadata(login.metadata.DesktopUpdatesUrl)}
      <div class="mt-4 flex flex-row-reverse mr-4">
        {#if !($deviceInfo.isMobile && $deviceInfo.minWidth) && desktopUrl != null && desktopUrl !== ''}
          <BottomAction
            action={{
              // caption: login.string.Downloads,
              i18n: login.string.Downloads,
              page: 'downloads',
              func: () => {
                goTo('downloads')
              }
            }}
          />
        {/if}
      </div>
    {/if}
  </svelte:fragment>
</LoginAppBase>

<style lang="scss">
  @use './themes/intabia.scss';
  @use './themes/huly.scss';

  .back-image {
    position: fixed;
    top: 32px;
    left: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: left top;
    /* Ensure the background stays behind content and doesn't capture pointer events */
    z-index: -2;
    pointer-events: none;
  }

  /* Page layout helpers */
  .backd {
    position: relative;
  }
  .bg-image {
    display: flex;
    justify-content: center;
    align-items: center;
    width: 100%;
    height: 100%;
  }

  .fs-title {
    color: var(--login-content-color, var(--theme-content-color));
  }

  /* Centralized layout: panel sizing/positioning is identical across themes.
     Themes control visuals only (colors, gradients, images). */
  .panel,
  .panel-base {
    position: fixed !important;
    z-index: 1000 !important;
    display: flex;
    flex-direction: column;
    justify-content: center;
    width: 24% !important;
    width: 460px !important;
    height: auto;
    left: 50% !important;
    top: 50% !important;
    transform: translate(-50%, -50%) !important;
  }

  .panel {
    position: relative;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    justify-content: center;
    height: auto;
    background: var(--login-panel-bg, rgba(45, 50, 160, 0.5));
    mix-blend-mode: normal;
    box-shadow: -30px 1.52px 173.87px #121437;
    backdrop-filter: blur(157.855px);
    border-radius: 1rem;
  }

  .panel::after {
    overflow: hidden;
    position: absolute;
    content: '';
    inset: 0;
    background: var(--login-panel-gradient);
    border-radius: 1rem;
    z-index: -1;
  }

  .panel::before {
    position: absolute;
    content: '';
    inset: 0;
    padding: 1px;
    background: conic-gradient(
        rgba(255, 255, 255, 0.18) 10%,
        rgba(126, 120, 165, 0.5),
        rgba(191, 216, 253, 0.5),
        rgba(246, 247, 249, 0.32),
        rgba(219, 229, 242, 0.34) 60%,
        rgba(163, 203, 255, 0.24) 90%
      )
      border-box;
    -webkit-mask:
      linear-gradient(#000 0 0) content-box,
      linear-gradient(#000 0 0);
    -webkit-mask-composite: xor;
    mask-composite: exclude;
    border-radius: 1rem;
    transform: rotate(180deg);
    transition: opacity 0.15s var(--timing-main);
    opacity: 0.7;
    pointer-events: none;
  }

  @supports not (mask-composite: exclude) {
    .panel::before {
      z-index: -1;
    }
  }
  @supports not (-webkit-mask-composite: xor) {
    .panel::before {
      z-index: -1;
    }
  }

  /* Content wrapper inside the panel */
  .panel .form-content {
    display: flex;
    flex-direction: column;
    justify-content: center;
    flex-grow: 1;
    height: max-content;
  }

  /* Intabia-scoped primary button visuals */
  .login-theme-intabia .antiButton.primary {
    border-radius: var(--primary-button-border-radius, 0.5rem);
    padding: var(--primary-button-padding, 0 1.5rem);
    height: var(--primary-button-height, 3.5rem);
    font-size: var(--primary-button-font-size, 1rem);
    font-weight: var(--primary-button-font-weight, 600);
    background-color: var(--login-primary-button-default);
    color: var(--login-button-text-color, #ffffff);
  }
  .login-theme-intabia .antiButton.primary:hover {
    background-color: var(--login-primary-button-hovered);
  }
  .login-theme-intabia .antiButton.primary:active {
    background-color: var(--login-primary-button-pressed);
  }
  .login-theme-intabia .antiButton.primary:focus-visible {
    outline: 0;
    box-shadow: 0 0 0 4px var(--login-primary-button-focus-ring);
    border-color: var(--login-primary-button-focused);
  }
  .login-theme-intabia .antiButton.primary[disabled],
  .login-theme-intabia .antiButton.primary:disabled {
    background: var(--login-button-contrast-disabled);
    color: var(--login-button-contrast-disabled-color);
    cursor: not-allowed;
    opacity: 1;
    box-shadow: none;
    border-color: var(--login-button-contrast-border);
  }
  /* Localized popup label color for login theme (applies only inside login UI) */
  .login-theme-intabia .login-popup .hulyPopup-row__label {
    color: var(--login-content-color, var(--theme-content-color));
  }

  /* Huly-scoped primary button visuals (contrast) */
  .login-theme-huly .antiButton.primary {
    border-radius: var(--primary-button-border-radius, 0.5rem);
    padding: var(--primary-button-padding, 0 1.5rem);
    height: var(--primary-button-height, 3.5rem);
    font-size: var(--primary-button-font-size, 1rem);
    font-weight: var(--primary-button-font-weight, 600);
    background-color: var(--login-button-contrast-enabled, rgb(255, 255, 255));
    color: var(--login-button-contrast-color, rgb(0, 0, 0));
    border-color: var(--login-button-contrast-border, rgba(255, 255, 255, 0.2));
  }
  .login-theme-huly .antiButton.primary:hover {
    background-color: var(--login-button-contrast-hovered, #ffffff);
  }
  .login-theme-huly .antiButton.primary:active {
    background-color: var(--login-button-contrast-pressed, rgba(255, 255, 255, 0.6));
  }
  .login-theme-huly .antiButton.primary:focus-visible {
    outline: 0;
    box-shadow: 0 0 0 4px var(--login-primary-button-focus-ring);
    border-color: var(--login-primary-button-focused);
  }
  .login-theme-huly .antiButton.primary[disabled],
  .login-theme-huly .antiButton.primary:disabled {
    background: var(--login-button-contrast-disabled);
    color: var(--login-button-contrast-disabled-color);
    cursor: not-allowed;
    opacity: 1;
    box-shadow: none;
    border-color: var(--login-button-contrast-border);
  }
  /* Localized popup label color for Huly login theme (applies only inside login UI) */
  .login-theme-huly .login-popup .hulyPopup-row__label {
    color: var(--login-content-color, var(--theme-content-color));
  }

  /* Mobile fallbacks: make panel full-width and ensure panel-base padding/background
     so the login container looks correct on smaller screens and is controlled centrally. */
  @media (max-width: 768px) {
    /* Keep a small margin from the screen edges on narrow devices */
    .panel,
    .panel-base {
      position: static !important;
      left: auto !important;
      top: auto !important;
      transform: none !important;
      width: calc(100% - 2rem) !important;
      min-width: 0 !important;
      max-width: calc(100% - 2rem) !important;
      margin-left: 1rem !important;
      margin-right: 1rem !important;
    }

    .backd.paneld .panel-base,
    .backd .paneld .panel-base {
      width: calc(100% - 2rem) !important;
      margin-left: 1rem !important;
      margin-right: 1rem !important;
    }
  }
</style>
