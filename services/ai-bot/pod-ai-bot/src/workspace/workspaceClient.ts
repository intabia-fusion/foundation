//
// Copyright © 2024 Hardcore Engineering Inc.
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
import aiBot, {
  AIEventRequest,
  type AIContextMessage,
  type AIEditProposalMessage,
  type AIPersonalData,
  type AIRequest,
  aiBotEmailSocialKey,
  ConnectMeetingRequest,
  DisconnectMeetingRequest,
  IdentityResponse
} from '@hcengineering/ai-bot'
import attachment, { Attachment } from '@hcengineering/attachment'
import chunter, { ChatMessage, ThreadMessage, DirectMessage } from '@hcengineering/chunter'
import contact, {
  AvatarType,
  combineName,
  ensureEmployee,
  getFirstName,
  getLastName,
  Person,
  SocialIdentity
} from '@hcengineering/contact'
import core, {
  AccountRole,
  AccountUuid,
  Blob,
  Class,
  Doc,
  MeasureContext,
  PersonId,
  PersonUuid,
  pickPrimarySocialId,
  RateLimiter,
  Ref,
  SocialId,
  SortingOrder,
  Space,
  Timestamp,
  withContext,
  systemAccountUuid,
  type Account,
  type WorkspaceIds
} from '@hcengineering/core'
import love, { type MeetingMinutes } from '@hcengineering/love'
import pulse, { type TypingIndicator } from '@hcengineering/pulse'
import fs from 'fs'
import type { LLMProvider, ChatMessage as LLMChatMessage, ContextMode } from '../llms'
import type { AILevel } from '../config'
import { getTools, type ReqCtx } from '../utils/tools'
import { resolveMemory, type AIMemory } from './memory'
import { donePatch, failedPatch, queuedRequest } from './aiRequest'
import { resolveModel, planMultiplier } from '../llms/modelRegistry'
import { getWorkspaceWindows } from '../billing'
import { decideLevel } from './windowLimit'
import { buildThreadContext, type ContextMessage } from './threadContext'

// Token counting and other LLM operations are delegated to the injected LLM provider
import { type IntlString, translate } from '@hcengineering/platform'
import { getAccountClient } from '@hcengineering/server-client'
import { generateToken } from '@hcengineering/server-token'
import { ConsumerControl, StorageAdapter } from '@hcengineering/server-core'
import { jsonToMarkup, markupToJSON, markupToText } from '@hcengineering/text'
import { markdownToMarkup, markupToMarkdown } from '@hcengineering/text-markdown'
import tracker, { Issue } from '@hcengineering/tracker'
import document, { type Document } from '@hcengineering/document'
import config from '../config'
import { getGlobalPerson } from '../utils/account'
import { connectPlatform } from '../utils/platform'
import { LoveController } from './love'
import { RestClient } from '@hcengineering/api-client'
import { CollaboratorClient, getClient as getCollaboratorClient } from '@hcengineering/collaborator-client'

interface LLMHistoryRecord {
  role: 'user' | 'assistant' | 'system'
  content: string
}

// Collapse whitespace for a change-detection compare, so a re-emitted-but-identical document
// (common with small models) is treated as a no-op regardless of trailing/interior spacing.
function normalizeForCompare (md: string): string {
  return md.replace(/\s+/g, ' ').trim()
}

export class WorkspaceClient {
  client: RestClient

  rate = new RateLimiter(1)

  primarySocialId: SocialId
  aiPerson: Person | undefined
  personUuidBySocialId = new Map<PersonId, PersonUuid>()

  love: LoveController | undefined
  memoryMap = new Map<PersonUuid, AIMemory>()
  userSocialIdByPersonUuid = new Map<PersonUuid, PersonId>()
  initPromise: Promise<void> | undefined

  collaborator: CollaboratorClient | undefined

  constructor (
    readonly storage: StorageAdapter,
    readonly transactorUrl: string,
    readonly token: string,
    readonly wsIds: WorkspaceIds,
    readonly personUuid: AccountUuid,
    readonly socialIds: SocialId[],
    readonly ctx: MeasureContext,
    readonly collaboratorEndpoint: string | undefined,
    readonly llm?: LLMProvider
  ) {
    this.client = connectPlatform(this.token, this.wsIds.uuid, this.transactorUrl)
    this.primarySocialId = pickPrimarySocialId(this.socialIds)
    if (this.collaboratorEndpoint !== undefined && this.collaboratorEndpoint !== '') {
      this.ctx.info('create collaborator client', { endpoint: this.collaboratorEndpoint })
      this.collaborator = getCollaboratorClient(this.wsIds.uuid, this.token, this.collaboratorEndpoint)
    }
    this.initPromise = this.initClient()
  }

  private async ensureEmployee (client: RestClient): Promise<void> {
    const me: Account = {
      uuid: this.personUuid,
      role: AccountRole.User,
      primarySocialId: this.primarySocialId._id,
      socialIds: this.socialIds.map((it) => it._id),
      fullSocialIds: this.socialIds
    }
    await ensureEmployee(this.ctx, me, client, this.socialIds, async () => await getGlobalPerson(this.token))
  }

