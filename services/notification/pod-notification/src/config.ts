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

interface Config {
  Source: string
  PushSubject?: string
  PushPublicKey?: string
  PushPrivateKey?: string

  QueueConfig: string
  QueueRegion: string

  ServiceId: string

  // APNs: a .p8 key from a paid Apple team; free provisioning issues no push
  // entitlement. ApnsTopic is the app bundle id.
  ApnsKeyId?: string
  ApnsTeamId?: string
  ApnsKey?: string
  ApnsTopic?: string
  ApnsProduction: boolean

  // FCM: the service-account JSON, verbatim.
  FcmServiceAccount?: string

  TTL: number

  AccountsUrl: string
  Secret: string
}

const envMap: { [key in keyof Required<Config>]: string } = {
  Source: 'SOURCE',
  PushPublicKey: 'PUSH_PUBLIC_KEY',
  PushPrivateKey: 'PUSH_PRIVATE_KEY',
  PushSubject: 'PUSH_SUBJECT',
  TTL: 'TTL',
  QueueConfig: 'QUEUE_CONFIG',
  QueueRegion: 'QUEUE_REGION',
  ServiceId: 'SERVICE_ID',
  AccountsUrl: 'ACCOUNTS_URL',
  Secret: 'SECRET',
  ApnsKeyId: 'APNS_KEY_ID',
  ApnsTeamId: 'APNS_TEAM_ID',
  ApnsKey: 'APNS_KEY',
  ApnsTopic: 'APNS_TOPIC',
  ApnsProduction: 'APNS_PRODUCTION',
  FcmServiceAccount: 'FCM_SERVICE_ACCOUNT'
}

const parseNumber = (str: string | undefined): number | undefined => {
  if (str === undefined) return undefined
  const num = Number(str)
  return isNaN(num) ? undefined : num
}

const config: Config = (() => {
  const params: Partial<Config> = {
    Source: process.env[envMap.Source],
    PushPublicKey: process.env[envMap.PushPublicKey],
    PushPrivateKey: process.env[envMap.PushPrivateKey],
    PushSubject: process.env[envMap.PushSubject],
    TTL: parseNumber(process.env[envMap.TTL] ?? '86400') ?? 86400, // default to 24 hours (86400 seconds)
    QueueConfig: process.env[envMap.QueueConfig],
    QueueRegion: process.env[envMap.QueueRegion],
    ServiceId: process.env[envMap.ServiceId] ?? 'web-push-service',
    AccountsUrl: process.env[envMap.AccountsUrl],
    Secret: process.env[envMap.Secret],
    ApnsKeyId: process.env[envMap.ApnsKeyId],
    ApnsTeamId: process.env[envMap.ApnsTeamId],
    // The .p8 body travels through env, where a real newline cannot: \n is the
    // usual way to carry a PEM, and createPrivateKey needs it restored.
    ApnsKey: process.env[envMap.ApnsKey]?.replace(/\\n/g, '\n'),
    ApnsTopic: process.env[envMap.ApnsTopic],
    ApnsProduction: process.env[envMap.ApnsProduction] !== 'false',
    FcmServiceAccount: process.env[envMap.FcmServiceAccount]
  }

  const required: Array<keyof Config> = ['Source', 'AccountsUrl', 'Secret']

  const missingEnv = required.filter((key) => params[key] === undefined).map((key) => envMap[key])

  if (missingEnv.length > 0) {
    throw Error(`Missing env variables: ${missingEnv.join(', ')}`)
  }

  return params as Config
})()

export default config
