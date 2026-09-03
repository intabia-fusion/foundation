//
// Copyright © 2026 Intabia Fusion Inc.
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

import core, {
  AccountUuid,
  Class,
  Collaborator,
  Doc,
  DocumentQuery,
  getClassCollaborators,
  groupByArray,
  MeasureContext,
  notEmpty,
  PersonId,
  Ref,
  Space,
  systemAccountUuid,
  TxCreateDoc,
  TxCUD,
  TxMixin,
  TxProcessor,
  TxRemoveDoc,
  TxUpdateDoc,
  UserStatus
} from '@hcengineering/core'
import notification, {
  DocNotificationSetting,
  DocNotifyContext,
  type NotificationProviderSetting,
  type NotificationTypeSetting,
  ReadState,
  PushSubscription,
  PushSubscriptionSetting
} from '@hcengineering/notification'
import contact, { Employee, Person, PersonSpace, SocialIdentity, SocialIdentityRef } from '@hcengineering/contact'
import { Receiver, Sender } from '@hcengineering/server-notification'
import { LRUCache } from 'lru-cache'

import { Client, EmployeeInfo, NotificationSettings, SocialIdentityInfo } from './types'

/**
 * WorkspaceCache manages caching and transaction-driven updates of
 * notification-related workspace documents, collaborator access lists, and user statuses.
 */
class WorkspaceCache {
  // ==========================================
  // Primary LRU Caches (Bounded at 1000 items)
  // ==========================================

  /** Caches collaborators lists for a given document. */
  private readonly collaboratorsByDocCache = new LRUCache<Ref<Doc>, Collaborator[]>({
    max: 1000,
    dispose: (collabs, _key, reason) => {
      if (reason === 'evict') {
        for (const collab of collabs) {
          this.collaboratorToDocMap.delete(collab._id)
        }
      }
    }
  })

  /** Caches active notification contexts of a document. */
  private readonly contextsByDocCache = new LRUCache<Ref<Doc>, DocNotifyContext[]>({
    max: 1000,
    dispose: (contexts, _key, reason) => {
      if (reason === 'evict') {
        for (const context of contexts) {
          this.contextToDocMap.delete(context._id)
        }
      }
    }
  })

  /** Caches specific notification settings attached to a document. */
  private readonly notificationSettingsByDocCache = new LRUCache<Ref<Doc>, DocNotificationSetting[]>({
    max: 1000,
    dispose: (settings, _key, reason) => {
      if (reason === 'evict') {
        for (const setting of settings) {
          this.settingToDocMap.delete(setting._id)
        }
      }
    }
  })

  /** General document cache. */
  private readonly documentsCache = new LRUCache<Ref<Doc>, Doc>({
    max: 1000
  })

  /** Caches read state settings for documents. */
  private readonly readStatesByDocCache = new LRUCache<Ref<Doc>, ReadState>({
    max: 1000,
    dispose: (state, _key, reason) => {
      if (reason === 'evict') {
        this.readStateToDocMap.delete(state._id)
      }
    }
  })

  /** Caches loaded Person records indexed by their Social identity ID. */
  private readonly personsBySocialIdCache = new LRUCache<PersonId, Person>({
    max: 1000,
    dispose: (person, socialId, reason) => {
      if (reason === 'evict') {
        const set = this.personToSocialIdsMap.get(person._id)
        if (set !== undefined) {
          set.delete(socialId)
          if (set.size === 0) {
            this.personToSocialIdsMap.delete(person._id)
          }
        }
      }
    }
  })

  /** Caches workspace settings spaces assigned to a user account. */
  private readonly personSpacesByAccountCache = new LRUCache<AccountUuid, PersonSpace>({
    max: 1000,
    dispose: (space, _account, reason) => {
      if (reason === 'evict') {
        this.personSpaceToAccountMap.delete(space._id)
      }
    }
  })

  /** Caches employee information records. */
  private readonly employeesByAccountCache = new LRUCache<AccountUuid, EmployeeInfo>({
    max: 1000,
    dispose: (employee, _account, reason) => {
      if (reason === 'evict') {
        this.employeeToAccountMap.delete(employee._id)
      }
    }
  })

  /** Caches social identities lists mapped to an employee profile. */
  private readonly socialIdentitiesByEmployeeCache = new LRUCache<Ref<Employee>, SocialIdentityInfo[]>({
    max: 1000,
    dispose: (socialIds, _employeeRef, reason) => {
      if (reason === 'evict') {
        for (const socialId of socialIds) {
          this.socialIdToEmployeeMap.delete(socialId._id)
        }
      }
    }
  })

  /** Caches active push notifications subscription tokens. */
  private readonly pushSubscriptionsByAccountCache = new LRUCache<AccountUuid, PushSubscription[]>({
    max: 1000
  })

