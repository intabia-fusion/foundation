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
import { DocUpdateMessage } from '@hcengineering/activity'
import contact, { Channel } from '@hcengineering/contact'
import {
  Class,
  Doc,
  DocumentQuery,
  FindOptions,
  FindResult,
  Hierarchy,
  Ref,
  Tx,
  TxCreateDoc,
  TxProcessor
} from '@hcengineering/core'
import { NotificationType } from '@hcengineering/notification'
import { TriggerControl } from '@hcengineering/server-core'
import telegram, { TelegramMessage } from '@hcengineering/telegram'
import { Receiver, TypeMatchClient, TypeMatchFunc } from '@hcengineering/server-notification'

/**
 * @public
 */
export async function FindMessages (
  doc: Doc,
  hiearachy: Hierarchy,
  findAll: <T extends Doc>(
    clazz: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: FindOptions<T>
  ) => Promise<FindResult<T>>
): Promise<Doc[]> {
  const channel = doc as Channel
  if (channel.provider !== contact.channelProvider.Telegram) {
    return []
  }
  const messages = await findAll(telegram.class.Message, { attachedTo: channel._id })
  const newMessages = await findAll(telegram.class.NewMessage, { attachedTo: channel._id })
  return [...messages, ...newMessages]
}

/**
 * @public
 */
export async function OnMessageCreate (txes: Tx[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []
  for (const tx of txes) {
    const message = TxProcessor.createDoc2Doc<TelegramMessage>(tx as TxCreateDoc<TelegramMessage>)
    const channel = (
      await control.findAll(control.ctx, contact.class.Channel, { _id: message.attachedTo }, { limit: 1 })
    )[0]
    if (channel !== undefined) {
      if (channel.lastMessage === undefined || channel.lastMessage < message.sendOn) {
        const tx = control.txFactory.createTxUpdateDoc(channel._class, channel.space, channel._id, {
          lastMessage: message.sendOn
        })
        result.push(tx)
      }
    }
  }

  return result
}

/**
 * @public
 */
export const IsIncomingMessageTypeMatch: TypeMatchFunc = async (
  client: TypeMatchClient,
  _type: NotificationType,
  _typeObject: Doc,
  doc: Doc,
  _receiver: Receiver
): Promise<boolean> => {
  const { hierarchy } = client
  const message = _typeObject as DocUpdateMessage
  if (!hierarchy.isDerived(message.objectClass, telegram.class.Message)) return false
  if (message.action !== 'create') return false

  const tgMessage = (
    await client.findAll(
      client.ctx,
      telegram.class.Message,
      { _id: message.objectId as Ref<TelegramMessage> },
      { limit: 1 }
    )
  )[0]
  if (tgMessage == null) return false
  return tgMessage.incoming && tgMessage.sendOn > (doc.createdOn ?? doc.modifiedOn)
}

export async function GetCurrentEmployeeTG (
  control: TriggerControl,
  context: Record<string, Doc>
): Promise<string | undefined> {
  // TODO: FIXME
  // const account = await control.modelDb.findOne(contact.class.PersonAccount, {
  //   _id: control.txFactory.account as PersonId
  // })
  // if (account === undefined) return
  // const employee = (
  //   await control.findAll(control.ctx, contact.mixin.Employee, { _id: account.person as Ref<Employee> })
  // )[0]
  // if (employee !== undefined) {
  //   return await getContactChannel(control, employee, contact.channelProvider.Telegram)
  // }

  return undefined
}

export async function GetIntegrationOwnerTG (
  control: TriggerControl,
  context: Record<string, Doc>
): Promise<string | undefined> {
  // TODO: FIXME
  // const value = context[setting.class.Integration] as Integration
  // if (value === undefined) return
  // const account = await control.modelDb.findOne(contact.class.PersonAccount, {
  //   _id: value.modifiedBy as PersonId
  // })
  // if (account === undefined) return
  // const employee = (
  //   await control.findAll(control.ctx, contact.mixin.Employee, { _id: account.person as Ref<Employee> })
  // )[0]
  // if (employee !== undefined) {
  //   return await getContactChannel(control, employee, contact.channelProvider.Telegram)
  // }

  return undefined
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export default async () => ({
  trigger: {
    OnMessageCreate
  },
  function: {
    IsIncomingMessageTypeMatch,
    FindMessages,
    GetCurrentEmployeeTG,
    GetIntegrationOwnerTG
  }
})
