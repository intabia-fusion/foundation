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

import contact, { type Employee, type Person } from '@hcengineering/contact'
import {
  AccountRole,
  type CollectionSize,
  type Domain,
  type MarkupBlobRef,
  type Ref,
  type Timestamp,
  DOMAIN_TRANSIENT,
  DateRangeMode,
  IndexKind,
  type AccountUuid,
  SocialIdType,
  DOMAIN_SPACE,
  SortingOrder
} from '@hcengineering/core'
import {
  type DevicesPreference,
  type Floor,
  loveId,
  type MeetingEventLink,
  type MeetingMinutes,
  type MeetingStatus,
  type MeetingSchedule,
  type Office,
  type ParticipantInfo,
  type PendingRecording,
  type RecordingFormat,
  type Room,
  type RoomInfo,
  type RoomLanguage,
  type RoomType,
  type TranscriptionState,
  type RecordingState,
  type UserMeetingInvite
} from '@hcengineering/love'
import {
  type Builder,
  Collection,
  Collection as PropCollection,
  Index,
  Mixin,
  Model,
  Prop,
  ReadOnly,
  TypeAny,
  TypeCollaborativeDoc,
  TypeDate,
  TypeRef,
  TypeString,
  TypeTimestamp,
  UX,
  TypeBoolean,
  Hidden,
  TypeNumber,
  ArrOf,
  TypeAccountUuid
} from '@hcengineering/model'
import calendar, { TEvent, TSchedule } from '@hcengineering/model-calendar'
import core, { TAttachedDoc, TDoc, TSpace } from '@hcengineering/model-core'
import preference, { TPreference } from '@hcengineering/model-preference'
import presentation from '@hcengineering/model-presentation'
import view, { createAction, createAttributePresenter, showColorsViewOption } from '@hcengineering/model-view'
import { type ViewOptionModel } from '@hcengineering/view'
import media from '@hcengineering/media'
import notification, { type MessageNotificationType, type TxNotificationType } from '@hcengineering/notification'
import { getEmbeddedLabel } from '@hcengineering/platform'
import setting from '@hcengineering/setting'
import workbench, { WidgetType } from '@hcengineering/workbench'
import activity from '@hcengineering/activity'
import chunter from '@hcengineering/chunter'
import attachment from '@hcengineering/attachment'
import time, { type ToDo, type Todoable } from '@hcengineering/time'

import love from './plugin'

export { loveId } from '@hcengineering/love'
export * from './migration'
export const DOMAIN_LOVE = 'love' as Domain
export const DOMAIN_LOVE_PENDING = 'love-pending' as Domain
export const DOMAIN_MEETING_MINUTES = 'meeting-minutes' as Domain

@Model(love.class.Room, core.class.Doc, DOMAIN_LOVE)
@UX(love.string.Room, love.icon.Love, undefined, undefined, undefined, undefined, 'name')
export class TRoom extends TDoc implements Room {
  @Prop(TypeString(), core.string.Name)
  @Index(IndexKind.FullText)
    name!: string

  @Prop(TypeCollaborativeDoc(), core.string.Description)
  @Index(IndexKind.FullText)
    description!: MarkupBlobRef | null

  type!: RoomType

  @Prop(TypeRef(love.class.Floor), love.string.Floor)
  @ReadOnly()
  // @Index(IndexKind.Indexed)
    floor!: Ref<Floor>

  width!: number
  height!: number
  x!: number
  y!: number

  @Prop(TypeString(), love.string.Language, { editor: love.component.RoomLanguageEditor })
  @Hidden()
    language!: RoomLanguage

  @Prop(TypeBoolean(), love.string.StartWithTranscription)
    startWithTranscription!: boolean

  @Prop(TypeBoolean(), love.string.StartWithRecording)
    startWithRecording!: boolean

  @Prop(TypeBoolean(), love.string.StartPrivate)
    startPrivate!: boolean

  @Prop(Collection(attachment.class.Attachment), attachment.string.Attachments, { shortLabel: attachment.string.Files })
    attachments?: number

  @Prop(PropCollection(chunter.class.ChatMessage), activity.string.Messages)
    messages?: number
}

