import { type AIConversationPurpose, type AIFeature } from '@hcengineering/ai-bot'
import { AccountUuid, Class, Doc, Markup, MarkupBlobRef, Ref, Space } from '@hcengineering/core'
import document, { Document, getFirstRank, Teamspace } from '@hcengineering/document'
import { makeRank } from '@hcengineering/rank'
import { markdownToMarkup } from '@hcengineering/text-markdown'
import {
  BaseFunctionsArgs,
  RunnableFunctionWithoutParse,
  RunnableFunctionWithParse,
  RunnableToolFunction,
  RunnableToolFunctionWithoutParse,
  RunnableToolFunctionWithParse,
  RunnableTools
} from 'openai/lib/RunnableFunction'
import { Stream } from 'stream'
import { v4 as uuid } from 'uuid'
import { type AILevelFeatures } from '../config'
import config from '../config'
import { applyToolBudget, type ToolBudget } from './budget'
import { WorkspaceClient } from '../workspace/workspaceClient'

async function stream2buffer (stream: Stream): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const _buf = Array<any>()
    stream.on('data', (chunk) => {
      _buf.push(chunk)
    })
    stream.on('end', () => {
      resolve(Buffer.concat(_buf))
    })
    stream.on('error', (err) => {
      reject(new Error(`error converting stream - ${err}`))
    })
  })
}

async function pdfToMarkdown (
  workspaceClient: WorkspaceClient,
  fileId: string,
  name: string | undefined
): Promise<string | undefined> {
  if (config.DataLabApiKey !== '') {
    try {
      const stat = await workspaceClient.storage.stat(workspaceClient.ctx, workspaceClient.wsIds, fileId)
      if (stat?.contentType !== 'application/pdf') {
        return
      }
      const file = await workspaceClient.storage.get(workspaceClient.ctx, workspaceClient.wsIds, fileId)
      const buffer = await stream2buffer(file)

      const url = 'https://www.datalab.to/api/v1/marker'
      const formData = new FormData()
      formData.append('file', new Blob([new Uint8Array(buffer)], { type: 'application/pdf' }), name ?? 'test.pdf')
      formData.append('force_ocr', 'false')
      formData.append('paginate', 'false')
      formData.append('output_format', 'markdown')
      formData.append('use_llm', 'false')
      formData.append('strip_existing_ocr', 'false')
      formData.append('disable_image_extraction', 'false')

      const headers = { 'X-Api-Key': config.DataLabApiKey }

      const response = await fetch(url, {
        method: 'POST',
        body: formData,
        headers
      })

      const data = await response.json()

      if (data.request_check_url !== undefined) {
        for (let attempt = 0; attempt < 10; attempt++) {
          const resp = await fetch(data.request_check_url, { headers })
          const result = await resp.json()
          if (result.status === 'complete' && result.markdown !== undefined) {
            return result.markdown
          }
          await new Promise((resolve) => setTimeout(resolve, 2000))
        }
      }
    } catch (e) {
      console.error(e)
    }
  }
}

async function saveFile (
  workspaceClient: WorkspaceClient,
  user: AccountUuid | undefined,
  args: { fileId: string, folder: string | undefined, parent: string | undefined, name: string }
): Promise<string> {
  const content = await pdfToMarkdown(workspaceClient, args.fileId, args.name)
  if (content === undefined) {
    return 'Error while converting pdf to markdown'
  }
  const converted = JSON.stringify(markdownToMarkup(content))

  const client = workspaceClient.client
  const fileId = uuid()
  await workspaceClient.storage.put(workspaceClient.ctx, workspaceClient.wsIds, fileId, converted, 'application/json')

  const teamspaces = await client.findAll(document.class.Teamspace, {})
  const parent = await client.findOne(document.class.Document, { _id: args.parent as Ref<Document> })
  const teamspaceId = getTeamspace(args.folder, parent, teamspaces)
  const parentId = parent?._id ?? document.ids.NoParent
  const lastRank = await getFirstRank(client, teamspaceId, parentId)
  const rank = makeRank(lastRank, undefined)
  const _id = await client.createDoc(document.class.Document, teamspaceId, {
    title: args.name,
    parent: parentId,
    content: fileId as MarkupBlobRef,
    rank
  })

  return `File saved as ${args.name} with id ${_id}, always provide mention link as: [](ref://?_class=document%3Aclass%3ADocument&_id=${_id}&label=${args.name})`
}

