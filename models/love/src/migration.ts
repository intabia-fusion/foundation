//
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
//

import contact, { type SocialIdentity, type Employee } from '@hcengineering/contact'
import {
  type AttachedDoc,
  type MarkupBlobRef,
  TxOperations,
  type Ref,
  type Space,
  type Timestamp,
  type Domain,
  type PersonId,
  type AccountUuid
} from '@hcengineering/core'
import drive from '@hcengineering/drive'
import activity, { type DocUpdateMessage } from '@hcengineering/activity'
import {
  MeetingStatus,
  type RoomLanguage,
  RoomType,
  type TranscriptionState,
  createDefaultRooms,
  isOffice,
  loveId,
  type Floor,
  type Room,
  type MeetingMinutes,
  type RecordingState
} from '@hcengineering/love'
import {
  createDefaultSpace,
  migrateSpace,
  tryMigrate,
  tryUpgrade,
  type MigrateOperation,
  type MigrationClient,
  type MigrationUpgradeClient
} from '@hcengineering/model'
import core, { DOMAIN_SPACE } from '@hcengineering/model-core'
import { DOMAIN_LOVE, DOMAIN_LOVE_PENDING, DOMAIN_MEETING_MINUTES } from '.'
import love from './plugin'

const DOMAIN_ACTIVITY = 'activity' as Domain
const DOMAIN_ATTACHMENT = 'attachment' as Domain
const DOMAIN_CONTACT = 'contact' as Domain

// Old MeetingMinutes interface before migration to Space (extends AttachedDoc which extends Doc)
interface OldMeetingMinutes extends AttachedDoc {
  // Old MeetingMinutes fields (from plugins/love/src/types.ts before Space migration)
  title: string
  description: MarkupBlobRef | null
  status: MeetingStatus
  transcriptionState: TranscriptionState
  recordingState: RecordingState
  meetingEnd?: Timestamp
  meetingScheduledDate?: Timestamp
  transcription?: number
  messages?: number
  attachments?: number
  recordings?: number
  language: RoomLanguage
  startWithRecording?: boolean
  startWithTranscription?: boolean
}

function isMissingTableError (err: unknown): boolean {
  if (err instanceof Error) {
    const code = 'code' in err ? (err as Error & { code: string }).code : undefined
    return code === '42P01' || err.message.includes('does not exist')
  }
  return false
}

async function createDefaultFloor (tx: TxOperations): Promise<void> {
  const current = await tx.findOne(love.class.Floor, {
    _id: love.ids.MainFloor
  })
  if (current === undefined) {
    await tx.createDoc(
      love.class.Floor,
      core.space.Workspace,
      {
        name: 'Main'
      },
      love.ids.MainFloor
    )
  }
}

async function createRooms (client: MigrationUpgradeClient): Promise<void> {
  const tx = new TxOperations(client, core.account.System)
  const rooms = await client.findAll(love.class.Room, {})
  for (const room of rooms) {
    await tx.remove(room)
  }
  const employees = await client.findAll(contact.mixin.Employee, { active: true })

  const data = createDefaultRooms(
    employees.map((p) => p._id),
    true,
    false
  )
  for (const room of data) {
    const _class = isOffice(room) ? love.class.Office : love.class.Room
    await tx.createDoc(_class, core.space.Workspace, room, room._id)
  }
}

async function createReception (client: MigrationUpgradeClient): Promise<void> {
  const tx = new TxOperations(client, core.account.System)
  const current = await tx.findOne(love.class.Room, {
    _id: love.ids.Reception
  })
  if (current !== undefined) return
  await tx.createDoc(
    love.class.Room,
    core.space.Workspace,
    {
      name: 'Reception',
      type: RoomType.Reception,
      floor: '' as Ref<Floor>,
      width: 100,
      height: 0,
      x: 0,
      y: 0,
      language: 'en',
      startWithTranscription: false,
      startWithRecording: false,
      startPrivate: false,
      description: null
    },
    love.ids.Reception
  )
}

