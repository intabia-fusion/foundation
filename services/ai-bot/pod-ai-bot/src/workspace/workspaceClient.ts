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
  type AITaskProposal,
  type AITaskProposalMessage,
  type AudioTranscribe,
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
  type Employee,
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
  type TxMeta,
  withContext,
  systemAccountUuid,
  type Account,
  type Hierarchy,
  type WorkspaceIds
} from '@hcengineering/core'
import love, { type MeetingMinutes } from '@hcengineering/love'
import pulse, { type TypingIndicator } from '@hcengineering/pulse'
import fs from 'fs'
import type { LLMProvider, ChatMessage as LLMChatMessage, ContextMode, ToolLoopHooks } from '../llms'
import type { AILevel } from '../config'
import { getTools, type PendingProposal, type ReqCtx } from '../utils/tools'
import { sanitizeDocumentMarkdown } from '../utils/documentMarkdown'
import { resolveMemory, type AIMemory } from './memory'
import { donePatch, failedPatch, queuedRequest } from './aiRequest'
import { resolveModel, registryForFeature } from '../llms/modelRegistry'
import { getWorkspaceWindows } from '../billing'
import { decideLevel } from './windowLimit'
import { buildThreadContext, type ContextMessage } from './threadContext'
import {
  appendTurns,
  type ConversationSnapshot,
  parseSnapshot,
  renderSnapshot,
  appendSummary,
  contextTurns,
  snapshotBlobId,
  snapshotMessageIds,
  type SnapshotTurn
} from './conversationSnapshot'
import { buildDocPromptText } from './docPrompt'
import { isContextOverflow, planCompaction, renderForSummary } from './compaction'
import { toolBudgets } from '../utils/budget'
import { botName } from '../llms/prompts'
import { renderPrompt } from '../llms/promptStore'
import { loadWelcomeMessages, pickWelcome } from '../welcome'

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

// How long a reply waits for a still-running voice transcription before answering without it.
const VOICE_TRANSCRIPT_WAIT_MS = 60000

// Loop backstop: replies to one chat allowed inside the window before requests are dropped.
const REPLY_FLOOD_WINDOW_MS = 60000
const REPLY_FLOOD_LIMIT = 20

// Personal memory is re-read after this; a UI edit shows up on the next request past it.
const MEMORY_CACHE_TTL_MS = 60000

interface LLMHistoryRecord {
  role: 'user' | 'assistant' | 'system'
  content: string
}

// Collapse whitespace for a change-detection compare, so a re-emitted-but-identical document
// (common with small models) is treated as a no-op regardless of trailing/interior spacing.
function normalizeForCompare (md: string): string {
  return md.replace(/\s+/g, ' ').trim()
}

/**
 * History budget for a level: the model's own context window minus the room its answer needs,
 * capped by the pod-wide budget. Falls back to the pod-wide budget when the level says nothing.
 */
// Token counts are estimates (tiktoken for a GigaChat model is a guess), so the history is cut
// to 85% of what is nominally free: filling the window to the brim ends in a 422 from the
// provider, and the request is lost rather than trimmed.
const CONTEXT_SAFETY = 0.85

// Greeting texts live in welcome.yaml so they can be reworded without a rebuild; read once.
let welcomeMessages: Record<string, string> | undefined

// Turns kept in a conversation file. Far above what any context window takes - the cap only stops
// a years-old thread from growing without bound.
const SNAPSHOT_MAX_TURNS = 500

// Share of the level's window the linked document may take. Past it the body is replaced with an
// outline and editing is refused: a rewrite built from a partial body deletes the rest.
const DOC_PROMPT_SHARE = 0.45

function contextBudgetFor (level: AILevel): number {
  const caps = resolveLevelCapabilities(level)
  const contextWindow = caps?.maxContextTokens
  if (contextWindow === undefined || contextWindow <= 0) return config.MaxContentTokens
  const reserved = caps?.maxOutputTokens ?? 0
  const free = Math.floor((contextWindow - reserved) * CONTEXT_SAFETY)
  return Math.max(1, Math.min(config.MaxContentTokens, free))
}

/** Capabilities of the level as served by whichever provider serves it. */
function resolveLevelCapabilities (level: AILevel): { maxContextTokens?: number, maxOutputTokens?: number } | undefined {
  for (const provider of config.AIProviders) {
    const caps = provider.levels[level]?.capabilities
    if (caps !== undefined) return caps
  }
  return undefined
}

export class WorkspaceClient {
  client: RestClient

  rate = new RateLimiter(1)

  primarySocialId: SocialId
  aiPerson: Person | undefined
  personUuidBySocialId = new Map<PersonId, PersonUuid>()
  // Replies answered per chat inside the current window; see isRepliesFlooding.
  repliesPerObject = new Map<Ref<Doc>, { since: number, count: number }>()

  love: LoveController | undefined
  memoryMap = new Map<PersonUuid, { at: number, value: AIMemory }>()
  userSocialIdByPersonUuid = new Map<PersonUuid, PersonId>()
  initPromise: Promise<void> | undefined

  collaborator: CollaboratorClient | undefined

  // AIRequest currently running per chat, so the typing refresh can spot a cancel on its own.
  private readonly activeRequests = new Map<Ref<Doc>, Ref<AIRequest>>()

  // The bot is not a member of every project, the person discussing the task always is. Reads of the
  // linked object go under them, so a private project stays readable in their own thread.
  private readonly userClients = new Map<PersonUuid, RestClient>()