  /**
   * Remove duplicate AI bot Person records that were left after workspace backup/restore.
   * Finds all SocialIdentity with aiBotEmailSocialKey, keeps only the Person matching
   * current personUuid, and removes the rest along with their SocialIdentities.
   */
  private async cleanupDuplicatePersons (client: RestClient): Promise<void> {
    try {
      const aiSocialIdentities = await client.findAll<SocialIdentity>(contact.class.SocialIdentity, {
        key: aiBotEmailSocialKey
      })

      if (aiSocialIdentities.length <= 1) {
        return
      }

      const personIds = new Set(aiSocialIdentities.map((si) => si.attachedTo))
      const persons = await client.findAll(contact.class.Person, {
        _id: { $in: Array.from(personIds) }
      })

      const duplicatePersons = persons.filter((p) => p.personUuid !== this.personUuid)

      if (duplicatePersons.length === 0) {
        return
      }

      this.ctx.info('Cleaning up duplicate AI bot persons', {
        workspace: this.wsIds.uuid,
        duplicates: duplicatePersons.length,
        keepPersonUuid: this.personUuid
      })

      const duplicatePersonIds = new Set(duplicatePersons.map((p) => p._id))

      // Remove SocialIdentities attached to duplicate persons
      for (const si of aiSocialIdentities) {
        if (duplicatePersonIds.has(si.attachedTo)) {
          await client.remove(si)
        }
      }

      // Remove all SocialIdentities for duplicate persons (not just email ones)
      for (const personId of duplicatePersonIds) {
        const allSocialIds = await client.findAll<SocialIdentity>(contact.class.SocialIdentity, {
          attachedTo: personId
        })
        for (const si of allSocialIds) {
          await client.remove(si)
        }
      }

      // Remove duplicate Person documents
      for (const person of duplicatePersons) {
        await client.remove(person)
        this.ctx.info('Removed duplicate AI bot person', {
          personId: person._id,
          personUuid: person.personUuid,
          name: person.name
        })
      }
    } catch (err: any) {
      this.ctx.error('Failed to cleanup duplicate AI bot persons', { err })
    }
  }

  private async initClient (): Promise<void> {
    await this.cleanupDuplicatePersons(this.client)
    await this.ensureEmployee(this.client)
    await this.checkEmployeeInfo(this.client)

    if (this.aiPerson !== undefined && config.LoveEndpoint !== '') {
      const systemToken = generateToken(systemAccountUuid, this.wsIds.uuid, { service: 'aibot' })
      const systemClient = connectPlatform(systemToken, this.wsIds.uuid, this.transactorUrl)
      this.love = new LoveController(
        this.wsIds.uuid,
        this.ctx.newChild('love', {}, { span: false }),
        this.token,
        systemClient,
        this.aiPerson
      )
    }
    this.ctx.info('Initialized workspace', { workspace: this.wsIds })
  }

  private async checkEmployeeInfo (client: RestClient): Promise<void> {
    this.ctx.info('Upload avatar file', { workspace: this.wsIds })

    try {
      const uploadInfo = await this.storage.stat(this.ctx, this.wsIds, config.AvatarName)

      if (uploadInfo === undefined) {
        const data = fs.readFileSync(config.AvatarPath)

        await this.storage.put(this.ctx, this.wsIds, config.AvatarName, data, config.AvatarContentType, data.length)
        this.ctx.info('Avatar file uploaded successfully', { workspace: this.wsIds, path: config.AvatarPath })
      }
    } catch (e) {
      this.ctx.error('Failed to upload avatar file', { e })
    }

    await this.checkPersonData(client)
  }

  private async checkPersonData (client: RestClient): Promise<void> {
    this.aiPerson = this.aiPerson ?? (await client.findOne(contact.class.Person, { personUuid: this.personUuid }))

    if (this.aiPerson === undefined) {
      this.ctx.error('Cannot find AI Person ', { personUuid: this.personUuid })
      return
    }

    const firstName = getFirstName(this.aiPerson.name)
    const lastName = getLastName(this.aiPerson.name)

    if (lastName !== config.LastName || firstName !== config.FirstName) {
      await this.client.update(this.aiPerson, {
        name: combineName(config.FirstName, config.LastName)
      })
    }

    if (this.aiPerson.avatar === config.AvatarName) {
      return
    }

    const exist = await this.storage.stat(this.ctx, this.wsIds, config.AvatarName)

    if (exist === undefined) {
      this.ctx.error('Cannot find file', { file: config.AvatarName, workspace: this.wsIds })
      return
    }
    const pData = await client.findOne(this.aiPerson._class, { _id: this.aiPerson._id })
    if (pData?.avatar !== config.AvatarName || pData.avatarType !== AvatarType.IMAGE) {
      await client.update(this.aiPerson, {
        avatar: config.AvatarName as Ref<Blob>,
        avatarType: AvatarType.IMAGE
      })
    }
  }

  // Resolve the user's primary social id (PersonId) so the bot can write the
  // user's memory Preference on their behalf (createdBy = user, not the bot).
  private async getUserSocialId (personUuid: PersonUuid): Promise<PersonId | undefined> {
    const cached = this.userSocialIdByPersonUuid.get(personUuid)
    if (cached !== undefined) return cached
    const ids = await this.client?.findAll<SocialIdentity>(contact.class.SocialIdentity, {
      attachedTo: personUuid as unknown as Ref<Person>
    })
    if (ids === undefined || ids.length === 0) return undefined
    const primary = pickPrimarySocialId(ids)._id
    this.userSocialIdByPersonUuid.set(personUuid, primary)
    return primary
  }

  // Read the user's AI memory from the Preference document (created on their behalf).
  private async readMemoryPreference (personUuid: PersonUuid): Promise<AIPersonalData | undefined> {
    return await this.client?.findOne<AIPersonalData>(aiBot.class.AIPersonalData, {
      attachedTo: personUuid as AccountUuid
    })
  }

