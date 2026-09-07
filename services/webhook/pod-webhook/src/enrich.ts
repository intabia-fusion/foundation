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

import contact, { type Person } from '@hcengineering/contact'
import core, {
  SocialIdType,
  type Class,
  type Doc,
  type MeasureContext,
  type PersonId,
  type Ref,
  type Space,
  type WorkspaceUuid
} from '@hcengineering/core'
import tracker, { IssuePriority } from '@hcengineering/tracker'
import type { Config } from './config'
import { channelUrl, documentUrl, issueUrl, personUrl, type LinkContext } from './links'
import type { WebhookEvent } from './types'
import { getSystemTransactorTarget } from './workspaceClient'

// The names `/api/v1/ops` accepts on the way in (opsApi.ts's PRIORITY_NAMES), so a receiver can send
// back what it was given. Same reason status is a name and a person is an email here.
const PRIORITY_NAMES: Record<number, string> = {
  [IssuePriority.Urgent]: 'urgent',
  [IssuePriority.High]: 'high',
  [IssuePriority.Medium]: 'medium',
  [IssuePriority.Low]: 'low',
  [IssuePriority.NoPriority]: 'no_priority'
}

export interface EnrichCache {
  /** `${workspace}:${ref}` -> resolved token. Misses stay unresolved rather than guessed. */
  statusNames: Map<string, string>
  personEmails: Map<string, string>
  socialIdPersons: Map<string, Ref<Person>>
  spaces: Map<string, { name: string, _class: Ref<Class<Doc>> }>
  issueIdentifiers: Map<string, string>
}

export function createEnrichCache (): EnrichCache {
  return {
    statusNames: new Map(),
    personEmails: new Map(),
    socialIdPersons: new Map(),
    spaces: new Map(),
    issueIdentifiers: new Map()
  }
}

const MAX_ENTRIES = 20_000

function cap<T> (cache: Map<string, T>): void {
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next()
    if (oldest.done === true) break
    cache.delete(oldest.value)
  }
}

function refsOf (value: unknown): string[] {
  return typeof value === 'string' && value !== '' ? [value] : []
}

interface Pending {
  statuses: Set<string>
  persons: Set<string>
  socialIds: Set<string>
  spaces: Set<string>
  issues: Set<string>
}

function collect (events: Array<{ space: Ref<Space>, event: WebhookEvent }>, cache: EnrichCache, ws: string): Pending {
  const pending: Pending = {
    statuses: new Set(),
    persons: new Set(),
    socialIds: new Set(),
    spaces: new Set(),
    issues: new Set()
  }
  for (const { space, event } of events) {
    const data = event.data
    const from = event.updatedFrom ?? {}
    for (const id of [...refsOf(data.status), ...refsOf(from.status)]) {
      if (!cache.statusNames.has(`${ws}:${id}`)) pending.statuses.add(id)
    }
    for (const id of [
      ...refsOf(data.assignee),
      ...refsOf(from.assignee),
      ...refsOf(data.employee),
      ...refsOf(from.employee)
    ]) {
      if (!cache.personEmails.has(`${ws}:${id}`)) pending.persons.add(id)
    }
    for (const id of refsOf(data.issue)) {
      if (!cache.issueIdentifiers.has(`${ws}:${id}`)) pending.issues.add(id)
    }
    if (!cache.socialIdPersons.has(`${ws}:${event.actor}`)) pending.socialIds.add(event.actor)
    if (event.type === 'message.posted' && !cache.spaces.has(`${ws}:${space}`)) pending.spaces.add(space)
  }
  return pending
}

