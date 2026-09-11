/* eslint-disable import/first */
//
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
//

import { writable } from 'svelte/store'

const eventListeners: Record<string, any> = {}
const g = globalThis as any

// Setup global mocks before importing notifications module
g.__mockAppPushStore = writable<any[]>([])
g.__mockActivePreferences = writable<any>({ showNotifications: true, playSound: true })
g.__mockCrossWorkspaceNotificationStore = writable<any>(null)
g.__mockWorkspacesStore = writable<any>([])
g.__mockLocation = writable<any>({ path: ['workbenchId'] })
g.__mockLanguageStore = writable<string>('en')
g.__mockElectronAPI = {
  sendNotification: jest.fn(),
  dockBounce: jest.fn(),
  setBadge: jest.fn(),
  setTitle: jest.fn()
}

// Compact mocks of external modules
jest.mock('@hcengineering/platform', () => ({
  addEventListener: (event: string, cb: any) => {
    eventListeners[event] = cb
  },
  translate: jest.fn(async (key) => key)
}))
jest.mock('@hcengineering/workbench', () => ({
  // TypeScript 6 emits the __importDefault helper, which only unwraps `default`
  // on modules flagged as ES modules; without this a default import gets the
  // whole mock object instead of its `default`.
  __esModule: true,
  default: { event: { NotifyConnection: 'NotifyConnection', NotifyTitle: 'NotifyTitle' } },
  workbenchId: 'workbenchId'
}))
jest.mock('../../ui/typesUtils', () => ({ ipcMainExposed: () => g.__mockElectronAPI }))
jest.mock('@hcengineering/notification-resources', () => ({
  NotificationClientImpl: { getClient: () => ({ totalUnreadCount: { subscribe: jest.fn() } }) },
  appPushStore: g.__mockAppPushStore,
  removeAppPush: jest.fn(),
  desktopPushEnabled: { set: jest.fn() }
}))
jest.mock('@hcengineering/desktop-preferences-resources', () => ({ activePreferences: g.__mockActivePreferences }))
jest.mock('@hcengineering/workbench-resources', () => ({
  crossWorkspaceNotificationStore: g.__mockCrossWorkspaceNotificationStore,
  workspacesStore: g.__mockWorkspacesStore
}))
jest.mock('@hcengineering/ui', () => ({
  location: g.__mockLocation,
  languageStore: g.__mockLanguageStore
}))
jest.mock('@hcengineering/notification', () => ({
  __esModule: true,
  default: { string: {} },
  notificationId: 'notificationId',
  truncate: (str: string) => {
    return str
  },
  translateNotification: async (push: any) => ({ title: `Title: ${push.titleIntl}`, body: `Body: ${push.bodyIntl}` })
}))
jest.mock('@hcengineering/desktop-preferences', () => ({ defaultNotificationPreference: { showNotifications: true } }))
jest.mock('@hcengineering/presentation', () => ({ getCurrentWorkspaceUuid: () => 'workspace-1' }))

// Now import configureNotifications and mocked functions
import { removeAppPush } from '@hcengineering/notification-resources'

import { configureNotifications } from '../../ui/notifications'

describe('configureNotifications', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    g.__mockAppPushStore.set([])
  })

  it('handles app pushes and sends notifications with correct parameters', async () => {
    configureNotifications()

    const notifyConnectionCallback = eventListeners.NotifyConnection
    expect(notifyConnectionCallback).toBeDefined()
    await notifyConnectionCallback()

    const mockPushes = [
      {
        _id: 'push-1',
        titleIntl: 'Push 1 Title',
        bodyIntl: 'Push 1 Body',
        soundAlert: true,
        onClickLocation: 'location-1'
      },
      {
        _id: 'push-2',
        titleIntl: 'Push 2 Title',
        bodyIntl: 'Push 2 Body',
        soundAlert: false,
        onClickLocation: 'location-2'
      }
    ]

    g.__mockAppPushStore.set(mockPushes)
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Verify correct notification parameters are sent to desktop
    expect(g.__mockElectronAPI.sendNotification).toHaveBeenCalledWith({
      silent: false,
      application: 'notificationId',
      title: 'Title: Push 1 Title',
      body: 'Body: Push 1 Body',
      onClickLocation: 'location-1'
    })
    expect(g.__mockElectronAPI.sendNotification).toHaveBeenCalledWith({
      silent: false,
      application: 'notificationId',
      title: 'Title: Push 2 Title',
      body: 'Body: Push 2 Body',
      onClickLocation: 'location-2'
    })

    // Verify notifications are cleaned up/removed
    expect(removeAppPush).toHaveBeenCalledWith(mockPushes[0])
    expect(removeAppPush).toHaveBeenCalledWith(mockPushes[1])
  })

  it('does not send notification if preferences showNotifications is false', async () => {
    configureNotifications()
    const notifyConnectionCallback = eventListeners.NotifyConnection
    await notifyConnectionCallback()

    // Disable desktop notifications
    g.__mockActivePreferences.set({ showNotifications: false })

    const mockPush = {
      _id: 'push-3',
      titleIntl: 'Title 3',
      bodyIntl: 'Body 3',
      soundAlert: true,
      onClickLocation: 'location-3'
    }

    g.__mockAppPushStore.set([mockPush])
    await new Promise((resolve) => setTimeout(resolve, 0))

    // DB entry should still be cleaned up, but no OS notification displayed
    expect(removeAppPush).toHaveBeenCalledWith(mockPush)
    expect(g.__mockElectronAPI.sendNotification).not.toHaveBeenCalled()
  })
})