  // "Юля is typing" indicator: a pulse TypingIndicator has a 3s transient TTL, so a single create
  // expires mid-generation (replies can take minutes). Refresh it every 2s until stopped. Returns a
  // stop function that clears the timer and removes the doc. Best-effort (never throws).
  private startTyping (objectId: Ref<Doc>, space: Ref<Space>): () => Promise<void> {
    const socialId = this.primarySocialId._id
    const id = `typing:${objectId}:${socialId}` as Ref<TypingIndicator>
    const TYPING_REFRESH_MS = 2000 // < 3s TTL (models/pulse TransientTTL)

    const touch = async (): Promise<void> => {
      try {
        // Re-create keeps the deterministic id; any CUD tx resets the transient TTL server-side.
        await this.client.createDoc(
          pulse.class.TypingIndicator,
          space,
          { objectId, socialId, status: chunter.string.IsTyping },
          id
        )
      } catch {
        // Already exists (still within TTL): bump it via update to reset the TTL window.
        try {
          await this.client.updateDoc(pulse.class.TypingIndicator, space, id, { status: chunter.string.IsTyping })
        } catch (err) {
          this.ctx.warn('failed to refresh typing', { err })
        }
      }
    }

    void touch()
    const timer = setInterval(() => {
      void touch()
    }, TYPING_REFRESH_MS)

    return async () => {
      clearInterval(timer)
      try {
        await this.client.removeDoc(pulse.class.TypingIndicator, space, id)
      } catch (err) {
        this.ctx.warn('failed to clear typing', { err })
      }
    }
  }

  // Reply language: direct chats honor the user's personal override first, then fall back to the
  // space language, workspace default, and finally the pod DefaultLanguage. Group chats skip the
  // personal override (the space owns the language of shared replies).
  private async resolveChatLanguage (
    personUuid: PersonUuid,
    space: Ref<Space> | undefined,
    isDirect: boolean
  ): Promise<string> {
    try {
      if (isDirect) {
        const personal = await this.readMemoryPreference(personUuid)
        if (personal?.language !== undefined && personal.language !== '') return personal.language
      }
      const settings = await this.client?.findAll(aiBot.class.AISpaceSettings, {})
      const forSpace = space !== undefined ? settings?.find((s) => s.attachedTo === space) : undefined
      const wsDefault = settings?.find((s) => s.attachedTo == null)
      return forSpace?.language ?? wsDefault?.language ?? config.DefaultLanguage
    } catch {
      return config.DefaultLanguage
    }
  }

  private async writeMemoryPreference (personUuid: PersonUuid, memory: { personalContext: string }): Promise<void> {
    const modifiedBy = await this.getUserSocialId(personUuid)
    const existing = await this.readMemoryPreference(personUuid)
    if (existing !== undefined) {
      await this.client.update(existing, { personalContext: memory.personalContext }, false, undefined, modifiedBy)
      return
    }
    await this.client.createDoc<AIPersonalData>(
      aiBot.class.AIPersonalData,
      core.space.Workspace,
      { attachedTo: personUuid as AccountUuid, personalContext: memory.personalContext },
      undefined,
      undefined,
      modifiedBy
    )
  }

  /** The user's PersonSpace (where their AIRequest status docs live). */
  private async getUserPersonSpace (personUuid: PersonUuid): Promise<Ref<Space> | undefined> {
    const space = await this.client?.findOne(contact.class.PersonSpace, { account: personUuid as AccountUuid })
    return space?._id
  }

  /**
   * Create an AIRequest status doc (processing) in the user's PersonSpace, on the
   * user's behalf. Returns its id so the caller can mark it done/failed. Best-effort:
   * returns undefined if the space can't be resolved (status tracking is non-critical).
   */
  async createAIRequest (
    personUuid: PersonUuid,
    seed: { level: AILevel, modelId: string, kind: string }
  ): Promise<Ref<AIRequest> | undefined> {
    const space = await this.getUserPersonSpace(personUuid)
    if (space === undefined) return undefined
    const modifiedBy = await this.getUserSocialId(personUuid)
    return await this.client.createDoc<AIRequest>(
      aiBot.class.AIRequest,
      space,
      { ...queuedRequest(seed.level, seed.modelId, seed.kind), status: 'processing' },
      undefined,
      undefined,
      modifiedBy
    )
  }

  /** Apply a status patch (done/failed) to an AIRequest, on the user's behalf. */
  async updateAIRequest (
    personUuid: PersonUuid,
    id: Ref<AIRequest>,
    space: Ref<Space>,
    patch: Partial<AIRequest>
  ): Promise<void> {
    const modifiedBy = await this.getUserSocialId(personUuid)
    await this.client.updateDoc(aiBot.class.AIRequest, space, id, patch, false, undefined, modifiedBy)
  }

  private async getMemory (personUuid: PersonUuid): Promise<AIMemory> {
    const cached = this.memoryMap.get(personUuid)
    if (cached !== undefined) return cached

    const pref = await this.readMemoryPreference(personUuid)

    let blobMemory: { userMemory?: string, assistantMemory?: string } | undefined
    if (pref === undefined) {
      try {
        const blob = JSON.parse(
          Buffer.concat(await this.storage.read(this.ctx, this.wsIds, 'ai-bot-phr-' + personUuid)).toString()
        )
        blobMemory = { userMemory: blob.userMemory, assistantMemory: blob.assistantMemory }
      } catch (err: any) {
        // No blob: fine.
      }
    }

    const personData =
      pref === undefined && blobMemory === undefined
        ? await this.client?.findOne(contact.mixin.Employee, { personUuid: personUuid as AccountUuid })
        : undefined

    const { memory, migrate } = resolveMemory(pref, blobMemory, personData?.name)

    // Fill sharedPrompt from workspace AISpaceSettings.
    const spaceSettings = await this.client?.findOne(aiBot.class.AISpaceSettings, { attachedTo: { $exists: false } })
    memory.sharedPrompt = spaceSettings?.sharedPrompt ?? ''

    if (migrate) {
      await this.writeMemoryPreference(personUuid, memory)
    }

    this.memoryMap.set(personUuid, memory)
    return memory
  }

