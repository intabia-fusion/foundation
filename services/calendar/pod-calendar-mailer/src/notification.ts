//
// Copyright © 2025 Hardcore Engineering Inc.
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
import calendar, { Event } from '@hcengineering/calendar'
import contact from '@hcengineering/contact'
import { AccountUuid, Doc, MeasureContext, PersonId, Ref, Space, WorkspaceUuid } from '@hcengineering/core'
import { IntlString } from '@hcengineering/platform'
import notification from '@hcengineering/notification'

import { getClient } from './utils'

export enum MeetingNotificationType {
  Scheduled = 'meeting-scheduled',
  Rescheduled = 'meeting-rescheduled',
  Canceled = 'meeting-canceled'
}

const notificationMessages: Record<MeetingNotificationType, IntlString> = {
  [MeetingNotificationType.Scheduled]: calendar.string.MeetingScheduledNotification,
  [MeetingNotificationType.Rescheduled]: calendar.string.MeetingRescheduledNotification,
  [MeetingNotificationType.Canceled]: calendar.string.MeetingCanceledNotification
}

export async function createNotification (
  ctx: MeasureContext,
  workspaceUuid: WorkspaceUuid,
  type: MeetingNotificationType,
  forEvent: Event,
  modifiedBy: PersonId
): Promise<void> {
  if (notificationMessages[type] === undefined) {
    throw new Error('Invalid notification type')
  }

  const { client, accountClient } = await getClient(workspaceUuid)

  const accountUuid = (await accountClient.findPersonBySocialId(forEvent.user, true)) as AccountUuid | undefined
  if (accountUuid === undefined) {
    throw new Error(`Global person not found for social-id ${forEvent.user}`)
  }

  const space = await client.findOne(contact.class.PersonSpace, { account: accountUuid }, { projection: { _id: 1 } })
  if (space === undefined) {
    throw new Error(`Person space not found for account ${accountUuid}`)
  }

  let objectId: Ref<Doc<Space>> = forEvent._id
  let objectClass = forEvent._class

  if (type === MeetingNotificationType.Canceled) {
    const calendr = await client.findOne(
      calendar.class.Calendar,
      { _id: forEvent.calendar },
      { projection: { _id: 1 } }
    )
    if (calendr === undefined) {
      throw new Error(`Calendar not found for event ${forEvent._id}`)
    }
    objectId = calendr._id
    objectClass = calendar.class.Calendar
  }

  await client.createDoc(
    notification.class.CreateNotificationAction,
    space._id,
    {
      attachedTo: objectId,
      attachedToClass: objectClass,
      account: accountUuid,
      notification: {
        icon: calendar.icon.Calendar,
        messageIntl: notificationMessages[type]
      },
      intl: {
        intlParams: { title: forEvent.title }
      }
    },
    undefined,
    forEvent.createdOn,
    modifiedBy
  )

  ctx.info('Notification created', {
    accountUuid,
    eventId: forEvent.eventId,
    objectId: forEvent._id,
    spaceId: space._id
  })
}