  /** Caches social identity to account mappings. */
  private readonly accountsBySocialIdCache = new LRUCache<PersonId, AccountUuid>({
    max: 1000
  })

  // ==========================================
  // Static Configuration & Global State Maps
  // ==========================================

  private isSettingsLoaded = false
  private readonly notificationProviderSettingsMap = new Map<
  Ref<NotificationProviderSetting>,
  NotificationProviderSetting
  >()

  private readonly notificationTypeSettingsMap = new Map<Ref<NotificationTypeSetting>, NotificationTypeSetting>()
  private readonly userStatusesMap = new Map<Ref<UserStatus>, UserStatus>()

  // ==========================================
  // Secondary Indexes for O(1) Transaction Updates
  // ==========================================

  private readonly collaboratorToDocMap = new Map<Ref<Collaborator>, Ref<Doc>>()
  private readonly readStateToDocMap = new Map<Ref<ReadState>, Ref<Doc>>()
  private readonly contextToDocMap = new Map<Ref<DocNotifyContext>, Ref<Doc>>()
  private readonly settingToDocMap = new Map<Ref<DocNotificationSetting>, Ref<Doc>>()
  private readonly personSpaceToAccountMap = new Map<Ref<PersonSpace>, AccountUuid>()
  private readonly personToSocialIdsMap = new Map<Ref<Person>, Set<PersonId>>()
  private readonly socialIdToEmployeeMap = new Map<Ref<SocialIdentity>, Ref<Employee>>()
  private readonly employeeToAccountMap = new Map<Ref<Employee>, AccountUuid>()

  private readonly serviceTxes = new LRUCache<Ref<TxCUD<Doc>>, boolean>({ max: 10000 })

  constructor (
    private readonly ctx: MeasureContext,
    private readonly client: Client
  ) {}

  // ==========================================
  // Public API
  // ==========================================

  /**
   * Processes a transaction CUD event and updates the cache indexes in real time.
   */
  public tx (tx: TxCUD<Doc>, service: boolean = false): void {
    if (this.serviceTxes.has(tx._id)) {
      this.serviceTxes.delete(tx._id)
      return
    }

    if (this.isPushSubscriptionTx(tx)) {
      this.pushSubscriptionsByAccountCache.clear()
    }
    if (tx._class === core.class.TxCreateDoc) {
      this.txCreateDoc(tx as TxCreateDoc<Doc>)
    }

    if ([core.class.TxUpdateDoc, core.class.TxMixin].includes(tx._class)) {
      this.txUpdateDoc(tx as TxUpdateDoc<Doc> | TxMixin<Doc, Doc>)
    }

    if (tx._class === core.class.TxRemoveDoc) {
      this.txRemoveDoc(tx as TxRemoveDoc<Doc>)
    }

    if (service) {
      this.serviceTxes.set(tx._id, true)
    }
  }

  /**
   * Resolves notification providers and types configurations.
   */
  public async getSettings (): Promise<NotificationSettings> {
    const providersSettings: NotificationProviderSetting[] = this.isSettingsLoaded
      ? Array.from(this.notificationProviderSettingsMap.values())
      : await this.client.findAll<NotificationProviderSetting>(notification.class.NotificationProviderSetting, {})

    if (!this.isSettingsLoaded) {
      for (const setting of providersSettings) {
        this.notificationProviderSettingsMap.set(setting._id, setting)
      }
    }

    const typesSettings: NotificationTypeSetting[] = this.isSettingsLoaded
      ? Array.from(this.notificationTypeSettingsMap.values())
      : await this.client.findAll(notification.class.NotificationTypeSetting, {})

    if (!this.isSettingsLoaded) {
      for (const setting of typesSettings) {
        this.notificationTypeSettingsMap.set(setting._id, setting)
      }
    }

    this.isSettingsLoaded = true

    return {
      providersSettings,
      typesSettings,
      settingsByProvider: groupByArray(providersSettings, (it) => it.attachedTo),
      typesByProvider: groupByArray(typesSettings, (it) => it.attachedTo)
    }
  }

  /**
   * Returns list of collaborators for a specific document.
   */
  public async getCollaborators (_id: Ref<Doc>, _class: Ref<Class<Doc>>): Promise<Collaborator[]> {
    if (this.collaboratorsByDocCache.has(_id)) {
      return this.collaboratorsByDocCache.get(_id) ?? []
    }

    const mixin = getClassCollaborators(this.client.model, this.client.hierarchy, _class)
    if (mixin === undefined) {
      return []
    }

    const collaborators = await this.client.findAll(core.class.Collaborator, { attachedTo: _id })

    this.collaboratorsByDocCache.set(_id, collaborators)
    for (const collab of collaborators) {
      this.collaboratorToDocMap.set(collab._id, _id)
    }

    return collaborators
  }