  private async getAttachments (client: RestClient, objectId: Ref<Doc>): Promise<Attachment[]> {
    return await client.findAll(attachment.class.Attachment, { attachedTo: objectId })
  }

  async processMessageEvent (
    event: AIEventRequest,
    control?: ConsumerControl,
    provider?: LLMProvider,
    level?: AILevel,
    providers?: Map<string, LLMProvider>
  ): Promise<void> {
    // Per-provider pipeline passes the resolved provider+level; fall back to the default.
    const llm = provider ?? this.llm
    if (llm === undefined) {
      throw new Error('LLM provider is not configured')
    }

    const { user, objectId, objectClass, messageClass } = event
    const accountClient = getAccountClient(this.token)
    const personUuid = this.personUuidBySocialId.get(user) ?? (await accountClient.findPersonBySocialId(user))

    const contextMode = objectClass === chunter.class.DirectMessage ? 'direct' : 'thread'

    if (personUuid === undefined) {
      return
    }

    this.personUuidBySocialId.set(user, personUuid)

    let promptText = markupToText(event.message)
    const files = await this.getAttachments(this.client, event.messageId)
    if (files.length > 0) {
      promptText += '\n\nAttachments:'
      for (const file of files) {
        promptText += `\nName:${file.name} FileId:${file.file} Type:${file.type}`
      }
    }
    const prompt: LLMChatMessage = { content: promptText, role: 'user' as const }
    const promptTokens = llm.countTokens([prompt]) ?? 0

    const space = event.objectIdIsSpace ? (objectId as Ref<Space>) : event.objectSpace

    // Show "Юля is typing" until the reply is written (or the request bails out early).
    const stopTyping = this.startTyping(objectId, space)
    try {
      await this.generateAndReply(event, {
        llm,
        personUuid,
        contextMode,
        objectId,
        objectClass,
        messageClass,
        space,
        prompt,
        promptTokens,
        level,
        providers
      })
    } finally {
      await stopTyping()
    }
  }

  // Read markup stored in a blob (collaborative-doc fields: issue description, document
  // content, etc.) and flatten it to plain text.
  private async readMarkupBlob (blob: Ref<Blob>): Promise<string | undefined> {
    try {
      const readable = await this.storage.read(this.ctx, this.wsIds, blob)
      const markup = Buffer.concat(readable as any).toString()
      return markupToText(markup)
        .split(/ +|\t+|\f+/)
        .filter((it) => it)
        .join(' ')
        .split(/\n\n+/)
        .join('\n')
    } catch (err: any) {
      this.ctx.error('failed to read markup blob', { _id: blob, workspace: this.wsIds.uuid })
      return undefined
    }
  }

  // Read a collaborative-doc blob as markdown, preserving structure. Used for the editable
  // document context so the model rewrites in the same format it sees (flattened text loses
  // headings/lists and confuses the rewrite tool).
  private async readMarkupBlobAsMarkdown (blob: Ref<Blob>): Promise<string | undefined> {
    try {
      const readable = await this.storage.read(this.ctx, this.wsIds, blob)
      const markup = Buffer.concat(readable as any).toString()
      return markupToMarkdown(markupToJSON(markup), { refUrl: '', imageUrl: '' })
    } catch (err: any) {
      this.ctx.error('failed to read markup blob as markdown', { _id: blob, workspace: this.wsIds.uuid })
      return undefined
    }
  }

  // Build a source-object prompt for the small set of object types we link conversations to.
  // Add a new `case` when a new source type is introduced. The trailing note marks this as the
  // definitive source, so the model does not mistake the chat comments that follow for it.
  private async buildDocPrompt (doc: Doc): Promise<string | undefined> {
    const parts: string[] = []
    // Current editable body as markdown, delimited so the model can round-trip it via the
    // rewrite_document tool. Kept separate from the prose above so a small model does not merge
    // the surrounding chat into the document.
    let body: string | undefined
    switch (doc._class) {
      case tracker.class.Issue: {
        const is = doc as Issue
        parts.push(`This conversation is about task ${is.identifier ?? ''}.`)
        parts.push('TITLE: ' + is.title)
        body = is.description != null ? await this.readMarkupBlobAsMarkdown(is.description) : undefined
        break
      }
      case document.class.Document: {
        const d = doc as Document
        parts.push('This conversation is about document ' + d.title + '.')
        parts.push('TITLE: ' + d.title)
        body = d.content != null ? await this.readMarkupBlobAsMarkdown(d.content) : undefined
        break
      }
      default:
        return undefined
    }
    parts.push('This is the current document body (markdown):')
    parts.push('```markdown\n' + (body ?? '') + '\n```')
    parts.push(
      'To change the document, call the rewrite_document tool. Its `markdown` argument must be the ' +
        'full new body: copy the current body above verbatim, apply ONLY the change the user asked for, ' +
        'and pass the result.'
    )
    parts.push(
      'STRICT rules for the markdown you pass:\n' +
        '- Output ONLY the document itself. The document ends where its content ends.\n' +
        '- Do NOT append examples, alternatives, samples, notes, explanations, or "here is another way".\n' +
        '- Reproduce code and ```mermaid blocks EXACTLY as in the current body unless the user asked to change them.\n' +
        '- Do NOT add a new mermaid/code block unless explicitly requested.\n' +
        '- Do NOT wrap the whole thing in a code fence, and do NOT include the user request or chat text.'
    )
    return parts.join('\n')
  }

