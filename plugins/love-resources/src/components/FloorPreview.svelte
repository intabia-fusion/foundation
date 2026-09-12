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
  import contact from '@hcengineering/contact'
  import { AccountRole, Ref, getCurrentAccount, hasAccountRole } from '@hcengineering/core'
  import platform, { getMetadata, IntlString } from '@hcengineering/platform'
  import { getClient } from '@hcengineering/presentation'
  import {
    AccordionItem,
    ButtonIcon,
    IconDelete,
    IconEdit,
    IconMoreH,
    IconSearch,
    IconSettings,
    Label,
    SelectPopup,
    eventToHTMLElement,
    showPopup,
    type SelectPopupValueType
  } from '@hcengineering/ui'
  import love, { Floor, isOffice, isServiceFloor, Office, ParticipantInfo, Room } from '@hcengineering/love'
  import { createEventDispatcher, onMount } from 'svelte'
  import plugin from '../plugin'
  import { infos } from '../stores'
  import { calculateFloorSize } from '../utils'
  import EditFloorPopup from './EditFloorPopup.svelte'
  import FloorGrid from './FloorGrid.svelte'
  import RoomPreview from './RoomPreview.svelte'
  import { loadUsersStatus } from '@hcengineering/contact-resources'

  export let floor: Floor
  export let configurable: boolean = false
  export let rooms: Room[] = []
  export let selected: boolean
  export let disabled: boolean = false
  export let isOpen: boolean = false
  export let cropped: boolean = false
  export let showRoomName: boolean = false
  export let size: 'small' | 'medium' | 'large' = 'large'
  export let background: string | undefined = undefined
  export let kind: 'default' | 'second' | 'no-border' = 'default'
  export let configure: boolean = false

  const me = getCurrentAccount()
  const dispatch = createEventDispatcher()

  let floorContainer: HTMLDivElement
  let hovered: number = -1

  function getInfo (room: Ref<Room>, info: ParticipantInfo[]): ParticipantInfo[] {
    return info.filter((p) => p.room === room)
  }

  let roomName: IntlString | undefined = undefined

  function hover (e: CustomEvent<any>, n: number): void {
    roomName = e.detail.name
    hovered = n
  }

  // The service floor is created by fixed id and owned by the workspace - renaming or deleting it
  // would strand every scheduled meeting, so it never offers the edit affordances.
  $: editable = hasAccountRole(me, AccountRole.Maintainer) && !isServiceFloor(floor._id)
  $: rows = calculateFloorSize(rooms) - (cropped ? 1 : 0)

  const client = getClient()

  async function remove (): Promise<void> {
    await client.remove(floor)
  }

  function renameFloor (): void {
    showPopup(EditFloorPopup, { id: floor._id }, 'top', () => {
      pressed = false
    })
  }

  let pressed: boolean = false
  const clickMore = (e: MouseEvent): void => {
    pressed = true
    const value: SelectPopupValueType[] = [
      { id: 'rename', icon: IconEdit, label: plugin.string.RenameAFloor },
      ...(getMetadata(platform.metadata.DevModel) === true
        ? [
            { id: 'debug', icon: IconSettings, label: 'Debug Offices' as IntlString },
            { id: 'clearAiBot', icon: IconDelete, label: 'Clear AI Bot Offices' as IntlString },
            { id: 'searchAccounts', icon: IconSearch, label: 'Search Accounts' as IntlString }
          ]
        : [])
    ]
    showPopup(SelectPopup, { value }, eventToHTMLElement(e), (result) => {
      if (result === 'configure') {
        dispatch('configure', floor)
        pressed = false
      } else if (result === 'rename') {
        renameFloor()
      } else if (result === 'debug') {
        void debugOffices()
        pressed = false
      } else if (result === 'clearAiBot') {
        void clearAiBotAssignments()
        pressed = false
      } else if (result === 'searchAccounts') {
        void searchAccountsAndPersons()
        pressed = false
      }
    })
  }

  onMount(() => {
    loadUsersStatus()
  })

  async function debugOffices (): Promise<void> {
    const allRooms = await client.findAll(love.class.Room, {})
    const allOffices = allRooms.filter((r) => isOffice(r))
    const allParticipantInfo = await client.findAll(love.class.ParticipantInfo, {})
    const allPersons = await client.findAll(contact.class.Person, {})

    console.log('[FloorPreview Debug] === OFFICE DIAGNOSTICS ===')
    console.log('[FloorPreview Debug] Total rooms:', allRooms.length)
    console.log('[FloorPreview Debug] Total offices:', allOffices.length)
    console.log('[FloorPreview Debug] Total ParticipantInfo:', allParticipantInfo.length)
    console.log('[FloorPreview Debug] Total Persons:', allPersons.length)

    const officesData = allOffices.map((office) => {
      const officeTyped = office
      const officePerson = allPersons.find((p) => p._id === officeTyped.person)
      const officeParticipants = allParticipantInfo.filter((pi) => pi.room === office._id)

      return {
        officeId: office._id,
        officeName: office.name,
        assignedPersonId: officeTyped.person,
        assignedPersonName: officePerson?.name ?? 'Unknown',
        participantCount: officeParticipants.length,
        participants: officeParticipants.map((p) => ({
          personId: p.person,
          personName: p.name,
          x: p.x,
          y: p.y,
          meeting: p.meeting
        }))
      }
    })

    console.log('[FloorPreview Debug] Offices:', JSON.stringify(officesData, undefined, 2))

    // Check for AI Julia in multiple offices
    const juliaOffices = officesData.filter((o) =>
      o.participants.some((p) => p.personName?.toLowerCase().includes('julia'))
    )
    if (juliaOffices.length > 0) {
      console.log(
        '[FloorPreview Debug] AI Julia found in offices:',
        juliaOffices.map((o) => o.officeName)
      )
    }

    // Check all ParticipantInfo for Julia
    const juliaParticipants = allParticipantInfo.filter((pi) => pi.name?.toLowerCase().includes('julia'))
    console.log(
      '[FloorPreview Debug] All Julia ParticipantInfo:',
      juliaParticipants.map((p) => ({
        person: p.person,
        name: p.name,
        room: p.room,
        meeting: p.meeting,
        x: p.x,
        y: p.y
      }))
    )

    console.log('[FloorPreview Debug] === END DIAGNOSTICS ===')
  }

  async function clearAiBotAssignments (): Promise<void> {
    console.log('[FloorPreview] Clearing AI bot assignments...')

    // Find AI bot employee
    const employees = await client.findAll(contact.mixin.Employee, {})
    const aiBot = employees.find((e) => e.name?.toLowerCase().includes('julia') || e.name?.toLowerCase().includes('ai'))

    if (aiBot === undefined) {
      console.log('[FloorPreview] AI bot not found')
      return
    }

    console.log(`[FloorPreview] Found AI bot: ${aiBot._id} (${aiBot.name})`)

    // Find all offices assigned to AI bot
    const allOffices = await client.findAll(love.class.Office, {})
    const aiBotOffices = allOffices.filter((o) => o.person === aiBot._id)

    console.log(`[FloorPreview] Found ${aiBotOffices.length} offices assigned to AI bot`)

    if (aiBotOffices.length === 0) {
      console.log('[FloorPreview] No offices to clear')
      return
    }

    // Keep only the first office, clear others
    const sortedOffices = [...aiBotOffices].sort((a, b) => a._id.localeCompare(b._id))
    const officeToKeep = sortedOffices[0]
    const officesToClear = sortedOffices.slice(1)

    console.log(`[FloorPreview] Keeping office ${officeToKeep._id}, clearing ${officesToClear.length} offices`)

    for (const office of officesToClear) {
      console.log(`[FloorPreview] Clearing office ${office._id}`)
      await client.updateDoc(office._class, office.space, office._id, {
        person: null
      })
    }

    console.log('[FloorPreview] Done clearing AI bot assignments')
  }

  async function searchAccountsAndPersons (): Promise<void> {
    console.log('[FloorPreview] Searching accounts and persons...')

    const allPersons = await client.findAll(contact.class.Person, {})
    const allEmployees = await client.findAll(contact.mixin.Employee, {})
    const allSocialIds = await client.findAll(contact.class.SocialIdentity, {})

    console.log('[FloorPreview] === ACCOUNTS/PERSONS SEARCH ===')
    console.log(`[FloorPreview] Total Persons: ${allPersons.length}`)
    console.log(`[FloorPreview] Total Employees: ${allEmployees.length}`)
    console.log(`[FloorPreview] Total Social Identities: ${allSocialIds.length}`)

    const searchTerms = ['haiodo@gmail.com', 'haiodo@xored.com']

    for (const term of searchTerms) {
      console.log(`\n[FloorPreview] Searching for: ${term}`)

      // Search in social identities
      const matchingSocialIds = allSocialIds.filter(
        (sid) =>
          sid.value?.toLowerCase().includes(term.toLowerCase()) || sid.key?.toLowerCase().includes(term.toLowerCase())
      )

      if (matchingSocialIds.length > 0) {
        console.log(`[FloorPreview] Found ${matchingSocialIds.length} matching social identities:`)
        for (const sid of matchingSocialIds) {
          const person = allPersons.find((p) => p._id === sid.attachedTo)
          const employee = allEmployees.find((e) => e._id === sid.attachedTo)
          console.log(`  - SocialID: ${sid._id}, key: ${sid.key}, value: ${sid.value}`)
          console.log(`    Attached to Person: ${sid.attachedTo} (${person?.name ?? 'Unknown'})`)
          console.log(`    Is Employee: ${employee !== undefined}`)
          if (employee) {
            console.log(`    Employee active: ${employee.active}, role: ${employee.role}`)
          }

          // Check office assignment
          const allOffices = await client.findAll(love.class.Office, {})
          const assignedOffice = allOffices.find((o) => o.person === sid.attachedTo)
          if (assignedOffice) {
            console.log(`    Assigned to office: ${assignedOffice._id} (${assignedOffice.name || 'Unnamed'})`)
          }
        }
      } else {
        console.log('[FloorPreview] No matching social identities found')
      }

      // Search in persons by name
      const matchingPersons = allPersons.filter((p) => p.name?.toLowerCase().includes(term.toLowerCase()))
      if (matchingPersons.length > 0) {
        console.log(`[FloorPreview] Found ${matchingPersons.length} matching persons by name:`)
        for (const person of matchingPersons) {
          console.log(`  - Person: ${person._id}, name: ${person.name}, uuid: ${person.personUuid}`)
        }
      }
    }

    console.log('[FloorPreview] === END SEARCH ===')
  }
</script>

<AccordionItem
  id={`floor-${floor._id}`}
  title={floor.name}
  {size}
  {background}
  {isOpen}
  selectable
  {selected}
  {disabled}
  {kind}
  categoryHeader
  contentAlign={'center'}
  on:select
>
  <svelte:fragment slot="actions">
    {#if showRoomName && roomName !== undefined}
      <span class="content-color overflow-label"><Label label={roomName} /></span>
    {/if}
    {#if configurable && editable}
      {#if rooms.length === 0}
        <div class="mr-2">
          <ButtonIcon icon={IconDelete} kind={'negative'} size={'small'} on:click={remove} />
        </div>
      {/if}
      <ButtonIcon icon={IconMoreH} kind={'tertiary'} size={'small'} {pressed} on:click={clickMore} />
    {/if}
  </svelte:fragment>
  <FloorGrid bind:floorContainer {rows} preview on:mouseover={() => (roomName = undefined)}>
    {#each rooms as room, i}
      <RoomPreview
        {room}
        info={getInfo(room._id, $infos)}
        preview
        on:hover={(e) => {
          hover(e, i)
        }}
      />
    {/each}
  </FloorGrid>
</AccordionItem>