  /**
   * Returns a cached document or fetches it from database.
   */
  public async getDoc<T extends Doc = Doc>(_id: Ref<T>, _class: Ref<Class<T>>): Promise<T | undefined> {
    if (this.documentsCache.has(_id)) return this.documentsCache.get(_id) as T
    // A tx can name a task type's target mixin that the workspace model no longer has; findOne then
    // throws "domain not found" and the tx consumer retries that one message forever.
    if (!this.client.hierarchy.hasClass(_class)) return undefined

    const query = { _id } as unknown as DocumentQuery<T>
    const doc = await this.client.findOne(_class, query)
    if (doc !== undefined) {
      this.documentsCache.set(_id, doc)
    } else {
      this.documentsCache.delete(_id)
    }
    return doc as T | undefined
  }

  /**
   * Returns document notification contexts.
   */
  public async getContexts (_id: Ref<Doc>): Promise<DocNotifyContext[]> {
    if (this.contextsByDocCache.has(_id)) return this.contextsByDocCache.get(_id) ?? []

    const contexts = await this.client.findAll(notification.class.DocNotifyContext, { objectId: _id })
    this.contextsByDocCache.set(_id, contexts)
    for (const context of contexts) {
      this.contextToDocMap.set(context._id, _id)
    }

    return contexts
  }

  public async getContext (_id: Ref<Doc>, account: AccountUuid): Promise<DocNotifyContext | undefined> {
    const loaded = (this.contextsByDocCache.get(_id) ?? []).find((it) => it.user === account)
    if (loaded != null) return loaded

    return await this.client.findOne(notification.class.DocNotifyContext, { objectId: _id, user: account })
  }

  /**
   * Returns document settings.
   */
  public async getDocSettings (_id: Ref<Doc>): Promise<DocNotificationSetting[]> {
    if (this.notificationSettingsByDocCache.has(_id)) return this.notificationSettingsByDocCache.get(_id) ?? []

    const settings = await this.client.findAll(notification.class.DocNotificationSetting, { attachedTo: _id })
    this.notificationSettingsByDocCache.set(_id, settings)
    for (const setting of settings) {
      this.settingToDocMap.set(setting._id, _id)
    }

    return settings
  }

  /**
   * Manually adds a document context to the cache.
   */
  public storeContext (context: DocNotifyContext): void {
    const current = this.contextsByDocCache.get(context.objectId) ?? []
    this.contextsByDocCache.set(context.objectId, [...current, context])
    this.contextToDocMap.set(context._id, context.objectId)
  }

  /**
   * Resolves the Space document assigned to a given doc.
   */
  public async getDocSpace (doc: Doc): Promise<Space | undefined> {
    if (this.client.hierarchy.isDerived(doc._class, core.class.Space)) return doc as Space
    const curent = this.documentsCache.get(doc.space)
    if (curent !== undefined) return curent as Space

    const space = await this.client.findOne<Space>(core.class.Space, { _id: doc.space }, { limit: 1 })

    if (space !== undefined) {
      this.documentsCache.set(doc.space, space)
    }

    return space
  }

  /**
   * Fetches read state document attached to a given doc.
   */
  public async getDocReadState (attachedTo: Ref<Doc>): Promise<ReadState | undefined> {
    const current = this.readStatesByDocCache.get(attachedTo)
    if (current !== undefined) return current
    const readState = await this.client.findOne<ReadState>(notification.class.ReadState, { attachedTo })
    if (readState !== undefined) {
      this.readStatesByDocCache.set(attachedTo, readState)
      this.readStateToDocMap.set(readState._id, attachedTo)
    }
    return readState
  }

  /**
   * Fetches read state document by its own ID.
   */
  public async getReadState (readStateId: Ref<ReadState>): Promise<ReadState | undefined> {
    const attachedTo = this.readStateToDocMap.get(readStateId)
    if (attachedTo !== undefined) {
      const cached = this.readStatesByDocCache.get(attachedTo)
      if (cached !== undefined) return cached
    }

    const readState = await this.client.findOne<ReadState>(notification.class.ReadState, { _id: readStateId })
    if (readState !== undefined) {
      this.readStatesByDocCache.set(readState.attachedTo, readState)
      this.readStateToDocMap.set(readState._id, readState.attachedTo)
    }
    return readState
  }

  /**
   * Searches for a PersonSpace document by its reference ID.
   */
  public async findPersonSpace (_id: Ref<PersonSpace>): Promise<PersonSpace | undefined> {
    const account = this.personSpaceToAccountMap.get(_id)
    if (account !== undefined) {
      const cached = this.personSpacesByAccountCache.get(account)
      if (cached !== undefined) return cached
    }

    const space = await this.client.findOne(contact.class.PersonSpace, { _id })
    if (space != null) {
      this.personSpacesByAccountCache.set(space.account, space)
      this.personSpaceToAccountMap.set(space._id, space.account)
    }
    return space
  }