function getTeamspace (
  folder: string | undefined,
  parent: Document | undefined,
  teamspaces: Teamspace[]
): Ref<Teamspace> {
  if (parent !== undefined) return parent.space
  if (folder !== undefined) {
    const teamspace = teamspaces.find(
      (p) => p.name.trim().toLowerCase() === folder.trim().toLowerCase() || p._id === folder
    )
    if (teamspace !== undefined) return teamspace._id
  }
  return teamspaces[0]._id
}

async function getFoldersForDocuments (
  workspaceClient: WorkspaceClient,
  user: AccountUuid | undefined,
  args: Record<string, any>
): Promise<string> {
  const client = workspaceClient.client
  // TODO: need a set of user PersonIds here
  const spaces = await client.findAll(
    document.class.Teamspace,
    user !== undefined ? { members: user, archived: false } : { archived: false }
  )
  let res = 'Folders:\n'
  for (const space of spaces) {
    res += `Id: ${space._id} Name: ${space.name}\n`
  }
  res += 'Parents:\n'
  const parents = await client.findAll(
    document.class.Document,
    { space: { $in: spaces.map((p) => p._id) } },
    { limit: 200 }
  )
  for (const parent of parents) {
    res += `Id: ${parent._id} Name: ${parent.title}\n`
  }
  return res
}

type ChangeFields<T, R> = Omit<T, keyof R> & R
type PredefinedTool<T extends object | string> = ChangeFields<
RunnableToolFunction<T>,
{
  function: PredefinedToolFunction<T>
}
>
type PredefinedToolFunction<T extends object | string> = Omit<
T extends string ? RunnableFunctionWithoutParse : RunnableFunctionWithParse<any>,
'function'
>
/**
 * Proposal a tool produced during the tool loop. Not posted on the spot: it is carried here and
 * merged into the bot's own reply, so the user sees one message with the text and the card.
 */
export type PendingProposal =
  | {
    kind: 'edit'
    targetId: Ref<Doc>
    targetClass: Ref<Class<Doc>>
    targetAttr: string
    // Absent when only the title is proposed.
    proposedMarkup?: Markup
    // Raw markdown staged so far; kept so a follow-up part can be appended to it.
    markdown?: string
    // Proposed new title, applied by the user from the card like the body is.
    title?: string
    // The model said more parts are coming, so the next call continues instead of replacing.
    awaitingMore?: boolean
  }
  | {
    kind: 'task'
    title: string
    description?: string
    subtasks?: Array<{ title: string, description?: string }>
    parent?: Ref<Doc>
    priority?: number
    estimation?: number
    dueDate?: string
    labels?: string[]
    // The model said the description continues, so the next call appends instead of replacing.
    awaitingMore?: boolean
  }

export interface ReqCtx {
  objectId: Ref<Doc>
  objectClass: Ref<Class<Doc>>
  space: Ref<Space>
  collection: string
  // What the conversation is for; tools narrow their behaviour by it.
  purpose?: AIConversationPurpose
  // Filled by the proposal tools, read once the reply text is ready.
  pending?: PendingProposal
  // Ceiling on what tool results add to the context over one run; see utils/budget.ts.
  budget?: ToolBudget
  // Ceiling for a single result. Both are set by the caller from the serving level's window.
  perCallChars?: number
  // The linked document did not fit the window, so only an outline is in context. Editing tools
  // are withheld: a proposal built from a partial body would delete the rest.
  documentReadOnly?: boolean
}
type ToolFunc = (
  workspaceClient: WorkspaceClient,
  user: AccountUuid | undefined,
  args: any,
  reqCtx?: ReqCtx
) => Promise<string> | string

