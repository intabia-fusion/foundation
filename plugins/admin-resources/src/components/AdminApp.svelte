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
  import login, { loginId } from '@hcengineering/login'
  import { getMetadata, setMetadata, translate } from '@hcengineering/platform'
  import presentation, { isAdminUser, isBillingAdminUser } from '@hcengineering/presentation'
  import { Component, Loading, location, navigate, themeStore } from '@hcengineering/ui'
  import { onMount } from 'svelte'

  import adminRes from '../plugin'
  import { getAccountClient, hasAdminSession } from '../utils'
  import AdminPanel from './AdminPanel.svelte'
  import AdminSessionGate from './AdminSessionGate.svelte'

  // Fresh page load has no token metadata: restore session from auth cookie,
  // else render the login form in place (successful login populates the token).
  let token: string | undefined = getMetadata(presentation.metadata.Token)
  let restoring: boolean = token == null

  onMount(async () => {
    if (token == null) {
      try {
        const info = await getAccountClient(null).getLoginInfoByToken()
        if (info != null && 'token' in info && info.token != null) {
          setMetadata(presentation.metadata.Token, info.token)
          token = info.token
        }
      } catch (err: any) {
        // not logged in - fall through to login form
      }
    }
    restoring = false
  })

  $: void translate(adminRes.string.AdminPanelTitle, {}, $themeStore.language).then((title) => {
    document.title = title
  })

  $: if ($location !== undefined && !restoring) {
    token = getMetadata(presentation.metadata.Token)
  }

  // Logged in but neither full admin nor read-only billing admin. This is also what an
  // impersonation session looks like on the way back, so try the auth cookie before bailing out.
  $: notAdmin = !restoring && token != null && !isAdminUser() && !isBillingAdminUser()
  $: if (notAdmin) {
    void restoreFromCookie()
  }

  let cookieRestoreTried = false
  async function restoreFromCookie (): Promise<void> {
    if (cookieRestoreTried) {
      navigate({ path: [loginId] }, true)
      return
    }
    cookieRestoreTried = true
    try {
      const info = await getAccountClient(null).getLoginInfoByToken()
      if (info != null && 'token' in info && info.token != null) {
        setMetadata(presentation.metadata.Token, info.token)
        token = info.token
        return
      }
    } catch (err: any) {
      // fall through to the login form
    }
    navigate({ path: [loginId] }, true)
  }

  // Second factor: every admin RPC refuses a token without a fresh `mfaAt`.
  let sessionTick = 0
  $: hasSession = sessionTick >= 0 && token != null && hasAdminSession()
</script>

{#if restoring}
  <Loading />
{:else if token == null}
  <Component is={login.component.LoginApp} />
{:else if notAdmin}
  <Loading />
{:else if !hasSession}
  <AdminSessionGate
    on:opened={() => {
      token = getMetadata(presentation.metadata.Token)
      sessionTick++
    }}
  />
{:else}
  <AdminPanel />
{/if}