  /**
   * Resolves PersonSpaces documents associated with user accounts.
   */
  public async getPersonSpaces (accounts: AccountUuid[]): Promise<PersonSpace[]> {
    const result: PersonSpace[] = []
    const toLoad: AccountUuid[] = []

    for (const account of accounts) {
      const space = this.personSpacesByAccountCache.get(account)
      if (space !== undefined) {
        result.push(space)
      } else {
        toLoad.push(account)
      }
    }
    if (toLoad.length === 0) return result

    const loaded = await this.client.findAll(contact.class.PersonSpace, {
      account: { $in: toLoad }
    })

    for (const space of loaded) {
      this.personSpacesByAccountCache.set(space.account, space)
      this.personSpaceToAccountMap.set(space._id, space.account)
      if (toLoad.includes(space.account)) {
        result.push(space)
      }
    }

    return result
  }

  /**
   * Fetches active push notifications subscriptions for a user.
   */
  public async getPushSubscriptions (user: AccountUuid): Promise<PushSubscription[]> {
    const cached = this.pushSubscriptionsByAccountCache.get(user)
    if (cached !== undefined) return cached

    const subscriptions = await this.client.findAll<PushSubscription>(notification.class.PushSubscription, { user })
    if (subscriptions.length === 0) {
      this.pushSubscriptionsByAccountCache.set(user, [])
      return []
    }

    const settings = await this.client.findAll<PushSubscriptionSetting>(notification.class.PushSubscriptionSetting, {
      attachedTo: { $in: subscriptions.map((it) => it._id) }
    })

    const filtered = subscriptions.filter((sub) => {
      const setting = settings.find((s) => s.attachedTo === sub._id)
      return setting?.enabled !== false
    })

    this.pushSubscriptionsByAccountCache.set(user, filtered)
    return filtered
  }

  /**
   * Assembles the receiver definitions list for active document collaborators.
   */
  public async getReceivers (collaborators: AccountUuid[]): Promise<Receiver[]> {
    if (collaborators.length === 0) return []

    const employees: EmployeeInfo[] = await this.getEmployeesInfo(collaborators)
    if (employees.length === 0) return []

    const personSpaces: PersonSpace[] = await this.getPersonSpaces(collaborators)
    if (personSpaces.length === 0) return []

    const socialIds: SocialIdentityInfo[] = await this.getSocialIds(employees.map((it) => it._id))

    const employeeByAccount = new Map(employees.map((it) => [it.personUuid, it]))
    const spaceByPerson = new Map(personSpaces.map((it) => [it.person, it]))
    const socialIdsByEmployee = groupByArray(socialIds, (it) => it.attachedTo)
    const statuses = await this.getUserStatuses()

    return collaborators
      .map((it) => {
        const employee = employeeByAccount.get(it)
        if (employee === undefined) return undefined
        const space = spaceByPerson.get(employee._id)
        if (space === undefined) return undefined

        const info: Receiver = {
          employeeRef: employee._id,
          role: employee.role,
          space: space._id,
          account: it,
          socialIds: socialIdsByEmployee.get(employee._id)?.map((it) => it._id) ?? [],
          online: statuses.find((s) => s.user === it)?.online ?? false,
          language: this.client.branding?.defaultLanguage ?? 'en'
        }
        return info
      })
      .filter(notEmpty)
  }

  /**
   * Resolves details of the message sender by their Social ID reference.
   */
  public async getSender (socialId: PersonId): Promise<Sender> {
    if (socialId === core.account.System) {
      return {
        socialId,
        account: systemAccountUuid
      }
    }

    const person = this.personsBySocialIdCache.get(socialId)
    if (person != null) {
      return { socialId, person, account: person.personUuid as AccountUuid }
    }

    const account = (await this.getAccountBySocialId(socialId)) ?? undefined

    if (account != null) {
      const pp = await this.client.findOne(contact.class.Person, { personUuid: account })

      if (pp != null) {
        this.personsBySocialIdCache.set(socialId, pp)
        const set = this.personToSocialIdsMap.get(pp._id) ?? new Set()
        set.add(socialId)
        this.personToSocialIdsMap.set(pp._id, set)
        return { socialId, person: pp, account }
      }

      return { socialId, account }
    }

    const socialIdentity = await this.client.findOne(contact.class.SocialIdentity, {
      _id: socialId as SocialIdentityRef
    })

    if (socialIdentity === undefined) {
      this.ctx.error('Cannot find SocialIdentity', { _id: socialId })
      return { socialId, account }
    }

    const pp = await this.client.findOne(contact.class.Person, { _id: socialIdentity.attachedTo })

    if (pp != null) {
      this.personsBySocialIdCache.set(socialId, pp)
      const set = this.personToSocialIdsMap.get(pp._id) ?? new Set()
      set.add(socialId)
      this.personToSocialIdsMap.set(pp._id, set)
    }

    return { socialId, person: pp, account }
  }

