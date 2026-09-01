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

import type { ApiKeyOperation } from '@hcengineering/account-client'
import { type Channel, postMessage, resolveChannel } from '@hcengineering/chunter'
import { saveCollabJson } from '@hcengineering/collaboration'
import contact, { type Employee, type Person } from '@hcengineering/contact'
import {
  type Blob,
  type CollaborativeDoc,
  type Markup,
  type MarkupBlobRef,
  type MeasureContext,
  type Ref,
  SocialIdType,
  type Timestamp,
  type TxOperations,
  type WorkspaceIds
} from '@hcengineering/core'
import document, {
  type Document,
  type DocumentUpdateData,
  type Teamspace,
  createDocument,
  updateDocument
} from '@hcengineering/document'
import platform, { PlatformError, Severity, Status } from '@hcengineering/platform'
import type { StorageAdapter } from '@hcengineering/server-core'
import task from '@hcengineering/task'
import { jsonToMarkup } from '@hcengineering/text-core'
import { markdownToMarkup } from '@hcengineering/text-markdown'
import tracker, {
  type CreatedIssue,
  type Issue,
  type IssueStatus,
  type IssueUpdate,
  IssuePriority,
  type NewIssue,
  type Project,
  commentIssue,
  createIssue,
  reportTime,
  updateIssue
} from '@hcengineering/tracker'

/** Uploads collaborative markup and returns the resulting blob ref - structurally the same contract
 * `createIssue`/`updateIssue`/`createDocument`/`updateDocument` already accept. Optional: a caller that
 * never needs it (comments, chat, time reports) or a test can omit it. */
export type UploadMarkupFn = (collabId: CollaborativeDoc, markup: Markup) => Promise<Ref<Blob>>

/** Backed by the same collaborative storage helper `server/tool`'s initializer and `server/collaborator`
 * use - the transactor needs no collaborator-client of its own, just the storage adapter it already has. */
export function makeUploadMarkup (
  ctx: MeasureContext,
  storageAdapter: StorageAdapter,
  wsIds: WorkspaceIds
): UploadMarkupFn {
  return async (collabId, markup) => await saveCollabJson(ctx, storageAdapter, wsIds, collabId, markup)
}

// Resolves human identifiers and calls `ops` over the transactor's own pipeline, so the pod needs no
// model. The caller checks the `ops` grant; the middleware scopes the resulting txes to the spaces.
export type OpsExecutor = (
  client: TxOperations,
  payload: Record<string, unknown>,
  uploadMarkup?: UploadMarkupFn
) => Promise<Record<string, unknown>>

// ---- payload field helpers -------------------------------------------------

// Permanent errors, never worth a retry. `.message` is overwritten because PlatformError's default
// JSON-escapes it, and the caller reads the field name out of the plain text.
function badRequest (message: string): PlatformError {
  const err = new PlatformError(new Status(Severity.ERROR, platform.status.BadRequest, { message }))
  err.message = message
  return err
}

function requireString (payload: Record<string, unknown>, field: string): string {
  const value = payload[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw badRequest(`field "${field}": required`)
  }
  return value
}

function optionalString (payload: Record<string, unknown>, field: string): string | undefined {
  const value = payload[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw badRequest(`field "${field}": expected a string`)
  }
  return value
}

// `body` (markdown) replaces a raw-markup/already-uploaded field - two sources for the same value is
// a caller bug, not something to silently prioritize between.
function optionalMarkdown (
  payload: Record<string, unknown>,
  bodyField: string,
  conflictsWith: string[]
): Markup | undefined {
  const body = optionalString(payload, bodyField)
  if (body === undefined) return undefined
  for (const field of conflictsWith) {
    if (payload[field] !== undefined) {
      throw badRequest(`field "${bodyField}": cannot be combined with "${field}"`)
    }
  }
  return jsonToMarkup(markdownToMarkup(body))
}

function optionalNumber (payload: Record<string, unknown>, field: string): number | undefined {
  const value = payload[field]
  if (value === undefined) return undefined
  if (typeof value !== 'number') {
    throw badRequest(`field "${field}": expected a number`)
  }
  return value
}

function requirePositiveNumber (payload: Record<string, unknown>, field: string): number {
  const value = payload[field]
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw badRequest(`field "${field}": expected a positive number`)
  }
  return value
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

// Rejects both malformed strings and calendar rollovers (e.g. "2026-02-30"), which Date.parse
// silently accepts and rolls into March.
function parseDate (payload: Record<string, unknown>, field: string): Timestamp {
  const value = requireString(payload, field)
  const ts = ISO_DATE.test(value) ? Date.parse(`${value}T00:00:00.000Z`) : NaN
  if (Number.isNaN(ts) || new Date(ts).toISOString().slice(0, 10) !== value) {
    throw badRequest(`field "${field}": expected an ISO date (YYYY-MM-DD), got "${value}"`)
  }
  return ts
}