// [definition, handler, where it applies, AI feature it needs, conversation purpose it belongs to]
const tools: [PredefinedTool<any>, ToolFunc, 'direct' | 'thread' | 'any', AIFeature?, AIConversationPurpose?][] = []

export function registerTool<T extends object | string> (
  tool: PredefinedTool<T>,
  func: ToolFunc,
  contextMode: 'direct' | 'thread' | 'any',
  feature?: AIFeature,
  // Set for tools that make sense in one kind of conversation only; they are hidden elsewhere.
  purpose?: AIConversationPurpose
): void {
  tools.push([tool, func, contextMode, feature, purpose])
}

if (config.DataLabApiKey !== '') {
  registerTool(
    {
      type: 'function',
      function: {
        name: 'getDataBeforeImport',
        parameters: {
          type: 'object',
          properties: {}
        },
        description:
          'Get folders and parents for documents. This step necessery before saveFile tool. YOU MUST USE IT BEFORE import file.'
      }
    },
    getFoldersForDocuments,
    'any'
  )
}

if (config.DataLabApiKey !== '') {
  registerTool<object>(
    {
      type: 'function',
      function: {
        name: 'saveFile',
        parse: JSON.parse,
        parameters: {
          type: 'object',
          required: ['fileId, folder, name'],
          properties: {
            fileId: { type: 'string', description: 'File id to parse' },
            folder: {
              type: 'string',
              default: '',
              description:
                'Folder, id from getDataBeforeImport. If not provided you can guess by file name and folder name, or by another file names, if you can`t, just ask user. Don`t provide empty, this field is required. If no folders at all, you should stop pipeline execution and ask user to create teamspace'
            },
            parent: {
              type: 'string',
              default: '',
              description:
                'Parent document, use id from getDataBeforeImport, leave empty string if not provided, it is not necessery, please feel free to pass empty string'
            },
            name: {
              type: 'string',
              description: 'Name for file, try to recognize from user input, if not provided use attached file name'
            }
          }
        },
        description:
          'Parse pdf to markdown and save it, using for import files. Use only if provide file in current message and user require to import/save, if file not provided ask user to attach it. You MUST call getDataBeforeImport tool before for get ids. Use file name as name if user not provide it, don`t use old parameters. You can ask user about folder if you have not enough data to get folder id'
      }
    },
    saveFile,
    'any'
  )
}

function startOfTodayMs (): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const loadThreadHistory: ToolFunc = async (workspaceClient, _user, args, reqCtx) => {
  if (reqCtx === undefined) return 'No conversation context available.'
  let before: number
  if (typeof args?.beforeIso === 'string' && args.beforeIso !== '') {
    const t = Date.parse(args.beforeIso)
    before = isNaN(t) ? startOfTodayMs() : t
  } else {
    before = startOfTodayMs()
  }
  const limit = typeof args?.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 200) : 50
  return await workspaceClient.loadThreadHistory(reqCtx.objectId, reqCtx.objectClass, before, limit)
}

registerTool<object>(
  {
    type: 'function',
    function: {
      name: 'load_thread_history',
      parse: JSON.parse,
      parameters: {
        type: 'object',
        properties: {
          beforeIso: {
            type: 'string',
            description:
              'ISO timestamp; load messages strictly older than this. Defaults to the start of today if omitted.'
          },
          limit: {
            type: 'number',
            description: 'Max number of older messages to load (1..200, default 50).'
          }
        }
      },
      description:
        "Load messages OLDER THAN TODAY from the current channel/thread. Today's messages are ALREADY in the prompt — do NOT call this for questions about today, recent, or the current discussion. Call ONLY when the user explicitly asks about an earlier period (yesterday, last week, a specific past date). Returns older messages as text, oldest first."
    }
  },
  loadThreadHistory,
  'any'
)