  /**
   * Maps a SocialIdentity ID back to the corresponding User Account UUID.
   */
  public async getAccountBySocialId (socialId: PersonId): Promise<AccountUuid | null> {
    const account = this.accountsBySocialIdCache.get(socialId)

    if (account != null) return account

    const socialIdentity = await this.client.findOne(contact.class.SocialIdentity, {
      _id: socialId as SocialIdentityRef
    })

    if (socialIdentity == null) return null

    const employee = await this.client.findOne(contact.mixin.Employee, {
      _id: socialIdentity.attachedTo as Ref<Employee>
    })

    const acc = employee?.personUuid ?? null

    if (acc != null) {
      this.accountsBySocialIdCache.set(socialId, acc)
    }

    return acc
  }

  /**
   * Returns list of user status records.
   */
  public async getUserStatuses (): Promise<UserStatus[]> {
    if (this.userStatusesMap.size > 0) {
      return Array.from(this.userStatusesMap.values())
    }

    const statuses = await this.client.findAll(core.class.UserStatus, {})

    for (const status of statuses) {
      this.userStatusesMap.set(status._id, status)
    }

    return statuses
  }

  // ==========================================
  // Private Dispatchers
  // ==========================================

  private txCreateDoc (tx: TxCreateDoc<Doc>): void {
    const doc = TxProcessor.createDoc2Doc(tx)
    const { hierarchy } = this.client

    if (hierarchy.isDerived(doc._class, core.class.Collaborator)) {
      this.createCollaborator(doc as Collaborator)
    }
    if (hierarchy.isDerived(doc._class, notification.class.ReadState)) {
      this.createReadState(doc as ReadState)
    }
    if (hierarchy.isDerived(doc._class, notification.class.DocNotifyContext)) {
      this.createNotifyContext(doc as DocNotifyContext)
    }
    if (hierarchy.isDerived(doc._class, notification.class.DocNotificationSetting)) {
      this.createNotificationSetting(doc as DocNotificationSetting)
    }
    if (this.isSettingsLoaded && hierarchy.isDerived(doc._class, notification.class.NotificationProviderSetting)) {
      const setting = doc as NotificationProviderSetting
      this.notificationProviderSettingsMap.set(setting._id, setting)
    }
    if (this.isSettingsLoaded && hierarchy.isDerived(doc._class, notification.class.NotificationTypeSetting)) {
      const setting = doc as NotificationTypeSetting
      this.notificationTypeSettingsMap.set(setting._id, setting)
    }
    if (hierarchy.isDerived(doc._class, contact.class.PersonSpace)) {
      this.createPersonSpace(doc as PersonSpace)
    }
    if (hierarchy.isDerived(doc._class, core.class.UserStatus)) {
      const status = doc as UserStatus
      this.userStatusesMap.set(status._id, status)
    }
  }

  private txUpdateDoc (tx: TxUpdateDoc<Doc> | TxMixin<Doc, Doc>): void {
    const doc = this.documentsCache.get(tx.objectId)
    const { hierarchy } = this.client

    if (doc != null) {
      const updated = this.updateOrMixin(tx, doc)
      this.documentsCache.set(updated._id, updated)
    }

    if (hierarchy.isDerived(tx.objectClass, core.class.Collaborator)) {
      this.updateCollaborator(tx)
    }
    if (hierarchy.isDerived(tx.objectClass, notification.class.ReadState)) {
      this.updateReadState(tx)
    }
    if (hierarchy.isDerived(tx.objectClass, notification.class.DocNotifyContext)) {
      this.updateNotifyContext(tx)
    }
    if (hierarchy.isDerived(tx.objectClass, notification.class.DocNotificationSetting)) {
      this.updateNotificationSetting(tx)
    }
    if (hierarchy.isDerived(tx.objectClass, notification.class.NotificationProviderSetting)) {
      const setting = this.notificationProviderSettingsMap.get(tx.objectId as Ref<NotificationProviderSetting>)
      if (setting !== undefined) {
        this.notificationProviderSettingsMap.set(setting._id, this.updateOrMixin(tx, setting))
      }
    }
    if (hierarchy.isDerived(tx.objectClass, notification.class.NotificationTypeSetting)) {
      const setting = this.notificationTypeSettingsMap.get(tx.objectId as Ref<NotificationTypeSetting>)
      if (setting !== undefined) {
        this.notificationTypeSettingsMap.set(setting._id, this.updateOrMixin(tx, setting))
      }
    }
    if (hierarchy.isDerived(tx.objectClass, contact.class.PersonSpace)) {
      this.updatePersonSpace(tx)
    }
    if (hierarchy.isDerived(tx.objectClass, core.class.UserStatus)) {
      const status = this.userStatusesMap.get(tx.objectId as Ref<UserStatus>)
      if (status !== undefined) {
        this.userStatusesMap.set(status._id, this.updateOrMixin(tx, status))
      }
    }
    if (hierarchy.isDerived(tx.objectClass, contact.class.Person)) {
      this.updatePerson(tx)
    }
  }

