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

import { type PushData } from '@hcengineering/notification'
import { createPrivateKey, sign } from 'crypto'
import { connect, constants, type ClientHttp2Session } from 'http2'
import config from './config'

/**
 * A native client has no service worker, so it cannot produce a Web Push
 * subscription: Apple hands out `web.push.apple.com` endpoints to Safari only,
 * and Android has no equivalent at all. Both platforms give a device token
 * instead, and it is carried in the same `PushSubscription.endpoint` field
 * under a scheme of its own - the model and the trigger stay untouched.
 */
export enum PushKind {
  Web = 'web',
  Apns = 'apns',
  Fcm = 'fcm'
}

export type PushTarget =
  | { kind: PushKind.Web }
  | { kind: PushKind.Apns, token: string }
  | { kind: PushKind.Fcm, token: string }

export function pushTarget (endpoint: string): PushTarget {
  for (const kind of [PushKind.Apns, PushKind.Fcm]) {
    const scheme = `${kind}://`
    if (endpoint.startsWith(scheme)) return { kind, token: endpoint.slice(scheme.length) }
  }
  return { kind: PushKind.Web }
}

/** A delivery outcome; `Gone` means the token is dead and its subscription must go. */
export enum Delivery {
  Ok = 'ok',
  Gone = 'gone',
  Error = 'error'
}

export function apnsConfigured (): boolean {
  return config.ApnsKeyId !== undefined && config.ApnsTeamId !== undefined && config.ApnsKey !== undefined
}

export function fcmConfigured (): boolean {
  return config.FcmServiceAccount !== undefined
}

const base64url = (value: string | Buffer): string =>
  (typeof value === 'string' ? Buffer.from(value) : value).toString('base64url')

function jwt (header: object, claims: object, key: string, format: 'ieee-p1363' | 'der'): string {
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`
  const signature = sign('sha256', Buffer.from(input), { key: createPrivateKey(key), dsaEncoding: format })
  return `${input}.${base64url(signature)}`
}

// Apple rejects a token refreshed more often than once in 20 minutes and expires
// it after an hour, so the window below sits between the two.
let apnsToken: { value: string, born: number } | undefined
const APNS_TOKEN_TTL = 40 * 60 * 1000

function apnsAuth (): string {
  const now = Date.now()
  if (apnsToken !== undefined && now - apnsToken.born < APNS_TOKEN_TTL) return apnsToken.value
  const value = jwt(
    { alg: 'ES256', kid: config.ApnsKeyId },
    { iss: config.ApnsTeamId, iat: Math.floor(now / 1000) },
    config.ApnsKey as string,
    'ieee-p1363'
  )
  apnsToken = { value, born: now }
  return value
}

let apnsSession: ClientHttp2Session | undefined

function apnsConnect (): ClientHttp2Session {
  if (apnsSession !== undefined && !apnsSession.closed && !apnsSession.destroyed) return apnsSession
  const host = config.ApnsProduction ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com'
  const session = connect(host)
  // Without a handler an unreachable APNs takes the process down with it.
  session.on('error', (err) => {
    console.error('APNs session error', err)
  })
  apnsSession = session
  return session
}

/**
 * An alert push, not a silent one: waking a sleeping phone is the whole point,
 * and `content-available` alone is throttled into "sometime later" by iOS.
 */
export async function sendApns (token: string, data: PushData): Promise<Delivery> {
  const payload = JSON.stringify({
    aps: {
      alert: { title: data.title, body: data.body },
      sound: 'default',
      'thread-id': data.tag,
      'mutable-content': 1
    },
    url: data.url,
    domain: data.domain,
    tag: data.tag
  })

  return await new Promise<Delivery>((resolve) => {
    let request
    try {
      request = apnsConnect().request({
        [constants.HTTP2_HEADER_METHOD]: 'POST',
        [constants.HTTP2_HEADER_PATH]: `/3/device/${token}`,
        [constants.HTTP2_HEADER_AUTHORIZATION]: `bearer ${apnsAuth()}`,
        'apns-topic': config.ApnsTopic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(Math.floor(Date.now() / 1000) + config.TTL)
      })
    } catch (err) {
      console.error('APNs request failed', err)
      resolve(Delivery.Error)
      return
    }

    let status = 0
    let body = ''
    request.on('response', (headers) => {
      status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0)
    })
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('error', (err) => {
      console.error('APNs stream error', err)
      resolve(Delivery.Error)
    })
    request.on('end', () => {
      if (status === 200) {
        resolve(Delivery.Ok)
        return
      }
      // 410 is a token Apple has retired; the 400 reasons below mean it never
      // belonged here. Everything else may be transient, so the subscription stays.
      const dead = ['Unregistered', 'BadDeviceToken', 'DeviceTokenNotForTopic']
      resolve(status === 410 || dead.some((reason) => body.includes(reason)) ? Delivery.Gone : Delivery.Error)
    })
    request.end(payload)
  })
}

// FCM authorizes with a service-account JWT exchanged for an access token; the
// legacy server key was switched off by Google in 2024.
let fcmToken: { value: string, expires: number } | undefined

interface ServiceAccount {
  project_id: string
  client_email: string
  private_key: string
}

function serviceAccount (): ServiceAccount {
  return JSON.parse(config.FcmServiceAccount as string)
}

async function fcmAuth (): Promise<string> {
  const now = Date.now()
  if (fcmToken !== undefined && now < fcmToken.expires) return fcmToken.value
  const account = serviceAccount()
  const issued = Math.floor(now / 1000)
  const assertion = jwt(
    { alg: 'RS256', typ: 'JWT' },
    {
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: issued,
      exp: issued + 3600
    },
    account.private_key,
    'der'
  )
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  })
  if (!response.ok) {
    throw new Error(`FCM token request failed: ${response.status} ${await response.text()}`)
  }
  const granted = await response.json()
  fcmToken = { value: granted.access_token, expires: now + (granted.expires_in - 60) * 1000 }
  return fcmToken.value
}

/**
 * `notification` rather than a data-only message on purpose: with it Android
 * draws the banner itself while the process is asleep, so nothing has to run
 * on the device for the push to arrive.
 */
export async function sendFcm (token: string, data: PushData): Promise<Delivery> {
  try {
    const account = serviceAccount()
    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await fcmAuth()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title: data.title, body: data.body },
          data: {
            ...(data.url !== undefined ? { url: data.url } : {}),
            ...(data.domain !== undefined ? { domain: data.domain } : {}),
            ...(data.tag !== undefined ? { tag: data.tag } : {})
          },
          android: { priority: 'HIGH', ttl: `${config.TTL}s`, notification: { tag: data.tag } }
        }
      })
    })
    if (response.ok) return Delivery.Ok
    const body = await response.text()
    // 404 is FCM's UNREGISTERED - the app was uninstalled or the token rotated.
    return response.status === 404 || body.includes('UNREGISTERED') || body.includes('INVALID_ARGUMENT')
      ? Delivery.Gone
      : Delivery.Error
  } catch (err) {
    console.error('FCM send failed', err)
    return Delivery.Error
  }
}