const rewriteDocument: ToolFunc = async (workspaceClient, user, args, reqCtx) => {
  if (reqCtx === undefined) return 'No conversation context available.'
  if (typeof args?.markdown !== 'string' || args.markdown.trim() === '') {
    return 'No content provided; pass the full new document as markdown.'
  }
  const target = await workspaceClient.resolveEditTarget(reqCtx.objectId, reqCtx.objectClass)
  if (target === undefined) {
    return 'This conversation is not linked to an editable document, so no edit can be proposed.'
  }
  const hasMore = args?.has_more === true
  const posted = await workspaceClient.postEditProposal(reqCtx, target, args.markdown, hasMore, user)
  if (!posted) {
    return 'The new content is identical to the current document — nothing to change. Do NOT call this tool again unless the user asks for a different change.'
  }
  if (hasMore) {
    const staged = reqCtx.pending?.kind === 'edit' ? (reqCtx.pending.markdown?.length ?? 0) : 0
    return (
      `Part staged; the document now holds ${staged} characters. Call this tool again with ONLY the ` +
      'continuation, picking up exactly where the last part ended. Set has_more=false on the final part.'
    )
  }
  return 'Proposed the edit to the user. They will review a diff and apply it themselves; do not repeat the content or call this tool again.'
}

// tracker IssuePriority, by name so the model does not have to know the numbers.
const PRIORITY: Record<string, number> = { none: 0, urgent: 1, high: 2, medium: 3, low: 4 }

// Subtask list from tool args: the model may pass strings or {title, description, ...} objects.
function parseSubtasks (raw: unknown): Array<{
  title: string
  description?: string
  priority?: number
  estimation?: number
}> {
  if (!Array.isArray(raw)) return []
  return raw
    .map((s: any) => {
      if (typeof s === 'string') return { title: s.trim() }
      const estimation = Number(s?.estimation)
      return {
        title: String(s?.title ?? '').trim(),
        description: s?.description,
        priority: PRIORITY[String(s?.priority ?? '').toLowerCase()],
        estimation: Number.isFinite(estimation) && estimation > 0 ? estimation : undefined
      }
    })
    .filter((s) => s.title !== '')
}

// A long list must arrive in batches: a single call carrying 50 sub-tasks overruns the model's
// output cap (finish_reason=length) and the whole function_call is lost. Repeated calls append.
const MAX_SUBTASKS = 100

const createTask: ToolFunc = async (workspaceClient, _user, args, reqCtx) => {
  if (reqCtx === undefined) return 'No conversation context available.'
  const title = typeof args?.title === 'string' ? args.title.trim() : ''
  const batch = parseSubtasks(args?.subtasks)
  const staged = reqCtx.pending?.kind === 'task' ? reqCtx.pending : undefined
  if (title === '' && staged === undefined) return 'No title provided; pass a short task title.'

  const subtasks = [...(staged?.subtasks ?? []), ...batch].slice(0, MAX_SUBTASKS)
  const hasMore = args?.has_more === true
  const incoming = typeof args?.description === 'string' ? args.description : undefined
  // A description sent in parts is appended; a fresh one replaces what was staged.
  const description =
    incoming === undefined
      ? staged?.description
      : staged?.awaitingMore === true
        ? (staged.description ?? '') + incoming
        : incoming
  const posted = await workspaceClient.postTaskProposal(reqCtx, {
    title: title !== '' ? title : (staged?.title ?? ''),
    description,
    subtasks,
    parent: staged?.parent,
    priority: parsePriority(args?.priority) ?? staged?.priority,
    estimation: typeof args?.estimation === 'number' ? args.estimation : staged?.estimation,
    dueDate: typeof args?.due_date === 'string' ? args.due_date : staged?.dueDate,
    labels: Array.isArray(args?.labels)
      ? args.labels.filter((l: unknown): l is string => typeof l === 'string' && l.trim() !== '')
      : staged?.labels,
    awaitingMore: hasMore
  })
  if (!posted) return 'Could not post the task proposal.'
  if (hasMore) {
    return (
      'Part staged. Call propose_task again with ONLY the next part of the description ' +
      '(no title, no repetition), and set has_more=false on the last part.'
    )
  }
  return batchReply(batch.length, subtasks.length)
}