  private txRemoveDoc (tx: TxRemoveDoc<Doc>): void {
    this.documentsCache.delete(tx.objectId)
    const { hierarchy } = this.client

    if (hierarchy.isDerived(tx.objectClass, core.class.Collaborator)) {
      this.removeCollaborator(tx)
      return
    }
    if (hierarchy.isDerived(tx.objectClass, notification.class.ReadState)) {
      this.removeReadState(tx)
    }
    if (hierarchy.isDerived(tx.objectClass, notification.class.DocNotifyContext)) {
      this.removeNotifyContext(tx)
      return
    }
    if (hierarchy.isDerived(tx.objectClass, notification.class.DocNotificationSetting)) {
      this.removeNotificationSetting(tx)
      return
    }
    if (hierarchy.isDerived(tx.objectClass, notification.class.NotificationProviderSetting)) {
      this.notificationProviderSettingsMap.delete(tx.objectId as Ref<NotificationProviderSetting>)
      return
    }
    if (hierarchy.isDerived(tx.objectClass, notification.class.NotificationTypeSetting)) {
      this.notificationTypeSettingsMap.delete(tx.objectId as Ref<NotificationTypeSetting>)
      return
    }
    if (hierarchy.isDerived(tx.objectClass, contact.class.PersonSpace)) {
      this.removePersonSpace(tx)
      return
    }
    if (hierarchy.isDerived(tx.objectClass, core.class.UserStatus)) {
      this.userStatusesMap.delete(tx.objectId as Ref<UserStatus>)
      return
    }
    if (hierarchy.isDerived(tx.objectClass, contact.class.Person)) {
      this.removePerson(tx)
      return
    }
    if (hierarchy.isDerived(tx.objectClass, contact.class.SocialIdentity)) {
      this.removeSocialIdentity(tx)
    }
  }

  // ==========================================
  // Private Action Handlers
  // ==========================================

  private createCollaborator (collab: Collaborator): void {
    if (!this.collaboratorsByDocCache.has(collab.attachedTo)) return

    const current = this.collaboratorsByDocCache.get(collab.attachedTo) ?? []
    if (!current.some((it) => it._id === collab._id)) {
      this.collaboratorsByDocCache.set(collab.attachedTo, [...current, collab])
      this.collaboratorToDocMap.set(collab._id, collab.attachedTo)
    }
  }

  private createReadState (state: ReadState): void {
    if (this.readStatesByDocCache.has(state.attachedTo)) return
    this.readStatesByDocCache.set(state.attachedTo, state)
    this.readStateToDocMap.set(state._id, state.attachedTo)
  }

  private createNotifyContext (context: DocNotifyContext): void {
    if (!this.contextsByDocCache.has(context.objectId)) return
    const current = this.contextsByDocCache.get(context.objectId) ?? []
    if (!current.some((it) => it._id === context._id)) {
      this.contextsByDocCache.set(context.objectId, [...current, context])
      this.contextToDocMap.set(context._id, context.objectId)
    }
  }

  private createNotificationSetting (setting: DocNotificationSetting): void {
    if (!this.notificationSettingsByDocCache.has(setting.attachedTo)) return
    const current = this.notificationSettingsByDocCache.get(setting.attachedTo) ?? []
    if (!current.some((it) => it._id === setting._id)) {
      this.notificationSettingsByDocCache.set(setting.attachedTo, [...current, setting])
      this.settingToDocMap.set(setting._id, setting.attachedTo)
    }
  }

  private createPersonSpace (space: PersonSpace): void {
    this.personSpacesByAccountCache.set(space.account, space)
    this.personSpaceToAccountMap.set(space._id, space.account)
  }

  private updateCollaborator (tx: TxUpdateDoc<Doc> | TxMixin<Doc, Doc>): void {
    const docId = this.collaboratorToDocMap.get(tx.objectId as Ref<Collaborator>)
    if (docId !== undefined) {
      const current = this.collaboratorsByDocCache.get(docId) ?? []
      const updated = current.map((it) => (it._id === tx.objectId ? this.updateOrMixin(tx, it) : it))
      this.collaboratorsByDocCache.set(docId, updated)
    }
  }

  private updateReadState (tx: TxUpdateDoc<Doc> | TxMixin<Doc, Doc>): void {
    const docId = this.readStateToDocMap.get(tx.objectId as Ref<ReadState>)
    if (docId !== undefined) {
      const state = this.readStatesByDocCache.get(docId)
      if (state != null) {
        if (tx.modifiedOn < state.modifiedOn) {
          this.readStatesByDocCache.delete(docId)
          return
        }
        this.readStatesByDocCache.set(docId, this.updateOrMixin(tx, state))
      }
    }
  }