  // Collaborative attribute rewritten by the AI edit tool, per source class. Extend alongside
  // buildDocPrompt when a new source type is linked.
  private editTargetAttr (objectClass: Ref<Class<Doc>>): string | undefined {
    if (objectClass === tracker.class.Issue) return 'description'
    if (objectClass === document.class.Document) return 'content'
    return undefined
  }

  // Resolve the object an edit-proposal targets from the current thread's root message. The
  // "Discuss with Yulia" root (AIContextMessage) links to the real source object.
  async resolveEditTarget (
    rootId: Ref<Doc>,
    rootClass: Ref<Class<Doc>>
  ): Promise<{ targetId: Ref<Doc>, targetClass: Ref<Class<Doc>>, targetAttr: string } | undefined> {
    const root = await this.client.findOne<Doc>(rootClass, { _id: rootId })
    if (root === undefined || root._class !== aiBot.class.AIContextMessage) return undefined
    const link = root as AIContextMessage
    const targetAttr = this.editTargetAttr(link.objectClass)
    if (targetAttr === undefined) return undefined
    return { targetId: link.objectId, targetClass: link.objectClass, targetAttr }
  }

  // Current body of the edit target as markdown, for change detection. Reads the collab blob.
  private async currentTargetMarkdown (target: {
    targetId: Ref<Doc>
    targetClass: Ref<Class<Doc>>
    targetAttr: string
  }): Promise<string | undefined> {
    const doc = await this.client.findOne<Doc>(target.targetClass, { _id: target.targetId })
    if (doc === undefined) return undefined
    const blob = (doc as any)[target.targetAttr] as Ref<Blob> | null | undefined
    if (blob == null) return ''
    return await this.readMarkupBlobAsMarkdown(blob)
  }

  // Post a bot edit proposal as a thread reply. The user reviews and applies it client-side.
  // Returns false when the proposal is a no-op (identical to the current document) — a small model
  // tends to call the tool every turn and re-emit the unchanged doc; we drop those instead of
  // spamming diffs.
  async postEditProposal (
    ctx: ReqCtx,
    target: { targetId: Ref<Doc>, targetClass: Ref<Class<Doc>>, targetAttr: string },
    markdown: string
  ): Promise<boolean> {
    const current = await this.currentTargetMarkdown(target)
    if (current !== undefined && normalizeForCompare(current) === normalizeForCompare(markdown)) {
      return false
    }
    const proposed = jsonToMarkup(markdownToMarkup(markdown, { refUrl: '', imageUrl: '' }))
    const parent = await this.client.findOne<ChatMessage>(chunter.class.ChatMessage, {
      _id: ctx.objectId as Ref<ChatMessage>
    })
    if (parent === undefined) return false
    await this.client.addCollection<Doc, AIEditProposalMessage>(
      aiBot.class.AIEditProposalMessage,
      ctx.space,
      ctx.objectId,
      ctx.objectClass,
      ctx.collection,
      {
        message: '',
        objectId: parent.attachedTo,
        objectClass: parent.attachedToClass,
        targetId: target.targetId,
        targetClass: target.targetClass,
        targetAttr: target.targetAttr,
        proposedMarkup: proposed
      }
    )
    return true
  }