/**
 * The create-issue dialog's assistant. It edits the draft the user is filling in - there is no
 * issue yet and nothing is created here: the staged result is offered as "apply to the form".
 */
const editIssueDraft: ToolFunc = async (workspaceClient, _user, args, reqCtx) => {
  if (reqCtx === undefined) return 'No conversation context available.'
  const staged = reqCtx.pending?.kind === 'task' ? reqCtx.pending : undefined
  const title = typeof args?.title === 'string' ? args.title.trim() : ''
  const hasMore = args?.has_more === true
  const incoming = typeof args?.description === 'string' ? args.description : undefined
  // A description sent in parts is appended; a fresh one replaces what was staged.
  const description =
    incoming === undefined
      ? staged?.description
      : staged?.awaitingMore === true
        ? (staged.description ?? '') + incoming
        : incoming

  const posted = await workspaceClient.postTaskProposal(reqCtx, {
    title: title !== '' ? title : (staged?.title ?? ''),
    description,
    // A draft is always a single issue: propose_subtasks is not offered in the issue-draft purpose.
    subtasks: [],
    priority: parsePriority(args?.priority) ?? staged?.priority,
    estimation: typeof args?.estimation === 'number' ? args.estimation : staged?.estimation,
    dueDate: typeof args?.due_date === 'string' ? args.due_date : staged?.dueDate,
    labels: Array.isArray(args?.labels)
      ? args.labels.filter((l: unknown): l is string => typeof l === 'string' && l.trim() !== '')
      : staged?.labels,
    awaitingMore: hasMore
  })
  if (!posted) return 'Could not stage the draft.'
  if (hasMore) {
    return (
      'Part staged. Call edit_issue_draft again with ONLY the next part of the description ' +
      '(no title, no repetition), and set has_more=false on the last part.'
    )
  }
  return 'Draft staged; the user sees it and applies it to the form. Do not repeat its content in your reply.'
}

function normalizeTitle (title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ')
}

// tracker IssuePriority: 0 none, 1 urgent, 2 high, 3 medium, 4 low.
const PRIORITY_BY_NAME: Record<string, number> = { none: 0, urgent: 1, high: 2, medium: 3, low: 4 }

function parsePriority (value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  return PRIORITY_BY_NAME[value.trim().toLowerCase()]
}

// Tell the model what is already staged, so it continues the list instead of restarting it.
function batchReply (added: number, total: number): string {
  // A plain task has no sub-tasks: "Staged 0 sub-task(s)" reads as a failure and invites a retry.
  if (total === 0) {
    return 'Task staged; the card is shown to the user, who creates it. Do NOT repeat its content in your reply.'
  }
  const base = `Staged ${added} sub-task(s); the card now holds ${total}.`
  if (total >= MAX_SUBTASKS) return `${base} That is the maximum - stop calling this tool.`
  return (
    `${base} The card is shown to the user with everything staged so far - do NOT repeat it in your ` +
    'reply. If the user asked for more than that, call this tool again with ONLY the next batch ' +
    '(up to 10 new sub-tasks, no duplicates). Otherwise answer in plain text.'
  )
}