@Model(love.class.Office, love.class.Room)
@UX(love.string.Office, love.icon.Love)
export class TOffice extends TRoom implements Office {
  @Prop(TypeRef(contact.mixin.Employee), contact.string.Employee)
  @Index(IndexKind.Indexed)
  @ReadOnly()
    person!: Ref<Employee> | null
}

@Model(love.class.Floor, core.class.Doc, DOMAIN_LOVE)
export class TFloor extends TDoc implements Floor {
  name!: string
}

@Model(love.class.ParticipantInfo, core.class.Doc, DOMAIN_TRANSIENT)
export class TParticipantInfo extends TDoc implements ParticipantInfo {
  name!: string
  @Prop(TypeRef(contact.class.Person), getEmbeddedLabel('Person'))
    person!: Ref<Person>

  @Prop(TypeRef(love.class.MeetingMinutes), love.string.MeetingMinutes)
    meeting!: Ref<MeetingMinutes>

  @Prop(TypeRef(love.class.Room), love.string.Room)
    room!: Ref<Room>

  x!: number
  y!: number

  kind!: 'user' | 'agent'

  sessionId!: string | null

  account!: AccountUuid | null
}

@Model(love.class.PendingRecording, core.class.AttachedDoc, DOMAIN_LOVE_PENDING)
export class TPendingRecording extends TAttachedDoc implements PendingRecording {
  @Prop(TypeRef(love.class.MeetingMinutes), love.string.MeetingMinutes)
  @Index(IndexKind.Indexed)
  declare attachedTo: Ref<MeetingMinutes>

  declare collection: 'recordings'

  egressId?: string

  @Prop(TypeString(), love.string.Recording)
    format!: RecordingFormat

  @Prop(TypeTimestamp(), love.string.MeetingStart)
    startedAt!: Timestamp

  roomName!: string

  @Prop(TypeString(), core.string.Name)
    name!: string

  @Prop(TypeNumber(), getEmbeddedLabel('Size'))
    size?: number

  @Prop(TypeString(), getEmbeddedLabel('Status'))
    status!: 'active' | 'cancelled' | 'completed'
}

@Model(love.class.DevicesPreference, preference.class.Preference)
export class TDevicesPreference extends TPreference implements DevicesPreference {
  blurRadius!: number
  noiseCancellation!: boolean
  micEnabled!: boolean
  camEnabled!: boolean
}

@Model(love.class.RoomInfo, core.class.Doc, DOMAIN_TRANSIENT)
export class TRoomInfo extends TDoc implements RoomInfo {
  persons!: Ref<Person>[]
  room!: Ref<Room>
  isOffice!: boolean
}

@Mixin(love.mixin.MeetingEventLink, calendar.class.Event)
export class TMeeting extends TEvent implements MeetingEventLink {
  room!: Ref<Room>
  meetingId!: Ref<MeetingMinutes>
}

@Model(love.class.MeetingMinutes, core.class.Space, DOMAIN_SPACE)
@UX(
  love.string.MeetingMinutes,
  love.icon.MeetingMinutes,
  undefined,
  'createdOn',
  undefined,
  love.string.MeetingsMinutes,
  'name'
)
export class TMeetingMinutes extends TSpace implements MeetingMinutes, Todoable {
  // From TSpace we inherit: name, description, private, archived, members, owners

  // Note: description in Space is CollaborativeDoc, but we need MarkupBlobRef
  // Use descriptionRef for MarkupBlobRef storage
  @Prop(TypeCollaborativeDoc(), core.string.Description)
  @Index(IndexKind.FullText)
    descriptionRef!: MarkupBlobRef | null

  @Prop(TypeCollaborativeDoc(), love.string.Summary)
  @Index(IndexKind.FullText)
    summary!: MarkupBlobRef | null

  @Prop(TypeRef(love.class.Room), love.string.Room)
  @Index(IndexKind.Indexed)
  @ReadOnly()
    roomId?: Ref<Room>

  @Prop(TypeAny(love.component.MeetingMinutesStatusPresenter, love.string.Status), love.string.Status, {
    editor: love.component.MeetingMinutesStatusPresenter
  })
  @ReadOnly()
    status!: MeetingStatus

  @Prop(
    TypeAny(love.component.MeetingMinutesTranscriptionStatePresenter, love.string.TranscriptionState),
    love.string.TranscriptionState,
    {
      editor: love.component.MeetingMinutesTranscriptionStatePresenter
    }
  )
  @ReadOnly()
    transcriptionState!: TranscriptionState