async function load (
  ctx: MeasureContext,
  config: Config,
  workspace: WorkspaceUuid,
  pending: Pending,
  cache: EnrichCache
): Promise<LinkContext> {
  const target = await getSystemTransactorTarget(config, workspace)
  const ws = workspace as string

  if (pending.statuses.size > 0) {
    const statuses = await target.rest.findAll(
      tracker.class.IssueStatus,
      { _id: { $in: Array.from(pending.statuses) as any } },
      { projection: { _id: 1, name: 1 } }
    )
    for (const s of statuses) cache.statusNames.set(`${ws}:${s._id}`, s.name)
  }

  if (pending.socialIds.size > 0) {
    const socials = await target.rest.findAll(
      contact.class.SocialIdentity,
      { _id: { $in: Array.from(pending.socialIds) as any } },
      { projection: { _id: 1, attachedTo: 1 } }
    )
    for (const s of socials) {
      cache.socialIdPersons.set(`${ws}:${s._id}`, s.attachedTo)
      if (!cache.personEmails.has(`${ws}:${s.attachedTo}`)) pending.persons.add(s.attachedTo)
    }
  }

  if (pending.persons.size > 0) {
    // Email social ids are what the ops API resolves a person by, so that is the token to send out.
    const emails = await target.rest.findAll(
      contact.class.SocialIdentity,
      { type: SocialIdType.EMAIL, attachedTo: { $in: Array.from(pending.persons) as any } },
      { projection: { attachedTo: 1, value: 1 } }
    )
    for (const e of emails) {
      if (!cache.personEmails.has(`${ws}:${e.attachedTo}`)) cache.personEmails.set(`${ws}:${e.attachedTo}`, e.value)
    }
  }

  if (pending.issues.size > 0) {
    // A comment or a time report is useless without the issue it hangs on, and the ingest API takes
    // that issue by identifier.
    const issues = await target.rest.findAll(
      tracker.class.Issue,
      { _id: { $in: Array.from(pending.issues) as any } },
      { projection: { _id: 1, identifier: 1 } }
    )
    for (const i of issues) cache.issueIdentifiers.set(`${ws}:${i._id}`, i.identifier)
  }

  if (pending.spaces.size > 0) {
    const spaces = await target.rest.findAll(
      core.class.Space,
      { _id: { $in: Array.from(pending.spaces) as any } },
      { projection: { _id: 1, name: 1, _class: 1 } }
    )
    for (const s of spaces) cache.spaces.set(`${ws}:${s._id}`, { name: s.name, _class: s._class })
  }

  cap(cache.statusNames)
  cap(cache.personEmails)
  cap(cache.socialIdPersons)
  cap(cache.spaces)
  cap(cache.issueIdentifiers)

  return { frontUrl: config.FrontUrl, workspaceUrl: target.workspaceUrl }
}

function personToken (cache: EnrichCache, ws: string, ref: unknown): unknown {
  const email = typeof ref === 'string' ? cache.personEmails.get(`${ws}:${ref}`) : undefined
  return email ?? ref
}

function statusToken (cache: EnrichCache, ws: string, ref: unknown): unknown {
  const name = typeof ref === 'string' ? cache.statusNames.get(`${ws}:${ref}`) : undefined
  return name ?? ref
}

function priorityToken (value: unknown): unknown {
  return typeof value === 'number' ? (PRIORITY_NAMES[value] ?? value) : value
}

function applyFields (fields: Record<string, unknown>, cache: EnrichCache, ws: string): void {
  if ('status' in fields) fields.status = statusToken(cache, ws, fields.status)
  if ('assignee' in fields && fields.assignee !== null) fields.assignee = personToken(cache, ws, fields.assignee)
  if ('employee' in fields && fields.employee !== null) fields.employee = personToken(cache, ws, fields.employee)
  if ('priority' in fields) fields.priority = priorityToken(fields.priority)
}

/**
 * Rewrites the `Ref`s a receiver cannot use into the tokens the ingest API accepts back - a status
 * name, a person's email, a priority name - and adds the document link. Unresolvable values are left
 * as they came: an id no receiver can read still beats a field that silently disappeared.
 */
export async function enrichEvents (
  ctx: MeasureContext,
  config: Config,
  workspace: WorkspaceUuid,
  events: Array<{ space: Ref<Space>, event: WebhookEvent }>,
  cache: EnrichCache
): Promise<void> {
  const ws = workspace as string
  let links: LinkContext
  try {
    links = await load(ctx, config, workspace, collect(events, cache, ws), cache)
  } catch (err) {
    // Never lose an event over a decoration: deliver it with raw refs instead.
    ctx.warn('webhook tx translator: failed to resolve event references', { workspace, err })
    return
  }

  for (const { space, event } of events) {
    const person = cache.socialIdPersons.get(`${ws}:${event.actor}`)
    const actorEmail = person !== undefined ? cache.personEmails.get(`${ws}:${person}`) : undefined
    if (actorEmail !== undefined) event.actor = actorEmail as PersonId
    if (person !== undefined) event.actorUrl = personUrl(links, person)

    applyFields(event.data, cache, ws)
    if (event.updatedFrom !== undefined) applyFields(event.updatedFrom, cache, ws)

    // The parent issue of a comment or a time report, by the identifier the ingest API takes.
    const issueRef = event.data.issue
    const parentIdentifier = typeof issueRef === 'string' ? cache.issueIdentifiers.get(`${ws}:${issueRef}`) : undefined
    if (parentIdentifier !== undefined) event.data.issue = parentIdentifier

    // A raw ref is never turned into a link: the front resolves an issue by identifier only.
    const identifier = typeof event.data.identifier === 'string' ? event.data.identifier : parentIdentifier
    if (identifier !== undefined) {
      event.url = issueUrl(links, identifier)
    } else if (event.type === 'document.created' && typeof event.data.title === 'string') {
      event.url = documentUrl(links, event.data.id as Ref<Doc>, event.data.title)
    } else if (event.type === 'message.posted') {
      const channel = cache.spaces.get(`${ws}:${space}`)
      if (channel !== undefined) {
        // The channel name is what `chat:post` takes as its `space`, so a receiver can answer into it.
        event.data.channel = channel.name
        event.url = channelUrl(links, space, channel._class)
      }
    }
  }
}