const splitTask: ToolFunc = async (workspaceClient, user, args, reqCtx) => {
  if (reqCtx === undefined) return 'No conversation context available.'
  const subtasks = parseSubtasks(args?.subtasks)
  if (subtasks.length === 0) return 'No sub-tasks provided; pass the list to split the task into.'
  const parent = await workspaceClient.resolveLinkedIssue(reqCtx.objectId, reqCtx.objectClass)
  if (parent === undefined) {
    return 'This conversation is not linked to a task, so there is nothing to split. Use create_task instead.'
  }
  const staged = reqCtx.pending?.kind === 'task' ? reqCtx.pending : undefined
  // Sub-tasks the task already has: proposing them again would create duplicates, and the user
  // asked about the existing split, not for a fresh one.
  const existing = await workspaceClient.existingSubIssueTitles(parent, user)
  const fresh = subtasks.filter((s) => !existing.has(normalizeTitle(s.title)))
  const skipped = subtasks.length - fresh.length
  if (fresh.length === 0) {
    return (
      `All ${subtasks.length} sub-task(s) already exist on this task, so nothing was staged. ` +
      'Answer in plain text about the current split instead of proposing it again.'
    )
  }
  const all = [...(staged?.subtasks ?? []), ...fresh].slice(0, MAX_SUBTASKS)
  const posted = await workspaceClient.postTaskProposal(reqCtx, {
    title: typeof args?.title === 'string' ? args.title.trim() : (staged?.title ?? ''),
    subtasks: all,
    parent
  })
  if (!posted) return 'Could not post the task proposal.'
  const reply = batchReply(fresh.length, all.length)
  return skipped > 0 ? `${reply} ${skipped} of them already existed and were dropped.` : reply
}

const listSubtasks: ToolFunc = async (workspaceClient, user, _args, reqCtx) => {
  if (reqCtx === undefined) return 'No conversation context available.'
  const parent = await workspaceClient.resolveLinkedIssue(reqCtx.objectId, reqCtx.objectClass)
  if (parent === undefined) return 'This conversation is not linked to a task, so it has no sub-tasks.'
  const staged = reqCtx.pending?.kind === 'task' ? (reqCtx.pending.subtasks ?? []) : []
  const existing = await workspaceClient.listSubIssues(parent, 100, user)
  if (staged.length === 0) return existing
  // Staged-but-not-created ones are invisible in the DB; list them too or the model re-proposes them.
  return `${existing}\n\nStaged on the card, not created yet (${staged.length}):\n${staged
    .map((s) => `- ${s.title}`)
    .join('\n')}`
}

registerTool<object>(
  {
    type: 'function',
    function: {
      name: 'list_subtasks',
      parse: JSON.parse,
      parameters: { type: 'object', properties: {} },
      description:
        'List the sub-tasks the linked task already has, with short descriptions. Call it BEFORE ' +
        'proposing new ones so you extend the list instead of duplicating it.'
    }
  },
  listSubtasks,
  'thread',
  'tasks'
)

const SUBTASKS_PARAM = {
  type: 'array',
  description:
    'Sub-tasks, each a short actionable title with an optional description. At most 10 per call - ' +
    'for a longer list call the tool again with the next batch; they accumulate on the same card.',
  items: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short title, one line, no markdown.' },
      description: {
        type: 'string',
        description: 'Body as markdown: what has to be done and how to tell it is finished.'
      },
      priority: {
        type: 'string',
        enum: ['none', 'urgent', 'high', 'medium', 'low'],
        description: 'How urgent this sub-task is relative to the others.'
      },
      estimation: { type: 'number', description: 'Rough effort in HOURS. Omit when you cannot judge it.' }
    },
    required: ['title']
  }
}

registerTool<object>(
  {
    type: 'function',
    function: {
      name: 'propose_task',
      parse: JSON.parse,
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short task title, one line, no markdown.' },
          description: {
            type: 'string',
            description:
              'Task body as markdown: what the problem is and what has to be done, summarized from the conversation.'
          },
          has_more: {
            type: 'boolean',
            description:
              'Set to true when the description does not fit this call: send the next part in the following ' +
              'call and it will be appended. Set false (or omit) on the last part.'
          },
          priority: {
            type: 'string',
            enum: ['none', 'urgent', 'high', 'medium', 'low'],
            description: 'How urgent the task is. Omit to leave the current one.'
          },
          estimation: { type: 'number', description: 'Rough effort in HOURS. Omit when you cannot judge it.' },
          due_date: {
            type: 'string',
            description: 'Deadline as YYYY-MM-DD. Omit unless the user named a date.'
          },
          labels: {
            type: 'array',
            items: { type: 'string' },
            description: 'Label names. Only labels that already exist in the workspace are applied.'
          },
          subtasks: SUBTASKS_PARAM
        },
        required: ['title']
      },
      description:
        'Do NOT call this when the conversation is linked to a task and the user asks to change, extend or ' +
        'rewrite THAT task: its description is edited with propose_new_document. ' +
        'Propose a new task built from the conversation (a summary of the problem plus what to do). NOTHING IS ' +
        'CREATED by this call: the user gets an editable card and presses the create button themselves, so it is ' +
        'always safe to call. Use when the user asks to create a task or to turn the discussion into one. ' +
        'A long description must be sent across several calls with has_more=true - one oversized call is cut ' +
        'off at the output limit and lost entirely. Do not echo its content in your reply.'
    }
  },
  createTask,
  'any',
  'tasks'
)

