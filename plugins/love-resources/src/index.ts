import { getMetadata, type Resources } from '@hcengineering/platform'
import aiBot from '@hcengineering/ai-bot'
import { AccountRole, getCurrentAccount, hasAccountRole, type AccountUuid } from '@hcengineering/core'
import { type MeetingMinutes } from '@hcengineering/love'
import { getCurrentEmployee } from '@hcengineering/contact'
import { getPersonByPersonRef } from '@hcengineering/contact-resources'

import ControlExt from './components/meeting/ControlExt.svelte'
import InvitesExt from './components/meeting/invites/InvitesExt.svelte'
import EditMeetingData from './components/EditMeetingData.svelte'
import Main from './components/Main.svelte'
import MeetingData from './components/MeetingData.svelte'
import SelectScreenSourcePopup from './components/SelectScreenSourcePopup.svelte'
import Settings from './components/Settings.svelte'
import WorkbenchExtension from './components/WorkbenchExtension.svelte'
import LoveWidget from './components/LoveWidget.svelte'
import MeetingWidget from './components/meeting/widget/MeetingWidget.svelte'
import WidgetSwitcher from './components/meeting/widget/WidgetSwitcher.svelte'
import MeetingMinutesPresenter from './components/MeetingMinutesPresenter.svelte'
import MeetingMinutesSection from './components/MeetingMinutesSection.svelte'
import EditMeetingMinutes from './components/EditMeetingMinutes.svelte'
import EditRoom from './components/EditRoom.svelte'
import FloorAttributePresenter from './components/FloorAttributePresenter.svelte'
import FloorView from './components/FloorView.svelte'
import MeetingMinutesTable from './components/MeetingMinutesTable.svelte'
import FloorMeetingMinutesList from './components/FloorMeetingMinutesList.svelte'
import RoomAttributePresenter from './components/RoomAttributePresenter.svelte'
import MeetingMinutesMessagesPresenter from './components/MeetingMinutesMessagesPresenter.svelte'
import MeetingMinutesTranscriptionPresenter from './components/MeetingMinutesTranscriptionPresenter.svelte'
import RoomPresenter from './components/RoomPresenter.svelte'
import MeetingMinutesDocEditor from './components/MeetingMinutesDocEditor.svelte'
import MeetingMinutesStatusPresenter from './components/MeetingMinutesStatusPresenter.svelte'
import MeetingMinutesTranscriptionStatePresenter from './components/MeetingMinutesTranscriptionStatePresenter.svelte'
import MeetingMinutesRecordingStatePresenter from './components/MeetingMinutesRecordingStatePresenter.svelte'
import RoomLanguageEditor from './components/RoomLanguageEditor.svelte'
import MediaPopupItemExt from './components/MediaPopupItemExt.svelte'
import SharingStateIndicator from './components/SharingStateIndicator.svelte'
import SpeakingWhileMutedIndicator from './components/meeting/SpeakingWhileMutedIndicator.svelte'
import MeetingScheduleData from './components/MeetingScheduleData.svelte'
import EditMeetingScheduleData from './components/EditMeetingScheduleData.svelte'
import InviteEmployeeButton from './components/meeting/invites/InviteEmployeeButton.svelte'
import PendingRecordingPresenter from './components/PendingRecordingPresenter.svelte'
import GuestMeetingApp from './components/guest/GuestMeetingApp.svelte'
import RoomMeetingsFooter from './components/RoomMeetingsFooter.svelte'
import MeetingMinutesBreadcrumb from './components/MeetingMinutesBreadcrumb.svelte'
import MeetingMinutesView from './components/MeetingMinutesView.svelte'
import MeetingMinutesListItem from './components/MeetingMinutesListItem.svelte'
import RoomsView from './components/RoomsView.svelte'
import RoomTablePresenter from './components/RoomTablePresenter.svelte'
import RoomListItem from './components/RoomListItem.svelte'