  // Service writes into spaces the bot is not a member of (a voice note in someone's direct).
  private serviceClient: RestClient | undefined

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
    void this.ensureInited().catch(() => {})
  }

  /** A workspace touched while it is upgrading answers 403; a cached rejection would leave the
   *  bot blind to it until the pod restarts, so the next caller re-runs the init. */
  private async ensureInited (): Promise<void> {
    if (this.initPromise === undefined) {
      this.initPromise = this.initClient().catch((err) => {
        this.initPromise = undefined
        throw err
      })
    }
    await this.initPromise
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

  /** Remove duplicate AI bot Person records left after workspace backup/restore. */
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
    await this.backfillWelcomeDirects()
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

  // Typing indicator has a 3s TTL; refresh every 2s. Returns a stop function that clears it.
  // The typing indicator doubles as a status line: the same doc carries any IntlString, and the
  // chat renders it in place of "is typing". Lets the pod push a state the UI would otherwise
  // have to poll for.
  private async setTypingStatus (objectId: Ref<Doc>, space: Ref<Space>, status: IntlString): Promise<void> {
    const socialId = this.primarySocialId._id
    const id = `typing:${objectId}:${socialId}` as Ref<TypingIndicator>
    try {
      await this.client.updateDoc(pulse.class.TypingIndicator, space, id, { status })
    } catch {
      try {
        await this.client.createDoc(pulse.class.TypingIndicator, space, { objectId, socialId, status }, id)
      } catch (err) {
        this.ctx.warn('failed to set typing status', { err })
      }
    }
  }

  private startTyping (objectId: Ref<Doc>, space: Ref<Space>): () => Promise<void> {
    const socialId = this.primarySocialId._id
    const id = `typing:${objectId}:${socialId}` as Ref<TypingIndicator>
    const TYPING_REFRESH_MS = 2000 // < 3s TTL (models/pulse TransientTTL)

    let stopped = false
    const touch = async (): Promise<void> => {
      if (stopped) return
      // The tool loop only notices a cancel between rounds, and one round can run for minutes.
      if (await this.isRequestCancelled(objectId)) {
        void stop()
        return
      }
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

    const timer = setInterval(() => {
      void touch()
    }, TYPING_REFRESH_MS)

    // Idempotent: a cancel stops it early, the caller's finally still runs.
    const stop = async (): Promise<void> => {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      try {
        await this.client.removeDoc(pulse.class.TypingIndicator, space, id)
      } catch (err) {
        this.ctx.warn('failed to clear typing', { err })
      }
    }

    void touch()
    return stop
  }

  /** The request this chat is currently running was cancelled by the user. */
  private async isRequestCancelled (objectId: Ref<Doc>): Promise<boolean> {
    const id = this.activeRequests.get(objectId)
    if (id === undefined) return false
    try {
      return (await this.client.findOne(aiBot.class.AIRequest, { _id: id }))?.status === 'cancelled'
    } catch {
      return false
    }
  }

  // Direct chats honor the user's personal language override; group chats use the space language.
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

  /**
   * Create an AIRequest status doc in the chat's own space. NOT the user's PersonSpace: that one is
   * private to the user, so the bot account cannot read or write it (the doc was silently never
   * created). The chat space is visible to both, which is also what the progress UI needs.
   */
  async createAIRequest (
    personUuid: PersonUuid,
    space: Ref<Space>,
    seed: { level: AILevel, modelId: string, kind: string, objectId?: Ref<Doc> }
  ): Promise<Ref<AIRequest> | undefined> {
    try {
      const modifiedBy = await this.getUserSocialId(personUuid)
      return await this.client.createDoc<AIRequest>(
        aiBot.class.AIRequest,
        space,
        { ...queuedRequest(seed.level, seed.modelId, seed.kind), status: 'processing', objectId: seed.objectId },
        undefined,
        undefined,
        modifiedBy
      )
    } catch (err: any) {
      // Status telemetry must never cost the user their answer.
      this.ctx.warn('failed to create AI request doc', { err: err?.message })
      return undefined
    }
  }

  /**
   * Live progress + cancel for one request: token counts land on the AIRequest doc (the user sees
   * them next to the typing indicator), and the user cancelling that doc stops the tool loop.
   */
  private requestHooks (
    personUuid: PersonUuid,
    id: Ref<AIRequest> | undefined,
    space: Ref<Space> | undefined,
    onCancelled?: () => Promise<void>
  ): ToolLoopHooks | undefined {
    if (id === undefined || space === undefined) return undefined
    return {
      onProgress: ({ iteration, usage }) => {
        void this.updateAIRequest(personUuid, id, space, {
          iteration,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens
        }).catch((err) => {
          this.ctx.warn('failed to report AI request progress', { err: err?.message })
        })
      },
      isCancelled: async () => {
        try {
          const doc = await this.client.findOne(aiBot.class.AIRequest, { _id: id })
          if (doc?.status !== 'cancelled') return false
          // Stop "is typing" here, not after the last round: the user pressed cancel and the
          // wrap-up round still takes seconds, during which the bot looks like it kept going.
          await onCancelled?.()
          return true
        } catch (err: any) {
          this.ctx.warn('failed to read AI request status', { err: err?.message })
          return false
        }
      }
    }
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

  /** Workspace-wide shared prompt. Never cached: edited in the UI, and the pod has no tx feed. */
  private async getSharedPrompt (): Promise<string> {
    const settings = await this.client?.findOne(aiBot.class.AISpaceSettings, { attachedTo: { $exists: false } })
    return settings?.sharedPrompt ?? ''
  }

  private async getMemory (personUuid: PersonUuid): Promise<AIMemory> {
    const cached = this.memoryMap.get(personUuid)
    // Personal context is edited in the UI too, so the cache only spares repeated reads
    // within a conversation burst.
    if (cached !== undefined && Date.now() - cached.at < MEMORY_CACHE_TTL_MS) {
      return { personalContext: cached.value.personalContext, sharedPrompt: await this.getSharedPrompt() }
    }

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

    const { personalContext, migrate } = resolveMemory(pref, blobMemory, personData?.name)
    const memory: AIMemory = { personalContext, sharedPrompt: await this.getSharedPrompt() }

    if (migrate) {
      await this.writeMemoryPreference(personUuid, memory)
    }

    this.memoryMap.set(personUuid, { at: Date.now(), value: memory })
    return memory
  }

  private async getAttachments (client: RestClient, objectId: Ref<Doc>): Promise<Attachment[]> {
    return await client.findAll(attachment.class.Attachment, { attachedTo: objectId })
  }

  // Collect the transcript text of voice-note attachments, waiting for any still-transcribing ones
  // to finish (bounded poll). Failed/empty ones are reported as `missing` so the reply can say so
  // instead of answering an empty prompt.
  private async collectVoiceTranscripts (files: Attachment[]): Promise<{ texts: string[], missing: number }> {
    const voice = files.filter((f) => f._class === aiBot.class.AudioTranscribe) as AudioTranscribe[]
    if (voice.length === 0) return { texts: [], missing: 0 }

    const deadline = Date.now() + VOICE_TRANSCRIPT_WAIT_MS
    let pending = voice.filter((v) => v.state === 'pending').map((v) => v._id)
    while (pending.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      const fresh = await this.client.findAll(aiBot.class.AudioTranscribe, { _id: { $in: pending } })
      const byId = new Map(fresh.map((d) => [d._id, d]))
      for (const v of voice) {
        const upd = byId.get(v._id)
        if (upd !== undefined) v.state = upd.state
        if (upd?.text !== undefined) v.text = upd.text
      }
      pending = voice.filter((v) => v.state === 'pending').map((v) => v._id)
    }

    const texts = voice.map((v) => (v.text ?? '').trim()).filter((t) => t !== '')
    return { texts, missing: voice.length - texts.length }
  }

  // Backstop for loops the self-check cannot see: no human chat needs this many answers a minute.
  private isRepliesFlooding (objectId: Ref<Doc>): boolean {
    const now = Date.now()
    const seen = this.repliesPerObject.get(objectId)
    if (seen === undefined || now - seen.since > REPLY_FLOOD_WINDOW_MS) {
      // Windows that already closed carry no state worth keeping.
      for (const [key, entry] of this.repliesPerObject) {
        if (now - entry.since > REPLY_FLOOD_WINDOW_MS) this.repliesPerObject.delete(key)
      }
      this.repliesPerObject.set(objectId, { since: now, count: 1 })
      return false
    }
    seen.count++
    if (seen.count > REPLY_FLOOD_LIMIT) {
      this.ctx.error('Reply flood detected, dropping the request', {
        objectId,
        count: seen.count,
        windowMs: REPLY_FLOOD_WINDOW_MS
      })
      return true
    }
    return false
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

    // Never answer ourselves: the trigger filters by known social ids and can miss one.
    if (personUuid === this.personUuid) {
      this.ctx.warn('Skipping own message: the bot must not answer itself', { objectId, user })
      return
    }

    if (this.isRepliesFlooding(objectId)) {
      return
    }

    this.personUuidBySocialId.set(user, personUuid)

    let promptText = markupToText(event.message)
    const files = await this.getAttachments(this.client, event.messageId)
    // Voice-note transcripts are part of what the user "said": wait for pending ones to finish,
    // then fold their text into the prompt. Non-voice attachments stay as file references.
    const transcripts = await this.collectVoiceTranscripts(files)
    if (transcripts.texts.length > 0) {
      promptText += '\n\n' + transcripts.texts.join('\n')
    }
    if (transcripts.missing > 0) {
      promptText += '\n\n[A voice message could not be transcribed - tell the user the transcription failed]'
    }
    const otherFiles = files.filter((f) => f._class !== aiBot.class.AudioTranscribe)
    if (otherFiles.length > 0) {
      promptText += '\n\nAttachments:'
      for (const file of otherFiles) {
        promptText += `\nName:${file.name} FileId:${file.file} Type:${file.type}`
      }
    }
    const prompt: LLMChatMessage = { content: promptText, role: 'user' as const }
    const promptTokens = llm.countTokens([prompt]) ?? 0

    const space = event.objectIdIsSpace ? (objectId as Ref<Space>) : event.objectSpace

    // Show the typing indicator until the reply is written (or the request bails out early).
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
        providers,
        stopTyping
      })
    } finally {
      this.activeRequests.delete(objectId)
      await stopTyping()
    }
  }

  /** System client: for service work in spaces no person acts on behalf of (voice transcription). */
  systemAccessClient (): RestClient {
    if (this.serviceClient === undefined) {
      const token = generateToken(systemAccountUuid, this.wsIds.uuid, { service: 'aibot' })
      this.serviceClient = connectPlatform(token, this.wsIds.uuid, this.transactorUrl)
    }
    return this.serviceClient
  }

  /** Client reading as `personUuid`; the bot's own when there is nobody to act for. */
  private clientFor (personUuid: PersonUuid | undefined): RestClient {
    if (personUuid === undefined || personUuid === this.personUuid) return this.client

    let client = this.userClients.get(personUuid)
    if (client === undefined) {
      const token = generateToken(personUuid as AccountUuid, this.wsIds.uuid, { service: 'aibot' })
      client = connectPlatform(token, this.wsIds.uuid, this.transactorUrl)
      this.userClients.set(personUuid, client)
    }
    return client
  }

  // Read a collaborative-doc blob as markdown, preserving structure for the rewrite tool.
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

  // Model hierarchy, cached: getModel() refetches the whole model over HTTP on every call.
  private hierarchyPromise: Promise<Hierarchy> | undefined
  private async getHierarchy (): Promise<Hierarchy> {
    this.hierarchyPromise ??= this.client.getModel().then((m) => m.hierarchy)
    return await this.hierarchyPromise
  }

  /**
   * Context block for the linked object. `budgetTokens` is the share of the window the body may
   * take; over it the body is not truncated but replaced with an outline (see docPrompt.ts), and
   * the caller is told so it can withhold the editing tools.
   */
  private async buildDocPrompt (
    doc: Doc,
    countTokens: (text: string) => number,
    budgetTokens: number,
    asUser?: PersonUuid
  ): Promise<{ text: string, oversized: boolean } | undefined> {
    // isDerived, not ===: a task type is its own class derived from Issue (tracker:class:IssueTaskType).
    const hierarchy = await this.getHierarchy()
    if (hierarchy.isDerived(doc._class, tracker.class.Issue)) {
      const is = doc as Issue
      const body = (is.description != null ? await this.readMarkupBlobAsMarkdown(is.description) : undefined) ?? ''
      const oversized = countTokens(body) > budgetTokens
      return {
        oversized,
        text: buildDocPromptText({
          kind: 'issue',
          title: is.title,
          identifier: is.identifier,
          body,
          oversized,
          subtasksListing: await this.listSubIssues(is._id, 100, asUser)
        })
      }
    }
    if (hierarchy.isDerived(doc._class, document.class.Document)) {
      const d = doc as Document
      const body = (d.content != null ? await this.readMarkupBlobAsMarkdown(d.content) : undefined) ?? ''
      const oversized = countTokens(body) > budgetTokens
      return { oversized, text: buildDocPromptText({ kind: 'document', title: d.title, body, oversized }) }
    }
    return undefined
  }

  // Collaborative attribute rewritten by the AI edit tool, per source class. Extend alongside
  // buildDocPrompt when a new source type is linked.
  private async editTargetAttr (objectClass: Ref<Class<Doc>>): Promise<string | undefined> {
    const hierarchy = await this.getHierarchy()
    if (hierarchy.isDerived(objectClass, tracker.class.Issue)) return 'description'
    if (hierarchy.isDerived(objectClass, document.class.Document)) return 'content'
    return undefined
  }

  // Resolve the object an edit-proposal targets from the current thread's root message. The
  // "Discuss with the assistant" root (AIContextMessage) links to the real source object.
  async resolveEditTarget (
    rootId: Ref<Doc>,
    rootClass: Ref<Class<Doc>>
  ): Promise<{ targetId: Ref<Doc>, targetClass: Ref<Class<Doc>>, targetAttr: string } | undefined> {
    const root = await this.client.findOne<Doc>(rootClass, { _id: rootId })
    if (root === undefined || root._class !== aiBot.class.AIContextMessage) return undefined
    const link = root as AIContextMessage
    const targetAttr = await this.editTargetAttr(link.objectClass)
    if (targetAttr === undefined) return undefined
    return { targetId: link.objectId, targetClass: link.objectClass, targetAttr }
  }

  /** Stage a rename. Like every other change it is a proposal: the user applies it from the card. */
  async proposeRename (
    ctx: ReqCtx,
    target: { targetId: Ref<Doc>, targetClass: Ref<Class<Doc>>, targetAttr: string },
    title: string,
    asUser?: PersonUuid
  ): Promise<boolean> {
    const doc = await this.clientFor(asUser).findOne<Doc>(target.targetClass, { _id: target.targetId })
    if (doc === undefined) return false
    // Whatever the class calls its title: `titleKey` is what the platform renames docs by.
    const hierarchy = await this.getHierarchy()
    const titleKey = hierarchy.getClass(target.targetClass).titleKey ?? 'title'
    if ((doc as unknown as Record<string, unknown>)[titleKey] === title) return false
    // Merge into a body edit staged in the same run, so one card carries both.
    const staged = ctx.pending?.kind === 'edit' ? ctx.pending : undefined
    ctx.pending = { ...(staged ?? { kind: 'edit', ...target }), title }
    return true
  }

  // Stage a task proposal. It is not posted here: generateAndReply merges it into the bot's reply
  // so the text and the card land in one message.
  async postTaskProposal (
    ctx: ReqCtx,
    proposal: {
      title: string
      description?: string
      subtasks?: AITaskProposal[]
      parent?: Ref<Doc>
      priority?: number
      estimation?: number
      dueDate?: string
      labels?: string[]
      // More description parts are coming: the next call appends instead of replacing.
      awaitingMore?: boolean
    }
  ): Promise<boolean> {
    ctx.pending = { kind: 'task', ...proposal }
    return true
  }

  /** Titles of the sub-issues a task already has, normalized for comparison. */
  async existingSubIssueTitles (parentId: Ref<Doc>, asUser?: PersonUuid): Promise<Set<string>> {
    const subs = await this.clientFor(asUser).findAll<Issue>(
      tracker.class.Issue,
      { attachedTo: parentId as Ref<Issue> },
      { limit: 200, projection: { title: 1 } }
    )
    return new Set(subs.map((s) => s.title.trim().toLowerCase().replace(/\s+/g, ' ')))
  }

  // Compact listing of existing sub-issues for the model; bodies are trimmed.
  async listSubIssues (parentId: Ref<Doc>, limit = 100, asUser?: PersonUuid): Promise<string> {
    const subs = await this.clientFor(asUser).findAll<Issue>(
      tracker.class.Issue,
      { attachedTo: parentId as Ref<Issue> },
      { limit, sort: { rank: SortingOrder.Ascending } }
    )
    if (subs.length === 0) return 'This task has no sub-tasks yet.'
    const lines = await Promise.all(
      subs.map(async (s) => {
        const body = s.description != null ? await this.readMarkupBlobAsMarkdown(s.description) : undefined
        const short = body?.replace(/\s+/g, ' ').trim().slice(0, 200) ?? ''
        return `- ${s.identifier} ${s.title}${short !== '' ? ` — ${short}` : ''}`
      })
    )
    return `Existing sub-tasks (${subs.length}):\n${lines.join('\n')}`
  }

  // The issue this thread is linked to, when it is one - the parent for a split proposal.
  async resolveLinkedIssue (rootId: Ref<Doc>, rootClass: Ref<Class<Doc>>): Promise<Ref<Doc> | undefined> {
    const root = await this.client.findOne<Doc>(rootClass, { _id: rootId })
    if (root === undefined || root._class !== aiBot.class.AIContextMessage) return undefined
    const link = root as AIContextMessage
    const hierarchy = await this.getHierarchy()
    return hierarchy.isDerived(link.objectClass, tracker.class.Issue) ? link.objectId : undefined
  }

  // Current body of the edit target as markdown, for change detection. Reads the collab blob.
  private async currentTargetMarkdown (
    target: {
      targetId: Ref<Doc>
      targetClass: Ref<Class<Doc>>
      targetAttr: string
    },
    asUser?: PersonUuid
  ): Promise<string | undefined> {
    const doc = await this.clientFor(asUser).findOne<Doc>(target.targetClass, { _id: target.targetId })
    if (doc === undefined) return undefined
    const blob = (doc as any)[target.targetAttr] as Ref<Blob> | null | undefined
    if (blob == null) return ''
    return await this.readMarkupBlobAsMarkdown(blob)
  }

  /** Stage an edit proposal (see postTaskProposal); returns false if the finished proposal is a no-op. */
  async postEditProposal (
    ctx: ReqCtx,
    target: { targetId: Ref<Doc>, targetClass: Ref<Class<Doc>>, targetAttr: string },
    markdown: string,
    hasMore: boolean = false,
    asUser?: PersonUuid
  ): Promise<boolean> {
    // A rename staged earlier in the same run rides on the same card and must survive.
    const prior = ctx.pending?.kind === 'edit' ? ctx.pending : undefined
    const staged = prior?.awaitingMore === true ? prior.markdown : undefined
    const full = sanitizeDocumentMarkdown(staged !== undefined ? staged + markdown : markdown)
    // Compare only once the document is complete: an intermediate part always differs.
    if (!hasMore) {
      const current = await this.currentTargetMarkdown(target, asUser)
      if (current !== undefined && normalizeForCompare(current) === normalizeForCompare(full)) {
        ctx.pending = prior?.title !== undefined ? { kind: 'edit', ...target, title: prior.title } : undefined
        return false
      }
    }
    ctx.pending = {
      kind: 'edit',
      ...target,
      markdown: full,
      awaitingMore: hasMore,
      proposedMarkup: jsonToMarkup(markdownToMarkup(full, { refUrl: '', imageUrl: '' })),
      title: prior?.title
    }
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
      // Clears "is typing" the moment a cancel is noticed, before the wrap-up round.
      stopTyping?: () => Promise<void>
      // Set on the single retry after a compaction, so it cannot loop.
      retriedAfterCompaction?: boolean
    }
  ): Promise<void> {
    let { llm } = args
    const { personUuid, contextMode, objectId, objectClass, messageClass, space, prompt, promptTokens, providers } =
      args
    const level = args.level

    // Stamped before anything is read: the snapshot cursor anchors here, so a message posted while
    // this turn runs is picked up by the next one instead of falling into the gap.
    const askedAt = Date.now()

    // Memory (assistant/user/shared) lives in a Preference; conversation context
    // now comes from the chunter thread, not from a blob history.
    const memory = await this.getMemory(personUuid)

    const useHistory: LLMHistoryRecord[] = []

    const systemPrompts: LLMHistoryRecord[] = []

    // Placed at the END of history, next to the task: small models "lose the middle".
    let docPrompt: string | undefined
    // The document did not fit: only its outline is in context, so editing tools are withheld.
    let documentReadOnly = false
    // This turn folded the older part of the conversation into a summary.
    let didCompact = false
    // Kept for the compact-and-retry path: the provider may still refuse a context we measured as
    // fitting, and then the only way forward is to fold more of it.
    let snapshotForRetry: ConversationSnapshot | undefined
    const retriedAfterCompaction = args.retriedAfterCompaction === true

    // Monthly billed-token window (from billing). Past the limit: paid plans downgrade to
    // the local low level, free plans are blocked (fallback-eligible levels always serve).
    const requestedLevel = level ?? config.DefaultLevel
    // Only levels allowed for this feature take part in routing and window downgrade.
    const registry = registryForFeature(config.AIProviders, event.feature)
    const windows = await getWorkspaceWindows(this.ctx, this.wsIds.uuid)
    // Limits are feature-agnostic: the fallback is searched in the full registry, else a feature
    // that excludes the fallback-eligible level (low) would hard-block instead of degrading.
    const decision = decideLevel(requestedLevel, windows)
    if (decision.action === 'block') {
      const lang = event.language ?? config.DefaultLanguage
      const message =
        decision.reason === 'unavailable' ? aiBot.string.AIServiceUnavailable : aiBot.string.TokenLimitReachedMonth
      // Replaces "is typing" with the reason right away, so the user reads it while the refusal
      // message is still being written.
      await this.setTypingStatus(objectId, space, message)
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

    // Effective level may have been downgraded to a fallback-eligible model. A downgrade serves
    // from the full registry (degraded answer beats none); the normal path stays feature-narrowed.
    const effectiveLevel = decision.level ?? requestedLevel
    const resolved = resolveModel(effectiveLevel, effectiveLevel === requestedLevel ? registry : config.AIProviders)

    // Every budget below is measured against the level that actually serves.
    const servedBudget = contextBudgetFor(resolved.level)

    // Landed on a different level than requested (window downgrade or a feature-denied level):
    // switch the LLM instance too, else the original provider would run + bill the wrong level.
    if (resolved.level !== requestedLevel && providers !== undefined) {
      const downgraded = providers.get(resolved.provider.id)
      if (downgraded !== undefined) {
        llm = downgraded
      }
    }

    {
      // Top-level replies use only today's messages; older ones load via load_thread_history tool.
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
          // User-authored content must stay at user level: as a system message it would let the
          // author override tool-use instructions via prompt injection.
          systemPrompts.push({
            role: 'user' as const,
            content: 'Content: ' + markupToText((msg as ChatMessage).message)
          })
        }
        // "Discuss with the assistant" thread: the root message links to a source object (issue,
        // document, ...). Load that object so its content is in context, not just the starter.
        let linked: Doc | undefined
        if (msg._class === aiBot.class.AIContextMessage) {
          const link = msg as AIContextMessage
          linked = await this.clientFor(personUuid).findOne<Doc>(link.objectClass, { _id: link.objectId })
          if (linked === undefined && link.purpose !== 'issue-draft') {
            // Deleted, or in a space the asker cannot read. Silently it looks like an unlinked chat.
            this.ctx.warn('linked object not readable', {
              workspace: this.wsIds.uuid,
              root: link._id,
              objectId: link.objectId,
              objectClass: link.objectClass
            })
            systemPrompts.push({
              role: 'system' as const,
              content:
                'The task or document this conversation is linked to cannot be read (it was deleted, or ' +
                'you have no access to its space). Say that plainly when asked about it: you cannot quote ' +
                'or edit it, and you must not guess what it contains.'
            })
          }
          // Draft the conversation works on (create-issue dialog). Kept off the message body so
          // the chat stays readable; the model still needs it on every turn.
          if (link.workingContext !== undefined && link.workingContext.trim() !== '') {
            systemPrompts.push({ role: 'user' as const, content: link.workingContext })
          }
        }
        // Any non-chat source object (issue, document, ...) is described from its class schema.
        const source = linked ?? (msg._class !== chunter.class.ChatMessage ? msg : undefined)
        const isChatStarter =
          source !== undefined &&
          (source._class === chunter.class.ChatMessage ||
            source._class === chunter.class.ThreadMessage ||
            source._class === aiBot.class.AIContextMessage)
        if (source !== undefined && !isChatStarter) {
          const built = await this.buildDocPrompt(
            source,
            (text) => llm.countTokens([{ role: 'user', content: text }]) ?? 0,
            Math.floor(servedBudget * DOC_PROMPT_SHARE),
            personUuid
          )
          docPrompt = built?.text
          documentReadOnly = built?.oversized === true
        }
      }

      // A thread keeps its own transcript file, written after every reply. Reading it back beats
      // re-querying (and re-tokenizing) the whole thread; only what arrived after the file's cursor
      // still has to come from the database. Top-level replies are day-limited and keep the old path.
      let snapshot = dayLimited ? undefined : await this.loadSnapshot(objectId)
      const beforeCompaction = snapshot?.firstKept
      // Compact before assembling: past this point the window trim would silently drop the oldest
      // turns, and whatever was agreed at the start would go with them.
      if (snapshot !== undefined) {
        snapshot = await this.compactIfNeeded(
          objectId,
          snapshot,
          llm,
          servedBudget,
          event.language ?? config.DefaultLanguage,
          resolved.level,
          personUuid,
          space
        )
        didCompact = snapshot.firstKept !== beforeCompaction
        snapshotForRetry = snapshot
      }
      const sinceQuery =
        snapshot !== undefined ? { ...contextQuery, modifiedOn: { $gte: snapshot.cursor } } : contextQuery
      const alreadyInSnapshot = snapshotMessageIds(snapshot)

      const lastMessages =
        (await this.client?.findAll(chunter.class.ChatMessage, sinceQuery, {
          limit: 500,
          sort: { modifiedOn: SortingOrder.Descending }
        })) ?? []

      lastMessages.sort((a, b) => a.modifiedOn - b.modifiedOn)

      // Match own social ids to tag messages as 'assistant' vs 'user'.
      const botSocialIds = new Set(this.socialIds.map((it) => it._id))

      const contextMessages: ContextMessage[] = []
      // `contextTurns` hands back the newest summary plus the verbatim tail after it; tool turns
      // stay in the file for the reader, the model never saw prior runs' tool traffic before.
      for (const turn of contextTurns(snapshot)) {
        if (turn.role === 'tool') continue
        // A summary is context about the conversation, not something anyone said in it.
        const role: 'user' | 'assistant' = turn.role === 'assistant' ? 'assistant' : 'user'
        const content =
          turn.role === 'summary' ? `[Summary of the earlier part of this conversation]\n${turn.content}` : turn.content
        contextMessages.push({
          role,
          content,
          tokens: llm.countTokens([{ role, content }]) ?? 0
        })
      }
      for (const msg of lastMessages) {
        if (alreadyInSnapshot.has(msg._id)) continue
        const msgRole: 'assistant' | 'user' = botSocialIds.has(msg.modifiedBy) ? 'assistant' : 'user'
        // Edit proposals are UI artifacts; feed only the fact it happened, never the proposed body.
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

      // Truncate the thread context to fit the model window (oldest dropped first). The serving
      // level's own context window wins when it is tighter than the pod-wide budget: a small model
      // silently drops whatever overflows, so the history must be cut to what it can actually read.
      useHistory.push(...buildThreadContext(contextMessages, promptTokens, servedBudget))

      // Document goes last (after the chat history, just before the user request) so a small model
      // sees it adjacent to the task it must act on.
      if (docPrompt !== undefined) {
        useHistory.push({ role: 'user' as const, content: docPrompt })
      }
    }

    const aiRequestId = await this.createAIRequest(personUuid, space, {
      level: resolved.level,
      modelId: resolved.model.model,
      kind: 'chat',
      objectId
    })
    // Lets the typing refresh see a cancel without waiting for the round to end.
    if (aiRequestId !== undefined) this.activeRequests.set(objectId, aiRequestId)

    // How full the context is and where compaction kicks in. Written on every request so the user
    // sees it coming instead of noticing afterwards that the early part of the talk is gone.
    if (aiRequestId !== undefined) {
      const used = useHistory.reduce((sum, m) => sum + (llm.countTokens([m]) ?? 0), promptTokens)
      await this.updateAIRequest(personUuid, aiRequestId, space, {
        contextTokens: used,
        contextCompactAt: Math.max(0, servedBudget - config.CompactionReserveTokens),
        compacted: didCompact
      }).catch((err) => {
        this.ctx.warn('failed to report context fill', { err: err?.message })
      })
    }

    // Shared with the tools: a proposal tool stages its result here instead of posting a message.
    // Ceilings for what tools may add to the context, derived from the level that actually serves.
    const budgets = toolBudgets(servedBudget)
    const reqCtx: ReqCtx = {
      objectId,
      objectClass,
      space,
      collection: event.collection,
      purpose: event.purpose,
      documentReadOnly,
      perCallChars: budgets.perCall,
      budget: { maxChars: budgets.perRun, spentChars: 0 }
    }
    const tools = getTools(this, contextMode, personUuid as AccountUuid, reqCtx, resolved.model.features, event.purpose)
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
        replyLang,
        this.requestHooks(personUuid, aiRequestId, space, args.stopTyping)
      )
    } catch (err: any) {
      // Estimates can under-count, so compact and retry once - but only while the window still
      // serves: the failed call may have used it up, and compacting is another billed call.
      if (isContextOverflow(err) && snapshotForRetry !== undefined && !retriedAfterCompaction) {
        const windowsNow = await getWorkspaceWindows(this.ctx, this.wsIds.uuid)
        if (decideLevel(resolved.level, windowsNow).action !== 'block') {
          this.ctx.warn('context overflow, compacting and retrying once', { workspace: this.wsIds.uuid })
          const compacted = await this.compactIfNeeded(
            objectId,
            snapshotForRetry,
            llm,
            servedBudget,
            event.language ?? config.DefaultLanguage,
            resolved.level,
            personUuid,
            space,
            true
          )
          if (compacted.firstKept !== snapshotForRetry.firstKept) {
            await this.generateAndReply(event, { ...args, retriedAfterCompaction: true })
            return
          }
        }
      }
      // LLM failed after in-worker retries; swallow instead of rethrow so the queue does not reprocess.
      this.ctx.error('chat completion failed', { workspace: this.wsIds.uuid, error: err?.message })
      if (aiRequestId !== undefined) {
        await this.updateAIRequest(personUuid, aiRequestId, space, failedPatch(err?.message ?? 'error'))
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
      if (aiRequestId !== undefined) {
        await this.updateAIRequest(personUuid, aiRequestId, space, failedPatch('empty response'))
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

    if (aiRequestId !== undefined) {
      const multiplier = resolved.model.tokenMultiplier
      const patch = donePatch(chatCompletion?.usage, multiplier)
      await this.updateAIRequest(
        personUuid,
        aiRequestId,
        space,
        chatCompletion?.cancelled === true ? { ...patch, status: 'cancelled' } : patch
      )
    }
    const parseResponse = jsonToMarkup(markdownToMarkup(response, { refUrl: '', imageUrl: '' }))
    // A tool staged a proposal: the reply carries it, so the user gets one message - text + card.
    const replyId = await this.writeReply(
      messageClass,
      space,
      objectId,
      objectClass,
      event.collection,
      parseResponse,
      reqCtx.pending
    )

    // The answer is out - freeze this turn so the next one reads the file instead of the thread.
    // Detached: a storage hiccup must not fail a reply the user already has.
    if (!event.objectIdIsSpace) {
      void this.appendSnapshotTurn(objectId, objectClass, {
        userMessageId: event.messageId,
        userContent: prompt.content,
        userAuthor: personUuid,
        askedAt,
        toolTranscript: chatCompletion?.toolTranscript,
        answer: response,
        replyId
      })
    }
  }

  /** The thread's transcript file as it is stored, for the download button. */
  async readSnapshotFile (conversation: Ref<Doc>): Promise<string | undefined> {
    try {
      const id = snapshotBlobId(conversation)
      if ((await this.storage.stat(this.ctx, this.wsIds, id)) === undefined) return undefined
      return Buffer.concat(await this.storage.read(this.ctx, this.wsIds, id)).toString()
    } catch (err: any) {
      this.ctx.warn('conversation snapshot read failed', { workspace: this.wsIds.uuid, error: err?.message })
      return undefined
    }
  }

  /** Read the thread's transcript file. Missing or unparseable - the caller falls back to the DB. */
  private async loadSnapshot (conversation: Ref<Doc>): Promise<ConversationSnapshot | undefined> {
    try {
      const id = snapshotBlobId(conversation)
      if ((await this.storage.stat(this.ctx, this.wsIds, id)) === undefined) return undefined
      const text = Buffer.concat(await this.storage.read(this.ctx, this.wsIds, id)).toString()
      return parseSnapshot(text)
    } catch (err: any) {
      this.ctx.warn('conversation snapshot read failed', {
        workspace: this.wsIds.uuid,
        conversation,
        error: err?.message
      })
      return undefined
    }
  }

  /**
   * Append one completed turn (the request, the tools it triggered, the answer) to the thread file.
   * Idempotent by the incoming message id, so a redelivered event does not duplicate the turn.
   */
  private async appendSnapshotTurn (
    conversation: Ref<Doc>,
    conversationClass: Ref<Class<Doc>>,
    turn: {
      userMessageId: Ref<Doc>
      userContent: string
      userAuthor: PersonUuid
      askedAt: number
      toolTranscript?: Array<{ name: string, arguments?: string, content: string }>
      answer: string
      replyId?: Ref<Doc>
    }
  ): Promise<void> {
    try {
      const existing = await this.loadSnapshot(conversation)
      if (existing?.turns.some((t) => t.messageId === turn.userMessageId) === true) return

      const at = Date.now()
      const author = (await this.client.findOne(contact.class.Person, { personUuid: turn.userAuthor }))?.name
      const turns: SnapshotTurn[] = [
        {
          role: 'user',
          // The request's own timestamp, not now: the cursor anchors here, and whatever was posted
          // while the model was thinking still has to be re-read.
          author: author ?? turn.userAuthor,
          at: turn.askedAt,
          messageId: turn.userMessageId,
          content: turn.userContent
        }
      ]
      for (const call of turn.toolTranscript ?? []) {
        turns.push({
          role: 'tool',
          author: call.name,
          at,
          content: `\`\`\`json\n${JSON.stringify({ arguments: call.arguments, result: call.content })}\n\`\`\``
        })
      }
      turns.push({
        role: 'assistant',
        author: this.aiPerson?.name ?? 'assistant',
        at,
        messageId: turn.replyId,
        content: turn.answer
      })

      const snapshot = appendTurns(
        existing,
        conversation,
        `${conversationClass}:${conversation}`,
        turns,
        SNAPSHOT_MAX_TURNS
      )
      await this.writeSnapshot(conversation, snapshot)
    } catch (err: any) {
      this.ctx.warn('conversation snapshot write failed', {
        workspace: this.wsIds.uuid,
        conversation,
        error: err?.message
      })
    }
  }

  private async writeSnapshot (conversation: Ref<Doc>, snapshot: ConversationSnapshot): Promise<void> {
    const data = Buffer.from(renderSnapshot(snapshot))
    await this.storage.put(this.ctx, this.wsIds, snapshotBlobId(conversation), data, 'text/markdown', data.length)
  }

  /**
   * Fold the older part of the conversation into a summary when it no longer fits the window.
   * Called before the context is assembled: without it `buildThreadContext` would drop the oldest
   * turns silently, taking with them whatever was agreed at the start.
   *
   * Failure is not fatal - the conversation carries on uncompacted and the window trim applies as
   * before, so a summarizer hiccup never costs the user their answer.
   */
  private async compactIfNeeded (
    conversation: Ref<Doc>,
    snapshot: ConversationSnapshot,
    llm: LLMProvider,
    budgetTokens: number,
    lang: string,
    level: AILevel | undefined,
    personUuid: PersonUuid,
    space: Ref<Space>,
    force = false
  ): Promise<ConversationSnapshot> {
    if (llm.compactConversation === undefined) return snapshot
    const plan = planCompaction({
      turns: snapshot.turns,
      firstKept: snapshot.firstKept,
      countTokens: (text) => llm.countTokens([{ role: 'user', content: text }]) ?? 0,
      budgetTokens,
      reserveTokens: config.CompactionReserveTokens,
      keepRecentTokens: config.CompactionKeepRecentTokens,
      force
    })
    if (!plan.needed) return snapshot

    const previous = [...snapshot.turns].reverse().find((t) => t.role === 'summary')?.content
    const aiRequestId = await this.createAIRequest(personUuid, space, {
      level: level ?? config.DefaultLevel,
      modelId: '',
      kind: 'compaction',
      objectId: conversation
    })
    try {
      const summary = await llm.compactConversation(
        this.ctx,
        this.wsIds.uuid,
        renderForSummary(plan.toSummarize),
        lang,
        previous,
        level
      )
      if (summary === undefined || summary.trim() === '') return snapshot

      const compacted = appendSummary(snapshot, summary.trim(), plan.firstKeptId, Date.now())
      await this.writeSnapshot(conversation, compacted)
      this.ctx.info('conversation compacted', {
        workspace: this.wsIds.uuid,
        conversation,
        folded: plan.toSummarize.length,
        kept: plan.kept.length
      })
      if (aiRequestId !== undefined) {
        await this.updateAIRequest(personUuid, aiRequestId, space, { status: 'done' })
      }
      return compacted
    } catch (err: any) {
      this.ctx.warn('conversation compaction failed', { workspace: this.wsIds.uuid, error: err?.message })
      if (aiRequestId !== undefined) {
        await this.updateAIRequest(personUuid, aiRequestId, space, failedPatch(err?.message ?? 'error'))
      }
      return snapshot
    }
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

  // A member became active -> open the Direct with the bot and greet. Without this the chat exists
  // only after the user finds the "Talk to the assistant" button, so on a fresh workspace the bot looks
  // absent. An existing Direct is the idempotency guard.
  async sendWelcomeIfNeeded (person: Ref<Person>): Promise<void> {
    await this.ensureInited()
    const aiAccount = this.aiPerson?.personUuid as AccountUuid | undefined
    if (aiAccount === undefined) return

    try {
      const employee = await this.client.findOne(contact.mixin.Employee, { _id: person as Ref<Employee> })
      const account = employee?.personUuid
      if (employee?.active !== true || account === undefined || account === aiAccount) return
      if ((await this.findUserDirect(account)) !== undefined) return
      await this.sendWelcome(account, aiAccount)
    } catch (err: any) {
      this.ctx.warn('welcome failed', { workspace: this.wsIds.uuid, person, error: err?.message })
    }
  }

  // Members who joined before the welcome existed have no Direct with the bot at all: the chat used to
  // appear only when someone pressed "Talk to the assistant". Backfill it on connect.
  private async backfillWelcomeDirects (): Promise<void> {
    const aiAccount = this.aiPerson?.personUuid as AccountUuid | undefined
    if (aiAccount === undefined) return

    try {
      const directs = await this.client.findAll<DirectMessage>(chunter.class.DirectMessage, { members: aiAccount })
      const greeted = new Set<AccountUuid>()
      for (const dm of directs) {
        if (dm.members.length !== 2) continue
        const other = dm.members.find((m) => m !== aiAccount)
        if (other !== undefined) greeted.add(other)
      }

      const employees = await this.client.findAll(contact.mixin.Employee, { active: true })
      for (const employee of employees) {
        const account = employee.personUuid
        if (account === undefined || account === aiAccount || greeted.has(account)) continue
        await this.sendWelcome(account, aiAccount)
      }
    } catch (err: any) {
      this.ctx.warn('welcome backfill failed', { workspace: this.wsIds.uuid, error: err?.message })
    }
  }

  private async sendWelcome (account: AccountUuid, aiAccount: AccountUuid): Promise<void> {
    welcomeMessages = welcomeMessages ?? loadWelcomeMessages()
    const lang = await this.resolveChatLanguage(account, undefined, true)
    const text = pickWelcome(welcomeMessages, lang)
    if (text === undefined) return
    const greeting = renderPrompt(text, { botName: botName(config.FirstName) })
    const markup = jsonToMarkup(markdownToMarkup(greeting, { refUrl: '', imageUrl: '' }))
    // The backfill greets every existing member at once, so keep it inbox-only instead of pushing to everyone.
    const meta: TxMeta = { inboxOnly: true }
    const direct = await this.client.createDoc<DirectMessage>(
      chunter.class.DirectMessage,
      core.space.Space,
      {
        name: '',
        description: '',
        private: true,
        archived: false,
        members: [aiAccount, account],
        type: 'person'
      },
      undefined,
      undefined,
      undefined,
      meta
    )
    await this.client.addCollection<Doc, ChatMessage>(
      chunter.class.ChatMessage,
      direct,
      direct,
      chunter.class.DirectMessage,
      'messages',
      { message: markup },
      undefined,
      undefined,
      undefined,
      meta
    )
  }

  // Find the user's existing Direct chat with the bot (does not create one).
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

  // Post a notice in the user's Direct chat with the bot, falling back to the request's origin thread.
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

  // Write a bot reply as a ChatMessage or a ThreadMessage under the parent message. Returns the id
  // written, which the conversation snapshot records so the next turn does not re-read it.
  private async writeReply (
    messageClass: Ref<Class<Doc>>,
    space: Ref<Space>,
    objectId: Ref<Doc>,
    objectClass: Ref<Class<Doc>>,
    collection: string,
    markup: string,
    pending?: PendingProposal
  ): Promise<Ref<Doc> | undefined> {
    // Proposal messages derive from ThreadMessage, so they need the thread parent's object refs.
    // In a Direct there is no parent message and the channel itself plays that role.
    const parent = await this.client.findOne<ChatMessage>(chunter.class.ChatMessage, {
      _id: objectId as Ref<ChatMessage>
    })
    const threadRefs = {
      objectId: parent?.attachedTo ?? objectId,
      objectClass: parent?.attachedToClass ?? objectClass
    }

    if (pending?.kind === 'edit') {
      return await this.client.addCollection<Doc, AIEditProposalMessage>(
        aiBot.class.AIEditProposalMessage,
        space,
        objectId,
        objectClass,
        collection,
        {
          message: markup,
          ...threadRefs,
          targetId: pending.targetId,
          targetClass: pending.targetClass,
          targetAttr: pending.targetAttr,
          proposedMarkup: pending.proposedMarkup,
          proposedTitle: pending.title
        }
      )
    }
    if (pending?.kind === 'task') {
      return await this.client.addCollection<Doc, AITaskProposalMessage>(
        aiBot.class.AITaskProposalMessage,
        space,
        objectId,
        objectClass,
        collection,
        {
          message: markup,
          ...threadRefs,
          title: pending.title,
          description: pending.description,
          subtasks: pending.subtasks,
          parent: pending.parent,
          priority: pending.priority,
          estimation: pending.estimation,
          dueDate: pending.dueDate,
          labels: pending.labels
        }
      )
    }

    if (messageClass === chunter.class.ChatMessage) {
      return await this.client.addCollection<Doc, ChatMessage>(
        chunter.class.ChatMessage,
        space,
        objectId,
        objectClass,
        collection,
        { message: markup }
      )
    } else if (messageClass === chunter.class.ThreadMessage && parent !== undefined) {
      return await this.client.addCollection<Doc, ThreadMessage>(
        chunter.class.ThreadMessage,
        space,
        objectId,
        objectClass,
        collection,
        { message: markup, ...threadRefs }
      )
    }
  }

  async meetingStarted (meetingId: Ref<MeetingMinutes>): Promise<void> {
    await this.ensureInited()
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
    await this.ensureInited()
    await this.love?.disconnect(meetingId)
  }

  async close (): Promise<void> {
    this.userClients.clear()
    this.ctx.info('Closed workspace client: ', { workspace: this.wsIds })
  }

  async loveConnect (request: ConnectMeetingRequest): Promise<void> {
    await this.ensureInited()
    if (this.love === undefined) {
      this.ctx.error('Love controller is not initialized')
      return
    }
    await this.love.connect(request)
  }

  async loveDisconnect (request: DisconnectMeetingRequest): Promise<void> {
    await this.ensureInited()
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
    await this.ensureInited()
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
    await this.ensureInited()
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
    await this.ensureInited()
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
    await this.ensureInited()
    if (this.love === undefined) {
      this.ctx.error('Love controller is not initialized')
      return false
    }

    return await this.love.createTranscriptionMessageWithTimestamp(text, participant, meeting, timestamp)
  }

  async getLoveIdentity (): Promise<IdentityResponse | undefined> {
    await this.ensureInited()
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