export const loveOperation: MigrateOperation = {
  async migrate (client: MigrationClient, mode): Promise<void> {
    await tryMigrate(mode, client, loveId, [
      {
        state: 'removeDeprecatedSpace',
        mode: 'upgrade',
        func: async (client: MigrationClient) => {
          await migrateSpace(client, 'love:space:Rooms' as Ref<Space>, core.space.Workspace, [DOMAIN_LOVE])
        }
      },
      {
        state: 'setup-defaults-settings-v3',
        mode: 'upgrade',
        func: async (client: MigrationClient) => {
          await client.update(
            DOMAIN_LOVE,
            { _class: love.class.Room, language: { $exists: false } },
            { language: 'ru' }
          )
          await client.update(
            DOMAIN_LOVE,
            { _class: love.class.Office, language: { $exists: false } },
            { language: 'ru' }
          )
          await client.update(
            DOMAIN_LOVE,
            { _class: love.class.Room, type: RoomType.Video, startWithTranscription: { $exists: false } },
            { startWithTranscription: true }
          )
          await client.update(
            DOMAIN_LOVE,
            { _class: love.class.Room, startWithTranscription: { $exists: false } },
            { startWithTranscription: true }
          )
          await client.update(
            DOMAIN_LOVE,
            { _class: love.class.Office, startWithTranscription: { $exists: false } },
            { startWithTranscription: true }
          )
          await client.update(
            DOMAIN_LOVE,
            { _class: love.class.Room, type: RoomType.Video, startWithRecording: { $exists: false } },
            { startWithRecording: false }
          )
          await client.update(
            DOMAIN_LOVE,
            { _class: love.class.Room, startWithRecording: { $exists: false } },
            { startWithRecording: false }
          )
          await client.update(
            DOMAIN_LOVE,
            { _class: love.class.Office, startWithRecording: { $exists: false } },
            { startWithRecording: false }
          )
        }
      },
      {
        state: 'setup-defaults-start-private',
        mode: 'upgrade',
        func: async (client) => {
          // Offices always start private
          await client.update(
            DOMAIN_LOVE,
            { _class: love.class.Office, startPrivate: { $exists: false } },
            { startPrivate: true }
          )
          // Regular rooms default to not private
          await client.update(
            DOMAIN_LOVE,
            { _class: love.class.Room, startPrivate: { $exists: false } },
            { startPrivate: false }
          )
        }
      },
      {
        state: 'move-meeting-minutes',
        mode: 'upgrade',
        func: async (client) => {
          await client.move(DOMAIN_LOVE, { _class: love.class.MeetingMinutes }, DOMAIN_MEETING_MINUTES)
        }
      },
      {
        state: 'default-meeting-minutes-status',
        mode: 'upgrade',
        func: async (client) => {
          try {
            await client.update(
              DOMAIN_MEETING_MINUTES,
              { status: { $exists: false } },
              { status: MeetingStatus.Finished }
            )
          } catch (err: unknown) {
            if (isMissingTableError(err)) {
              return // Table does not exist — skip
            }
            throw err
          }
        }
      },
      {
        state: 'meeting-minutes-reindex-v1',
        func: async (client) => {
          try {
            await client.reindex(DOMAIN_MEETING_MINUTES, [love.class.MeetingMinutes])
          } catch (err: unknown) {
            if (isMissingTableError(err)) {
              return // Table does not exist — skip
            }
            throw err
          }
        }
      },
      {
        state: 'office-rooms-to-video-v1',
        mode: 'upgrade',
        func: async (client: MigrationClient) => {
          await client.update(
            DOMAIN_LOVE,
            { _class: love.class.Office, type: RoomType.Audio },
            { type: RoomType.Video }
          )
        }
      },
      {
        state: 'meeting-minutes-to-space-v2',
        mode: 'upgrade',
        func: async (client) => {
          // Check if DOMAIN_MEETING_MINUTES table exists (it may not for new workspaces
          // since MeetingMinutes is now in DOMAIN_SPACE and the old domain is not in the model)
          try {
            const existing = await client.find(
              DOMAIN_MEETING_MINUTES,
              { _class: love.class.MeetingMinutes },
              { limit: 1 }
            )

            const spacemm = await client.find(DOMAIN_SPACE, { _class: love.class.MeetingMinutes }, { limit: 1 })
            if (existing.length === 0 && spacemm.length === 0) {
              client.logger.log('No MeetingMinutes found in DOMAIN_MEETING_MINUTES, skipping migration', {})
              return
            }
          } catch (err: unknown) {
            if (isMissingTableError(err)) {
              client.logger.log('DOMAIN_MEETING_MINUTES does not exist, skipping migration', {})
              return
            }
            throw err
          }

          // Build mapping from PersonId (createdBy) to AccountUuid (personUuid)
          // 1. Get all SocialIdentity documents (their _id is PersonId)
          // 2. Get all Employees by attachedTo from SocialIdentity
          // 3. Create mapping: SocialIdentity._id -> Employee.personUuid

          const socialIdentities = await client.find<SocialIdentity>(DOMAIN_CONTACT, {
            _class: contact.class.SocialIdentity
          })
          const employeeIds = socialIdentities.map((si) => si.attachedTo as Ref<Employee>)
          const employees = await client.find<Employee>(DOMAIN_CONTACT, {
            _class: contact.mixin.Employee,
            _id: { $in: employeeIds }
          })
          const employeeById = new Map(employees.map((e) => [e._id, e]))

          const personIdToAccountUuid = new Map<PersonId, AccountUuid>()
          for (const si of socialIdentities) {
            const employee = employeeById.get(si.attachedTo as Ref<Employee>)
            if (employee?.personUuid != null) {
              personIdToAccountUuid.set(si._id, employee.personUuid)
            }
          }
          client.logger.log('Built PersonId to AccountUuid mapping', { count: personIdToAccountUuid.size })

          // Process MeetingMinutes in batches: read -> transform -> upload to DOMAIN_SPACE -> delete from source
          const iterator = await client.traverse(DOMAIN_MEETING_MINUTES, {
            _class: love.class.MeetingMinutes
          })

          try {
            let processed = 0
            while (true) {
              const meetings = await iterator.next(1000)
              if (meetings == null || meetings.length === 0) break

              // Transform meetings in memory
              const transformedMeetings = meetings.map((meeting) => {
                const m = meeting as unknown as OldMeetingMinutes

                // Convert createdBy (PersonId) to AccountUuid for owners
                const ownerAccount = m.createdBy != null ? personIdToAccountUuid.get(m.createdBy) : undefined

                // Build transformed document for new MeetingMinutes as Space
                const transformed: MeetingMinutes = {
                  // Core Doc fields (preserved from original)
                  _id: m._id as unknown as Ref<MeetingMinutes>,
                  _class: m._class,
                  space: m._id as unknown as Ref<MeetingMinutes>,
                  modifiedOn: m.modifiedOn,
                  modifiedBy: m.modifiedBy,
                  createdOn: m.createdOn,
                  createdBy: m.createdBy,

                  // Space required fields (migrated from old fields)
                  name: m.title ?? '', // title -> name
                  description: '', // Space requires string description (we use descriptionRef for actual content)
                  private: false,
                  archived: false,
                  members: [],
                  owners: ownerAccount != null ? [ownerAccount] : [],

                  // MeetingMinutes specific fields
                  descriptionRef: m.description, // description -> descriptionRef
                  summary: null, // new field
                  roomId: m.attachedToClass === love.class.Room ? (m.attachedTo as Ref<Room>) : undefined,
                  status: m.status,
                  transcriptionState: m.transcriptionState,
                  recordingState: m.recordingState,
                  meetingEnd: m.meetingEnd,
                  meetingScheduledDate: m.meetingScheduledDate,
                  transcription: m.transcription,
                  messages: m.messages,
                  attachments: m.attachments,
                  recordings: m.recordings,
                  language: m.language,
                  startWithRecording: m.startWithRecording,
                  startWithTranscription: m.startWithTranscription
                }

                return transformed
              })

              // Upload to DOMAIN_SPACE
              await client.create(DOMAIN_SPACE, transformedMeetings)

              // Delete from DOMAIN_MEETING_MINUTES
              await client.deleteMany(DOMAIN_MEETING_MINUTES, {
                _id: { $in: meetings.map((m) => m._id) }
              })

              processed += meetings.length
              client.logger.log('...processed MeetingMinutes', { count: processed })
            }
          } finally {
            await iterator.close()
          }

          client.logger.log('Finished migrating MeetingMinutes to DOMAIN_SPACE', {})

          // Update space for all documents attached to MeetingMinutes
          // Get all meeting IDs from DOMAIN_SPACE (they are now Spaces)
          const allMeetings = await client.find(DOMAIN_SPACE, { _class: love.class.MeetingMinutes })
          const meetingIds = new Set(allMeetings.map((m) => m._id))

          if (meetingIds.size > 0) {
            const meetingIdArray = Array.from(meetingIds)

            // Update PendingRecording documents in DOMAIN_LOVE_PENDING
            const pendingIterator = await client.traverse<AttachedDoc>(DOMAIN_LOVE_PENDING, {
              attachedTo: { $in: meetingIdArray }
            })
            try {
              let processed = 0
              while (true) {
                const docs = await pendingIterator.next(1000)
                if (docs == null || docs.length === 0) break

                const operations = docs.map((doc) => ({
                  filter: { _id: doc._id },
                  update: { space: doc.attachedTo as Ref<Space> }
                }))
                await client.bulk(DOMAIN_LOVE_PENDING, operations)
                processed += docs.length
                client.logger.log('...processed PendingRecording spaces', { count: processed })
              }
            } finally {
              await pendingIterator.close()
            }

            // Update Activity messages
            const activityIterator = await client.traverse<AttachedDoc>(DOMAIN_ACTIVITY, {
              attachedTo: { $in: meetingIdArray },
              attachedToClass: love.class.MeetingMinutes
            })
            try {
              let processed = 0
              while (true) {
                const docs = await activityIterator.next(1000)
                if (docs == null || docs.length === 0) break

                const operations = docs.map((doc) => ({
                  filter: { _id: doc._id },
                  update: { space: doc.attachedTo as Ref<Space> }
                }))
                await client.bulk(DOMAIN_ACTIVITY, operations)
                processed += docs.length
                client.logger.log('...processed ActivityMessage spaces', { count: processed })
              }
            } finally {
              await activityIterator.close()
            }

            // Update Activity messages: description -> descriptionRef + update space to meeting id
            const descActivityIterator = await client.traverse<DocUpdateMessage>(DOMAIN_ACTIVITY, {
              _class: activity.class.DocUpdateMessage,
              objectClass: love.class.MeetingMinutes
            })
            try {
              let processed = 0
              while (true) {
                const docs = await descActivityIterator.next(1000)
                if (docs == null || docs.length === 0) break

                const operations = docs
                  .map((doc) => {
                    const update: Record<string, any> = {}
                    // Update space to point to the meeting (objectId) instead of core.space.Workspace
                    if (doc.objectId != null && meetingIds.has(doc.objectId)) {
                      update.space = doc.objectId
                    }
                    if (doc.attributeUpdates?.attrKey === 'description') {
                      update.attributeUpdates = { ...doc.attributeUpdates, attrKey: 'descriptionRef' }
                    }
                    if ((doc.history ?? [])?.some((h) => h.update?.attrKey === 'description')) {
                      update.history = doc.history.map((h: any) => {
                        if (h.update?.attrKey === 'description') {
                          return { ...h, update: { ...h.update, attrKey: 'descriptionRef' } }
                        }
                        return h
                      })
                    }
                    return {
                      filter: { _id: doc._id },
                      update
                    }
                  })
                  .filter((op: any) => Object.keys(op.update).length > 0)
                if (operations.length > 0) {
                  await client.bulk(DOMAIN_ACTIVITY, operations)
                }
                processed += docs.length
                client.logger.log('...processed DocUpdateMessage description->descriptionRef + space', {
                  count: processed,
                  updated: operations.length
                })
              }
            } finally {
              await descActivityIterator.close()
            }

            // Update Attachments
            const attachmentIterator = await client.traverse<AttachedDoc>(DOMAIN_ATTACHMENT, {
              attachedTo: { $in: meetingIdArray },
              attachedToClass: love.class.MeetingMinutes
            })
            try {
              let processed = 0
              while (true) {
                const docs = await attachmentIterator.next(1000)
                if (docs == null || docs.length === 0) break

                const operations = docs.map((doc) => ({
                  filter: { _id: doc._id },
                  update: { space: doc.attachedTo as Ref<Space> }
                }))
                await client.bulk(DOMAIN_ATTACHMENT, operations)
                processed += docs.length
                client.logger.log('...processed Attachment spaces', { count: processed })
              }
            } finally {
              await attachmentIterator.close()
            }
          }
        }
      }
    ])
  },
  async upgrade (state: Map<string, Set<string>>, client: () => Promise<MigrationUpgradeClient>, mode): Promise<void> {
    await tryUpgrade(mode, state, client, loveId, [
      {
        state: 'initial-defaults',
        func: async (client) => {
          const tx = new TxOperations(client, core.account.System)
          await createDefaultFloor(tx)
        }
      },
      {
        state: 'createRooms_v2',
        func: createRooms
      },

      {
        state: 'create-reception',
        func: async (client) => {
          await createReception(client)
        }
      },
      {
        state: 'create-drive',
        func: async (client) => {
          await createDefaultSpace(
            client,
            love.space.Drive,
            {
              name: 'Records',
              description: 'Office records',
              type: drive.spaceType.DefaultDrive,
              autoJoin: true
            },
            drive.class.Drive
          )
        }
      }
    ])
  }
}
