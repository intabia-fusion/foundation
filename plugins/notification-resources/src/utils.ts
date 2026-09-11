//
// Copyright © 2020, 2021 Anticrm Platform Contributors.
// Copyright © 2021, 2022 Hardcore Engineering Inc.
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
import activity, { type ActivityMessage } from '@hcengineering/activity'
import { isActivityMessageClass, messageInFocus } from '@hcengineering/activity-resources'
import { Analytics } from '@hcengineering/analytics'
import chunter, { type ThreadMessage } from '@hcengineering/chunter'
import { type Class, type Doc, type Ref } from '@hcengineering/core'
import {
  type DocNotifyContext,
  notificationId,
  type ContextNotification,
  type NotificationMessage
} from '@hcengineering/notification'
import { getResource } from '@hcengineering/platform'
import { getClient } from '@hcengineering/presentation'
import {
  getCurrentLocation,
  getLocation,
  type Location,
  locationStorageKeyId,
  navigate,
  type ResolvedLocation
} from '@hcengineering/ui'
import view, { decodeObjectURI, encodeObjectURI, type LinkIdProvider } from '@hcengineering/view'
import { getObjectLinkId, parseLinkId } from '@hcengineering/view-resources'
import type { LocationData } from '@hcengineering/workbench'

export async function resolveLocation (loc: Location): Promise<ResolvedLocation | undefined> {
  if (loc.path[2] !== notificationId) {
    return undefined
  }

  const [_id, _class] = decodeObjectURI(loc.path[3])

  if (_id === undefined || _class === undefined) {
    return {
      loc: {
        path: [loc.path[0], loc.path[1], notificationId],
        fragment: undefined
      },
      defaultLocation: {
        path: [loc.path[0], loc.path[1], notificationId],
        fragment: undefined
      }
    }
  }

  return await generateLocation(loc, _id, _class)
}

async function generateLocation (
  loc: Location,
  _id: string,
  _class: Ref<Class<Doc>>
): Promise<ResolvedLocation | undefined> {
  const client = getClient()

  const appComponent = loc.path[0] ?? ''
  const workspace = loc.path[1] ?? ''
  const threadId = loc.path[4] as Ref<ActivityMessage> | undefined

  const thread =
    threadId !== undefined ? await client.findOne(activity.class.ActivityMessage, { _id: threadId }) : undefined

  if (thread === undefined) {
    return {
      loc: {
        path: [appComponent, workspace, notificationId, encodeObjectURI(_id, _class)],
        fragment: undefined,
        query: { ...loc.query }
      },
      defaultLocation: {
        path: [appComponent, workspace, notificationId, encodeObjectURI(_id, _class)],
        fragment: undefined,
        query: { ...loc.query }
      }
    }
  }

  return {
    loc: {
      path: [appComponent, workspace, notificationId, encodeObjectURI(_id, _class), threadId as string],
      fragment: undefined,
      query: { ...loc.query }
    },
    defaultLocation: {
      path: [appComponent, workspace, notificationId, encodeObjectURI(_id, _class), threadId as string],
      fragment: undefined,
      query: { ...loc.query }
    }
  }
}

let navigateToInboxDocToken = 0

async function navigateToInboxDoc (
  providers: LinkIdProvider[],
  context: Ref<DocNotifyContext>,
  _id?: Ref<Doc>,
  _class?: Ref<Class<Doc>>,
  thread?: Ref<ActivityMessage>,
  message?: Ref<ActivityMessage>
): Promise<void> {
  const token = ++navigateToInboxDocToken
  const loc = getLocation()

  if (loc.path[2] !== notificationId) {
    return
  }

  if (_id === undefined || _class === undefined) {
    resetInboxContext()
    return
  }

  loc.path[3] = encodeObjectURI(_id, _class)

  if (thread !== undefined) {
    loc.path[4] = thread
    loc.path.length = 5
    const fn = await getResource(chunter.function.OpenThreadInSidebar)
    if (token !== navigateToInboxDocToken) return
    void fn(thread, undefined, undefined, message, { autofocus: false })
  } else {
    loc.path[4] = ''
    loc.path.length = 4
  }

  loc.query = { ...loc.query, context, message: message ?? null }
  messageInFocus.set(message)
  Analytics.handleEvent('inbox.ReadDoc', { objectId: _id, objectClass: _class, thread, message })
  navigate(loc)

  const provider = providers.find(({ _id }) => _id === _class)
  if (provider !== undefined) {
    void getObjectLinkId(providers, _id, _class).then((resolvedId) => {
      if (token !== navigateToInboxDocToken) return
      if (resolvedId !== _id) {
        const currentLoc = getCurrentLocation()
        if (currentLoc.path[2] === notificationId && currentLoc.path[3] === encodeObjectURI(_id, _class)) {
          currentLoc.path[3] = encodeObjectURI(resolvedId, _class)
          navigate(currentLoc, true)
        }
      }
    })
  }
}

