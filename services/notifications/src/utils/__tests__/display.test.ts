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
  getDocTitle,
  getDocIdentifier,
  getDocUrl,
  getDocLabel,
  getDocIcon,
  getObjectDisplayData,
  getBaseDisplayParams
} from '../display'
import { getEmptyTxCache } from '../result'
import {
  getDocIcon as _getDocIcon,
  getDocIdentifier as _getDocIdentifier,
  getDocLabel as _getDocLabel,
  getDocTitle as _getDocTitle,
  getDocUrl as _getDocUrl,
  getIconPresenter,
  getTitlePresenter
} from '@hcengineering/server-activity'
import { getSenderName, Sender } from '@hcengineering/server-notification'
import { Client, TxCache } from '../../types'
import { Doc, AccountUuid } from '@hcengineering/core'
import { NotificationType } from '@hcengineering/notification'

jest.mock('@hcengineering/server-activity', () => ({
  getDocIcon: jest.fn(),
  getDocIdentifier: jest.fn(),
  getDocLabel: jest.fn(),
  getDocTitle: jest.fn(),
  getDocUrl: jest.fn(),
  getIconPresenter: jest.fn(),
  getTitlePresenter: jest.fn()
}))

jest.mock('@hcengineering/server-notification', () => ({
  getSenderName: jest.fn()
}))

