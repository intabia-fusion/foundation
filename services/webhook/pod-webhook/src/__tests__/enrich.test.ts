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

jest.mock('../workspaceClient', () => ({
  getSystemTransactorTarget: jest.fn()
}))

/* eslint-disable import/first */
import contact from '@hcengineering/contact'
import core, { MeasureMetricsContext, type Ref, type Space, type WorkspaceUuid } from '@hcengineering/core'
import tracker, { IssuePriority } from '@hcengineering/tracker'
import { createEnrichCache, enrichEvents } from '../enrich'
import type { WebhookEvent } from '../types'
import { getSystemTransactorTarget } from '../workspaceClient'

const ctx = new MeasureMetricsContext('test', {})
const workspace = 'ws-1' as WorkspaceUuid
const SPACE = 'space-1' as Ref<Space>
const config: any = { FrontUrl: 'https://front.example.com' }

const ACTOR_SOCIAL = 'social-1'
const ACTOR_PERSON = 'person-1'
const ASSIGNEE_PERSON = 'person-2'

function setTransactor (rows: (_class: any, query: any) => any[]): void {
  ;(getSystemTransactorTarget as jest.Mock).mockResolvedValue({
    workspaceUrl: 'acme',
    rest: {
      findAll: async (_class: any, query: any) => rows(_class, query)
    }
  })
}

function defaultRows (_class: any, query: any): any[] {
  if (_class === tracker.class.IssueStatus) {
    return [
      { _id: 'status-new', name: 'In Progress' },
      { _id: 'status-old', name: 'Todo' }
    ]
  }
  if (_class === contact.class.SocialIdentity) {
    // First pass resolves the actor's social id, second one every person's email.
    if (query._id !== undefined) return [{ _id: ACTOR_SOCIAL, attachedTo: ACTOR_PERSON }]
    return [
      { attachedTo: ACTOR_PERSON, value: 'author@example.com' },
      { attachedTo: ASSIGNEE_PERSON, value: 'assignee@example.com' }
    ]
  }
  if (_class === tracker.class.Issue) {
    return [{ _id: 'issue-1', identifier: 'FUSIO-123' }]
  }
  if (_class === core.class.Space) {
    return [{ _id: SPACE, name: 'general', _class: 'chunter:class:Channel' }]
  }
  return []
}

function statusEvent (): WebhookEvent {
  return {
    action: 'update',
    type: 'issue.status_changed',
    actor: ACTOR_SOCIAL as any,
    data: { id: 'issue-1', identifier: 'FUSIO-123', status: 'status-new' },
    updatedFrom: { status: 'status-old' },
    organizationId: workspace
  }
}

