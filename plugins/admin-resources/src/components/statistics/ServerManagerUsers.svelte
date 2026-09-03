<script lang="ts">
  import { groupByArray, systemAccountUuid, type PersonInfo, type PersonUuid, WorkspaceUuid } from '@hcengineering/core'
  import { getEmbeddedLabel, getMetadata } from '@hcengineering/platform'
  import presentation, { isAdminUser, type OverviewStatistics } from '@hcengineering/presentation'
  import { Button, CheckBox, ticker, Expandable } from '@hcengineering/ui'
  import { FixedColumn } from '@hcengineering/view-resources'

  import { adminFetch, getAccountClient, listWorkspacesPaged, requestAdminOtpCode } from '../../utils'

  const endpoint = getMetadata(presentation.metadata.StatsUrl)

  // One audited RPC: account queues the event and whichever transactor holds the workspace acts.
  // The panel no longer fans the call out to every transactor from the browser.
  function forceClose (wsId: string): void {
    void requestAdminOtpCode().then(async (code) => {
      if (code === undefined) return
      try {
        await getAccountClient().adminForceCloseWorkspace(wsId as WorkspaceUuid, code)
      } catch (err) {
        console.error('Failed to force close the workspace:', err)
      }
    })
  }

  // Resolve session userIds to person name/email, cached across refreshes
  let persons = new Map<string, PersonInfo>()
  const resolving = new Set<string>()

  async function resolvePersons (d: OverviewStatistics | undefined): Promise<void> {
    if (d === undefined) return
    const ids = new Set<string>()
    for (const ws of d.workspaces ?? []) {
      for (const s of ws.sessions) ids.add(s.userId)
    }
    const missing = [...ids].filter((id) => !persons.has(id) && !resolving.has(id) && !isSystemAccount(id))
    if (missing.length === 0) return
    missing.forEach((id) => resolving.add(id))
    const client = getAccountClient()
    const infos = await Promise.all(
      missing.map(async (id) => await client.getPersonInfo(id as PersonUuid).catch(() => undefined))
    )
    for (const [i, info] of infos.entries()) {
      if (info !== undefined) {
        persons.set(missing[i], info)
      } else {
        // Drop failed lookups so the next refresh retries them
        resolving.delete(missing[i])
      }
    }
    persons = persons
  }
  function personLabel (id: string, _persons: Map<string, PersonInfo>): string {
    if (id === systemAccountUuid) return 'System'
    const p = _persons.get(id)
    if (p === undefined) return id
    const email = p.socialIds.find((s) => s.type === 'email')?.value
    return email != null ? `${p.name} (${email})` : p.name
  }

  // Workspace names for display (admin panel has no live workspacesStore)
  let wsNames = new Map<string, string>()
  void listWorkspacesPaged({ limit: 1000 }).then((res) => {
    if (res != null) {
      wsNames = new Map(res.workspaces.map((w) => [w.uuid as string, w.name ?? w.url ?? '']))
    }
  })

  async function fetchStats (time: number): Promise<void> {
    await adminFetch(endpoint + '/api/v1/overview')
      .then(async (json) => {
        data = await json.json()
      })
      .catch((err) => {
        console.error(err)
      })
  }
  let data: OverviewStatistics | undefined
  $: void fetchStats($ticker)
  $: void resolvePersons(data)
  let realUsers: boolean
  let showActive5: boolean

  $: byService = groupByArray(
    (data?.workspaces ?? []).filter((it) => !showActive5 || it.sessions.some((sit) => sit.current.tx > 0)),
    (it) => it.service
  )

  const isSystemAccount = (it: string): boolean =>
    it === systemAccountUuid || it === '5a1a5faa-582c-42a6-8613-fc80a15e3ae8' // Hardcoded AiBot account, fix me later!
</script>

<div class="p-6">
  <div class="flex-row-center">
    Uniq users: {data?.usersTotal} of {data?.connectionsTotal} connections
  </div>
  <div class="flex-row-center">
    <CheckBox bind:checked={realUsers} />
    <div class="ml-1">Show only users</div>
  </div>
  <div class="flex-row-center">
    <CheckBox bind:checked={showActive5} />
    <div class="ml-1">Show active in 5mins</div>
  </div>
