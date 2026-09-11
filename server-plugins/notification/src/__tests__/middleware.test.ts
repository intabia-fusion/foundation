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

import {
  type MeasureContext,
  type SessionData,
  type TxCreateDoc,
  type TxUpdateDoc,
  type TxRemoveDoc,
  systemAccountUuid,
  toFindResult,
  Space,
  Ref,
  PersonId,
  DocumentUpdate,
  AccountUuid
} from '@hcengineering/core'
import core from '@hcengineering/core'
import notification, { AppPushNotification, DocNotifyContext, type ReadState } from '@hcengineering/notification'
import { PlatformError } from '@hcengineering/platform'
import chunter, { ThreadMessage } from '@hcengineering/chunter'
import type { PipelineContext, Middleware } from '@hcengineering/server-core'
import { ActivityMessage } from '@hcengineering/activity'

import { NotificationMiddleware } from '../middleware'

describe('NotificationMiddleware', () => {
  let mockPipelineContext: PipelineContext
  let mockNext: jest.Mocked<Middleware>
  let mockMeasureContext: MeasureContext<SessionData>
  let userAccountUuid: string
  let middleware: NotificationMiddleware

  beforeEach(() => {
    userAccountUuid = 'user-1-uuid'
    mockNext = {
      findAll: jest.fn().mockResolvedValue(toFindResult([])),
      tx: jest.fn().mockResolvedValue({}),
      groupBy: jest.fn(),
      searchFulltext: jest.fn(),
      loadModel: jest.fn(),
      handleBroadcast: jest.fn(),
      domainRequest: jest.fn(),
      closeSession: jest.fn(),
      close: jest.fn()
    } as any

    mockPipelineContext = {
      derived: {
        tx: jest.fn()
      }
    } as any

    mockMeasureContext = {
      contextData: {
        account: {
          uuid: userAccountUuid
        },
        isTriggerCtx: false
      }
    } as any
  })

  afterEach(async () => {
    if (middleware != null) {
      await middleware.close()
    }
  })

  it('allows system account to create ReadState', async () => {
    middleware = (await NotificationMiddleware.create(
      mockMeasureContext,
      mockPipelineContext,
      mockNext
    )) as NotificationMiddleware
    mockMeasureContext.contextData.account.uuid = systemAccountUuid

    const tx: TxCreateDoc<ReadState> = {
      _class: core.class.TxCreateDoc,
      objectClass: notification.class.ReadState,
      objectId: 'readstate-1' as any,
      objectSpace: 'space-1' as any,
      attributes: {} as any
    } as any

    await expect(middleware.tx(mockMeasureContext, [tx])).resolves.not.toThrow()
  })

  it('allows triggers to create ReadState', async () => {
    middleware = (await NotificationMiddleware.create(
      mockMeasureContext,
      mockPipelineContext,
      mockNext
    )) as NotificationMiddleware
    mockMeasureContext.contextData.isTriggerCtx = true

    const tx: TxCreateDoc<ReadState> = {
      _class: core.class.TxCreateDoc,
      objectClass: notification.class.ReadState,
      objectId: 'readstate-1' as any,
      objectSpace: 'space-1' as any,
      attributes: {} as any
    } as any

    await expect(middleware.tx(mockMeasureContext, [tx])).resolves.not.toThrow()
  })

  it('forbids normal user from creating ReadState', async () => {
    middleware = (await NotificationMiddleware.create(
      mockMeasureContext,
      mockPipelineContext,
      mockNext
    )) as NotificationMiddleware

    const tx: TxCreateDoc<ReadState> = {
      _class: core.class.TxCreateDoc,
      objectClass: notification.class.ReadState,
      objectId: 'readstate-1' as any,
      objectSpace: 'space-1' as any,
      attributes: {} as any
    } as any

    await expect(middleware.tx(mockMeasureContext, [tx])).rejects.toThrow(PlatformError)
  })

  it('allows system account to remove ReadState', async () => {
    middleware = (await NotificationMiddleware.create(
      mockMeasureContext,
      mockPipelineContext,
      mockNext
    )) as NotificationMiddleware
    mockMeasureContext.contextData.account.uuid = systemAccountUuid

    const tx: TxRemoveDoc<ReadState> = {
      _class: core.class.TxRemoveDoc,
      objectClass: notification.class.ReadState,
      objectId: 'readstate-1' as any,
      objectSpace: 'space-1' as any
    } as any

    await expect(middleware.tx(mockMeasureContext, [tx])).resolves.not.toThrow()
  })

  it('allows triggers to remove ReadState', async () => {
    middleware = (await NotificationMiddleware.create(
      mockMeasureContext,
      mockPipelineContext,
      mockNext
    )) as NotificationMiddleware
    mockMeasureContext.contextData.isTriggerCtx = true

    const tx: TxRemoveDoc<ReadState> = {
      _class: core.class.TxRemoveDoc,
      objectClass: notification.class.ReadState,
      objectId: 'readstate-1' as any,
      objectSpace: 'space-1' as any
    } as any

    await expect(middleware.tx(mockMeasureContext, [tx])).resolves.not.toThrow()
  })

  it('forbids normal user from removing ReadState', async () => {
    middleware = (await NotificationMiddleware.create(
      mockMeasureContext,
      mockPipelineContext,
      mockNext
    )) as NotificationMiddleware

    const tx: TxRemoveDoc<ReadState> = {
      _class: core.class.TxRemoveDoc,
      objectClass: notification.class.ReadState,
      objectId: 'readstate-1' as any,
      objectSpace: 'space-1' as any
    } as any

    await expect(middleware.tx(mockMeasureContext, [tx])).rejects.toThrow(PlatformError)
  })

  it('allows normal user to update their own read position', async () => {
    middleware = (await NotificationMiddleware.create(
      mockMeasureContext,
      mockPipelineContext,
      mockNext
    )) as NotificationMiddleware
    const mockState: ReadState = {
      _id: 'readstate-1' as any,
      [userAccountUuid]: {
        messageId: 'old-msg-id',
        timestamp: 100
      }
    } as any

    // We need mockNext.findAll to return mockState when getState is called
    mockNext.findAll.mockResolvedValue(toFindResult([mockState]))

    const tx: TxUpdateDoc<ReadState> = {
      _class: core.class.TxUpdateDoc,
      objectClass: notification.class.ReadState,
      objectId: 'readstate-1' as any,
      objectSpace: 'space-1' as any,
      operations: {
        [userAccountUuid]: {
          messageId: 'new-msg-id',
          timestamp: 200
        }
      }
    } as any

    await expect(middleware.tx(mockMeasureContext, [tx])).resolves.not.toThrow()
  })

  describe('ReadState validation', () => {
    const updateTx = (ops: DocumentUpdate<ReadState> = {}): TxUpdateDoc<ReadState> => ({
      _id: 'tx-1' as Ref<TxUpdateDoc<ReadState>>,
      _class: core.class.TxUpdateDoc,
      objectClass: notification.class.ReadState,
      objectId: 'readstate-1' as Ref<ReadState>,
      objectSpace: 'objectSpace-1' as Ref<Space>,
      space: 'space-1' as Ref<Space>,
      modifiedBy: 'socialId-1' as PersonId,
      modifiedOn: 1,
      operations: ops
    })
    it('forbids normal user from updating other users read position', async () => {
      middleware = (await NotificationMiddleware.create(
        mockMeasureContext,
        mockPipelineContext,
        mockNext
      )) as NotificationMiddleware

      const otherAccount = 'some-other-user' as AccountUuid
      const tx: TxUpdateDoc<ReadState> = updateTx({
        [otherAccount]: {
          messageId: 'new-msg-id' as Ref<ActivityMessage>,
          timestamp: 200
        }
      })

      await expect(middleware.tx(mockMeasureContext, [tx])).rejects.toThrow(PlatformError)
    })

    it('strips fields other than user own position for normal user', async () => {
      middleware = (await NotificationMiddleware.create(
        mockMeasureContext,
        mockPipelineContext,
        mockNext
      )) as NotificationMiddleware

      mockNext.findAll.mockResolvedValue(toFindResult([{ _id: 'readstate-1' } as any]))

      const tx: TxUpdateDoc<ReadState> = updateTx({
        latestMessageId: 'new-msg-id' as Ref<ActivityMessage>,
        [userAccountUuid]: {
          messageId: 'new-msg-id' as Ref<ActivityMessage>,
          timestamp: 200
        } as any
      })

      await middleware.tx(mockMeasureContext, [tx])

      expect(tx.operations).toEqual({
        [userAccountUuid]: {
          messageId: 'new-msg-id',
          timestamp: 200
        }
      })
    })

    it('does not apply update transaction if update timestamp is older than current timestamp', async () => {
      middleware = (await NotificationMiddleware.create(
        mockMeasureContext,
        mockPipelineContext,
        mockNext
      )) as NotificationMiddleware
      const mockState: ReadState = {
        _id: 'readstate-1' as any,
        [userAccountUuid]: {
          messageId: 'old-msg-id',
          timestamp: 200
        }
      } as any

      mockNext.findAll.mockResolvedValue(toFindResult([mockState]))

      const tx: TxUpdateDoc<ReadState> = updateTx({
        [userAccountUuid]: {
          messageId: 'new-msg-id' as Ref<ActivityMessage>,
          timestamp: 100
        }
      })

      await middleware.tx(mockMeasureContext, [tx])

      expect(mockNext.tx).not.toHaveBeenCalled()
    })

    it('creates ReadState when ThreadMessage is created and ReadState does not exist', async () => {
      middleware = (await NotificationMiddleware.create(
        mockMeasureContext,
        mockPipelineContext,
        mockNext
      )) as NotificationMiddleware

      const tx: TxCreateDoc<ThreadMessage> = {
        _id: 'tx-1' as Ref<TxCreateDoc<ThreadMessage>>,
        _class: core.class.TxCreateDoc,
        objectClass: chunter.class.ThreadMessage,
        objectId: 'msg-1' as Ref<ThreadMessage>,
        objectSpace: 'objectSpace-1' as Ref<Space>,
        space: 'space-1' as Ref<Space>,
        modifiedBy: 'user-1' as PersonId,
        modifiedOn: 1,
        attributes: {
          attachedTo: 'doc-1',
          attachedToClass: 'SomeDocClass',
          space: 'space-1'
        } as any
      }

      await middleware.tx(mockMeasureContext, [tx])

      expect(mockPipelineContext.derived?.tx).toHaveBeenCalledWith(
        expect.anything(),
        expect.arrayContaining([
          expect.objectContaining({
            _class: core.class.TxCreateDoc,
            objectClass: notification.class.ReadState,
            attributes: expect.objectContaining({
              attachedTo: 'doc-1',
              attachedToClass: 'SomeDocClass',
              collection: 'readStates'
            })
          })
        ])
      )
    })

    it('does not create ReadState when ThreadMessage is created and ReadState already exists', async () => {
      middleware = (await NotificationMiddleware.create(
        mockMeasureContext,
        mockPipelineContext,
        mockNext
      )) as NotificationMiddleware
      const mockState: ReadState = {
        _id: 'readstate-1',
        attachedTo: 'doc-1',
        attachedToClass: 'SomeDocClass'
      } as any

      mockNext.findAll.mockResolvedValue(toFindResult([mockState]))

      const tx: TxCreateDoc<ThreadMessage> = {
        _id: 'tx-1' as Ref<TxCreateDoc<ThreadMessage>>,
        _class: core.class.TxCreateDoc,
        objectClass: chunter.class.ThreadMessage,
        objectId: 'msg-1' as Ref<ThreadMessage>,
        objectSpace: 'objectSpace-1' as Ref<Space>,
        space: 'space-1' as Ref<Space>,
        modifiedBy: 'user-1' as PersonId,
        modifiedOn: 1,
        attributes: {
          attachedTo: 'doc-1',
          attachedToClass: 'SomeDocClass',
          space: 'space-1'
        } as any
      }

      await middleware.tx(mockMeasureContext, [tx])

      expect(mockPipelineContext.derived?.tx).not.toHaveBeenCalled()
    })

    it('allows system account to update ReadState without restrictions', async () => {
      middleware = (await NotificationMiddleware.create(
        mockMeasureContext,
        mockPipelineContext,
        mockNext
      )) as NotificationMiddleware
      mockMeasureContext.contextData.account.uuid = systemAccountUuid

      const tx: TxUpdateDoc<ReadState> = updateTx({
        otherField: 'arbitrary'
      } as any)

      await expect(middleware.tx(mockMeasureContext, [tx])).resolves.not.toThrow()
    })

    it('allows triggers to update ReadState without restrictions', async () => {
      middleware = (await NotificationMiddleware.create(
        mockMeasureContext,
        mockPipelineContext,
        mockNext
      )) as NotificationMiddleware
      mockMeasureContext.contextData.isTriggerCtx = true

      const tx: TxUpdateDoc<ReadState> = updateTx({
        otherField: 'arbitrary'
      } as any)

      await expect(middleware.tx(mockMeasureContext, [tx])).resolves.not.toThrow()
    })

    it('allows normal user to send update for non-existent ReadState without throwing', async () => {
      middleware = (await NotificationMiddleware.create(
        mockMeasureContext,
        mockPipelineContext,
        mockNext
      )) as NotificationMiddleware

      mockNext.findAll.mockResolvedValue(toFindResult([]))

      const tx: TxUpdateDoc<ReadState> = updateTx({
        [userAccountUuid]: {
          messageId: 'new-msg-id' as Ref<ActivityMessage>,
          timestamp: 200
        }
      })

      const res = await middleware.tx(mockMeasureContext, [tx])
      expect(res).toBeDefined()
    })

    it('skips only the transaction with older timestamp when multiple transactions are provided', async () => {
      middleware = (await NotificationMiddleware.create(
        mockMeasureContext,
        mockPipelineContext,
        mockNext
      )) as NotificationMiddleware
      const mockState: ReadState = {
        _id: 'readstate-1' as any,
        [userAccountUuid]: {
          messageId: 'old-msg-id',
          timestamp: 200
        }
      } as any

      mockNext.findAll.mockResolvedValue(toFindResult([mockState]))

      const tx1: TxUpdateDoc<ReadState> = {
        ...updateTx({
          [userAccountUuid]: {
            messageId: 'new-msg-id-1' as Ref<ActivityMessage>,
            timestamp: 100
          }
        }),
        _id: 'tx-1' as Ref<TxUpdateDoc<ReadState>>
      }

      const tx2: TxUpdateDoc<ReadState> = {
        ...updateTx({
          [userAccountUuid]: {
            messageId: 'new-msg-id-2' as Ref<ActivityMessage>,
            timestamp: 300
          }
        }),
        _id: 'tx-2' as Ref<TxUpdateDoc<ReadState>>
      }

      await middleware.tx(mockMeasureContext, [tx1, tx2])

      expect(mockNext.tx).toHaveBeenCalledWith(mockMeasureContext, [tx2])
    })
  })

  describe('DocNotifyContext validation', () => {
    const createTx = (): TxCreateDoc<DocNotifyContext> => ({
      _id: 'tx-1' as Ref<TxCreateDoc<DocNotifyContext>>,
      _class: core.class.TxCreateDoc,
      objectClass: notification.class.DocNotifyContext,
      objectId: 'objectId-1' as Ref<DocNotifyContext>,
      objectSpace: 'objectSpace-1' as Ref<Space>,
      space: 'space-1' as Ref<Space>,
      modifiedBy: 'socialId-1' as PersonId,
      modifiedOn: 1,
      attributes: {} as any
    })

    const updateTx = (): TxUpdateDoc<DocNotifyContext> => ({
      _id: 'tx-1' as Ref<TxUpdateDoc<DocNotifyContext>>,
      _class: core.class.TxUpdateDoc,
      objectClass: notification.class.DocNotifyContext,
      objectId: 'objectId-1' as Ref<DocNotifyContext>,
      objectSpace: 'objectSpace-1' as Ref<Space>,
      space: 'space-1' as Ref<Space>,
      modifiedBy: 'socialId-1' as PersonId,
      modifiedOn: 1,
      operations: {} as any
    })

    const removeTx = (): TxRemoveDoc<DocNotifyContext> => ({
      _id: 'tx-1' as Ref<TxRemoveDoc<DocNotifyContext>>,
      _class: core.class.TxRemoveDoc,
      objectClass: notification.class.DocNotifyContext,
      objectId: 'objectId-1' as Ref<DocNotifyContext>,
      objectSpace: 'objectSpace-1' as Ref<Space>,
      space: 'space-1' as Ref<Space>,
      modifiedBy: 'socialId-1' as PersonId,
      modifiedOn: 1
    })

    it('allows system account to create DocNotifyContext', async () => {
      middleware = (await NotificationMiddleware.create(
        mockMeasureContext,
        mockPipelineContext,
        mockNext
      )) as NotificationMiddleware
      mockMeasureContext.contextData.account.uuid = systemAccountUuid

      await expect(middleware.tx(mockMeasureContext, [createTx()])).resolves.not.toThrow()
    })

    it('allows triggers to create DocNotifyContext', async () => {
      middleware = (await NotificationMiddleware.create(
        mockMeasureContext,
        mockPipelineContext,
        mockNext
      )) as NotificationMiddleware
      mockMeasureContext.contextData.isTriggerCtx = true

      await expect(middleware.tx(mockMeasureContext, [createTx()])).resolves.not.toThrow()
    })

    it('forbids normal user from creating DocNotifyContext', async () => {
      middleware = (await NotificationMiddleware.create(
        mockMeasureContext,
        mockPipelineContext,
        mockNext
      )) as NotificationMiddleware

      await expect(middleware.tx(mockMeasureContext, [createTx()])).rejects.toThrow(PlatformError)
    })

    it('allows system account to update DocNotifyContext', async () => {
      middleware = (await NotificationMiddleware.create(
        mockMeasureContext,
        mockPipelineContext,
        mockNext
      )) as NotificationMiddleware
      mockMeasureContext.contextData.account.uuid = systemAccountUuid

      await expect(middleware.tx(mockMeasureContext, [updateTx()])).resolves.not.toThrow()
    })

    it('allows triggers to update DocNotifyContext', async () => {
      middleware = (await NotificationMiddleware.create(
        mockMeasureContext,
        mockPipelineContext,
        mockNext
      )) as NotificationMiddleware
      mockMeasureContext.contextData.isTriggerCtx = true

      await expect(middleware.tx(mockMeasureContext, [updateTx()])).resolves.not.toThrow()
    })

    it('forbids normal user from updating DocNotifyContext', async () => {
      middleware = (await NotificationMiddleware.create(
        mockMeasureContext,
        mockPipelineContext,
        mockNext
      )) as NotificationMiddleware

      await expect(middleware.tx(mockMeasureContext, [updateTx()])).rejects.toThrow(PlatformError)
    })

    it('allows system account to remove DocNotifyContext', async () => {
      middleware = (await NotificationMiddleware.create(
        mockMeasureContext,
        mockPipelineContext,
        mockNext
      )) as NotificationMiddleware
      mockMeasureContext.contextData.account.uuid = systemAccountUuid

      await expect(middleware.tx(mockMeasureContext, [removeTx()])).resolves.not.toThrow()
    })

    it('allows triggers to remove DocNotifyContext', async () => {
      middleware = (await NotificationMiddleware.create(
        mockMeasureContext,
        mockPipelineContext,
        mockNext
      )) as NotificationMiddleware
      mockMeasureContext.contextData.isTriggerCtx = true

      await expect(middleware.tx(mockMeasureContext, [removeTx()])).resolves.not.toThrow()
    })

    it('allows normal user to remove DocNotifyContext', async () => {
      middleware = (await NotificationMiddleware.create(
        mockMeasureContext,
        mockPipelineContext,
        mockNext
      )) as NotificationMiddleware

      await expect(middleware.tx(mockMeasureContext, [removeTx()])).resolves.not.toThrow()
    })
  })

  describe('AppPushNotification validation', () => {
    const createTx = (): TxCreateDoc<AppPushNotification> => ({
      _id: 'tx-1' as Ref<TxCreateDoc<AppPushNotification>>,
      _class: core.class.TxCreateDoc,
      objectClass: notification.class.AppPushNotification,
      objectId: 'objectId-1' as Ref<AppPushNotification>,
      objectSpace: 'objectSpace-1' as Ref<Space>,
      space: 'space-1' as Ref<Space>,
      modifiedBy: 'socialId-1' as PersonId,
      modifiedOn: 1,
      attributes: {} as any
    })

    const updateTx = (): TxUpdateDoc<AppPushNotification> => ({
      _id: 'tx-1' as Ref<TxUpdateDoc<AppPushNotification>>,
      _class: core.class.TxUpdateDoc,
      objectClass: notification.class.AppPushNotification,
      objectId: 'objectId-1' as Ref<AppPushNotification>,
      objectSpace: 'objectSpace-1' as Ref<Space>,
      space: 'space-1' as Ref<Space>,
      modifiedBy: 'socialId-1' as PersonId,
      modifiedOn: 1,
      operations: {} as any
    })

    const removeTx = (): TxRemoveDoc<AppPushNotification> => ({
      _id: 'tx-1' as Ref<TxRemoveDoc<AppPushNotification>>,
      _class: core.class.TxRemoveDoc,
      objectClass: notification.class.AppPushNotification,
      objectId: 'objectId-1' as Ref<AppPushNotification>,
      objectSpace: 'objectSpace-1' as Ref<Space>,
      space: 'space-1' as Ref<Space>,
      modifiedBy: 'socialId-1' as PersonId,
      modifiedOn: 1
    })

    it('allows system account to create AppPushNotification', async () => {
      middleware = (await NotificationMiddleware.create(
        mockMeasureContext,
        mockPipelineContext,
        mockNext
      )) as NotificationMiddleware
      mockMeasureContext.contextData.account.uuid = systemAccountUuid

      await expect(middleware.tx(mockMeasureContext, [createTx()])).resolves.not.toThrow()
    })

    it('allows triggers to create AppPushNotification', async () => {
      middleware = (await NotificationMiddleware.create(
        mockMeasureContext,
        mockPipelineContext,
        mockNext
      )) as NotificationMiddleware
      mockMeasureContext.contextData.isTriggerCtx = true

      await expect(middleware.tx(mockMeasureContext, [createTx()])).resolves.not.toThrow()
    })

    it('forbids normal user from creating AppPushNotification', async () => {
      middleware = (await NotificationMiddleware.create(
        mockMeasureContext,
        mockPipelineContext,
        mockNext
      )) as NotificationMiddleware

      await expect(middleware.tx(mockMeasureContext, [createTx()])).rejects.toThrow(PlatformError)
    })

    it('allows system account to update AppPushNotification', async () => {
      middleware = (await NotificationMiddleware.create(
        mockMeasureContext,
        mockPipelineContext,
        mockNext
      )) as NotificationMiddleware
      mockMeasureContext.contextData.account.uuid = systemAccountUuid

      await expect(middleware.tx(mockMeasureContext, [createTx()])).resolves.not.toThrow()
    })

    it('allows triggers to update AppPushNotification', async () => {
      middleware = (await NotificationMiddleware.create(
        mockMeasureContext,
        mockPipelineContext,
        mockNext
      )) as NotificationMiddleware
      mockMeasureContext.contextData.isTriggerCtx = true

      await expect(middleware.tx(mockMeasureContext, [updateTx()])).resolves.not.toThrow()
    })

    it('forbids normal user from updating AppPushNotification', async () => {
      middleware = (await NotificationMiddleware.create(
        mockMeasureContext,
        mockPipelineContext,
        mockNext
      )) as NotificationMiddleware

      await expect(middleware.tx(mockMeasureContext, [updateTx()])).rejects.toThrow(PlatformError)
    })

    it('allows system account to remove AppPushNotification', async () => {
      middleware = (await NotificationMiddleware.create(
        mockMeasureContext,
        mockPipelineContext,
        mockNext
      )) as NotificationMiddleware
      mockMeasureContext.contextData.account.uuid = systemAccountUuid

      await expect(middleware.tx(mockMeasureContext, [removeTx()])).resolves.not.toThrow()
    })

    it('allows triggers to remove AppPushNotification', async () => {
      middleware = (await NotificationMiddleware.create(
        mockMeasureContext,
        mockPipelineContext,
        mockNext
      )) as NotificationMiddleware
      mockMeasureContext.contextData.isTriggerCtx = true

      await expect(middleware.tx(mockMeasureContext, [removeTx()])).resolves.not.toThrow()
    })

    it('allows normal user to remove AppPushNotification', async () => {
      middleware = (await NotificationMiddleware.create(
        mockMeasureContext,
        mockPipelineContext,
        mockNext
      )) as NotificationMiddleware

      await expect(middleware.tx(mockMeasureContext, [removeTx()])).resolves.not.toThrow()
    })
  })
})