describe('enrichEvents', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setTransactor(defaultRows)
  })

  it('sends the status name the ingest API accepts back, not its ref', async () => {
    const event = statusEvent()
    await enrichEvents(ctx, config, workspace, [{ space: SPACE, event }], createEnrichCache())

    expect(event.data.status).toBe('In Progress')
    expect(event.updatedFrom?.status).toBe('Todo')
  })

  it('sends people as emails and links them', async () => {
    const event: WebhookEvent = {
      action: 'create',
      type: 'issue.created',
      actor: ACTOR_SOCIAL as any,
      data: { id: 'issue-1', identifier: 'FUSIO-123', assignee: ASSIGNEE_PERSON, priority: IssuePriority.Urgent },
      organizationId: workspace
    }
    await enrichEvents(ctx, config, workspace, [{ space: SPACE, event }], createEnrichCache())

    expect(event.actor).toBe('author@example.com')
    expect(event.actorUrl).toBe(`https://front.example.com/workbench/acme/contact/${ACTOR_PERSON}`)
    expect(event.data.assignee).toBe('assignee@example.com')
    expect(event.data.priority).toBe('urgent')
    expect(event.url).toBe('https://front.example.com/workbench/acme/tracker/FUSIO-123')
  })

  it('names the channel a chat message landed in, so a receiver can answer into it', async () => {
    const event: WebhookEvent = {
      action: 'create',
      type: 'message.posted',
      actor: ACTOR_SOCIAL as any,
      data: { id: 'msg-1', message: 'Deploy finished' },
      organizationId: workspace
    }
    await enrichEvents(ctx, config, workspace, [{ space: SPACE, event }], createEnrichCache())

    expect(event.data.channel).toBe('general')
    expect(event.url).toBe(`https://front.example.com/workbench/acme/chunter/${SPACE}|chunter:class:Channel`)
  })

  it('links a document by id, the segment its resolver reads', async () => {
    const event: WebhookEvent = {
      action: 'create',
      type: 'document.created',
      actor: ACTOR_SOCIAL as any,
      data: { id: 'doc-1', title: 'Q3 Roadmap' },
      organizationId: workspace
    }
    await enrichEvents(ctx, config, workspace, [{ space: SPACE, event }], createEnrichCache())

    expect(event.url).toBe('https://front.example.com/workbench/acme/document/q3-roadmap-doc-1')
  })

  it('names the issue a time report hangs on and links it', async () => {
    const event: WebhookEvent = {
      action: 'create',
      type: 'issue.time_reported',
      actor: ACTOR_SOCIAL as any,
      data: { id: 'report-1', issue: 'issue-1', employee: ASSIGNEE_PERSON, value: 2.5 },
      organizationId: workspace
    }
    await enrichEvents(ctx, config, workspace, [{ space: SPACE, event }], createEnrichCache())

    expect(event.data.issue).toBe('FUSIO-123')
    expect(event.data.employee).toBe('assignee@example.com')
    expect(event.url).toBe('https://front.example.com/workbench/acme/tracker/FUSIO-123')
  })

  it('does not build a link from an issue ref it could not resolve', async () => {
    setTransactor((_class: any, query: any) => (_class === tracker.class.Issue ? [] : defaultRows(_class, query)))
    const event: WebhookEvent = {
      action: 'create',
      type: 'issue.commented',
      actor: ACTOR_SOCIAL as any,
      data: { id: 'msg-1', issue: 'issue-1', message: 'hi' },
      organizationId: workspace
    }
    await enrichEvents(ctx, config, workspace, [{ space: SPACE, event }], createEnrichCache())

    expect(event.data.issue).toBe('issue-1')
    expect(event.url).toBeUndefined()
  })

  it('rewrites the previous employee in updatedFrom too', async () => {
    const event: WebhookEvent = {
      action: 'update',
      type: 'issue.time_report_updated',
      actor: ACTOR_SOCIAL as any,
      data: { id: 'report-1', issue: 'issue-1', employee: ASSIGNEE_PERSON },
      updatedFrom: { employee: ACTOR_PERSON },
      organizationId: workspace
    }
    await enrichEvents(ctx, config, workspace, [{ space: SPACE, event }], createEnrichCache())

    expect(event.data.employee).toBe('assignee@example.com')
    expect(event.updatedFrom?.employee).toBe('author@example.com')
  })

  it('leaves refs untouched when the transactor is unreachable', async () => {
    ;(getSystemTransactorTarget as jest.Mock).mockRejectedValue(new Error('down'))
    const event = statusEvent()

    await enrichEvents(ctx, config, workspace, [{ space: SPACE, event }], createEnrichCache())

    expect(event.data.status).toBe('status-new')
    expect(event.url).toBeUndefined()
  })

  it('omits links when the pod has no front url configured', async () => {
    const event = statusEvent()
    await enrichEvents(ctx, { FrontUrl: '' } as any, workspace, [{ space: SPACE, event }], createEnrichCache())

    expect(event.url).toBeUndefined()
    expect(event.data.status).toBe('In Progress')
  })

  it('resolves each ref once across a batch', async () => {
    const findAll = jest.fn(defaultRows)
    ;(getSystemTransactorTarget as jest.Mock).mockResolvedValue({
      workspaceUrl: 'acme',
      rest: { findAll: async (_class: any, query: any) => findAll(_class, query) }
    })
    const cache = createEnrichCache()

    await enrichEvents(ctx, config, workspace, [{ space: SPACE, event: statusEvent() }], cache)
    const afterFirst = findAll.mock.calls.length
    await enrichEvents(ctx, config, workspace, [{ space: SPACE, event: statusEvent() }], cache)

    expect(findAll.mock.calls.length).toBe(afterFirst)
  })
})