  private async generateAndReply (
    event: AIEventRequest,
    args: {
      llm: LLMProvider
      personUuid: PersonUuid
      contextMode: ContextMode
      objectId: Ref<Doc>
      objectClass: Ref<Class<Doc>>
      messageClass: Ref<Class<Doc>>
      space: Ref<Space>
      prompt: LLMChatMessage
      promptTokens: number
      level?: AILevel
      providers?: Map<string, LLMProvider>
    }
  ): Promise<void> {
    let { llm } = args
    const { personUuid, contextMode, objectId, objectClass, messageClass, space, prompt, promptTokens, providers } =
      args
    const level = args.level

    // Memory (assistant/user/shared) lives in a Preference; conversation context
    // now comes from the chunter thread, not from a blob history.
    const memory = await this.getMemory(personUuid)

    const useHistory: LLMHistoryRecord[] = []

    const systemPrompts: LLMHistoryRecord[] = []

    // Source document context (issue/document body). Placed at the END of history, right before
    // the user's request, not in the system block: small models "lose the middle", so the document
    // must sit next to the task, not far above the chat history.
    let docPrompt: string | undefined

    {
      // Top-level replies (in a Direct or a Channel space) take only the current
      // day's recent messages as context; older messages are fetched on demand via
      // the load_thread_history tool. Thread replies keep the full thread context.
      const dayLimited = event.objectIdIsSpace
      const dayStart = new Date()
      dayStart.setHours(0, 0, 0, 0)
      // Exclude the incoming message itself; it is appended separately as the prompt.
      const contextQuery = dayLimited
        ? {
            attachedTo: objectId,
            attachedToClass: objectClass,
            _id: { $ne: event.messageId },
            modifiedOn: { $gte: dayStart.getTime() }
          }
        : { attachedTo: objectId, attachedToClass: objectClass, _id: { $ne: event.messageId } }

      // Load a message itself
      const msg = await this.client?.findOne<Doc>(objectClass, { _id: objectId })
      if (msg !== undefined) {
        systemPrompts.push({
          role: 'system' as const,
          content: 'Document type:' + msg?._class
        })
        if (msg._class === chunter.class.ThreadMessage || msg._class === chunter.class.ChatMessage) {
          systemPrompts.push({
            role: 'system' as const,
            content: 'Content: ' + markupToText((msg as ChatMessage).message)
          })
        }
        // "Discuss with Yulia" thread: the root message links to a source object (issue,
        // document, ...). Load that object so its content is in context, not just the starter.
        let linked: Doc | undefined
        if (msg._class === aiBot.class.AIContextMessage) {
          const link = msg as AIContextMessage
          linked = await this.client?.findOne<Doc>(link.objectClass, { _id: link.objectId })
        }
        // Any non-chat source object (issue, document, ...) is described from its class schema.
        const source = linked ?? (msg._class !== chunter.class.ChatMessage ? msg : undefined)
        const isChatStarter =
          source !== undefined &&
          (source._class === chunter.class.ChatMessage ||
            source._class === chunter.class.ThreadMessage ||
            source._class === aiBot.class.AIContextMessage)
        if (source !== undefined && !isChatStarter) {
          docPrompt = await this.buildDocPrompt(source)
        }
      }

      const lastMessages =
        (await this.client?.findAll(chunter.class.ChatMessage, contextQuery, {
          limit: 500,
          sort: { modifiedOn: SortingOrder.Descending }
        })) ?? []

      lastMessages.sort((a, b) => a.modifiedOn - b.modifiedOn)

      // The bot authors its replies under one of its own social ids; match against
      // them directly to tag messages as 'assistant' vs 'user'.
      // Note: a "new context" starts a new root message (new thread), so replies here already
      // belong only to the current context — no in-thread cut is needed.
      const botSocialIds = new Set(this.socialIds.map((it) => it._id))

      const contextMessages: ContextMessage[] = []
      for (const msg of lastMessages) {
        const msgRole: 'assistant' | 'user' = botSocialIds.has(msg.modifiedBy) ? 'assistant' : 'user'
        // Edit proposals are UI artifacts (a diff + apply button). Feed only a short fact that the
        // proposal happened — never its proposed body: the up-to-date document is already in the
        // doc context, so echoing the proposed text would duplicate it and drift the model.
        let content: string
        if (msg._class === aiBot.class.AIEditProposalMessage) {
          const applied = (msg as AIEditProposalMessage).applied === true
          content = applied
            ? '[You proposed an edit to the document; the user applied it. The document context above already reflects it.]'
            : '[You proposed an edit to the document; the user has not applied it yet.]'
        } else {
          content = markupToText(msg.message)
        }
        contextMessages.push({
          role: msgRole,
          content,
          tokens: llm.countTokens([{ role: msgRole, content }]) ?? 0
        })
      }

      // Truncate the thread context to fit the model window (oldest dropped first).
      useHistory.push(...buildThreadContext(contextMessages, promptTokens, config.MaxContentTokens))

      // Document goes last (after the chat history, just before the user request) so a small model
      // sees it adjacent to the task it must act on.
      if (docPrompt !== undefined) {
        useHistory.push({ role: 'user' as const, content: docPrompt })
      }
    }

    // Monthly billed-token window (from billing). Past the limit: paid plans downgrade to
    // the local low level, free plans are blocked (fallback-eligible levels always serve).
    const requestedLevel = level ?? config.DefaultLevel
    const windows = await getWorkspaceWindows(this.ctx, this.wsIds.uuid)
    const decision = decideLevel(requestedLevel, config.AIProviders, windows)
    if (decision.action === 'block') {
      const lang = event.language ?? config.DefaultLanguage
      const message =
        decision.reason === 'unavailable' ? aiBot.string.AIServiceUnavailable : aiBot.string.TokenLimitReachedMonth
      await this.notifyLimit(
        personUuid,
        lang,
        {
          messageClass,
          space,
          objectId,
          objectClass,
          collection: event.collection
        },
        message
      )
      return
    }

    // Effective level may have been downgraded to a fallback-eligible model.
    const effectiveLevel = decision.level ?? requestedLevel
    const resolved = resolveModel(effectiveLevel, config.AIProviders)

    // Window-downgrade landed on a different provider (e.g. pro -> local low): switch the LLM
    // instance too, otherwise the original provider would run + bill the requested level.
    if (effectiveLevel !== requestedLevel && providers !== undefined) {
      const downgraded = providers.get(resolved.provider.id)
      if (downgraded !== undefined) {
        llm = downgraded
      }
    }

    const aiRequestSpace = await this.getUserPersonSpace(personUuid)
    const aiRequestId = await this.createAIRequest(personUuid, {
      level: resolved.level,
      modelId: resolved.model.model,
      kind: 'chat'
    })

    const tools = getTools(this, contextMode, personUuid as AccountUuid, {
      objectId,
      objectClass,
      space,
      collection: event.collection
    })
    const replyLang = await this.resolveChatLanguage(personUuid, space, contextMode === 'direct')
    let chatCompletion
    try {
      chatCompletion = await llm.createChatCompletionWithTools(
        tools,
        prompt,
        contextMode,
        memory.sharedPrompt,
        memory.personalContext,
        personUuid as AccountUuid,
        this.ctx,
        this.wsIds.uuid,
        [...systemPrompts, ...useHistory],
        true,
        'chat',
        effectiveLevel,
        { plan: windows.plan, isFree: windows.isFree, hasPackages: windows.hasPackages },
        replyLang
      )
    } catch (err: any) {
      // LLM failed after its in-worker retries (e.g. provider down / connection refused). Mark the
      // request failed and tell the user the service is temporarily unavailable instead of going
      // silent. Swallow instead of rethrow so the queue does not reprocess the event.
      this.ctx.error('chat completion failed', { workspace: this.wsIds.uuid, error: err?.message })
      if (aiRequestId !== undefined && aiRequestSpace !== undefined) {
        await this.updateAIRequest(personUuid, aiRequestId, aiRequestSpace, failedPatch(err?.message ?? 'error'))
      }
      const lang = event.language ?? config.DefaultLanguage
      await this.notifyLimit(
        personUuid,
        lang,
        { messageClass, space, objectId, objectClass, collection: event.collection },
        aiBot.string.AIServiceUnavailable
      )
      return
    }
    const response = chatCompletion?.completion

    if (response == null) {
      if (aiRequestId !== undefined && aiRequestSpace !== undefined) {
        await this.updateAIRequest(personUuid, aiRequestId, aiRequestSpace, failedPatch('empty response'))
      }
      // Silence reads as a broken bot: say so instead (e.g. the model kept asking for tools
      // and never produced text).
      const lang = event.language ?? config.DefaultLanguage
      await this.notifyLimit(
        personUuid,
        lang,
        { messageClass, space, objectId, objectClass, collection: event.collection },
        aiBot.string.AIEmptyResponse
      )
      return
    }

    if (aiRequestId !== undefined && aiRequestSpace !== undefined) {
      await this.updateAIRequest(
        personUuid,
        aiRequestId,
        aiRequestSpace,
        donePatch(chatCompletion?.usage, planMultiplier(resolved.model, windows.isFree, windows.hasPackages))
      )
    }
    const parseResponse = jsonToMarkup(markdownToMarkup(response, { refUrl: '', imageUrl: '' }))
    await this.writeReply(messageClass, space, objectId, objectClass, event.collection, parseResponse)
  }

