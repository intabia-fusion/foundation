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

import { apiKeyOperations } from '@hcengineering/account-client'
import platform, { PlatformError } from '@hcengineering/platform'
import { jsonToMarkup } from '@hcengineering/text-core'
import { markdownToMarkup } from '@hcengineering/text-markdown'
import task from '@hcengineering/task'
import tracker from '@hcengineering/tracker'
import { isOperationGranted, operations } from '../opsApi'

const taskTypeDoc = {
  _id: 'tt-1',
  parent: 'pt-1',
  isRootTaskType: true,
  statuses: ['st-1'],
  targetClass: tracker.class.Issue
}

function fakeClient (): any {
  return {
    findOne: jest.fn().mockResolvedValue(undefined),
    // resolveTaskType looks the project's task types up by { parent: project.type }; every other
    // findAll in these paths (teamspaces, documents) must still come back empty.
    findAll: jest.fn().mockImplementation(async (_class: any) => (_class === task.class.TaskType ? [taskTypeDoc] : [])),
    getHierarchy: () => ({ hasClass: () => true })
  }
}

describe('opsApi operations registry', () => {
  test('has an executor for every known API key operation, and nothing else', () => {
    for (const op of apiKeyOperations) {
      expect(operations[op]).toBeDefined()
    }
    expect(Object.keys(operations).sort()).toEqual([...apiKeyOperations].sort())
  })

  test('resolving a nonexistent project fails with a field-named error', async () => {
    const client = fakeClient()
    await expect(operations['issue:create'](client, { space: 'NOPE', title: 'Title' })).rejects.toThrow(
      'field "space": project not found: "NOPE"'
    )
  })

  test('resolving a nonexistent issue fails with a field-named error', async () => {
    const client = fakeClient()
    await expect(operations['issue:comment'](client, { space: 'FUSIO-999', message: 'hi' })).rejects.toThrow(
      'field "space": issue not found: "FUSIO-999"'
    )
  })

  test('a missing required field fails naming the field', async () => {
    const client = fakeClient()
    client.findOne.mockResolvedValueOnce({ _id: 'proj-1', identifier: 'FUSIO' })
    await expect(operations['issue:create'](client, { space: 'FUSIO' })).rejects.toThrow('field "title": required')
  })

  test('a body/resolve error is a PlatformError with BadRequest status, not a plain Error', async () => {
    const client = fakeClient()
    expect.assertions(2)
    try {
      await operations['issue:create'](client, { space: 'NOPE', title: 'Title' })
    } catch (err) {
      expect(err).toBeInstanceOf(PlatformError)
      expect((err as PlatformError).status.code).toBe(platform.status.BadRequest)
    }
  })

  test('issue:create uses a pre-uploaded descriptionRef instead of calling uploadMarkup', async () => {
    const client = fakeClient()
    client.findOne.mockResolvedValueOnce({
      _id: 'proj-1',
      identifier: 'FUSIO',
      type: 'pt-1',
      defaultIssueStatus: 'st-1'
    })
    client.updateDoc = jest.fn().mockResolvedValue({ object: { sequence: 1 } })
    client.addCollection = jest.fn().mockResolvedValue('issue-1')

    const result = await operations['issue:create'](client, {
      space: 'FUSIO',
      title: 'Title',
      descriptionRef: 'blob-ref-1'
    })

    expect(result.identifier).toBe('FUSIO-1')
    const value = client.addCollection.mock.calls[0][5]
    expect(value.description).toBe('blob-ref-1')
  })

  test('issue:create converts a markdown body and uploads the resulting markup', async () => {
    const client = fakeClient()
    client.findOne.mockResolvedValueOnce({
      _id: 'proj-1',
      identifier: 'FUSIO',
      type: 'pt-1',
      defaultIssueStatus: 'st-1'
    })
    client.updateDoc = jest.fn().mockResolvedValue({ object: { sequence: 1 } })
    client.addCollection = jest.fn().mockResolvedValue('issue-1')
    const uploadMarkup = jest.fn().mockResolvedValue('blob-ref-md-1')

    const result = await operations['issue:create'](
      client,
      { space: 'FUSIO', title: 'Title', body: '# Hello\n\nWorld' },
      uploadMarkup
    )

    expect(result.identifier).toBe('FUSIO-1')
    expect(uploadMarkup).toHaveBeenCalledTimes(1)
    expect(uploadMarkup.mock.calls[0][1]).toBe(jsonToMarkup(markdownToMarkup('# Hello\n\nWorld')))
    const value = client.addCollection.mock.calls[0][5]
    expect(value.description).toBe('blob-ref-md-1')
  })

  test('issue:create refuses a body combined with a raw description', async () => {
    const client = fakeClient()
    client.findOne.mockResolvedValueOnce({ _id: 'proj-1', identifier: 'FUSIO' })

    await expect(
      operations['issue:create'](
        client,
        { space: 'FUSIO', title: 'Title', body: '# Hello', description: '{"type":"doc","content":[]}' },
        jest.fn()
      )
    ).rejects.toThrow('field "body": cannot be combined with "description"')
  })

  test('issue:create no longer throws for a raw description, uploading it via uploadMarkup', async () => {
    const client = fakeClient()
    client.findOne.mockResolvedValueOnce({
      _id: 'proj-1',
      identifier: 'FUSIO',
      type: 'pt-1',
      defaultIssueStatus: 'st-1'
    })
    client.updateDoc = jest.fn().mockResolvedValue({ object: { sequence: 1 } })
    client.addCollection = jest.fn().mockResolvedValue('issue-1')
    const uploadMarkup = jest.fn().mockResolvedValue('blob-ref-raw-1')
    const rawMarkup = jsonToMarkup(markdownToMarkup('hi'))

    const result = await operations['issue:create'](
      client,
      { space: 'FUSIO', title: 'Title', description: rawMarkup },
      uploadMarkup
    )

    expect(result.identifier).toBe('FUSIO-1')
    expect(uploadMarkup).toHaveBeenCalledTimes(1)
    const value = client.addCollection.mock.calls[0][5]
    expect(value.description).toBe('blob-ref-raw-1')
  })

  describe('issue:time_report', () => {
    test('resolves issue and employee by email, then creates a report', async () => {
      const client = fakeClient()
      client.findOne
        .mockResolvedValueOnce({
          _id: 'issue-1',
          _class: 'tracker:class:Issue',
          space: 'proj-1',
          identifier: 'FUSIO-1'
        })
        .mockResolvedValueOnce({ attachedTo: 'person-1' })
      client.addCollection = jest.fn().mockResolvedValue('report-1')

      const result = await operations['issue:time_report'](client, {
        space: 'FUSIO-1',
        employee: 'a@b.com',
        date: '2026-01-15',
        hours: 3
      })

      expect(result.reportId).toBe('report-1')
      const [, space, attachedTo, , collection, attributes] = client.addCollection.mock.calls[0]
      expect(space).toBe('proj-1')
      expect(attachedTo).toBe('issue-1')
      expect(collection).toBe('reports')
      expect(attributes).toEqual({
        employee: 'person-1',
        date: Date.parse('2026-01-15T00:00:00.000Z'),
        value: 3,
        description: ''
      })
    })

    test('rejects an unknown issue', async () => {
      const client = fakeClient()
      await expect(
        operations['issue:time_report'](client, { space: 'NOPE', employee: 'a@b.com', date: '2026-01-15', hours: 1 })
      ).rejects.toThrow('field "space": issue not found: "NOPE"')
    })

    test('rejects an unknown employee email', async () => {
      const client = fakeClient()
      client.findOne.mockResolvedValueOnce({ _id: 'issue-1', identifier: 'FUSIO-1' })
      await expect(
        operations['issue:time_report'](client, {
          space: 'FUSIO-1',
          employee: 'nope@x.com',
          date: '2026-01-15',
          hours: 1
        })
      ).rejects.toThrow('field "employee": no person found for email "nope@x.com"')
    })

    test('rejects a malformed date', async () => {
      const client = fakeClient()
      client.findOne
        .mockResolvedValueOnce({ _id: 'issue-1', identifier: 'FUSIO-1' })
        .mockResolvedValueOnce({ attachedTo: 'person-1' })
      await expect(
        operations['issue:time_report'](client, {
          space: 'FUSIO-1',
          employee: 'a@b.com',
          date: '2026-02-30',
          hours: 1
        })
      ).rejects.toThrow('field "date": expected an ISO date')
    })

    test('rejects non-positive hours', async () => {
      const client = fakeClient()
      client.findOne
        .mockResolvedValueOnce({ _id: 'issue-1', identifier: 'FUSIO-1' })
        .mockResolvedValueOnce({ attachedTo: 'person-1' })
      await expect(
        operations['issue:time_report'](client, {
          space: 'FUSIO-1',
          employee: 'a@b.com',
          date: '2026-01-15',
          hours: 0
        })
      ).rejects.toThrow('field "hours": expected a positive number')
    })
  })

  describe('doc:update document resolution', () => {
    test('resolves by title when the value is not an id', async () => {
      const client = fakeClient()
      client.findAll.mockResolvedValueOnce([{ _id: 'doc-1', title: 'Runbook' }])
      client.update = jest.fn().mockResolvedValue(undefined)

      const res = await operations['doc:update'](client, { space: 'Runbook', title: 'Runbook v2' })

      expect(res).toEqual({ docId: 'doc-1' })
    })

    test('an ambiguous title is refused, naming the way out', async () => {
      const client = fakeClient()
      client.findAll.mockResolvedValueOnce([{ _id: 'doc-1' }, { _id: 'doc-2' }])

      await expect(operations['doc:update'](client, { space: 'Runbook', title: 'x' })).rejects.toThrow(
        'field "space": multiple documents titled "Runbook", use the document id'
      )
    })

    test('an unknown document fails with a field-named error', async () => {
      const client = fakeClient()
      await expect(operations['doc:update'](client, { space: 'Nope', title: 'x' })).rejects.toThrow(
        'field "space": document not found: "Nope"'
      )
    })
  })

  describe('isOperationGranted', () => {
    it('narrows an API key token to the operations it was granted', () => {
      const key = { apikey: 'k', apiops: 'issue:create,chat:post' }
      expect(isOperationGranted(key, 'issue:create')).toBe(true)
      expect(isOperationGranted(key, 'chat:post')).toBe(true)
      // Would let a chat-only key file issues straight through /api/v1/ops.
      expect(isOperationGranted({ apikey: 'k', apiops: 'chat:post' }, 'issue:create')).toBe(false)
      expect(isOperationGranted({ apikey: 'k', apiops: '' }, 'issue:create')).toBe(false)
    })

    it('refuses every operation for a read-only key, which carries no apiops at all', () => {
      expect(isOperationGranted({ apikey: 'k' }, 'issue:create')).toBe(false)
      expect(isOperationGranted({ apikey: 'k' }, 'chat:post')).toBe(false)
    })

    it('lets an unrestricted key through - it carries its user own rights', () => {
      expect(isOperationGranted({ apikey: 'k', apiall: '1' }, 'issue:create')).toBe(true)
    })

    it('leaves a non-key token alone', () => {
      expect(isOperationGranted(undefined, 'issue:create')).toBe(true)
      expect(isOperationGranted({ service: 'webhook' }, 'issue:create')).toBe(true)
    })
  })
})
