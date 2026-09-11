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

import { AccountUuid, Doc, TxCUD } from '@hcengineering/core'

import { Result, TxCache } from '../types'

export function emptyResult (): Result {
  return {
    updateContextTx: [],
    createContextTx: [],
    createAppPushNotificationTx: [],

    queueMessages: [],

    createUserMentionInfoTx: [],
    updateUserMentionInfoTx: [],
    removeUserMentionInfoTx: []
  }
}

export function getResultTxes (result: Result): TxCUD<Doc>[] {
  return [
    ...result.createContextTx,
    ...result.updateContextTx,
    ...result.createUserMentionInfoTx,
    ...result.updateUserMentionInfoTx,
    ...result.removeUserMentionInfoTx,
    ...result.createAppPushNotificationTx
  ].sort((a, b) => a.modifiedOn - b.modifiedOn)
}

export function isEmptyResult (result: Result): boolean {
  return (
    result.updateContextTx.length === 0 &&
    result.createContextTx.length === 0 &&
    result.createAppPushNotificationTx.length === 0 &&
    result.queueMessages.length === 0 &&
    result.createUserMentionInfoTx.length === 0 &&
    result.updateUserMentionInfoTx.length === 0 &&
    result.removeUserMentionInfoTx.length === 0
  )
}

export function getNotifiedUsers (result: Result): AccountUuid[] {
  return result.queueMessages.map((it) => it.account)
}

export function getEmptyTxCache (): TxCache {
  return {
    titleByDoc: new Map(),
    urlByDoc: new Map(),
    labelByDoc: new Map(),
    identifierByDoc: new Map(),
    iconByDoc: new Map(),
    templates: new Map()
  }
}
