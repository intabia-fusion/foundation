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
  import { Button, EditBox, Label, Popup, ticker1 } from '@hcengineering/ui'
  import { createEventDispatcher } from 'svelte'

  import adminRes from '../plugin'
  import { getAccountClient, openAdminSession } from '../utils'

  const dispatch = createEventDispatcher()

  let code = ''
  let retryOn = 0
  let sending = false
  let sent = false
  let sendFailed = false
  let confirming = false
  let rejected = false

  async function sendCode (): Promise<void> {
    if (sending) return
    sending = true
    sendFailed = false
    try {
      const info = await getAccountClient().requestAdminOperationOtp()
      retryOn = info.retryOn
      sent = true
    } catch (err) {
      console.error('Failed to send admin session OTP:', err)
      sendFailed = true
    } finally {
      sending = false
    }
  }

  async function confirm (): Promise<void> {
    if (confirming) return
    confirming = true
    rejected = false
    try {
      await openAdminSession(code.trim())
      dispatch('opened')
    } catch (err) {
      console.error('Failed to open the admin session:', err)
      rejected = true
      code = ''
    } finally {
      confirming = false
    }
  }

  void sendCode()

  $: retryLeft = Math.max(0, Math.ceil((retryOn - $ticker1) / 1000))
  $: canConfirm = code.trim().length === 6 && !confirming
</script>

<div class="gate flex-col-center">
  <div class="fs-title mb-2"><Label label={adminRes.string.AdminSessionTitle} /></div>
  <div class="mb-4 content-dark-color"><Label label={adminRes.string.AdminSessionHint} /></div>

  <div class="mb-2">
    {#if rejected}
      <span class="error-color"><Label label={adminRes.string.AdminSessionRejected} /></span>
    {:else if sendFailed}
      <span class="error-color"><Label label={adminRes.string.OtpSendFailed} /></span>
    {:else if sent}
      <Label label={adminRes.string.OtpSent} />
    {/if}
  </div>

  <div class="flex-row-center">
    <EditBox bind:value={code} placeholder={adminRes.string.OtpCode} kind={'large-style'} autoFocus />
    <div class="ml-4">
      <Button label={adminRes.string.Confirm} kind={'primary'} disabled={!canConfirm} on:click={confirm} />
    </div>
    <div class="ml-2">
      <Button label={adminRes.string.SendCode} disabled={sending || retryLeft > 0} on:click={sendCode} />
    </div>
    {#if retryLeft > 0}
      <span class="ml-2 content-dark-color">{retryLeft}s</span>
    {/if}
  </div>
</div>

<!-- The panel owns the popup host, and it is not mounted yet: without this the status-bar
     settings (and any other popup) silently do nothing on this screen. -->
<Popup />

<style lang="scss">
  .gate {
    justify-content: center;
    width: 100%;
    height: 100%;
    padding: 2rem;
  }
</style>