  // Copyright © 2026 Intabia Fusion
  // Load earlier messages from the thread/channel for on-demand history retrieval by the LLM tool.
  async loadThreadHistory (
    objectId: Ref<Doc>,
    objectClass: Ref<Class<Doc>>,
    beforeMs: number,
    limit: number
  ): Promise<string> {
    const clampedLimit = Math.max(1, Math.min(limit, 200))
    try {
      const messages = await this.client.findAll(
        chunter.class.ChatMessage,
        { attachedTo: objectId, attachedToClass: objectClass, modifiedOn: { $lt: beforeMs } },
        { limit: clampedLimit, sort: { modifiedOn: SortingOrder.Descending } }
      )
      if (messages.length === 0) return 'No older messages found.'
      // Reverse to chronological order (oldest first).
      messages.sort((a, b) => a.modifiedOn - b.modifiedOn)
      return messages.map((m) => markupToText(m.message)).join('\n')
    } catch (err: any) {
      this.ctx.warn('load_thread_history failed', { error: err })
      return 'Failed to load older messages.'
    }
  }

  // Find the user's existing Direct chat with Юля (does not create one).
  private async findUserDirect (personUuid: PersonUuid): Promise<DirectMessage | undefined> {
    const aiAccount = this.aiPerson?.personUuid as AccountUuid | undefined
    if (aiAccount === undefined) return undefined

    const wanted = new Set<AccountUuid>([personUuid as AccountUuid, aiAccount])
    const directs = await this.client.findAll<DirectMessage>(chunter.class.DirectMessage, {})
    return directs.find((dm) => {
      const members = new Set(dm.members)
      return members.size === wanted.size && [...wanted].every((a) => members.has(a))
    })
  }

  // Post a notice (token limit / service unavailable) in the user's Direct chat with Юля
  // (falls back to the request's origin thread if no Direct exists yet). Text is rendered
  // in the space language (`lang`), falling back to the pod's DefaultLanguage.
  private async notifyLimit (
    personUuid: PersonUuid,
    lang: string,
    fallback: {
      messageClass: Ref<Class<Doc>>
      space: Ref<Space>
      objectId: Ref<Doc>
      objectClass: Ref<Class<Doc>>
      collection: string
    },
    message: IntlString = aiBot.string.TokenLimitReachedMonth
  ): Promise<void> {
    const text = await translate(message, {}, lang)
    const markup = jsonToMarkup(markdownToMarkup(text, { refUrl: '', imageUrl: '' }))
    const direct = await this.findUserDirect(personUuid)
    if (direct !== undefined) {
      await this.client.addCollection<Doc, ChatMessage>(
        chunter.class.ChatMessage,
        direct._id,
        direct._id,
        direct._class,
        'messages',
        { message: markup }
      )
      return
    }
    await this.writeReply(
      fallback.messageClass,
      fallback.space,
      fallback.objectId,
      fallback.objectClass,
      fallback.collection,
      markup
    )
  }

  // Write a bot reply as a ChatMessage or a ThreadMessage under the parent message.
  private async writeReply (
    messageClass: Ref<Class<Doc>>,
    space: Ref<Space>,
    objectId: Ref<Doc>,
    objectClass: Ref<Class<Doc>>,
    collection: string,
    markup: string
  ): Promise<void> {
    if (messageClass === chunter.class.ChatMessage) {
      await this.client.addCollection<Doc, ChatMessage>(
        chunter.class.ChatMessage,
        space,
        objectId,
        objectClass,
        collection,
        { message: markup }
      )
    } else if (messageClass === chunter.class.ThreadMessage) {
      const parent = await this.client.findOne<ChatMessage>(chunter.class.ChatMessage, {
        _id: objectId as Ref<ChatMessage>
      })

      if (parent !== undefined) {
        await this.client.addCollection<Doc, ThreadMessage>(
          chunter.class.ThreadMessage,
          space,
          objectId,
          objectClass,
          collection,
          { message: markup, objectId: parent.attachedTo, objectClass: parent.attachedToClass }
        )
      }
    }
  }

  async meetingStarted (meetingId: Ref<MeetingMinutes>): Promise<void> {
    await this.initPromise
    if (this.love !== undefined) {
      const mm = await this.love.getMeeting(meetingId)
      if (mm !== undefined) {
        this.ctx.info('Meeting started, connecting to Love', {
          meetingId,
          autoTranscribe: mm.startWithTranscription ?? false
        })
        await this.love?.connect({
          language: mm.language,
          meetingId: mm._id,
          transcription: mm.startWithTranscription ?? false
        })
      }
    }
  }