describe('display utils', () => {
  let mockClient: Client
  let txCache: TxCache

  beforeEach(() => {
    mockClient = {
      ctx: 'ctx-val',
      workspace: 'ws-val',
      hierarchy: {
        isDerived: jest.fn().mockReturnValue(false)
      },
      model: 'model-val',
      branding: { lastNameFirst: true },
      findAll: jest.fn()
    } as unknown as Client
    txCache = getEmptyTxCache()
    jest.clearAllMocks()
  })

  describe('getDocTitle', () => {
    it('fetches and caches non-personalized title', async () => {
      const doc = { _id: 'doc-1', _class: 'DocClass' } as unknown as Doc
      ;(getTitlePresenter as jest.Mock).mockReturnValue({ personalized: false })
      ;(_getDocTitle as jest.Mock).mockResolvedValue('My Doc Title')

      const title1 = await getDocTitle(mockClient, txCache, doc)
      expect(title1).toBe('My Doc Title')
      expect(_getDocTitle).toHaveBeenCalledTimes(1)

      // Second call should retrieve from cache
      const title2 = await getDocTitle(mockClient, txCache, doc)
      expect(title2).toBe('My Doc Title')
      expect(_getDocTitle).toHaveBeenCalledTimes(1)
    })

    it('caches personalized title under account key', async () => {
      const doc = { _id: 'doc-1', _class: 'DocClass' } as unknown as Doc
      ;(getTitlePresenter as jest.Mock).mockReturnValue({ personalized: true })
      ;(_getDocTitle as jest.Mock).mockResolvedValueOnce('User 1 Title').mockResolvedValueOnce('User 2 Title')

      const t1 = await getDocTitle(mockClient, txCache, doc, 'user-1' as AccountUuid)
      const t2 = await getDocTitle(mockClient, txCache, doc, 'user-2' as AccountUuid)
      const t1Cached = await getDocTitle(mockClient, txCache, doc, 'user-1' as AccountUuid)

      expect(t1).toBe('User 1 Title')
      expect(t2).toBe('User 2 Title')
      expect(t1Cached).toBe('User 1 Title')
      expect(_getDocTitle).toHaveBeenCalledTimes(2)
    })
  })

  describe('getDocIdentifier', () => {
    it('fetches and caches document identifier', async () => {
      const doc = { _id: 'doc-1', _class: 'DocClass' } as unknown as Doc
      ;(_getDocIdentifier as jest.Mock).mockResolvedValue('ID-100')

      const id1 = await getDocIdentifier(mockClient, txCache, doc)
      const id2 = await getDocIdentifier(mockClient, txCache, doc)

      expect(id1).toBe('ID-100')
      expect(id2).toBe('ID-100')
      expect(_getDocIdentifier).toHaveBeenCalledTimes(1)
    })
  })

  describe('getDocUrl', () => {
    it('fetches and caches document url', async () => {
      const doc = { _id: 'doc-1', _class: 'DocClass' } as unknown as Doc
      ;(_getDocUrl as jest.Mock).mockResolvedValue('/docs/1')

      const url1 = await getDocUrl(mockClient, txCache, doc)
      const url2 = await getDocUrl(mockClient, txCache, doc)

      expect(url1).toBe('/docs/1')
      expect(url2).toBe('/docs/1')
      expect(_getDocUrl).toHaveBeenCalledTimes(1)
    })
  })

  describe('getDocLabel', () => {
    it('fetches and caches document label', async () => {
      const doc = { _id: 'doc-1', _class: 'DocClass' } as unknown as Doc
      ;(_getDocLabel as jest.Mock).mockResolvedValue('My Label')

      const label1 = await getDocLabel(mockClient, txCache, doc)
      const label2 = await getDocLabel(mockClient, txCache, doc)

      expect(label1).toBe('My Label')
      expect(label2).toBe('My Label')
      expect(_getDocLabel).toHaveBeenCalledTimes(1)
    })
  })

  describe('getDocIcon', () => {
    it('fetches and caches personalized icon', async () => {
      const doc = { _id: 'doc-1', _class: 'DocClass' } as unknown as Doc
      ;(getIconPresenter as jest.Mock).mockReturnValue({ personalized: true })
      ;(_getDocIcon as jest.Mock).mockResolvedValue('icon-user-1')

      const icon1 = await getDocIcon(mockClient, txCache, doc, 'user-1' as AccountUuid)
      const icon2 = await getDocIcon(mockClient, txCache, doc, 'user-1' as AccountUuid)

      expect(icon1).toBe('icon-user-1')
      expect(icon2).toBe('icon-user-1')
      expect(_getDocIcon).toHaveBeenCalledTimes(1)
    })
  })

  describe('getObjectDisplayData', () => {
    it('returns combined property display data', async () => {
      const doc = { _id: 'doc-1', _class: 'DocClass' } as unknown as Doc
      ;(getTitlePresenter as jest.Mock).mockReturnValue({ personalized: false })
      ;(getIconPresenter as jest.Mock).mockReturnValue({ personalized: false })
      ;(_getDocTitle as jest.Mock).mockResolvedValue('Title')
      ;(_getDocIdentifier as jest.Mock).mockResolvedValue('ID')
      ;(_getDocLabel as jest.Mock).mockResolvedValue('Label')
      ;(_getDocIcon as jest.Mock).mockResolvedValue('Icon')

      const result = await getObjectDisplayData(mockClient, {} as any, txCache, doc, 'user-1' as AccountUuid)

      expect(result).toEqual({
        objectTitle: 'Title',
        objectIdentifier: 'ID',
        objectLabel: 'Label',
        objectIcon: 'Icon'
      })
    })

    it('resolves and aggregates parent display properties if parent details exist on doc', async () => {
      const doc = {
        _id: 'msg-1',
        _class: 'MessageClass',
        attachedTo: 'parent-1',
        attachedToClass: 'ParentClass'
      } as unknown as Doc
      const parentDoc = { _id: 'parent-1', _class: 'ParentClass' } as unknown as Doc

      const mockCache = {
        getDoc: jest.fn().mockResolvedValue(parentDoc)
      } as any

      ;(mockClient.hierarchy.isDerived as jest.Mock).mockReturnValue(true)
      ;(getTitlePresenter as jest.Mock).mockReturnValue({ personalized: false })
      ;(getIconPresenter as jest.Mock).mockReturnValue({ personalized: false })
      ;(_getDocTitle as jest.Mock).mockImplementation(async (_, d) =>
        d?._id === 'msg-1' ? 'Msg Title' : 'Parent Title'
      )
      ;(_getDocIdentifier as jest.Mock).mockImplementation(async (_, d) =>
        d?._id === 'msg-1' ? 'Msg ID' : 'Parent ID'
      )
      ;(_getDocLabel as jest.Mock).mockImplementation(async (_, d) =>
        d?._id === 'msg-1' ? 'Msg Label' : 'Parent Label'
      )
      ;(_getDocIcon as jest.Mock).mockImplementation(async (_, d) => (d?._id === 'msg-1' ? 'Msg Icon' : 'Parent Icon'))

      const result = await getObjectDisplayData(mockClient, mockCache, txCache, doc, 'user-1' as AccountUuid)

      expect(mockCache.getDoc).toHaveBeenCalledWith('parent-1', 'ParentClass')
      expect(result).toEqual({
        objectTitle: 'Msg Title',
        objectIdentifier: 'Msg ID',
        objectLabel: 'Msg Label',
        objectIcon: 'Msg Icon',
        object: {
          _id: 'msg-1',
          _class: 'MessageClass',
          attachedTo: 'parent-1',
          attachedToClass: 'ParentClass'
        },
        parentObjectId: 'parent-1',
        parentObjectClass: 'ParentClass',
        parentObjectTitle: 'Parent Title',
        parentObjectIdentifier: 'Parent ID',
        parentObjectLabel: 'Parent Label',
        parentObjectIcon: 'Parent Icon'
      })
    })
  })

  describe('getBaseDisplayParams', () => {
    it('resolves parameters from title, url, identifier, sender, and message type', async () => {
      const doc = { _id: 'doc-1', _class: 'DocClass' } as unknown as Doc
      ;(getTitlePresenter as jest.Mock).mockReturnValue({ personalized: false })
      ;(_getDocTitle as jest.Mock).mockResolvedValue('Title')
      ;(_getDocUrl as jest.Mock).mockResolvedValue('/url')
      ;(_getDocIdentifier as jest.Mock).mockResolvedValue('ID')
      ;(getSenderName as jest.Mock).mockReturnValue('John Doe')

      const type = { notificationMessage: 'Hello World' } as unknown as NotificationType
      const sender = { name: 'John' } as unknown as Sender

      const result = await getBaseDisplayParams(mockClient, txCache, type, doc, sender, 'en')

      expect(getSenderName).toHaveBeenCalledWith(sender, true) // client.branding.lastNameFirst is true
      expect(result).toEqual({
        intlParams: {
          title: 'Title',
          doc: 'Title',
          url: '/url',
          identifier: 'ID',
          senderName: 'John Doe'
        },
        intlParamsNotLocalized: {
          message: 'Hello World'
        }
      })
    })

    it('handles missing/empty values gracefully', async () => {
      const doc = { _id: 'doc-1', _class: 'DocClass' } as unknown as Doc
      ;(getTitlePresenter as jest.Mock).mockReturnValue({ personalized: false })
      ;(_getDocTitle as jest.Mock).mockResolvedValue(null)
      ;(_getDocUrl as jest.Mock).mockResolvedValue(null)
      ;(_getDocIdentifier as jest.Mock).mockResolvedValue(null)
      ;(getSenderName as jest.Mock).mockReturnValue('Anonymous')

      const type = {} as unknown as NotificationType
      const sender = {} as unknown as Sender

      const result = await getBaseDisplayParams(mockClient, txCache, type, doc, sender, 'en')

      expect(result).toEqual({
        intlParams: {
          senderName: 'Anonymous'
        },
        intlParamsNotLocalized: {}
      })
    })
  })
})