registerTool<object>(
  {
    type: 'function',
    function: {
      name: 'edit_issue_draft',
      parse: JSON.parse,
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Task title, one line, no markdown.' },
          description: {
            type: 'string',
            description: 'Task body as markdown, complete and ready to replace what the user has.'
          },
          has_more: {
            type: 'boolean',
            description:
              'Set to true when the description does not fit this call: send the next part in the ' +
              'following call and it will be appended. Set false (or omit) on the last part.'
          },
          priority: {
            type: 'string',
            enum: ['none', 'urgent', 'high', 'medium', 'low'],
            description: 'How urgent the task is. Omit to leave the current one.'
          },
          estimation: { type: 'number', description: 'Rough effort in HOURS. Omit when you cannot judge it.' },
          due_date: { type: 'string', description: 'Deadline as YYYY-MM-DD. Omit unless the user named a date.' },
          labels: {
            type: 'array',
            items: { type: 'string' },
            description: 'Label names. Only labels that already exist in the workspace are applied.'
          }
        }
      },
      description:
        'Edit the issue the user is drafting in the create dialog. NOTHING IS CREATED: the user gets the ' +
        'result next to the form and applies it themselves. This is the only way to change the draft - ' +
        'always answer with this call and never with the text of the task in your reply. Send only the ' +
        'fields you change, but a description must always be complete (use has_more for a long one). ' +
        'The draft has no sub-tasks: it is a single issue that does not exist yet.'
    }
  },
  editIssueDraft,
  'any',
  'tasks',
  'issue-draft'
)

registerTool<object>(
  {
    type: 'function',
    function: {
      name: 'propose_subtasks',
      parse: JSON.parse,
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Optional heading for the proposal card.' },
          subtasks: SUBTASKS_PARAM
        },
        required: ['subtasks']
      },
      description:
        'Propose splitting the task this conversation is linked to into sub-tasks. NOTHING IS CREATED by this call: ' +
        'the sub-tasks are shown as an editable card the user confirms, so it is always safe to call. Use when the ' +
        'user asks to break the task down.'
    }
  },
  splitTask,
  'thread',
  'tasks'
)

const renameDocument: ToolFunc = async (workspaceClient, user, args, reqCtx) => {
  if (reqCtx === undefined) return 'No conversation context available.'
  const title = typeof args?.title === 'string' ? args.title.trim() : ''
  if (title === '') return 'No title provided.'
  const target = await workspaceClient.resolveEditTarget(reqCtx.objectId, reqCtx.objectClass)
  if (target === undefined) {
    return 'This conversation is not linked to a document or task, so there is nothing to rename.'
  }
  const staged = await workspaceClient.proposeRename(reqCtx, target, title, user)
  return staged
    ? 'Proposed the new title to the user; they apply it themselves. Do not repeat it in your reply.'
    : 'The title is already that; nothing to rename.'
}

registerTool<object>(
  {
    type: 'function',
    function: {
      name: 'rename_document',
      parse: JSON.parse,
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'The new title. Plain text, one line, no markdown and no quotes around it.'
          }
        },
        required: ['title']
      },
      description:
        'Propose a new title for the linked document or task: the title only, never its body. NOTHING IS ' +
        'CHANGED by this call - the user gets the new title on a card and applies it themselves, so it is ' +
        'always safe to call. Use when the user asks to rename it or to give it a name. Do not also call ' +
        'propose_new_document for the title.'
    }
  },
  renameDocument,
  'thread'
)