const PRIORITY_NAMES: Record<string, IssuePriority> = {
  urgent: IssuePriority.Urgent,
  high: IssuePriority.High,
  medium: IssuePriority.Medium,
  low: IssuePriority.Low,
  none: IssuePriority.NoPriority,
  no_priority: IssuePriority.NoPriority
}

function parsePriority (value: string | undefined): IssuePriority | undefined {
  if (value === undefined) return undefined
  const priority = PRIORITY_NAMES[value.toLowerCase()]
  if (priority === undefined) {
    throw badRequest(`field "priority": unknown value "${value}"`)
  }
  return priority
}

// ---- reference resolution ---------------------------------------------------
// Every resolver throws `field "<name>": <what wasn't found>`, never a generic "invalid_payload".

async function resolveProject (client: TxOperations, identifier: string): Promise<Project> {
  const project = await client.findOne(tracker.class.Project, { identifier })
  if (project === undefined) {
    throw badRequest(`field "space": project not found: "${identifier}"`)
  }
  return project
}

async function resolveIssue (client: TxOperations, identifier: string, field: string = 'space'): Promise<Issue> {
  const issue = await client.findOne(tracker.class.Issue, { identifier })
  if (issue === undefined) {
    throw badRequest(`field "${field}": issue not found: "${identifier}"`)
  }
  return issue
}

async function resolvePersonByEmail (
  client: TxOperations,
  email: string,
  field: string = 'assignee'
): Promise<Ref<Person>> {
  // Email social ids are stored lowercased, so a caller writing User@Example.com must still match.
  const social = await client.findOne(contact.class.SocialIdentity, {
    type: SocialIdType.EMAIL,
    value: email.toLowerCase()
  })
  if (social === undefined) {
    throw badRequest(`field "${field}": no person found for email "${email}"`)
  }
  return social.attachedTo
}

// Statuses belong to a task type, not to the project as a whole: matched against this issue's own
// `kind`, so a project carrying several task types cannot resolve a status the issue can never hold.
async function resolveStatus (client: TxOperations, issue: Issue, name: string): Promise<Ref<IssueStatus>> {
  const taskType = await client.findOne(task.class.TaskType, { _id: issue.kind })
  const statuses =
    taskType !== undefined
      ? await client.findAll(tracker.class.IssueStatus, { _id: { $in: taskType.statuses as Ref<IssueStatus>[] } })
      : []
  const match = statuses.find((s) => s.name.toLowerCase() === name.toLowerCase())
  if (match === undefined) {
    const project = await client.findOne(tracker.class.Project, { _id: issue.space })
    throw badRequest(`field "status": unknown status "${name}" for project "${project?.identifier ?? issue.space}"`)
  }
  return match._id
}

async function resolveTeamspace (client: TxOperations, nameOrRef: string): Promise<Teamspace> {
  const byRef = await client.findOne(document.class.Teamspace, { _id: nameOrRef as Ref<Teamspace> })
  if (byRef !== undefined) return byRef

  const byName = await client.findAll(document.class.Teamspace, { name: nameOrRef })
  if (byName.length === 0) {
    throw badRequest(`field "space": teamspace not found: "${nameOrRef}"`)
  }
  if (byName.length > 1) {
    throw badRequest(`field "space": multiple teamspaces named "${nameOrRef}"`)
  }
  return byName[0]
}

// Id or title, like resolveTeamspace - an external system has no way to learn a document's internal id.
async function resolveDocument (client: TxOperations, idOrTitle: string, field: string = 'space'): Promise<Document> {
  const byId = await client.findOne(document.class.Document, { _id: idOrTitle as Ref<Document> })
  if (byId !== undefined) return byId

  const byTitle = await client.findAll(document.class.Document, { title: idOrTitle })
  if (byTitle.length === 0) {
    throw badRequest(`field "${field}": document not found: "${idOrTitle}"`)
  }
  if (byTitle.length > 1) {
    throw badRequest(`field "${field}": multiple documents titled "${idOrTitle}", use the document id`)
  }
  return byTitle[0]
}

// ---- operations --------------------------------------------------------------
// `descriptionRef`/`contentRef` (already-uploaded) and `message` (Markup) arrive ready to use. A raw
// `description`/`content`/`body` needs uploading - `uploadMarkup` does that via the storage adapter
// threaded through from rpc.ts (see makeUploadMarkup above).

const issueCreate: OpsExecutor = async (client, payload, uploadMarkup) => {
  const project = await resolveProject(client, requireString(payload, 'space'))
  const title = requireString(payload, 'title')
  const description =
    optionalMarkdown(payload, 'body', ['description', 'descriptionRef']) ?? optionalString(payload, 'description')
  const descriptionRef = optionalString(payload, 'descriptionRef') as MarkupBlobRef | undefined
  const assigneeEmail = optionalString(payload, 'assignee')
  const assignee = assigneeEmail !== undefined ? await resolvePersonByEmail(client, assigneeEmail) : undefined
  const priority = parsePriority(optionalString(payload, 'priority'))
  const estimation = optionalNumber(payload, 'estimation')
  const parentId = optionalString(payload, 'parent')
  const parent = parentId !== undefined ? await resolveIssue(client, parentId, 'parent') : undefined

  const data: NewIssue = { title, description, descriptionRef, assignee, priority, estimation, parent }
  const created: CreatedIssue = await createIssue(client, project, data, uploadMarkup)
  return { identifier: created.identifier }
}

