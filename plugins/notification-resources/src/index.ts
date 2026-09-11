//
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
//

import { type Resources } from '@hcengineering/platform'

import Inbox from './components/inbox/Inbox.svelte'
import NotificationSettings from './components/settings/NotificationSettings.svelte'
import NotificationPresenter from './components/NotificationPresenter.svelte'
import DocNotifyContextPresenter from './components/DocNotifyContextPresenter.svelte'
import CollaboratorsChanged from './components/activity/CollaboratorsChanged.svelte'
import GeneralPreferencesGroup from './components/settings/GeneralPreferencesGroup.svelte'
import WebpushesPreferencesPresenter from './components/settings/WebpushesPreferencesPresenter.svelte'
import MutePopup from './components/MutePopup.svelte'
import NotificationAppearancePreferencesPresenter from './components/settings/NotificationAppearancePreferencesPresenter.svelte'

import { resolveLocation, locationDataResolver } from './utils'

import { NotificationClientImpl } from './client'
import {
  canReadNotifyContext,
  clearAll,
  editDocNotificationsAction,
  editDocNotificationsVisibilityTester,
  readAll,
  readNotifyContext,
  removeDocNotifyContext,
  unsubscribe
} from './actions'
import { checkPermission } from './webpush'

export * from './utils'
export * from './client'
export * from './stores'
export * from './actions'
export * from './appPush'

export { default as AppNotificator } from './components/AppNotificator.svelte'
export { default as NotifyMarker } from './components/NotifyMarker.svelte'
export { default as MutePopup } from './components/MutePopup.svelte'

export default async (): Promise<Resources> => ({
  component: {
    Inbox,
    NotificationPresenter,
    NotificationSettings,
    CollaboratorsChanged,
    DocNotifyContextPresenter,
    GeneralPreferencesGroup,
    WebpushesPreferencesPresenter,
    MutePopup,
    NotificationAppearancePreferencesPresenter
  },
  function: {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    GetNotificationsClient: NotificationClientImpl.getClient,
    CanReadNotifyContext: canReadNotifyContext,
    CheckWebPushPermission: checkPermission,
    LocationDataResolver: locationDataResolver,
    EditDocNotificationsVisibilityTester: editDocNotificationsVisibilityTester
  },
  actionImpl: {
    Unsubscribe: unsubscribe,
    ReadNotifyContext: readNotifyContext,
    RemoveDocNotifyContext: removeDocNotifyContext,
    ClearAll: clearAll,
    ReadAll: readAll,
    EditDocNotifications: editDocNotificationsAction
  },
  resolver: {
    Location: resolveLocation
  }
})