  @Prop(
    TypeAny(love.component.MeetingMinutesRecordingStatePresenter, love.string.RecordingState),
    love.string.RecordingState,
    {
      editor: love.component.MeetingMinutesRecordingStatePresenter
    }
  )
  @ReadOnly()
    recordingState!: RecordingState

  @Prop(Collection(attachment.class.Attachment), attachment.string.Attachments, { shortLabel: attachment.string.Files })
    attachments?: number

  @Prop(Collection(love.class.PendingRecording), love.string.Recording, {
    collectionEditor: love.component.PendingRecordingPresenter
  })
    recordings?: number

  @Prop(PropCollection(chunter.class.ChatMessage), love.string.Transcription)
    transcription?: number

  @Prop(PropCollection(chunter.class.ChatMessage), activity.string.Messages)
    messages?: number

  @Prop(TypeDate(DateRangeMode.DATETIME), love.string.MeetingStart, { editor: view.component.DateTimePresenter })
  @ReadOnly()
  @Index(IndexKind.IndexedDsc)
  declare createdOn: Timestamp

  @Prop(TypeDate(DateRangeMode.DATETIME), love.string.MeetingEnd, { editor: view.component.DateTimePresenter })
  @ReadOnly()
    meetingEnd?: Timestamp

  @Prop(Collection(time.class.ToDo), getEmbeddedLabel('Action Items'))
    todos?: CollectionSize<ToDo>

  language!: RoomLanguage

  @Prop(ArrOf(TypeAccountUuid()), love.string.Organizators)
  declare owners: AccountUuid[]
}

@Mixin(love.mixin.MeetingSchedule, calendar.class.Schedule)
export class TMeetingSchedule extends TSchedule implements MeetingSchedule {
  room!: Ref<Room>
  meetingId!: Ref<MeetingMinutes>
}

// Placeholder class so that the legacy `meeting-minutes` table is created/kept
// in the DB. Required to restore old backups that still ship this domain;
// the migration `meeting-minutes-to-space` then moves data into DOMAIN_SPACE.
@Model(love.class.LegacyMeetingMinutes, core.class.Doc, DOMAIN_MEETING_MINUTES)
export class TLegacyMeetingMinutes extends TDoc {}

@Model(love.class.UserMeetingInvite, core.class.Doc, DOMAIN_TRANSIENT)
@UX(love.string.MeetingRequest, love.icon.Invite)
export class TUserMeetingInvite extends TDoc implements UserMeetingInvite {
  @Prop(TypeString(), love.string.Kind)
  @Index(IndexKind.Indexed)
    kind!: 'invite-request' | 'invite-response'

  @Prop(TypeRef(contact.class.Person), love.string.From)
  @Index(IndexKind.Indexed)
    from!: Ref<Person>

  @Prop(TypeRef(contact.class.Person), love.string.To)
  @Index(IndexKind.Indexed)
    to!: Ref<Person>

  @Prop(TypeRef(love.class.MeetingMinutes), love.string.Meeting)
    meeting?: Ref<MeetingMinutes>

  @Prop(TypeRef(love.class.Room), love.string.Room)
    room?: Ref<Room>

  @Prop(TypeString(), love.string.Status)
    status!: 'pending' | 'accepted' | 'declined'

  @Prop(TypeString(), getEmbeddedLabel('AcceptedSessionId'))
  @Hidden()
    acceptedSessionId?: string

  @Prop(TypeString(), getEmbeddedLabel('SenderSessionId'))
  @Hidden()
    senderSessionId?: string
}

export default love