  private updateNotifyContext (tx: TxUpdateDoc<Doc> | TxMixin<Doc, Doc>): void {
    const docId = this.contextToDocMap.get(tx.objectId as Ref<DocNotifyContext>)
    if (docId !== undefined) {
      const current = this.contextsByDocCache.get(docId) ?? []
      const context = current.find((it) => it._id === tx.objectId)
      if (context !== undefined && tx.modifiedOn < context.modifiedOn) {
        this.invalidateContexts(docId)
        return
      }
      const updated = current.map((it) => (it._id === tx.objectId ? this.updateOrMixin(tx, it) : it))
      this.contextsByDocCache.set(docId, updated)
    }
  }

  private updateNotificationSetting (tx: TxUpdateDoc<Doc> | TxMixin<Doc, Doc>): void {
    const docId = this.settingToDocMap.get(tx.objectId as Ref<DocNotificationSetting>)
    if (docId !== undefined) {
      const current = this.notificationSettingsByDocCache.get(docId) ?? []
      const setting = current.find((it) => it._id === tx.objectId)
      if (setting !== undefined && tx.modifiedOn < setting.modifiedOn) {
        this.notificationSettingsByDocCache.delete(docId)
        return
      }
      const updated = current.map((it) => (it._id === tx.objectId ? this.updateOrMixin(tx, it) : it))
      this.notificationSettingsByDocCache.set(docId, updated)
    }
  }

  private updatePersonSpace (tx: TxUpdateDoc<Doc> | TxMixin<Doc, Doc>): void {
    const account = this.personSpaceToAccountMap.get(tx.objectId as Ref<PersonSpace>)
    if (account !== undefined) {
      const space = this.personSpacesByAccountCache.get(account)
      if (space !== undefined) {
        this.personSpacesByAccountCache.set(account, this.updateOrMixin(tx, space))
      }
    }
  }

  private updatePerson (tx: TxUpdateDoc<Doc> | TxMixin<Doc, Doc>): void {
    const socialIds = this.personToSocialIdsMap.get(tx.objectId as Ref<Person>)
    if (socialIds !== undefined) {
      for (const socialId of socialIds) {
        const person = this.personsBySocialIdCache.get(socialId)
        if (person != null) {
          this.personsBySocialIdCache.set(socialId, this.updateOrMixin(tx, person))
        }
      }
    }
  }

  private removeCollaborator (tx: TxRemoveDoc<Doc>): void {
    const docId = this.collaboratorToDocMap.get(tx.objectId as Ref<Collaborator>)
    if (docId !== undefined) {
      const current = this.collaboratorsByDocCache.get(docId) ?? []
      const removedCollab = current.find((it) => it._id === tx.objectId)
      this.collaboratorsByDocCache.set(
        docId,
        current.filter((it) => it._id !== tx.objectId)
      )
      this.collaboratorToDocMap.delete(tx.objectId as Ref<Collaborator>)
      if (removedCollab != null) {
        this.invalidateContexts(docId)
      }
    }
  }

  private removeReadState (tx: TxRemoveDoc<Doc>): void {
    const docId = this.readStateToDocMap.get(tx.objectId as Ref<ReadState>)
    if (docId !== undefined) {
      this.readStatesByDocCache.delete(docId)
      this.readStateToDocMap.delete(tx.objectId as Ref<ReadState>)
    }
  }

  private removeNotifyContext (tx: TxRemoveDoc<Doc>): void {
    const docId = this.contextToDocMap.get(tx.objectId as Ref<DocNotifyContext>)
    if (docId !== undefined) {
      const current = this.contextsByDocCache.get(docId) ?? []
      this.contextsByDocCache.set(
        docId,
        current.filter((it) => it._id !== tx.objectId)
      )
      this.contextToDocMap.delete(tx.objectId as Ref<DocNotifyContext>)
    }
  }

  private removeNotificationSetting (tx: TxRemoveDoc<Doc>): void {
    const docId = this.settingToDocMap.get(tx.objectId as Ref<DocNotificationSetting>)
    if (docId !== undefined) {
      const current = this.notificationSettingsByDocCache.get(docId) ?? []
      this.notificationSettingsByDocCache.set(
        docId,
        current.filter((it) => it._id !== tx.objectId)
      )
      this.settingToDocMap.delete(tx.objectId as Ref<DocNotificationSetting>)
    }
  }

  private removePersonSpace (tx: TxRemoveDoc<Doc>): void {
    const account = this.personSpaceToAccountMap.get(tx.objectId as Ref<PersonSpace>)
    if (account !== undefined) {
      this.personSpacesByAccountCache.delete(account)
      this.personSpaceToAccountMap.delete(tx.objectId as Ref<PersonSpace>)
    }
  }