</div>
<div class="flex-column p-3 h-full" style:overflow="auto">
  {#if data !== undefined && (data.workspaces ?? []).length === 0}
    <!-- Live sessions only: empty until someone is connected to a workspace -->
    <div class="p-1 content-dark-color">No active workspace connections</div>
  {/if}
  {#each byService.keys() as s}
    {@const ss = byService.get(s) ?? []}
    <Expandable bordered expandable showChevron>
      <svelte:fragment slot="title">
        <div class="flex-row-center p-1">
          <FixedColumn key="service">
            <span class="p-1">
              Service: {s}
            </span>
          </FixedColumn>
          <span class="p-1">
            Workspaces: {ss.length}
          </span>

          <span class="p-1">
            Connections: {ss.reduce((it, itm) => it + itm.sessions.length, 0)}
          </span>
          <span class="p-1">
            Users: {ss.reduce((it, itm) => it + itm.sessions.filter((it) => !isSystemAccount(it.userId)).length, 0)}
          </span>
          <span class="p-1">
            Active {ss.reduce((it, itm) => it + itm.sessions.filter((it) => it.current.tx > 0).length, 0)} /
            {ss.reduce((it, itm) => it + itm.sessions.filter((it) => it.mins5.tx > 0 || it.current.tx > 0).length, 0)}
          </span>
        </div>
      </svelte:fragment>
      <div class="p-1">
        {#each ss as act}
          {@const wsName = wsNames.get(act.wsId)}
          {@const totalFind = act.sessions.reduce((it, itm) => itm.total.find + it, 0)}
          {@const totalTx = act.sessions.reduce((it, itm) => itm.total.tx + it, 0)}

          {@const currentFind = act.sessions.reduce((it, itm) => itm.current.find + it, 0)}
          {@const currentTx = act.sessions.reduce((it, itm) => itm.current.tx + it, 0)}
          {@const employeeGroups = Array.from(
            new Set(act.sessions.filter((it) => !showActive5 || it.current.tx > 0).map((it) => it.userId))
          ).filter((it) => !isSystemAccount(it) || !realUsers)}
          {@const realGroup = Array.from(new Set(act.sessions.map((it) => it.userId))).filter(
            (it) => !isSystemAccount(it)
          )}
          {@const wsServices = Array.from(new Set(act.sessions.map((s) => s.data?.service).filter((s) => s != null)))}
          {#if employeeGroups.length > 0}
            <span class="flex-col">
              <Expandable contentColor expanded={false} expandable={true} bordered>
                <svelte:fragment slot="title">
                  <div class="flex flex-row-center flex-between flex-grow p-1">
                    <div class="fs-title" class:greyed={realGroup.length === 0}>
                      Workspace: {wsName ?? act.wsId}: {employeeGroups.length} current 5 mins => {currentFind}/{currentTx},
                      total => {totalFind}/{totalTx}
                      {#if wsServices.length > 0}
                        <span class="content-dark-color">[{wsServices.join(', ')}]</span>
                      {/if}
                    </div>
                    {#if isAdminUser()}
                      <Button
                        label={getEmbeddedLabel('Force close')}
                        size={'small'}
                        kind={'ghost'}
                        on:click={() => {
                          forceClose(act.wsId)
                        }}
                      />
                    {/if}
                  </div>
                </svelte:fragment>
                <div class="flex-col">
                  {#each employeeGroups as employeeId}
                    {@const connections = act.sessions.filter((it) => it.userId === employeeId)}

                    {@const find = connections.reduce((it, itm) => itm.current.find + it, 0)}
                    {@const txes = connections.reduce((it, itm) => itm.current.tx + it, 0)}
                    {@const services = Array.from(
                      new Set(connections.map((c) => c.data?.service).filter((s) => s != null))
                    )}
                    <div class="p-1 flex-col ml-4">
                      <Expandable>
                        <svelte:fragment slot="title">
                          <div class="flex-row-center p-1">
                            {personLabel(employeeId, persons)}
                            {#if services.length > 0}
                              <span class="ml-1 content-dark-color">[{services.join(', ')}]</span>
                            {/if}
                            : {connections.length}
                            <div class="ml-4">
                              <div class="ml-1">{find} rx/{txes} tx</div>
                            </div>
                          </div>
                        </svelte:fragment>
                        {#each connections as user, i}
                          <div class="flex-row-center ml-10">
                            #{i}
                            {user.userId}
                            <div class="p-1">
                              Total: {user.total.find} rx/{user.total.tx} tx
                            </div>
                            <div class="p-1">
                              Previous 5 mins: {user.mins5.find} rx/{user.mins5.tx} tx
                            </div>
                            <div class="p-1">
                              Current 5 mins: {user.current.find} tx/{user.current.tx} tx
                            </div>
                          </div>
                          <div class="p-1 flex-col ml-10">
                            {#each Object.entries(user.data ?? {}) as [k, v]}
                              <div class="p-1">
                                {k}: {JSON.stringify(v)}
                              </div>
                            {/each}
                          </div>
                        {/each}
                      </Expandable>
                    </div>
                  {/each}
                </div>
              </Expandable>
            </span>
          {/if}
        {/each}
      </div>
    </Expandable>
  {/each}
</div>

<style lang="scss">
  .greyed {
    color: rgba(black, 0.5);
  }
</style>
