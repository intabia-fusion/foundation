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
  import {
    type AccountUuid,
    WorkspaceInfoWithStatus,
    type WorkspaceUuid,
    isActiveMode,
    isArchivingMode,
    isRestoringMode,
    isUpgradingMode
  } from '@hcengineering/core'
  import { LoginInfo } from '@hcengineering/login'
  import { OK, Severity, Status } from '@hcengineering/platform'
  import presentation, { MessageBox, reduceCalls } from '@hcengineering/presentation'
  import {
    Button,
    IconBack,
    Scroller,
    SearchEdit,
    Spinner,
    deviceOptionsStore as deviceInfo,
    showPopup,
    ticker
  } from '@hcengineering/ui'
  import Label from './internal/Label.svelte'
  import FormButton from './internal/FormButton.svelte'
  import { themeStore } from '@hcengineering/theme'
  import { logOut } from '@hcengineering/workbench'
  import { onMount } from 'svelte'

  import login from '../plugin'
  import {
    getAccount,
    getAccountClient,
    getAccountDisplayName,
    getHref,
    getWorkspaces,
    goTo,
    isReadOnlyGuestAccount,
    navigateToWorkspace,
    selectWorkspace,
    unArchive,
    cancelWorkspaceDeletion
  } from '../utils'
  import StatusControl from './StatusControl.svelte'
  import NavLink from './NavLink.svelte'
  import DeleteAccountDialog from './DeleteAccountDialog.svelte'
  import WorkspaceDeletionDialog from './WorkspaceDeletionDialog.svelte'

  export let navigateUrl: string | undefined = undefined

  let workspaces: WorkspaceInfoWithStatus[] = []
  // Edition is a deployment-wide signal repeated on every row; show the badge when this build is community.
  $: isCommunity = workspaces.some((w) => w.licenseEdition === 'community')
  let status = OK
  let accountPromise: Promise<LoginInfo | null>
  let account: LoginInfo | null | undefined = undefined
  let isReadOnlyGuest: boolean = true

  let flagToUpdateWorkspaces = false

  let canDeleteAccount = false

  async function loadAccount (): Promise<void> {
    accountPromise = getAccount()
    account = await accountPromise
    isReadOnlyGuest = await isReadOnlyGuestAccount(account)
    await loadCanDeleteAccount()
    askAboutScheduledDeletion()
  }

  // Signing in does not call the deletion off by itself: the person may have come to take their
  // data out. Show the deadline and let them decide.
  function askAboutScheduledDeletion (): void {
    const deleteOn = account?.deleteOn
    const token = account?.token
    if (deleteOn == null || token == null) return

    showPopup(MessageBox, {
      label: login.string.AccountDeletionScheduled,
      message: login.string.AccountDeletionScheduledDesc,
      params: { date: formatDeleteOn(deleteOn) },
      canSubmit: true,
      okLabel: login.string.CancelAccountDeletion,
      action: async () => {
        await getAccountClient(token).cancelAccountDeletion()
        account = await getAccount()
      }
    })
  }

  // The server owns the rule (nothing left that the account is the only owner of); the link is
  // simply hidden while anything blocks it.
  async function loadCanDeleteAccount (): Promise<void> {
    if (account?.token == null || isReadOnlyGuest) {
      canDeleteAccount = false
      return
    }
    try {
      canDeleteAccount = (await getAccountClient(account.token).canDeleteAccount()).canDelete
    } catch (err) {
      console.error('Failed to check whether the account can be deleted', err)
      canDeleteAccount = false
    }
  }

  async function deleteAccount (uuid: AccountUuid, token: string | null, code: string): Promise<void> {
    try {
      await getAccountClient(token).deleteAccount(uuid, code)
      await logOut()
      goTo('login')
    } catch (err: any) {
      console.error('Failed to delete the account', err)
      status = new Status(Severity.ERROR, login.status.JoinWorkspaceError, {})
    }
  }

  function handleDeleteAccount (): void {
    if (account?.account == null) return
    const uuid = account.account
    const token = account.token ?? null
    // showPopup hands the result to a sync callback, hence the detached promise.
    showPopup(DeleteAccountDialog, {}, undefined, (code) => {
      if (typeof code !== 'string' || code.length === 0) return
      void deleteAccount(uuid, token, code)
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const updateWorkspaces = reduceCalls(async function updateWorkspaces (_time?: number): Promise<void> {
    try {
      workspaces = await getWorkspaces()
    } catch (e) {
      // we should be able to continue from this state
    }
  })

  $: if (flagToUpdateWorkspaces) {
    void updateWorkspaces($ticker)
  }

  onMount(() => {
    void loadAccount()
  })

  function formatDeleteOn (deleteOn: number): string {
    return new Date(deleteOn).toLocaleDateString()
  }

  async function cancelDeletion (uuid: WorkspaceUuid, token: string): Promise<void> {
    if (await cancelWorkspaceDeletion(uuid, token)) {
      await awaitRestore(uuid)
    }
  }

  /** Waits out the restore the cancel kicked off, so the row stops showing a stale mode. */
  async function awaitRestore (uuid: string): Promise<void> {
    workspaces = await getWorkspaces()
    let info = workspaces.find((it) => it.uuid === uuid)
    while (isRestoringMode(info?.mode) || isUpgradingMode(info?.mode)) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5000))
      workspaces = await getWorkspaces()
      info = workspaces.find((it) => it.uuid === uuid)
    }
  }

  async function select (workspaceUrl: string): Promise<void> {
    status = new Status(Severity.INFO, login.status.ConnectingToServer, {})

    const [loginStatus, result] = await selectWorkspace(workspaceUrl)

    const ws = workspaces.find((it) => it.uuid === result?.workspace)
    if (ws?.deleteOn != null && result?.token != null) {
      const token = result.token
      showPopup(
        WorkspaceDeletionDialog,
        { uuid: ws.uuid, dataId: ws.dataId, deleteOn: ws.deleteOn, token },
        undefined,
        // showPopup hands the result to a sync callback, hence the detached promise.
        (res) => {
          if (res === 'cancel') {
            void cancelDeletion(ws.uuid, token)
          }
        }
      )
      status = loginStatus
      return
    }
    if (ws != null && isArchivingMode(ws?.mode) && result?.workspace !== undefined) {
      showPopup(MessageBox, {
        label: login.string.SelectWorkspace,
        message: login.string.WorkspaceArchivedDesc,
        canSubmit: true,
        params: {},
        okLabel: login.string.RestoreArchivedWorkspace,
        action: async () => {
          if (await unArchive(ws.uuid, result.token)) {
            await awaitRestore(ws.uuid)
          }
        }
      })
      status = loginStatus
      return
    }
    status = loginStatus

    navigateToWorkspace(workspaceUrl, result, navigateUrl)
  }

  async function _getWorkspaces (): Promise<void> {
    try {
      const res = await getWorkspaces()

      await accountPromise
      if (res.length === 0 && account?.token == null) {
        goTo('confirmationSend')
      }

      workspaces = res
      await updateWorkspaces()
      flagToUpdateWorkspaces = true
    } catch (err: any) {
      await logOut()
      goTo('login')
      throw err
    }
  }
  let search: string = ''