registerTool<object>(
  {
    type: 'function',
    function: {
      name: 'propose_new_document',
      parse: JSON.parse,
      parameters: {
        type: 'object',
        properties: {
          markdown: {
            type: 'string',
            description:
              'The new document body as RAW markdown. Take the CURRENT DOCUMENT shown in the system ' +
              'context, apply the requested change, and pass the result. NOT a diff. ' +
              'Do NOT wrap it in ``` code fences. ' +
              "Never include the user's request text or chat comments in it. " +
              'If the document does not fit in one reply, send it in parts with has_more (see below): ' +
              'a part that hits the output cap is lost entirely, so stop well before it.'
          },
          has_more: {
            type: 'boolean',
            description:
              'Set to true when this is only part of the document and the rest follows in the next call. ' +
              'The parts are joined in order, so continue exactly where this one ended - do not repeat ' +
              'what you already sent and do not re-send the beginning. Set false (or omit) on the last part.'
          }
        },
        required: ['markdown']
      },
      description:
        'Propose a new version of the linked document/issue. NOTHING IS CHANGED by this call: the user is shown ' +
        'your version next to the current one with an Apply button, and only they can apply it. So it is always ' +
        'safe to call - never refuse for fear of overwriting. Pass the new body as markdown, built from ' +
        'the CURRENT DOCUMENT in the system context with only the requested change applied. A long document may ' +
        'be sent across several calls using has_more. Use when the user ' +
        'asks to change/edit/rewrite/fill the document. Do not echo the content in your reply.'
    }
  },
  rewriteDocument,
  'thread'
)

/** Tools that replace a document body wholesale; useless and dangerous on a partial body. */
const WHOLE_BODY_TOOLS = new Set(['propose_new_document', 'edit_issue_draft'])

// Drafting an issue that does not exist yet: the model may only rewrite that draft. propose_task
// creates a separate issue, sub-task and document tools act on objects that do not exist here.
const PURPOSE_TOOLS: Record<AIConversationPurpose, Set<string>> = {
  'issue-draft': new Set(['edit_issue_draft', 'load_thread_history'])
}

export function getTools (
  workspaceClient: WorkspaceClient,
  contextMode: 'direct' | 'thread',
  user: AccountUuid | undefined,
  reqCtx?: ReqCtx,
  features?: AILevelFeatures,
  purpose?: AIConversationPurpose
): RunnableTools<BaseFunctionsArgs> {
  const allowed = purpose !== undefined ? PURPOSE_TOOLS[purpose] : undefined
  const result: (RunnableToolFunctionWithoutParse | RunnableToolFunctionWithParse<any>)[] = []
  for (const tool of tools) {
    const name = tool[0].function.name
    if (allowed !== undefined && (name === undefined || !allowed.has(name))) continue
    // Partial body in context: offering a rewrite tool invites silent data loss.
    if (reqCtx?.documentReadOnly === true && name !== undefined && WHOLE_BODY_TOOLS.has(name)) continue
    // Purpose-bound tools stay out of every other conversation.
    if (tool[4] !== undefined && tool[4] !== purpose) continue
    // A level that denies the feature does not get its tools: a weak model would call them and fail.
    if (tool[3] !== undefined && features?.[tool[3]] === false) continue
    if (tool[2] === contextMode || tool[2] === 'any') {
      const res: RunnableToolFunctionWithoutParse | RunnableToolFunctionWithParse<any> = {
        ...tool[0],
        function: {
          ...tool[0].function,
          // The budget is applied here, not in each tool: one place, and every new tool is covered
          // without having to remember about it.
          function: async (args: any) => {
            const out = await tool[1](workspaceClient, user, args, reqCtx)
            if (typeof out !== 'string' || reqCtx?.perCallChars === undefined) return out
            return applyToolBudget(out, reqCtx.perCallChars, reqCtx.budget)
          }
        }
      }
      result.push(res)
    }
  }
  return result
}
