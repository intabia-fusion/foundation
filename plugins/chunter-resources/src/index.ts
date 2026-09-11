//
// Copyright © 2020 Anticrm Platform Contributors.
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

import { type ActivityMessage } from '@hcengineering/activity'
import { type Channel, type ChatMessage } from '@hcengineering/chunter'
import { type Resources } from '@hcengineering/platform'
import { MessageBox, getClient } from '@hcengineering/presentation'
import { getLocation, navigate, showPopup } from '@hcengineering/ui'
import { get, writable } from 'svelte/store'
import notification, { type NotificationAppearancePreference } from '@hcengineering/notification'
import { NotificationClientImpl } from '@hcengineering/notification-resources'

import chunter from './plugin'

import ChannelCreatedMessage from './components/activity/ChannelCreatedMessage.svelte'
import MembersChangedMessage from './components/activity/MembersChangedMessage.svelte'
import ChannelHeader from './components/ChannelHeader.svelte'
import ChannelIcon from './components/ChannelIcon.svelte'
import ChannelPanel from './components/ChannelPanel.svelte'
import ChannelPresenter from './components/ChannelPresenter.svelte'
import ChannelPreview from './components/ChannelPreview.svelte'
import ChatMessageInput from './components/chat-message/ChatMessageInput.svelte'
import ChatMessagePresenter from './components/chat-message/ChatMessagePresenter.svelte'
import ChatMessagePreview from './components/chat-message/ChatMessagePreview.svelte'
import ChatMessagesPresenter from './components/chat-message/ChatMessagesPresenter.svelte'
import Chat from './components/chat/Chat.svelte'
import CreateChannel from './components/chat/create/CreateChannel.svelte'
import CreateDirectChat from './components/chat/create/CreateDirectChat.svelte'
import ChunterBrowser from './components/chat/specials/ChunterBrowser.svelte'
import SavedMessages from './components/chat/specials/SavedMessages.svelte'
import DirectIcon from './components/DirectIcon.svelte'
import DmHeader from './components/DmHeader.svelte'
import DmPresenter from './components/DmPresenter.svelte'
import EditChannel from './components/EditChannel.svelte'
import ChatMessageNotificationLabel from './components/notification/ChatMessageNotificationLabel.svelte'
import JoinChannelNotificationPresenter from './components/notification/JoinChannelNotificationPresenter.svelte'
import ThreadNotificationPresenter from './components/notification/ThreadNotificationPresenter.svelte'
import ThreadMessagePresenter from './components/threads/ThreadMessagePresenter.svelte'
import ThreadMessagePreview from './components/threads/ThreadMessagePreview.svelte'
import ThreadParentPresenter from './components/threads/ThreadParentPresenter.svelte'
import Threads from './components/threads/Threads.svelte'
import ThreadView from './components/threads/ThreadView.svelte'
import ThreadViewPanel from './components/threads/ThreadViewPanel.svelte'
import ChatWidget from './components/ChatWidget.svelte'
import ChatWidgetTab from './components/ChatWidgetTab.svelte'
import WorkbenchTabExtension from './components/WorkbenchTabExtension.svelte'
import AIChatButton from './components/AIChatButton.svelte'
import DirectMessageButton from './components/DirectMessageButton.svelte'
import EmployeePresenter from './components/ChunterEmployeePresenter.svelte'
import InlineCommentThread from './components/inline-comment/InlineCommentThread.svelte'
import ChannelsAndDMs from './components/chat/specials/ChannelsAndDMs.svelte'
import ForwardMessageDialog from './components/ForwardMessageDialog.svelte'

import {
  chunterSpaceLinkFragmentProvider,
  closeChatWidgetTab,
  getMessageLink,
  getMessageLocation,
  getThreadLink,
  locationDataResolver,
  openChannelInSidebar,
  openThreadInSidebar,
  replyToThread
} from './navigation'
import {
  ChannelTitleProvider,
  DirectTitleProvider,
  canCopyMessageLink,
  canDeleteMessage,
  canReplyToThread,
  getDmName,
  getTitle,
  getUnreadThreadsCount,
  translateMessage,
  showOriginalMessage,
  canTranslateMessage,
  startConversationAction,
  summarizeMessages,
  canSummarizeMessages,
  DirectLabelProvider,
  forwardMessage,
  replyToMessage,
  openDirectForPerson,
  CommentsApplier
} from './utils'
import DeleteMessageConfirmationPopup from './components/DeleteMessageConfirmationPopup.svelte'

export { default as ChannelEmbeddedContent } from './components/ChannelEmbeddedContent.svelte'
export { default as ChatMessageInput } from './components/chat-message/ChatMessageInput.svelte'
export { default as ChatMessageInputLite } from './components/chat-message/ChatMessageInputLite.svelte'
export { default as ChatMessagePopup } from './components/chat-message/ChatMessagePopup.svelte'
export { default as ChatMessagesPresenter } from './components/chat-message/ChatMessagesPresenter.svelte'
export { default as Header } from './components/Header.svelte'
export { default as ThreadView } from './components/threads/ThreadView.svelte'