</script>

<form class="container" style:padding={$deviceInfo.docWidth <= 480 ? '.25rem 1.25rem' : '1rem 1rem'}>
  <div class="grow-separator" />
  <div class="title-row">
    <FormButton
      type="button"
      kind="ghost"
      size="small"
      shape="round"
      on:click={() => {
        goTo('login')
      }}
    >
      <IconBack size="small" />
    </FormButton>
    <div class="title">
      <Label label={login.string.SelectWorkspace} variant={'heading'} />
    </div>
  </div>
  <div class="fs-title mt-2">
    {#if account != null}
      {getAccountDisplayName(account)}
    {:else}
      <Label label={login.string.LoadingAccount} />
    {/if}
  </div>
  <div class="status">
    <StatusControl {status} />
  </div>
  {#if isCommunity}
    <div class="community-badge">
      <Label label={login.string.CommunityEdition} />
    </div>
  {/if}
  {#if workspaces.length > 10}
    <div class="ml-2 mr-2 mb-2 flex-grow">
      <SearchEdit bind:value={search} width={'100%'} />
    </div>
  {/if}
  {#await _getWorkspaces()}
    <div class="workspace-loader">
      <Spinner />
    </div>
  {:then}
    <Scroller padding={'.125rem 0'} maxHeight={35}>
      {#if workspaces.length === 0 && account?.token != null && isReadOnlyGuest}
        <span class="readonly-warning"><Label label={login.string.SignUpToCreateWorkspace} /></span>
      {/if}
      <div class="form">
        {#each workspaces
          .filter((it) => search === '' || (it.name?.includes(search) ?? false) || it.url.includes(search))
          .slice(0, 500) as workspace}
          {@const wsName = workspace.name ?? workspace.url}
          {@const lastUsageDays =
            workspace.lastVisit === undefined
              ? 'N/A'
              : Math.round((Date.now() - workspace.lastVisit) / (1000 * 3600 * 24))}
          <!-- svelte-ignore a11y-click-events-have-key-events -->
          <!-- svelte-ignore a11y-no-static-element-interactions -->
          <div
            class="workspace flex-center fs-title cursor-pointer focused-button bordered form-row"
            on:click={() => select(workspace.url)}
          >
            <div class="flex flex-col flex-grow">
              <span class="label overflow-label flex-center">
                {wsName}
                {#if workspace.deleteOn != null}
                  - <Label
                    label={login.string.ScheduledForDeletion}
                    params={{ date: formatDeleteOn(workspace.deleteOn) }}
                  />
                {:else if isArchivingMode(workspace.mode)}
                  - <Label label={presentation.string.Archived} />
                {/if}
                {#if !isActiveMode(workspace.mode) && !isArchivingMode(workspace.mode)}
                  ({workspace.processingProgress}%)
                {/if}
              </span>
              <span class="text-xs flex-row-center flex-center">
                <div class="text-sm">
                  ({lastUsageDays} days)
                </div>
              </span>
            </div>
          </div>
        {/each}

        {#if workspaces.length === 0 && account?.token != null}
          <div class="form-row send">
            <Button
              label={isReadOnlyGuest ? login.string.SignUp : login.string.CreateWorkspace}
              kind={'primary'}
              width="100%"
              on:click={() => {
                goTo(isReadOnlyGuest ? 'signup' : 'createWorkspace')
              }}
            />
          </div>
        {/if}
      </div>
    </Scroller>
    <div class="grow-separator" />
    <div class="footer">
      {#if workspaces.length > 0 && !isReadOnlyGuest}
        <div>
          <span><Label label={login.string.WantAnotherWorkspace} /></span>
          <NavLink
            href={getHref('createWorkspace')}
            onClick={() => {
              goTo('createWorkspace')
            }}><Label label={login.string.CreateWorkspace} variant={'link'} /></NavLink
          >
        </div>
      {/if}
      <div>
        <span><Label label={login.string.NotSeeingWorkspace} /></span>
        <NavLink
          href={getHref('login')}
          onClick={async () => {
            await logOut()
            goTo('login')
          }}
        >
          <Label label={login.string.ChangeAccount} variant={'link'} />
        </NavLink>
      </div>
      {#if canDeleteAccount}
        <div class="delete-account">
          <button type="button" on:click={handleDeleteAccount}>
            <Label label={login.string.DeleteAccount} />
          </button>
        </div>
      {/if}
    </div>
  {/await}
</form>

<style lang="scss">
  .container {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    flex-grow: 1;
    overflow: hidden;

    .workspace-loader {
      height: 100%;
      display: flex;
      justify-content: center;
      align-items: center;
    }

    .fs-title {
      font-weight: 600;
      color: var(--login-content-color, var(--theme-content-color));
      margin-bottom: 0.75rem;
    }
    .title {
      font-weight: 600;
      font-size: 1.5rem;
      color: var(--login-caption-color, var(--theme-caption-color));
      /* Keep title on a single line, ellipsize on overflow */
      flex: 1 1 auto;
      min-width: 0; /* allow flex child to shrink for ellipsis */
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .title-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .status {
      /* min-height: 7.5rem; */
      max-height: 7.5rem;
      padding-top: 1.25rem;
    }

    .form {
      display: grid;
      grid-template-columns: 1fr 1fr;
      column-gap: 0.75rem;
      row-gap: 1.5rem;

      .form-row {
        grid-column-start: 1;
        grid-column-end: 3;
      }

      .workspace {
        padding: 1rem;
        border-radius: 1rem;
      }
    }
    .readonly-warning {
      margin-bottom: 1.5rem;
      color: var(--login-caption-color, var(--theme-caption-color));
    }
    .community-badge {
      align-self: center;
      margin: 0 0 1rem;
      padding: 0.25rem 0.75rem;
      border-radius: 0.75rem;
      font-size: 0.75rem;
      background: var(--theme-button-hovered);
      color: var(--theme-caption-color);
      opacity: 0.9;
    }
    .grow-separator {
      flex-grow: 1;
    }
    .delete-account {
      margin-top: 0.75rem;
      font-size: 0.75rem;
      color: var(--theme-darker-color);

      button {
        padding: 0;
        border: none;
        background: transparent;
        color: inherit;
        font: inherit;
        cursor: pointer;

        &:hover {
          color: var(--theme-caption-color);
        }
      }
    }

    .footer {
      margin-top: 3.5rem;
      font-size: 0.8rem;
      color: var(--login-caption-color, var(--theme-caption-color));
      span {
        opacity: 0.8;
      }
      /* Ensure anchors inside nested components (like NavLink) get styled in the footer.
         Svelte scopes component styles, so use :global(a) to target child anchor elements. */
      a {
        text-decoration: none;
        color: var(--login-navlink-color, var(--login-caption-color, var(--theme-caption-color)));
        opacity: 0.8;
        &:hover {
          opacity: 1;
        }
      }
    }
  }
</style>