const issueUpdate: OpsExecutor = async (client, payload, uploadMarkup) => {
  const issue = await resolveIssue(client, requireString(payload, 'space'))

  const update: IssueUpdate = {}
  const title = optionalString(payload, 'title')
  if (title !== undefined) update.title = title
  const description =
    optionalMarkdown(payload, 'body', ['description', 'descriptionRef']) ?? optionalString(payload, 'description')
  if (description !== undefined) update.description = description
  const descriptionRef = optionalString(payload, 'descriptionRef') as MarkupBlobRef | undefined
  if (descriptionRef !== undefined) update.descriptionRef = descriptionRef
  const priority = parsePriority(optionalString(payload, 'priority'))
  if (priority !== undefined) update.priority = priority
  if ('assignee' in payload) {
    const raw = payload.assignee
    if (raw === null) {
      update.assignee = null
    } else if (typeof raw === 'string' && raw.length > 0) {
      update.assignee = await resolvePersonByEmail(client, raw)
    } else {
      throw badRequest('field "assignee": expected a string or null')
    }
  }
  const statusName = optionalString(payload, 'status')
  if (statusName !== undefined) update.status = await resolveStatus(client, issue, statusName)

  await updateIssue(client, issue, update, uploadMarkup)
  return { identifier: issue.identifier }
}

const issueComment: OpsExecutor = async (client, payload) => {
  const issue = await resolveIssue(client, requireString(payload, 'space'))
  const message = requireString(payload, 'message')

  const messageId = await commentIssue(client, issue, message)
  return { messageId }
}

const issueTimeReport: OpsExecutor = async (client, payload) => {
  const issue = await resolveIssue(client, requireString(payload, 'space'))
  const employee = (await resolvePersonByEmail(client, requireString(payload, 'employee'), 'employee')) as Ref<Employee>
  const date = parseDate(payload, 'date')
  const hours = requirePositiveNumber(payload, 'hours')
  const description = optionalString(payload, 'description')

  const reportId = await reportTime(client, issue, employee, date, hours, description)
  return { reportId }
}

const chatPost: OpsExecutor = async (client, payload) => {
  const channel: Channel = await resolveChannel(client, requireString(payload, 'space'))
  const message = requireString(payload, 'message')

  const messageId = await postMessage(client, channel, message)
  return { messageId }
}

const docCreate: OpsExecutor = async (client, payload, uploadMarkup) => {
  const teamspace = await resolveTeamspace(client, requireString(payload, 'space'))
  const title = requireString(payload, 'title')
  const content = optionalMarkdown(payload, 'body', ['content', 'contentRef']) ?? optionalString(payload, 'content')
  const contentRef = optionalString(payload, 'contentRef') as MarkupBlobRef | undefined
  // ponytail: parent takes a raw Ref<Document> - documents have no human identifier like an issue's
  // FUSIO-42, add title-scoped lookup if callers need to name a parent doc instead of pasting its id.
  const parent = optionalString(payload, 'parent') as Ref<Document> | undefined

  const docId = await createDocument(client, teamspace._id, { title, content, contentRef, parent }, uploadMarkup)
  return { docId }
}

const docUpdate: OpsExecutor = async (client, payload, uploadMarkup) => {
  const doc = await resolveDocument(client, requireString(payload, 'space'))

  const update: DocumentUpdateData = {}
  const title = optionalString(payload, 'title')
  if (title !== undefined) update.title = title
  const content = optionalMarkdown(payload, 'body', ['content', 'contentRef']) ?? optionalString(payload, 'content')
  if (content !== undefined) update.content = content
  const contentRef = optionalString(payload, 'contentRef') as MarkupBlobRef | undefined
  if (contentRef !== undefined) update.contentRef = contentRef

  await updateDocument(client, doc, update, uploadMarkup)
  return { docId: doc._id }
}

// Single source of truth for what `/api/v1/ops/:operation/:workspaceId` can execute.
export const operations: Record<ApiKeyOperation, OpsExecutor> = {
  'issue:create': issueCreate,
  'issue:update': issueUpdate,
  'issue:comment': issueComment,
  'issue:time_report': issueTimeReport,
  'chat:post': chatPost,
  'doc:create': docCreate,
  'doc:update': docUpdate
}

/**
 * The middleware never looks at operation names, so the grant is checked here. Keyed off `apikey`, not
 * `apiops`: a read-only key carries no `apiops` at all, and treating that as "not a key token" would
 * let it run every operation. `apiall` is an unrestricted key - the user's own rights, nothing to narrow.
 */
export function isOperationGranted (extra: Record<string, any> | undefined, operation: ApiKeyOperation): boolean {
  if (extra?.apikey == null) return true
  if (extra.apiall != null) return true
  return String(extra.apiops ?? '')
    .split(',')
    .includes(operation)
}
