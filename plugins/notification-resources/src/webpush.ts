/**
 Copyright © 2026 Intabia Fusion.

 Licensed under the Eclipse Public License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License. You may
 obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

 See the License for the specific language governing permissions and
 limitations under the License.
 */

import { writable } from 'svelte/store'
import { getClient } from '@hcengineering/presentation'
import { getMetadata } from '@hcengineering/platform'
import notification from '@hcengineering/notification'
import { getCurrentLocation, navigate, parseLocation } from '@hcengineering/ui'
import core, { getCurrentAccount } from '@hcengineering/core'

export const pushAllowed = writable<boolean>(false)

export function pushAvailable (): boolean {
  const publicKey = getMetadata(notification.metadata.PushPublicKey)
  return (
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    publicKey !== undefined &&
    'Notification' in window &&
    Notification.permission !== 'denied'
  )
}
export async function checkPermission (value: boolean): Promise<boolean> {
  if (!value) return true
  if ('serviceWorker' in navigator && 'PushManager' in window) {
    try {
      const loc = getCurrentLocation()
      const registration = await navigator.serviceWorker.getRegistration(`/${loc.path[0]}/${loc.path[1]}`)
      if (registration !== undefined) {
        const current = await registration.pushManager.getSubscription()
        const res = current !== null
        pushAllowed.set(current !== null)
        void registration.update()
        addWorkerListener()
        return res
      }
    } catch {
      pushAllowed.set(false)
      return false
    }
  }
  pushAllowed.set(false)
  return false
}

export type PushSubscribeResult = 'success' | 'permission_denied' | 'network_error' | 'not_supported'

export async function subscribePush (): Promise<PushSubscribeResult> {
  const client = getClient()
  const publicKey = getMetadata(notification.metadata.PushPublicKey)
  if ('serviceWorker' in navigator && 'PushManager' in window && publicKey !== undefined) {
    try {
      const loc = getCurrentLocation()
      let registration = await navigator.serviceWorker.getRegistration(`/${loc.path[0]}/${loc.path[1]}`)
      if (registration !== undefined) {
        await registration.update()
      } else {
        registration = await navigator.serviceWorker.register('/serviceWorker.js', {
          scope: `/${loc.path[0]}/${loc.path[1]}`
        })
      }
      const current = await registration.pushManager.getSubscription()
      if (current == null) {
        const permission = await Notification.requestPermission()
        if (permission !== 'granted') {
          return 'permission_denied'
        }
        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: publicKey
        })
        await client.createDoc(notification.class.PushSubscription, core.space.Workspace, {
          user: getCurrentAccount().uuid,
          endpoint: subscription.endpoint,
          keys: {
            p256dh: arrayBufferToBase64(subscription.getKey('p256dh')),
            auth: arrayBufferToBase64(subscription.getKey('auth'))
          },
          name: navigator.userAgent
        })
      } else {
        const exists = await client.findOne(notification.class.PushSubscription, {
          user: getCurrentAccount().uuid,
          endpoint: current.endpoint
        })
        if (exists === undefined) {
          await client.createDoc(notification.class.PushSubscription, core.space.Workspace, {
            user: getCurrentAccount().uuid,
            endpoint: current.endpoint,
            keys: {
              p256dh: arrayBufferToBase64(current.getKey('p256dh')),
              auth: arrayBufferToBase64(current.getKey('auth'))
            },
            name: navigator.userAgent
          })
        }
      }
      addWorkerListener()
      pushAllowed.set(true)
      return 'success'
    } catch (err) {
      const error = err as Error
      console.error('Service Worker registration failed:', error)
      pushAllowed.set(false)
      if (error?.name === 'AbortError') return 'network_error'
      if (error?.name === 'NotAllowedError') return 'permission_denied'
      return 'network_error'
    }
  }
  pushAllowed.set(false)
  return 'not_supported'
}

export function parseUserAgent (userAgent: string): string {
  const browsers = [
    { name: 'Edge', pattern: /Edg\/[\d.]+/ },
    { name: 'Opera', pattern: /OPR\/[\d.]+/ },
    { name: 'Chrome', pattern: /CriOS\/[\d.]+|Chrome\/[\d.]+/ },
    { name: 'Firefox', pattern: /FxiOS\/[\d.]+|Firefox\/[\d.]+/ },
    { name: 'Safari', pattern: /Safari\/[\d.]+/ }
  ]

  const os = [
    { name: 'Windows', pattern: /Windows/ },
    { name: 'Mac', pattern: /Macintosh/ },
    { name: 'Linux', pattern: /Linux/ },
    { name: 'Android', pattern: /Android/ },
    { name: 'iOS', pattern: /iPhone|iPad/ }
  ]

  const browser = browsers.find(({ pattern }) => pattern.test(userAgent))?.name ?? 'Unknown browser'
  const system = os.find(({ pattern }) => pattern.test(userAgent))?.name ?? 'Unknown OS'

  return `${browser} on ${system}`
}

function arrayBufferToBase64 (buffer: ArrayBuffer | null): string {
  if (buffer != null) {
    const bytes = new Uint8Array(buffer)
    const array = Array.from(bytes)
    const binary = String.fromCharCode.apply(null, array)
    return btoa(binary)
  } else {
    return ''
  }
}

function addWorkerListener (): void {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data !== undefined && event.data.type === 'notification-click') {
      const { url, _id } = event.data
      if (url !== undefined) {
        navigate(parseLocation(new URL(url)))
      }
      if (_id !== undefined) {
        void cleanTag(_id)
      }
    }
  })
}

async function cleanTag (tag: string): Promise<void> {
  const client = getClient()
  const notifications = await client.findAll(notification.class.AppPushNotification, {
    tag
  })
  for (const notification of notifications) {
    await client.remove(notification)
  }
}
