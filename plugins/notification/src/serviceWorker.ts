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

import type { PushData } from './index'

declare const self: any

interface PushEvent extends Event {
  data: PushMessageData
  waitUntil: (promise: Promise<any>) => void
}

interface PushMessageData {
  json: () => PushData
}

self.addEventListener('push', (event: PushEvent) => {
  const payload: PushData = event.data.json()
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: payload.icon,
      tag: payload.tag,
      data: {
        domain: payload.domain,
        url: payload.url,
        notificationId: payload.tag
      }
    })
  )
})

async function handleNotificationClick (event: any): Promise<void> {
  event.notification.close()
  const clickedNotification = event.notification
  const notificationData = clickedNotification.data
  const notificationId = notificationData.notificationId
  const notificationUrl = notificationData.url
  const domain = notificationData.domain

  if (notificationUrl !== undefined && domain !== undefined) {
    const windowClients = (await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    })) as ReadonlyArray<any>

    const targetUrl = new URL(notificationUrl)
    for (const client of windowClients) {
      const clientUrl = new URL(client.url, self.location.href)
      if (decodeURI(clientUrl.pathname) === targetUrl.pathname) {
        client.postMessage({
          type: 'notification-click',
          url: notificationUrl,
          _id: notificationId
        })
        await client.focus()
        return
      }
    }

    for (const client of windowClients) {
      if ((client.url as string)?.startsWith(domain)) {
        client.postMessage({
          type: 'notification-click',
          url: notificationUrl,
          _id: notificationId
        })
        await client.focus()
        return
      }
    }

    console.log('No matching client found')
    // If no client with the same URL origin is found, open a new window/tab
    await self.clients.openWindow(notificationUrl)
  }
}

self.addEventListener('notificationclick', (e: any) => e.waitUntil(handleNotificationClick(e)))

self.addEventListener('install', (event: any) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event: any) => {
  event.waitUntil(self.clients.claim())
})
