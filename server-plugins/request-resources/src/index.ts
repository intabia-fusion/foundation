//
// Copyright © 2022 Hardcore Engineering Inc.
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

import core, {
  Doc,
  Tx,
  TxCUD,
  TxCreateDoc,
  TxProcessor,
  TxUpdateDoc,
  Ref,
  combineAttributes
} from '@hcengineering/core'
import { NotificationType } from '@hcengineering/notification'
import { translate } from '@hcengineering/platform'
import request, { Request, RequestStatus } from '@hcengineering/request'
import type { TriggerControl } from '@hcengineering/server-core'
import {
  CreateTxNotificationFunc,
  CreateNotificationResult,
  Receiver,
  TypeMatchClient,
  TypeMatchFunc
} from '@hcengineering/server-notification'
import { Employee } from '@hcengineering/contact'
import { StringPresenterFn, PresenterControl, getDocTitle } from '@hcengineering/server-activity'

/**
 * @public
 */
export async function OnRequest (txes: TxCUD<Doc>[], control: TriggerControl): Promise<Tx[]> {
  const hierarchy = control.hierarchy
  const ltxes = txes.filter((it) => hierarchy.isDerived(it.objectClass, request.class.Request))

  let res: Tx[] = []

  for (const ptx of ltxes) {
    if (ptx._class === core.class.TxUpdateDoc) {
      res = res.concat(await OnRequestUpdate(ptx as TxUpdateDoc<Request>, control))
    }
  }

  return res
}

async function OnRequestUpdate (ctx: TxUpdateDoc<Request>, control: TriggerControl): Promise<Tx[]> {
  const applyTxes: Tx[] = []

  if (ctx.operations.$push?.approved !== undefined) {
    const request = (await control.findAll(control.ctx, ctx.objectClass, { _id: ctx.objectId }))[0]

    if (request.approved.length === request.requiredApprovesCount) {
      const collectionTx = control.txFactory.createTxUpdateDoc(ctx.objectClass, ctx.objectSpace, ctx.objectId, {
        status: RequestStatus.Completed
      })
      collectionTx.space = core.space.Tx
      const resTx = control.txFactory.createTxCollectionCUD(
        ctx.attachedToClass ?? ctx.objectClass,
        ctx.attachedTo ?? ctx.objectId,
        ctx.objectSpace,
        'requests',
        collectionTx
      )
      resTx.space = core.space.Tx

      applyTxes.push(resTx)
      applyTxes.push(request.tx)
    }

    const approvedDateTx = control.txFactory.createTxCollectionCUD(
      ctx.attachedToClass ?? ctx.objectClass,
      ctx.attachedTo ?? ctx.objectId,
      ctx.objectSpace,
      'requests',
      control.txFactory.createTxUpdateDoc(ctx.objectClass, ctx.objectSpace, ctx.objectId, {
        $push: { approvedDates: Date.now() }
      })
    )
    applyTxes.push(approvedDateTx)
  }

  if (ctx.operations.status === RequestStatus.Rejected) {
    const request = (await control.findAll(control.ctx, ctx.objectClass, { _id: ctx.objectId }))[0]
    if (request.rejectedTx != null) {
      applyTxes.push(request.rejectedTx)
    }
  }

  if (applyTxes.length > 0) {
    await control.apply(control.ctx, applyTxes)
  }

  return []
}

const requestTitlePresenter: StringPresenterFn = async (doc: Doc, control: PresenterControl): Promise<string> => {
  const request = doc as Request
  const title = await translate(control.hierarchy.getClass(request._class).label, {}, control.branding?.defaultLanguage)

  const attachedDoc = (
    await control.findAll(control.ctx, request.attachedToClass, { _id: request.attachedTo }, { limit: 1 })
  )[0]
  if (attachedDoc == null) return title

  const attachedDocText = await getDocTitle(control, attachedDoc)

  return attachedDocText != null && attachedDocText !== '' ? `${title} — ${attachedDocText}` : title
}

export const sendRequestMatch: TypeMatchFunc = async (
  _client: TypeMatchClient,
  _type: NotificationType,
  _typeObject: Doc,
  _doc: Doc,
  receiver: Receiver
): Promise<boolean> => {
  const tx = _typeObject as TxCreateDoc<Request> | TxUpdateDoc<Request>
  if (tx._class === core.class.TxCreateDoc) {
    const createTx = tx as TxCreateDoc<Request>
    const request = TxProcessor.createDoc2Doc(createTx)

    return request.requested.includes(receiver.employeeRef)
  } else if (tx._class === core.class.TxUpdateDoc) {
    const updateTx = tx as TxUpdateDoc<Request>
    const pushed: Ref<Employee>[] = combineAttributes([updateTx.operations], 'requested', '$push', '$each') ?? []

    return pushed.includes(receiver.employeeRef)
  }

  return false
}

export const sendRequestCreateNotification: CreateTxNotificationFunc = async (
  client: TypeMatchClient,
  _tx: TxCUD<Doc>,
  attachedToDoc: Doc | undefined,
  object: Doc,
  _receiver: Receiver
): Promise<CreateNotificationResult | undefined> => {
  if (attachedToDoc == null) return undefined

  const req = object as Request
  const clazz = client.hierarchy.getClass(req._class)

  return {
    notification: {
      icon: clazz.icon,
      messageIntl: request.string.NewRequestNotification
    },
    intl: {
      intlParamsNotLocalized: { name: clazz.label }
    }
  }
}

export const removeRequestMatch: TypeMatchFunc = async (
  _client: TypeMatchClient,
  _type: NotificationType,
  _typeObject: Doc,
  _doc: Doc,
  receiver: Receiver
): Promise<boolean> => {
  const tx = _typeObject as TxUpdateDoc<Request>
  if (tx._class === core.class.TxUpdateDoc) {
    const removed: Ref<Employee>[] = combineAttributes([tx.operations], 'requested', '$pull', '$in') ?? []

    return removed.includes(receiver.employeeRef)
  }

  return false
}

export const removeRequestCreateNotification: CreateTxNotificationFunc = async (
  client: TypeMatchClient,
  _tx: TxCUD<Doc>,
  attachedToDoc: Doc | undefined,
  object: Doc,
  _receiver: Receiver
): Promise<CreateNotificationResult | undefined> => {
  if (attachedToDoc == null) return undefined

  const req = object as Request
  const clazz = client.hierarchy.getClass(req._class)

  return {
    notification: {
      icon: clazz.icon,
      messageIntl: request.string.CancelRequestNotification
    },
    intl: {
      intlParamsNotLocalized: { name: clazz.label }
    }
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export default async () => ({
  function: {
    RequestTitlePresenter: requestTitlePresenter,
    SendRequestMatch: sendRequestMatch,
    RemoveRequestMatch: removeRequestMatch,
    RemoveRequestCreateNotification: removeRequestCreateNotification,
    SendRequestCreateNotification: sendRequestCreateNotification
  },
  trigger: {
    OnRequest
  }
})