export function createModel (builder: Builder): void {
  builder.createModel(
    TRoom,
    TFloor,
    TOffice,
    TParticipantInfo,
    TPendingRecording,
    TDevicesPreference,
    TRoomInfo,
    TMeeting,
    TMeetingMinutes,
    TMeetingSchedule,
    TUserMeetingInvite,
    TLegacyMeetingMinutes
  )

  builder.createDoc(
    workbench.class.Application,
    core.space.Model,
    {
      label: love.string.Office,
      icon: love.icon.Love,
      alias: loveId,
      hidden: false,
      position: 'top',
      component: love.component.Main,
      order: 400
    },
    love.app.Love
  )

  builder.createDoc(
    workbench.class.Widget,
    core.space.Model,
    {
      label: love.string.Office,
      type: WidgetType.Fixed,
      icon: love.icon.Love,
      component: love.component.LoveWidget,
      accessLevel: AccountRole.DocGuest
    },
    love.ids.LoveWidget
  )

  builder.createDoc(
    workbench.class.Widget,
    core.space.Model,
    {
      label: love.string.Meeting,
      type: WidgetType.Flexible,
      icon: love.icon.Cam,
      component: love.component.MeetingWidget,
      switcherComponent: love.component.WidgetSwitcher
    },
    love.ids.MeetingWidget
  )

  builder.createDoc(presentation.class.ComponentPointExtension, core.space.Model, {
    extension: workbench.extensions.WorkbenchExtensions,
    component: love.component.WorkbenchExtension
  })

  builder.createDoc(presentation.class.DocCreateExtension, core.space.Model, {
    ofClass: calendar.class.Event,
    apply: love.function.CreateMeeting,
    components: {
      body: love.component.MeetingData
    }
  })

  builder.createDoc(presentation.class.ComponentPointExtension, core.space.Model, {
    extension: calendar.extensions.EditEventExtensions,
    component: love.component.EditMeetingData
  })

  builder.createDoc(presentation.class.DocCreateExtension, core.space.Model, {
    ofClass: calendar.class.Schedule,
    apply: love.function.CreateMeetingSchedule,
    components: {
      body: love.component.MeetingScheduleData
    }
  })

  builder.createDoc(presentation.class.ComponentPointExtension, core.space.Model, {
    extension: calendar.extensions.EditScheduleExtensions,
    component: love.component.EditMeetingScheduleData
  })

  builder.createDoc(presentation.class.ComponentPointExtension, core.space.Model, {
    extension: media.extension.StateContext,
    component: love.component.MediaPopupItemExt
  })

  builder.createDoc(presentation.class.ComponentPointExtension, core.space.Model, {
    extension: media.extension.StateIndicator,
    component: love.component.SharingStateIndicator
  })

  builder.createDoc(presentation.class.ComponentPointExtension, core.space.Model, {
    extension: media.extension.StateIndicator,
    component: love.component.SpeakingWhileMutedIndicator
  })

  builder.createDoc(
    setting.class.SettingsCategory,
    core.space.Model,
    {
      name: loveId,
      label: love.string.Office,
      icon: love.icon.Love,
      component: love.component.Settings,
      group: 'settings-account',
      role: AccountRole.Guest,
      feature: 'love',
      order: 1600
    },
    love.ids.Settings
  )

  builder.createDoc(
    notification.class.NotificationGroup,
    core.space.Model,
    {
      label: love.string.Office,
      icon: love.icon.Love
    },
    love.ids.LoveNotificationGroup
  )

  builder.createDoc(core.class.DomainIndexConfiguration, core.space.Model, {
    domain: DOMAIN_LOVE,
    disabled: [{ space: 1 }, { modifiedOn: 1 }, { modifiedBy: 1 }, { createdBy: 1 }, { createdOn: -1 }]
  })

  builder.createDoc(
    view.class.ActionCategory,
    core.space.Model,
    { label: love.string.Office, visible: true },
    love.category.Office
  )

  createAction(
    builder,
    {
      action: love.actionImpl.ToggleMic,
      label: love.string.Microphone,
      icon: love.icon.Mic,
      keyBinding: ['Meta + keyD'],
      category: love.category.Office,
      allowedForEditableContent: 'always',
      input: 'none',
      target: core.class.Doc,
      context: {
        mode: ['workbench', 'browser', 'panel', 'editor', 'input']
      }
    },
    love.action.ToggleMic
  )

  createAction(
    builder,
    {
      action: love.actionImpl.ToggleVideo,
      label: love.string.Camera,
      icon: love.icon.Cam,
      allowedForEditableContent: 'always',
      keyBinding: ['Meta + keyE'],
      category: love.category.Office,
      input: 'none',
      target: core.class.Doc,
      context: {
        mode: ['workbench', 'browser', 'panel', 'editor', 'input']
      }
    },
    love.action.ToggleVideo
  )

  createAction(builder, {
    action: love.actionImpl.CopyGuestLink,
    label: love.string.CopyGuestLink,
    icon: view.icon.Copy,
    category: love.category.Office,
    input: 'focus',
    target: love.class.MeetingMinutes,
    visibilityTester: love.function.CanCopyGuestLink,
    context: {
      mode: 'context'
    }
  })

  createAction(builder, {
    action: love.actionImpl.ShowRoomSettings,
    label: love.string.Settings,
    icon: view.icon.Setting,
    category: love.category.Office,
    input: 'focus',
    target: love.class.Room,
    visibilityTester: love.function.CanShowRoomSettings,
    context: {
      mode: 'context'
    }
  })

  createAction(builder, {
    action: love.actionImpl.ToggleRoomPrivacy,
    label: love.string.CloseRoom,
    icon: love.icon.DND,
    category: love.category.Office,
    input: 'focus',
    target: love.class.MeetingMinutes,
    visibilityTester: love.function.CanCloseRoom,
    context: {
      mode: 'context'
    }
  })

  createAction(builder, {
    action: love.actionImpl.ToggleRoomPrivacy,
    label: love.string.OpenRoom,
    icon: love.icon.Open,
    category: love.category.Office,
    input: 'focus',
    target: love.class.MeetingMinutes,
    visibilityTester: love.function.CanOpenRoom,
    context: {
      mode: 'context'
    }
  })

  builder.createDoc(activity.class.ActivityExtension, core.space.Model, {
    ofClass: love.class.Room,
    components: { input: { component: chunter.component.ChatMessageInput, props: { collection: 'messages' } } }
  })

  builder.createDoc(activity.class.ActivityExtension, core.space.Model, {
    ofClass: love.class.Office,
    components: { input: { component: chunter.component.ChatMessageInput, props: { collection: 'messages' } } }
  })

  builder.createDoc(activity.class.ActivityExtension, core.space.Model, {
    ofClass: love.class.MeetingMinutes,
    components: { input: { component: chunter.component.ChatMessageInput, props: { collection: 'messages' } } }
  })

  builder.mixin(love.class.MeetingMinutes, core.class.Class, activity.mixin.ActivityDoc, {})

  builder.mixin(love.class.Room, core.class.Class, activity.mixin.ActivityDoc, {})

  // Exclude PendingRecording from Activity feed - it should only appear in the recordings collection
  builder.mixin(love.class.PendingRecording, core.class.Class, activity.mixin.IgnoreActivity, {})

  builder.mixin(love.class.MeetingMinutes, core.class.Class, view.mixin.ObjectPresenter, {
    presenter: love.component.MeetingMinutesPresenter
  })

  builder.mixin(love.class.Room, core.class.Class, view.mixin.ObjectPresenter, {
    presenter: love.component.RoomPresenter
  })

  builder.mixin(love.class.Room, core.class.Class, view.mixin.AttributePresenter, {
    presenter: love.component.RoomAttributePresenter
  })

  builder.mixin(love.class.MeetingMinutes, core.class.Class, view.mixin.CollectionEditor, {
    editor: love.component.MeetingMinutesSection
  })

  builder.mixin(love.class.MeetingMinutes, core.class.Class, view.mixin.ObjectTitle, {
    titleProvider: love.function.MeetingMinutesTitleProvider
  })

  builder.mixin(love.class.UserMeetingInvite, core.class.Class, view.mixin.ObjectTitle, {
    titleProvider: love.function.UserMeetingInviteTitleProvider
  })

  builder.mixin(love.class.UserMeetingInvite, core.class.Class, core.mixin.TransientTTL, {
    ttl: 30
  })

  builder.mixin(love.class.Room, core.class.Class, view.mixin.ObjectEditor, {
    editor: love.component.EditRoom
  })

  builder.mixin(love.class.MeetingMinutes, core.class.Class, view.mixin.ObjectEditor, {
    editor: love.component.EditMeetingMinutes
  })

  builder.mixin(love.class.Floor, core.class.Class, view.mixin.AttributeEditor, {
    inlineEditor: love.component.FloorAttributePresenter
  })

  builder.mixin(love.class.MeetingMinutes, core.class.Class, view.mixin.ClassFilters, {
    filters: ['status', 'owners', 'members', 'roomId', 'private', 'createdOn', 'meetingEnd'],
    ignoreKeys: ['description', 'summary', 'transcription', 'messages', 'attachments', 'recordings']
  })

  builder.mixin(love.class.Room, core.class.Class, view.mixin.ClassFilters, {
    filters: ['language'],
    ignoreKeys: ['floor', 'width', 'height', 'x', 'y', 'type', 'access']
  })

  const hideArchivedOption: ViewOptionModel = {
    key: 'hideArchived',
    type: 'toggle',
    defaultValue: true,
    actionTarget: 'options',
    action: view.function.HideArchived,
    label: view.string.HideArchived
  }

  builder.createDoc(
    view.class.Viewlet,
    core.space.Model,
    {
      attachTo: love.class.MeetingMinutes,
      descriptor: view.viewlet.Table,
      config: [
        '',
        { key: 'status', presenter: love.component.MeetingMinutesStatusPresenter, label: love.string.Status },
        {
          key: '',
          label: activity.string.Messages,
          presenter: love.component.MeetingMinutesMessagesPresenter,
          displayProps: { key: 'messages', suffix: true }
        },
        {
          key: '',
          label: love.string.Transcription,
          presenter: love.component.MeetingMinutesTranscriptionPresenter,
          displayProps: { key: 'transcription', suffix: true }
        },
        { key: 'members', props: { noJoin: true } },
        { key: 'private', displayProps: { key: 'private', suffix: true } },
        'createdOn',
        'meetingEnd'
      ],
      configOptions: {
        hiddenKeys: ['description'],
        sortable: true
      },
      viewOptions: {
        groupBy: [],
        orderBy: [
          ['modifiedOn', SortingOrder.Descending],
          ['meetingStart', SortingOrder.Descending],
          ['meetingEnd', SortingOrder.Descending],
          ['createdOn', SortingOrder.Descending]
        ],
        other: [hideArchivedOption, showColorsViewOption]
      },
      options: {}
    },
    love.viewlet.TableMeetingMinutes
  )

  builder.createDoc(
    view.class.Viewlet,
    core.space.Model,
    {
      attachTo: love.class.MeetingMinutes,
      descriptor: view.viewlet.Table,
      config: [
        '',
        { key: 'status', presenter: love.component.MeetingMinutesStatusPresenter, label: love.string.Status },
        {
          key: '',
          label: activity.string.Messages,
          presenter: love.component.MeetingMinutesMessagesPresenter,
          displayProps: { key: 'messages', suffix: true }
        },
        {
          key: '',
          label: love.string.Transcription,
          presenter: love.component.MeetingMinutesTranscriptionPresenter,
          displayProps: { key: 'transcription', suffix: true }
        },
        'createdOn',
        'meetingEnd'
      ],
      configOptions: {
        hiddenKeys: ['description'],
        sortable: true
      },
      viewOptions: {
        groupBy: [],
        orderBy: [
          ['modifiedOn', SortingOrder.Descending],
          ['meetingStart', SortingOrder.Descending],
          ['meetingEnd', SortingOrder.Descending],
          ['createdOn', SortingOrder.Descending]
        ],
        other: [hideArchivedOption, showColorsViewOption]
      },
      variant: 'embedded'
    },
    love.viewlet.TableMeetingMinutesEmbedded
  )

  builder.createDoc(
    view.class.ViewletDescriptor,
    core.space.Model,
    {
      label: love.string.Floor,
      icon: love.icon.Love,
      component: love.component.FloorView
    },
    love.viewlet.FloorDescriptor
  )

  builder.createDoc(
    view.class.ViewletDescriptor,
    core.space.Model,
    {
      label: love.string.MeetingMinutes,
      icon: view.icon.Table,
      component: love.component.MeetingMinutesTable
    },
    love.viewlet.MeetingMinutesDescriptor
  )

  builder.createDoc(
    view.class.Viewlet,
    core.space.Model,
    {
      attachTo: love.class.Floor,
      descriptor: love.viewlet.FloorDescriptor,
      config: []
    },
    love.viewlet.Floor
  )

  builder.createDoc(
    view.class.Viewlet,
    core.space.Model,
    {
      attachTo: love.class.Floor,
      descriptor: love.viewlet.MeetingMinutesDescriptor,
      config: []
    },
    love.viewlet.FloorMeetingMinutes
  )

  // ListMeetingMinutesDescriptor — used for Floor-switcher third viewlet
  builder.createDoc(
    view.class.ViewletDescriptor,
    core.space.Model,
    {
      label: love.string.MeetingMinutesList,
      icon: view.icon.List,
      component: love.component.FloorMeetingMinutesList
    },
    love.viewlet.ListMeetingMinutesDescriptor
  )

  // 3rd Floor-switcher viewlet: List of MeetingMinutes by rooms on the floor.
  builder.createDoc(
    view.class.Viewlet,
    core.space.Model,
    {
      attachTo: love.class.Floor,
      descriptor: love.viewlet.ListMeetingMinutesDescriptor,
      config: []
    },
    love.viewlet.FloorMeetingMinutesListViewlet
  )

  builder.createDoc(
    view.class.Viewlet,
    core.space.Model,
    {
      attachTo: love.class.MeetingMinutes,
      descriptor: view.viewlet.List,
      viewOptions: {
        groupBy: ['roomId', 'status', 'createdBy'],
        orderBy: [
          ['modifiedOn', SortingOrder.Descending],
          ['meetingStart', SortingOrder.Descending],
          ['meetingEnd', SortingOrder.Descending],
          ['createdOn', SortingOrder.Descending]
        ],
        other: [hideArchivedOption, showColorsViewOption]
      },
      configOptions: {
        strict: true,
        hiddenKeys: ['description', 'summary', 'attachments', 'recordings']
      },
      config: [
        {
          key: '',
          label: love.string.MeetingMinutes,
          displayProps: { fixed: 'left', key: 'name' }
        },
        {
          key: 'status',
          presenter: love.component.MeetingMinutesStatusPresenter,
          label: love.string.Status,
          displayProps: { key: 'status' }
        },
        {
          key: '',
          label: activity.string.Messages,
          presenter: love.component.MeetingMinutesMessagesPresenter,
          displayProps: { key: 'messages', suffix: true }
        },
        {
          key: '',
          label: love.string.Transcription,
          presenter: love.component.MeetingMinutesTranscriptionPresenter,
          displayProps: { key: 'transcription', suffix: true }
        },
        { key: '', displayProps: { grow: true } },
        {
          key: 'members',
          props: { noJoin: true, kind: 'link', size: 'small' },
          displayProps: { key: 'members', compression: true }
        },
        {
          key: 'createdOn',
          displayProps: { key: 'createdOn', fixed: 'right', dividerBefore: true }
        },
        {
          key: 'meetingEnd',
          displayProps: { key: 'meetingEnd', fixed: 'right' }
        }
      ]
    },
    love.viewlet.ListMeetingMinutes
  )

  // TableRooms descriptor and viewlet
  builder.createDoc(
    view.class.ViewletDescriptor,
    core.space.Model,
    {
      label: love.string.RoomsTable,
      icon: view.icon.Table,
      component: love.component.RoomsView
    },
    love.viewlet.TableRoomsDescriptor
  )

  builder.createDoc(
    view.class.Viewlet,
    core.space.Model,
    {
      attachTo: love.class.Room,
      descriptor: love.viewlet.TableRoomsDescriptor,
      viewOptions: {
        groupBy: [],
        orderBy: [
          ['name', SortingOrder.Ascending],
          ['modifiedOn', SortingOrder.Descending]
        ],
        other: []
      },
      configOptions: {
        hiddenKeys: ['description'],
        sortable: true
      },
      config: [{ key: '', presenter: love.component.RoomTablePresenter }, 'members']
    },
    love.viewlet.TableRooms
  )

  // ListRooms descriptor and viewlet
  builder.createDoc(
    view.class.ViewletDescriptor,
    core.space.Model,
    {
      label: love.string.RoomsList,
      icon: view.icon.List,
      component: love.component.RoomsView
    },
    love.viewlet.ListRoomsDescriptor
  )

  builder.createDoc(
    view.class.Viewlet,
    core.space.Model,
    {
      attachTo: love.class.Room,
      descriptor: love.viewlet.ListRoomsDescriptor,
      viewOptions: {
        groupBy: ['floor'],
        orderBy: [
          ['name', SortingOrder.Ascending],
          ['modifiedOn', SortingOrder.Descending]
        ],
        other: []
      },
      configOptions: {
        strict: true,
        hiddenKeys: ['description']
      },
      config: [{ key: '', presenter: love.component.RoomListItem }, 'members']
    },
    love.viewlet.ListRooms
  )

  builder.createDoc<MessageNotificationType>(
    notification.class.MessageNotificationType,
    core.space.Model,
    {
      label: chunter.string.Chat,
      generated: false,
      hidden: false,
      messageClass: chunter.class.ChatMessage,
      objectClass: chunter.class.ChatMessage,
      attachedToClass: love.class.MeetingMinutes,
      match: {
        collection: 'messages'
      },
      defaultEnabled: false,
      group: love.ids.LoveNotificationGroup
    },
    love.ids.MeetingMinutesChatNotification
  )

  builder.createDoc<TxNotificationType>(
    notification.class.TxNotificationType,
    core.space.Model,
    {
      label: love.string.Invite,
      generated: false,
      hidden: true,
      objectClass: love.class.UserMeetingInvite,
      txClasses: [],
      defaultEnabled: true,
      group: love.ids.LoveNotificationGroup,
      isMention: true
    },
    love.ids.InviteNotification
  )

  builder.createDoc(notification.class.NotificationProviderDefaults, core.space.Model, {
    provider: notification.providers.InboxNotificationProvider,
    ignoredTypes: [],
    enabledTypes: [love.ids.MeetingMinutesChatNotification]
  })

  builder.createDoc(notification.class.NotificationProviderDefaults, core.space.Model, {
    provider: notification.providers.PushNotificationProvider,
    ignoredTypes: [],
    enabledTypes: [love.ids.MeetingMinutesChatNotification]
  })

  // defineCollaborators(builder, love.class.MeetingMinutes, { fields: ['createdBy'], provideSecurity: true })

  builder.mixin(love.class.Room, core.class.Class, core.mixin.IndexConfiguration, {
    indexes: [],
    searchDisabled: true
  })

  builder.mixin(love.class.Office, core.class.Class, core.mixin.IndexConfiguration, {
    indexes: [],
    searchDisabled: true
  })

  builder.mixin(love.class.Floor, core.class.Class, core.mixin.IndexConfiguration, {
    indexes: [],
    searchDisabled: true
  })

  // ObjectEditorFooter for Room and Office to show meetings at the bottom
  builder.mixin(love.class.Room, core.class.Class, view.mixin.ObjectEditorFooter, {
    editor: love.component.RoomMeetingsFooter
  })

  builder.mixin(love.class.Office, core.class.Class, view.mixin.ObjectEditorFooter, {
    editor: love.component.RoomMeetingsFooter
  })

  builder.createDoc(core.class.FullTextSearchContext, core.space.Model, {
    toClass: love.class.MeetingMinutes,
    fullTextSummary: true,
    forceIndex: true
  })

  builder.createDoc(
    presentation.class.ObjectSearchCategory,
    core.space.Model,
    {
      icon: love.icon.MeetingMinutes,
      label: love.string.SearchMeetingMinutes,
      title: love.string.MeetingMinutes,
      query: love.completion.MeetingMinutesQuery,
      context: ['search', 'mention', 'spotlight'],
      classToSearch: love.class.MeetingMinutes,
      priority: 600
    },
    love.completion.MeetingMinutesCategory
  )

  // Extensions
  builder.createDoc(presentation.class.ComponentPointExtension, core.space.Model, {
    extension: contact.extension.EmployeePopupActions,
    component: love.component.InviteEmployeeButton
  })

  builder.createDoc(presentation.class.ComponentPointExtension, core.space.Model, {
    extension: view.extensions.EditDocPreTitleExtension,
    component: love.component.MeetingMinutesBreadcrumb
  })

  createAttributePresenter(
    builder,
    view.component.DateTimePresenter,
    love.class.MeetingMinutes,
    'createdOn',
    'attribute'
  )
  createAttributePresenter(
    builder,
    view.component.DateTimePresenter,
    love.class.MeetingMinutes,
    'meetingEnd',
    'attribute'
  )

  builder.createDoc(
    contact.class.SocialIdentityProvider,
    core.space.Model,
    {
      label: love.string.Office,
      icon: love.icon.Love,
      type: SocialIdType.LOVE
    },
    love.socialIdentityProvider.Love
  )
}