  private removePerson (tx: TxRemoveDoc<Doc>): void {
    const accountUuid = this.employeeToAccountMap.get(tx.objectId as Ref<Employee>)
    if (accountUuid !== undefined) {
      this.employeesByAccountCache.delete(accountUuid)
      this.employeeToAccountMap.delete(tx.objectId as Ref<Employee>)
    }

    const socialIds = this.personToSocialIdsMap.get(tx.objectId as Ref<Person>)
    if (socialIds !== undefined) {
      for (const socialId of socialIds) {
        this.personsBySocialIdCache.delete(socialId)
        this.accountsBySocialIdCache.delete(socialId)
      }
      this.personToSocialIdsMap.delete(tx.objectId as Ref<Person>)
    }
  }

  private removeSocialIdentity (tx: TxRemoveDoc<Doc>): void {
    this.personsBySocialIdCache.delete(tx.objectId as any as PersonId)
    this.accountsBySocialIdCache.delete(tx.objectId as any as PersonId)

    const employeeRef = this.socialIdToEmployeeMap.get(tx.objectId as Ref<SocialIdentity>)
    if (employeeRef !== undefined) {
      const current = this.socialIdentitiesByEmployeeCache.get(employeeRef) ?? []
      this.socialIdentitiesByEmployeeCache.set(
        employeeRef,
        current.filter((it) => it._id !== tx.objectId)
      )
      this.socialIdToEmployeeMap.delete(tx.objectId as Ref<SocialIdentity>)
    }
  }

  // ==========================================
  // General Private Helpers
  // ==========================================

  private invalidateContexts (docId: Ref<Doc>): void {
    const contexts = this.contextsByDocCache.get(docId)
    if (contexts !== undefined) {
      for (const context of contexts) {
        this.contextToDocMap.delete(context._id)
      }
      this.contextsByDocCache.delete(docId)
    }
  }

  private updateOrMixin<T extends Doc>(tx: TxUpdateDoc<Doc> | TxMixin<Doc, Doc>, doc: T): T {
    if (tx._class === core.class.TxUpdateDoc) {
      return TxProcessor.updateDoc2Doc(doc, tx as TxUpdateDoc<Doc>) as T
    }

    return TxProcessor.updateMixin4Doc(doc, tx as TxMixin<Doc, Doc>) as T
  }

  private async getEmployeesInfo (collaborators: AccountUuid[]): Promise<EmployeeInfo[]> {
    const existing = collaborators.map((it) => this.employeesByAccountCache.get(it)).filter(notEmpty)

    const toLoad = collaborators.filter((it) => !this.employeesByAccountCache.has(it))
    if (toLoad.length === 0) return existing

    const employees: Pick<Employee, '_id' | 'personUuid' | 'role' | 'active'>[] = await this.client.findAll(
      contact.mixin.Employee,
      { personUuid: { $in: toLoad }, active: true },
      { projection: { _id: 1, personUuid: 1, role: 1, active: 1 } }
    )

    for (const employee of employees) {
      if (employee.personUuid == null) continue
      this.employeesByAccountCache.set(employee.personUuid, employee)
      this.employeeToAccountMap.set(employee._id, employee.personUuid)
    }

    return existing.concat(employees)
  }

  private async getSocialIds (persons: Ref<Employee>[]): Promise<SocialIdentityInfo[]> {
    const result: SocialIdentityInfo[] = []
    const toLoad: Ref<Employee>[] = []

    for (const person of persons) {
      const ids = this.socialIdentitiesByEmployeeCache.get(person)
      if (ids !== undefined) {
        result.push(...ids)
      } else {
        toLoad.push(person)
      }
    }
    if (toLoad.length === 0) return result

    const loaded: SocialIdentityInfo[] = await this.client.findAll(
      contact.class.SocialIdentity,
      { attachedTo: { $in: toLoad } },
      { projection: { _id: 1, attachedTo: 1 } }
    )

    for (const id of loaded) {
      const ref = id.attachedTo as Ref<Employee>
      const ids = this.socialIdentitiesByEmployeeCache.get(ref) ?? []
      this.socialIdentitiesByEmployeeCache.set(ref, [...ids, id])
      this.socialIdToEmployeeMap.set(id._id, ref)
      if (toLoad.includes(ref)) {
        result.push(id)
      }
    }

    return result
  }

  private isPushSubscriptionTx (tx: TxCUD<Doc>): boolean {
    return (
      this.client.hierarchy.isDerived(tx.objectClass, notification.class.PushSubscription) ||
      this.client.hierarchy.isDerived(tx.objectClass, notification.class.PushSubscriptionSetting)
    )
  }
}

export default WorkspaceCache