  async meetingFinished (meetingId: Ref<MeetingMinutes>): Promise<void> {
    await this.initPromise
    await this.love?.disconnect(meetingId)
  }

  async close (): Promise<void> {
    this.ctx.info('Closed workspace client: ', { workspace: this.wsIds })
  }

  async loveConnect (request: ConnectMeetingRequest): Promise<void> {
    await this.initPromise
    if (this.love === undefined) {
      this.ctx.error('Love controller is not initialized')
      return
    }
    await this.love.connect(request)
  }

  async loveDisconnect (request: DisconnectMeetingRequest): Promise<void> {
    await this.initPromise
    if (this.love === undefined) {
      this.ctx.error('Love controller is not initialized')
      return
    }

    await this.love.disconnect(request.meetingId)
  }

  @withContext('processLoveTranscript')
  async processLoveTranscript (
    ctx: MeasureContext,
    text: string,
    participant: Ref<Person>,
    meeting: Ref<MeetingMinutes>
  ): Promise<void> {
    await this.initPromise
    if (this.love === undefined) {
      this.ctx.error('Love controller is not initialized')
      return
    }

    // Diagnostics: log incoming love transcript for easier tracing
    ctx.info('workspaceClient.processLoveTranscript', {
      room: meeting,
      participant,
      textLength: text.length
    })

    await this.love.processTranscript(text, participant, meeting)
  }

  /**
   * Create a placeholder message for pending transcription
   */
  @withContext('createTranscriptionPlaceholder')
  async createTranscriptionPlaceholder (
    ctx: MeasureContext,
    participant: Ref<Person>,
    meetingId: Ref<MeetingMinutes>,
    startTimeSec: number,
    endTimeSec: number,
    blobId: string
  ): Promise<Ref<ChatMessage> | undefined> {
    await this.initPromise
    if (this.love === undefined) {
      this.ctx.error('Love controller is not initialized')
      return undefined
    }

    return await this.love.createTranscriptionPlaceholder(participant, meetingId, startTimeSec, endTimeSec, blobId)
  }

  /**
   * Update or delete a transcription placeholder message
   * @returns true if message was found and updated/deleted, false if not found
   */
  @withContext('updateTranscriptionMessage')
  async updateTranscriptionMessage (
    ctx: MeasureContext,
    messageId: Ref<ChatMessage>,
    text: string | null
  ): Promise<boolean> {
    await this.initPromise
    if (this.love === undefined) {
      this.ctx.error('Love controller is not initialized')
      return false
    }

    return await this.love.updateTranscriptionMessage(messageId, text)
  }

  /**
   * Create a transcription message with specific timestamp (fallback when placeholder not found)
   */
  @withContext('createTranscriptionMessageWithTimestamp')
  async createTranscriptionMessageWithTimestamp (
    ctx: MeasureContext,
    text: string,
    participant: Ref<Person>,
    meeting: Ref<MeetingMinutes>,
    timestamp: Timestamp
  ): Promise<boolean> {
    await this.initPromise
    if (this.love === undefined) {
      this.ctx.error('Love controller is not initialized')
      return false
    }

    return await this.love.createTranscriptionMessageWithTimestamp(text, participant, meeting, timestamp)
  }

  async getLoveIdentity (): Promise<IdentityResponse | undefined> {
    await this.initPromise
    if (this.love === undefined) {
      this.ctx.error('Love is not initialized')
      return
    }

    return this.love.getIdentity()
  }

  canClose (): boolean {
    if (this.love === undefined) return true

    return !this.love.hasActiveConnections()
  }

  /**
   * Add session recording as attachment to meeting minutes
   */
  async addSessionAttachment (
    meetingMinutesId: Ref<MeetingMinutes>,
    blobId: string,
    participant: string,
    startTimeSec: number,
    endTimeSec: number,
    size: number,
    sessionNumber: number
  ): Promise<void> {
    const meetingMinutes = await this.client.findOne<MeetingMinutes>(love.class.MeetingMinutes, {
      _id: meetingMinutesId
    })

    if (meetingMinutes === undefined) {
      this.ctx.warn('No meeting minutes found for room', { participant })
      return
    }

    // participant is now the display name from LiveKit (participant.name), not Ref<Person>
    // Just sanitize it for use in filename
    let participantName = participant.trim()
    if (participantName === '') {
      participantName = 'Unknown'
    }
    // Replace spaces and special characters for filename safety
    participantName = participantName.replace(/\s+/g, '_').replace(/[<>:"/\\|?*]/g, '_')

    // Format start and end times as mm:ss
    const formatTime = (sec: number): string => {
      const minutes = Math.floor(sec / 60)
      const seconds = Math.floor(sec % 60)
      return `${minutes}:${seconds.toString().padStart(2, '0')}`
    }
    const startTimeStr = formatTime(startTimeSec)
    const endTimeStr = formatTime(endTimeSec)

    // Create attachment with participant name, session number and time range
    // Using OGG container with Opus codec for browser compatibility
    const attachmentName = `${participantName}_${sessionNumber}_${startTimeStr}-${endTimeStr}.ogg`

    await this.client.addCollection(
      attachment.class.Attachment,
      meetingMinutes.space,
      meetingMinutes._id,
      meetingMinutes._class,
      'attachments',
      {
        name: attachmentName,
        file: blobId as Ref<Blob>,
        type: 'audio/ogg',
        size,
        lastModified: Date.now()
      }
    )

    this.ctx.info('Added session attachment to meeting minutes', {
      meetingMinutes: meetingMinutes._id,
      participant,
      participantName,
      sessionNumber,
      attachmentName,
      size,
      startTimeSec,
      endTimeSec
    })
  }
}