export async function ArchiveChannel (channel: Channel, evt: any, props?: { afterArchive?: () => void }): Promise<void> {
  showPopup(MessageBox, {
    label: chunter.string.ArchiveChannel,
    message: chunter.string.ArchiveConfirm,
    richMessage: true,
    action: async () => {
      const client = getClient()

      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      await client.update(channel, { archived: true })
      if (props?.afterArchive != null) props.afterArchive()

      const loc = getLocation()
      if (loc.path[3] === channel._id) {
        loc.path.length = 3
        navigate(loc)
      }
    }
  })
}

async function UnarchiveChannel (channel: Channel): Promise<void> {
  showPopup(MessageBox, {
    label: chunter.string.UnarchiveChannel,
    message: chunter.string.UnarchiveConfirm,
    action: async () => {
      const client = getClient()
      await client.update(channel, { archived: false })
    }
  })
}

export const userSearch = writable('')

export async function chunterBrowserVisible (): Promise<boolean> {
  return false
}

export function chatMessagesFilter (message: ActivityMessage): boolean {
  return message._class === chunter.class.ChatMessage
}

export async function deleteChatMessage (message: ChatMessage): Promise<void> {
  showPopup(
    DeleteMessageConfirmationPopup,
    {
      message
    },
    'center'
  )
}

export { replyToThread } from './navigation'

export default async (): Promise<Resources> => ({
  filter: {
    ChatMessagesFilter: chatMessagesFilter
  },
  component: {
    CreateChannel,
    CreateDirectChat,
    ThreadParentPresenter,
    ThreadViewPanel,
    ChannelHeader,
    ChannelPanel,
    ChannelPresenter,
    ChannelPreview,
    ChunterBrowser,
    DmHeader,
    DmPresenter,
    EditChannel,
    ThreadView,
    SavedMessages,
    ChatMessagePresenter,
    ChatMessageInput,
    ChatMessagesPresenter,
    Chat,
    ThreadMessagePresenter,
    Threads,
    DirectIcon,
    ChannelIcon,
    ChatMessageNotificationLabel,
    ThreadNotificationPresenter,
    ThreadMessagePreview,
    ChatMessagePreview,
    JoinChannelNotificationPresenter,
    ChatWidget,
    ChatWidgetTab,
    AIChatButton,
    WorkbenchTabExtension,
    DirectMessageButton,
    EmployeePresenter,
    InlineCommentThread,
    ChannelsAndDMs,
    ForwardMessageDialog
  },
  activity: {
    ChannelCreatedMessage,
    MembersChangedMessage
  },
  function: {
    CommentsApplier,
    GetDmName: getDmName,
    ChunterBrowserVisible: chunterBrowserVisible,
    GetFragment: getTitle,
    GetLink: getMessageLink,
    DirectTitleProvider,
    DirectLabelProvider,
    ChannelTitleProvider,
    CanDeleteMessage: canDeleteMessage,
    CanCopyMessageLink: canCopyMessageLink,
    GetChunterSpaceLinkFragment: chunterSpaceLinkFragmentProvider,
    GetUnreadThreadsCount: getUnreadThreadsCount,
    GetThreadLink: getThreadLink,
    ReplyToThread: replyToThread,
    CanReplyToThread: canReplyToThread,
    GetMessageLink: getMessageLocation,
    CloseChatWidgetTab: closeChatWidgetTab,
    OpenChannelInSidebar: openChannelInSidebar,
    OpenDirectForPerson: openDirectForPerson,
    CanTranslateMessage: canTranslateMessage,
    CanSummarizeMessages: canSummarizeMessages,
    OpenThreadInSidebar: openThreadInSidebar,
    LocationDataResolver: locationDataResolver,
    ShowNotifyMarkerFn: async (
      unreadCount: number,
      preference?: NotificationAppearancePreference
    ): Promise<boolean> => {
      if (preference?.showChatBadge === false) return false
      if (unreadCount === 0) return false

      const notificationClient = NotificationClientImpl.getClient()
      const loadedContexts = Array.from(get(notificationClient.contextById).values())

      if (loadedContexts.some((ctx) => (ctx?.unreadMessages?.length ?? 0) > 0)) return true

      const client = getClient()
      const context = await client.findOne(notification.class.DocNotifyContext, {
        unreadMessages: { $size: { $gt: 0 } }
      })

      return context != null
    }
  },
  actionImpl: {
    ArchiveChannel,
    UnarchiveChannel,
    DeleteChatMessage: deleteChatMessage,
    ReplyToThread: replyToThread,
    TranslateMessage: translateMessage,
    SummarizeMessages: summarizeMessages,
    ShowOriginalMessage: showOriginalMessage,
    StartConversation: startConversationAction,
    ReplyToMessage: replyToMessage,
    ForwardMessage: forwardMessage
  }
})