import {
  copyGuestLink,
  createMeeting,
  createMeetingSchedule,
  showRoomSettings,
  startTranscription,
  stopTranscription,
  getMeetingMinutesTitle,
  queryMeetingMinutes,
  getUserMeetingInviteTitle,
  toggleRoomPrivacy
} from './utils'
import { toggleMicState, toggleCamState } from '@hcengineering/media-resources'

function canShowRoomSettings (): boolean | undefined {
  if (!hasAccountRole(getCurrentAccount(), AccountRole.User)) {
    return undefined
  }
  // For now settings is available only when AI bot is enabled
  const url = getMetadata(aiBot.metadata.EndpointURL) ?? ''
  return url !== ''
}

function canCopyGuestLink (): boolean {
  return hasAccountRole(getCurrentAccount(), AccountRole.User)
}

async function isRoomOwner (mm?: MeetingMinutes): Promise<boolean> {
  if (mm === undefined) return false
  const me = getCurrentEmployee()
  const currentPerson = await getPersonByPersonRef(me)
  const myAccount = currentPerson?.personUuid as AccountUuid | undefined
  return myAccount !== undefined ? (mm.owners?.includes(myAccount) ?? false) : false
}

async function canCloseRoom (mm?: MeetingMinutes): Promise<boolean> {
  if (mm === undefined || mm.private) return false
  return await isRoomOwner(mm)
}

async function canOpenRoom (mm?: MeetingMinutes): Promise<boolean> {
  if (mm?.private !== true) return false
  return await isRoomOwner(mm)
}

export { setCustomCreateScreenTracks } from './utils'

export default async (): Promise<Resources> => ({
  component: {
    Main,
    ControlExt,
    InvitesExt,
    Settings,
    WorkbenchExtension,
    SelectScreenSourcePopup,
    MeetingData,
    EditMeetingData,
    LoveWidget,
    MeetingWidget,
    WidgetSwitcher,
    MeetingMinutesPresenter,
    MeetingMinutesSection,
    EditMeetingMinutes,
    EditRoom,
    FloorAttributePresenter,
    FloorView,
    MeetingMinutesTable,
    FloorMeetingMinutesList,
    RoomAttributePresenter,
    MeetingMinutesMessagesPresenter,
    MeetingMinutesTranscriptionPresenter,
    RoomPresenter,
    MeetingMinutesDocEditor,
    MeetingMinutesStatusPresenter,
    MeetingMinutesTranscriptionStatePresenter,
    MeetingMinutesRecordingStatePresenter,
    RoomLanguageEditor,
    MediaPopupItemExt,
    SharingStateIndicator,
    SpeakingWhileMutedIndicator,
    MeetingScheduleData,
    EditMeetingScheduleData,
    InviteEmployeeButton,
    PendingRecordingPresenter,
    GuestMeetingApp,
    RoomMeetingsFooter,
    MeetingMinutesBreadcrumb,
    MeetingMinutesView,
    MeetingMinutesListItem,
    RoomsView,
    RoomTablePresenter,
    RoomListItem
  },
  function: {
    CreateMeeting: createMeeting,
    CreateMeetingSchedule: createMeetingSchedule,
    CanShowRoomSettings: canShowRoomSettings,
    CanCopyGuestLink: canCopyGuestLink,
    CanCloseRoom: canCloseRoom,
    CanOpenRoom: canOpenRoom,
    MeetingMinutesTitleProvider: getMeetingMinutesTitle,
    UserMeetingInviteTitleProvider: getUserMeetingInviteTitle
  },
  actionImpl: {
    ToggleMic: toggleMicState,
    ToggleVideo: toggleCamState,
    StartTranscribing: startTranscription,
    StopTranscribing: stopTranscription,
    ShowRoomSettings: showRoomSettings,
    CopyGuestLink: copyGuestLink,
    ToggleRoomPrivacy: toggleRoomPrivacy
  },
  completion: {
    MeetingMinutesQuery: queryMeetingMinutes
  }
})