export function resetInboxContext (): void {
  const loc = getLocation()

  if (loc.path[2] !== notificationId) {
    return
  }

  loc.query = { message: null }
  loc.path.length = 3

  localStorage.setItem(`${locationStorageKeyId}_${notificationId}`, JSON.stringify(loc))

  navigate(loc)
}

export async function selectInboxContext (
  linkProviders: LinkIdProvider[],
  context: DocNotifyContext,
  notification?: ContextNotification
): Promise<void> {
  const client = getClient()
  const hierarchy = client.getHierarchy()
  const { objectId, objectClass } = context
  const loc = getCurrentLocation()
  const selectedMsg = notification?.type !== 'common' ? notification?.messageId : undefined
  const object = await client.findOne(objectClass, { _id: objectId })

  if (notification?.type === 'mention' && notification.messageId != null) {
    await navigateToInboxDoc(
      linkProviders,
      context._id,
      objectId,
      objectClass,
      isActivityMessageClass(objectClass) ? (objectId as Ref<ActivityMessage>) : undefined,
      selectedMsg
    )
    return
  }
  if (notification?.type === 'reaction') {
    const thread = loc.path[4] === objectId ? objectId : undefined
    const reactedTo = notification.message
    const isThread = reactedTo != null && hierarchy.isDerived(reactedTo._class, chunter.class.ThreadMessage)
    const channelId = isThread ? (reactedTo as NotificationMessage<ThreadMessage>)?.objectId : objectId
    const channelClass = isThread ? (reactedTo as NotificationMessage<ThreadMessage>)?.objectClass : objectClass

    await navigateToInboxDoc(
      linkProviders,
      context._id,
      channelId,
      channelClass,
      thread as Ref<ActivityMessage>,
      objectId as Ref<ActivityMessage>
    )
    return
  }

  if (hierarchy.isDerived(objectClass, activity.class.ActivityMessage)) {
    if (objectClass === chunter.class.ThreadMessage) {
      const thread =
        object?._id === objectId
          ? (object as ThreadMessage)
          : await client.findOne(
            chunter.class.ThreadMessage,
            {
              _id: objectId as Ref<ThreadMessage>
            },
            { projection: { _id: 1, attachedTo: 1 } }
          )

      await navigateToInboxDoc(
        linkProviders,
        context._id,
        thread?.objectId ?? objectId,
        thread?.objectClass ?? objectClass,
        thread?.attachedTo,
        thread?._id
      )
      return
    }

    const thread = selectedMsg !== objectId ? objectId : loc.path[4] === objectId ? objectId : undefined
    const channelId = (object as ActivityMessage)?.attachedTo ?? objectId
    const channelClass = (object as ActivityMessage)?.attachedToClass ?? objectClass

    await navigateToInboxDoc(
      linkProviders,
      context._id,
      channelId,
      channelClass,
      thread as Ref<ActivityMessage>,
      selectedMsg ?? (objectId as Ref<ActivityMessage>)
    )
    return
  }

  await navigateToInboxDoc(linkProviders, context._id, objectId, objectClass, undefined, selectedMsg)
}

export async function locationDataResolver (loc: Location): Promise<LocationData> {
  const client = getClient()

  try {
    const [id, _class] = decodeObjectURI(loc.path[3])
    const linkProviders = client.getModel().findAllSync(view.mixin.LinkIdProvider, {})
    const _id: Ref<Doc> | undefined = await parseLinkId(linkProviders, id, _class)

    return {
      objectId: _id,
      objectClass: _class
    }
  } catch (e) {
    return {}
  }
}
