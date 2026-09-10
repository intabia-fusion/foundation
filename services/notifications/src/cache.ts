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
  DocNotifyContext,
  type NotificationProviderSetting,
  type NotificationTypeSetting,
  ReadState
} from '@hcengineering/notification'
import contact, { Employee, Person, PersonSpace, SocialIdentityRef } from '@hcengineering/contact'
import { Receiver, Sender } from '@hcengineering/server-notification'

import { Client, EmployeeInfo, NotificationSettings, SocialIdentityInfo } from './types'

class WsCache {
  private readonly collaborators = new Map<Ref<Doc>, Collaborator[]>()

  private readonly contexts = new Map<Ref<Doc>, DocNotifyContext[]>()
  private readonly docs = new Map<Ref<Doc>, Doc>()

  private readonly readStateByDoc = new Map<Ref<Doc>, ReadState>()

  private isSettingsLoaded = false
  private readonly notificationProviderSettings = new Map<
    Ref<NotificationProviderSetting>,
    NotificationProviderSetting
  >()

  private readonly notificationTypeSettings = new Map<Ref<NotificationTypeSetting>, NotificationTypeSetting>()

  private readonly persons = new Map<PersonId, Person>()
  private readonly personSpaces = new Map<AccountUuid, PersonSpace>()
  private readonly userStatuses = new Map<Ref<UserStatus>, UserStatus>()

  private readonly accountBySocialId = new Map<PersonId, AccountUuid>()
  private readonly employees = new Map<AccountUuid, EmployeeInfo>()
  private readonly socialIds = new Map<Ref<Employee>, SocialIdentityInfo[]>()

  constructor (
    private readonly ctx: MeasureContext,
    private readonly client: Client
  ) {}

  public tx (tx: TxCUD<Doc>): void {
    this.clearLargeCaches()
    if (tx._class === core.class.TxCreateDoc) {
      this.txCreateDoc(tx as TxCreateDoc<Doc>)
    }

    if ([core.class.TxUpdateDoc, core.class.TxMixin].includes(tx._class)) {
      this.txUpdateDoc(tx as TxUpdateDoc<Doc> | TxMixin<Doc, Doc>)
    }

    if (tx._class === core.class.TxRemoveDoc) {
      this.txRemoveDoc(tx)
    }
  }

  private txCreateDoc (tx: TxCreateDoc<Doc>): void {
    const doc = TxProcessor.createDoc2Doc(tx)
    const { hierarchy } = this.client

    if (hierarchy.isDerived(doc._class, core.class.Collaborator)) {
      const collab = doc as Collaborator

      if (!this.collaborators.has(collab.attachedTo)) return

      const current = this.collaborators.get(collab.attachedTo) ?? []
      if (!current.some((it) => it._id === collab._id)) {
        this.collaborators.set(collab.attachedTo, [...current, collab])
      }
    }

    if (hierarchy.isDerived(doc._class, notification.class.ReadState)) {
      const state = doc as ReadState
      if (this.readStateByDoc.has(state.attachedTo)) return
      this.readStateByDoc.set(state.attachedTo, state)
    }

    if (hierarchy.isDerived(doc._class, notification.class.DocNotifyContext)) {
      const context = doc as DocNotifyContext
      if (!this.contexts.has(context.objectId)) return
      const current = this.contexts.get(context.objectId) ?? []
      if (!current.some((it) => it._id === context._id)) {
        this.contexts.set(context.objectId, [...current, context])
      }
    }

    if (this.isSettingsLoaded && hierarchy.isDerived(doc._class, notification.class.NotificationProviderSetting)) {
      const setting = doc as NotificationProviderSetting
      this.notificationProviderSettings.set(setting._id, setting)
    }

    if (this.isSettingsLoaded && hierarchy.isDerived(doc._class, notification.class.NotificationTypeSetting)) {
      const setting = doc as NotificationTypeSetting
      this.notificationTypeSettings.set(setting._id, setting)
    }

    if (hierarchy.isDerived(doc._class, contact.class.PersonSpace)) {
      const space = doc as PersonSpace
      this.personSpaces.set(space.account, space)
    }

    if (hierarchy.isDerived(doc._class, core.class.UserStatus)) {
      const status = doc as UserStatus
      this.userStatuses.set(status._id, status)
    }
  }

  private txUpdateDoc (tx: TxUpdateDoc<Doc> | TxMixin<Doc, Doc>): void {
    const doc = this.docs.get(tx.objectId)
    const { hierarchy } = this.client

    if (doc != null) {
      const updated = this.updateOrMixin(tx, doc)
      this.docs.set(updated._id, updated)
    }

    if (hierarchy.isDerived(tx.objectClass, core.class.Collaborator)) {
      const collabs = Array.from(this.collaborators.values()).flat()
      const collab = collabs.find((collab) => collab._id === tx.objectId)
      if (collab === undefined) return
      const updated = this.updateOrMixin(tx, collab)
      const current = this.collaborators.get(updated.attachedTo) ?? []
      this.collaborators.set(
        updated.attachedTo,
        current.map((it) => (it._id === updated._id ? updated : it))
      )
    }

    if (hierarchy.isDerived(tx.objectClass, notification.class.ReadState)) {
      const state = Array.from(this.readStateByDoc.values()).find((it) => it._id === tx.objectId)
      if (state == null) return
      const updated = this.updateOrMixin(tx, state)

      this.readStateByDoc.set(updated.attachedTo, updated)
    }

    if (hierarchy.isDerived(tx.objectClass, notification.class.DocNotifyContext)) {
      const contexts = Array.from(this.contexts.values()).flat()
      const context = contexts.find((context) => context._id === tx.objectId)
      if (context === undefined) return
      const updated = this.updateOrMixin(tx, context)
      const current = this.contexts.get(updated.objectId) ?? []
      this.contexts.set(
        updated.objectId,
        current.map((it) => (it._id === updated._id ? updated : it))
      )
    }

    if (hierarchy.isDerived(tx.objectClass, notification.class.NotificationProviderSetting)) {
      const setting = this.notificationProviderSettings.get(tx.objectId as Ref<NotificationProviderSetting>)
      if (setting === undefined) return
      const updated = this.updateOrMixin(tx, setting)
      this.notificationProviderSettings.set(updated._id, updated)
    }

    if (hierarchy.isDerived(tx.objectClass, notification.class.NotificationTypeSetting)) {
      const setting = this.notificationTypeSettings.get(tx.objectId as Ref<NotificationTypeSetting>)
      if (setting === undefined) return
      const updated = this.updateOrMixin(tx, setting)
      this.notificationTypeSettings.set(updated._id, updated)
    }

    if (hierarchy.isDerived(tx.objectClass, contact.class.PersonSpace)) {
      const spaces = Array.from(this.personSpaces.values())
      const space = spaces.find((space) => space._id === tx.objectId)
      if (space === undefined) return
      const updated = this.updateOrMixin(tx, space)
      this.personSpaces.set(updated.account, updated)
    }

    if (hierarchy.isDerived(tx.objectClass, core.class.UserStatus)) {
      const status = this.userStatuses.get(tx.objectId as Ref<UserStatus>)
      if (status === undefined) return
      const updated = this.updateOrMixin(tx, status)
      this.userStatuses.set(updated._id, updated)
    }

    if (
      hierarchy.isDerived(tx.objectClass, contact.mixin.Employee) ||
      hierarchy.isDerived(tx.objectClass, contact.class.Person)
    ) {
      const employees = Array.from(this.employees.values())
      const employee = employees.find((emp) => emp._id === tx.objectId)
      if (employee != null) {
        const updated = this.updateOrMixin(tx, employee as Employee) as EmployeeInfo
        if (updated.personUuid != null) {
          this.employees.set(updated.personUuid, updated)
        }
      }

      const persons: Array<[PersonId, Person]> = Array.from(this.persons.entries())
      const matched = persons.filter(([_, person]) => person._id === tx.objectId)
      if (matched.length > 0) {
        const updated = matched.map(([personId, person]): [PersonId, Person] => [
          personId,
          this.updateOrMixin(tx, person)
        ])
        for (const [personId, person] of updated) {
          this.persons.set(personId, person)
        }
      }
    }
  }

  private txRemoveDoc (tx: TxRemoveDoc<Doc>): void {
    this.docs.delete(tx.objectId)
    const { hierarchy } = this.client

    if (hierarchy.isDerived(tx.objectClass, core.class.Collaborator)) {
      const collabs = Array.from(this.collaborators.values()).flat()
      const collab = collabs.find((collab) => collab._id === tx.objectId)
      if (collab === undefined) return
      const current = this.collaborators.get(collab.attachedTo) ?? []
      this.collaborators.set(
        collab.attachedTo,
        current.filter((it) => it._id !== collab._id)
      )
      return
    }

    if (hierarchy.isDerived(tx.objectClass, notification.class.ReadState)) {
      const state = Array.from(this.readStateByDoc.values()).find((it) => it._id === tx.objectId)
      if (state == null) return
      this.readStateByDoc.delete(state.attachedTo)
    }

    if (hierarchy.isDerived(tx.objectClass, notification.class.DocNotifyContext)) {
      this.contexts.delete(tx.objectId)
      const contexts = Array.from(this.contexts.values()).flat()
      const context = contexts.find((context) => context._id === tx.objectId)
      if (context === undefined) return
      const current = this.contexts.get(context.objectId) ?? []
      this.contexts.set(
        context.objectId,
        current.filter((it) => it._id !== context._id)
      )
      return
    }

    if (hierarchy.isDerived(tx.objectClass, notification.class.NotificationProviderSetting)) {
      this.notificationProviderSettings.delete(tx.objectId as Ref<NotificationProviderSetting>)
      return
    }

    if (hierarchy.isDerived(tx.objectClass, notification.class.NotificationTypeSetting)) {
      this.notificationTypeSettings.delete(tx.objectId as Ref<NotificationTypeSetting>)
      return
    }

    if (hierarchy.isDerived(tx.objectClass, contact.class.PersonSpace)) {
      const spaces = Array.from(this.personSpaces.values())
      const space = spaces.find((space) => space._id === tx.objectId)
      if (space === undefined) return
      this.personSpaces.delete(space.account)
      return
    }

    if (hierarchy.isDerived(tx.objectClass, core.class.UserStatus)) {
      this.userStatuses.delete(tx.objectId as Ref<UserStatus>)
      return
    }

    if (
      hierarchy.isDerived(tx.objectClass, contact.mixin.Employee) ||
      hierarchy.isDerived(tx.objectClass, contact.class.Person)
    ) {
      const employees = Array.from(this.employees.values())
      const employee = employees.find((employee) => employee._id === tx.objectId)
      if (employee?.personUuid != null) {
        this.employees.delete(employee.personUuid)
      }

      const persons: Array<[PersonId, Person]> = Array.from(this.persons.entries())
      for (const [personId, person] of persons) {
        if (person._id === tx.objectId) {
          this.persons.delete(personId)
        }
      }

      return
    }

    if (hierarchy.isDerived(tx.objectClass, contact.class.SocialIdentity)) {
      this.persons.delete(tx.objectId as any as PersonId)
      const socialIds = Array.from(this.socialIds.values()).flat()
      const socialId = socialIds.find((socialId) => socialId._id === tx.objectId)
      if (socialId === undefined) return
      const ref = socialId.attachedTo as Ref<Employee>
      const ids = this.socialIds.get(ref) ?? []
      this.socialIds.set(
        ref,
        ids.filter((it) => it._id !== socialId._id)
      )
    }
  }

  private updateOrMixin<T extends Doc>(tx: TxUpdateDoc<Doc> | TxMixin<Doc, Doc>, doc: T): T {
    if (tx._class === core.class.TxUpdateDoc) {
      return TxProcessor.updateDoc2Doc(doc, tx as TxUpdateDoc<Doc>) as T
    }

    return TxProcessor.updateMixin4Doc(doc, tx as TxMixin<Doc, Doc>) as T
  }

  public async getSettings (): Promise<NotificationSettings> {
    const providersSettings: NotificationProviderSetting[] = this.isSettingsLoaded
      ? Array.from(this.notificationProviderSettings.values())
      : await this.client.findAll<NotificationProviderSetting>(notification.class.NotificationProviderSetting, {})

    if (!this.isSettingsLoaded) {
      for (const setting of providersSettings) {
        this.notificationProviderSettings.set(setting._id, setting)
      }
    }

    const typesSettings: NotificationTypeSetting[] = this.isSettingsLoaded
      ? Array.from(this.notificationTypeSettings.values())
      : await this.client.findAll(notification.class.NotificationTypeSetting, {})

    if (!this.isSettingsLoaded) {
      for (const setting of typesSettings) {
        this.notificationTypeSettings.set(setting._id, setting)
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

  public async getCollaborators (_id: Ref<Doc>, _class: Ref<Class<Doc>>): Promise<Collaborator[]> {
    if (this.collaborators.has(_id)) {
      return this.collaborators.get(_id) ?? []
    }

    const mixin = getClassCollaborators(this.client.model, this.client.hierarchy, _class)
    if (mixin === undefined) {
      return []
    }

    const collaborators = await this.client.findAll(core.class.Collaborator, { attachedTo: _id })

    this.collaborators.set(_id, collaborators)

    return collaborators
  }

  public async getDoc<T extends Doc = Doc>(_id: Ref<T>, _class: Ref<Class<T>>): Promise<T | undefined> {
    if (this.docs.has(_id)) return this.docs.get(_id) as T
    // A tx can name a task type's target mixin that the workspace model no longer has; findOne then
    // throws "domain not found" and the tx consumer retries that one message forever.
    if (!this.client.hierarchy.hasClass(_class)) return undefined
    const query = { _id } as unknown as DocumentQuery<T>

    const doc = await this.client.findOne(_class, query)
    if (doc !== undefined) {
      this.docs.set(_id, doc)
    } else {
      this.docs.delete(_id)
    }
    return doc
  }

  public async getContexts (_id: Ref<Doc>): Promise<DocNotifyContext[]> {
    if (this.contexts.has(_id)) return this.contexts.get(_id) ?? []

    const contexts = await this.client.findAll(notification.class.DocNotifyContext, { objectId: _id })
    this.contexts.set(_id, contexts)

    return contexts
  }

  public storeContext (context: DocNotifyContext): void {
    const current = this.contexts.get(context.objectId) ?? []
    this.contexts.set(context.objectId, [...current, context])
  }

  public async getDocSpace (doc: Doc): Promise<Space | undefined> {
    if (this.client.hierarchy.isDerived(doc._class, core.class.Space)) return doc as Space
    const curent = this.docs.get(doc.space)
    if (curent !== undefined) return curent as Space

    const space = await this.client.findOne<Space>(core.class.Space, { _id: doc.space }, { limit: 1 })

    if (space !== undefined) {
      this.docs.set(doc.space, space)
    }

    return space
  }

  public async getDocReadState (attachedTo: Ref<Doc>): Promise<ReadState | undefined> {
    const current = this.readStateByDoc.get(attachedTo)
    if (current !== undefined) return current
    const readState = await this.client.findOne<ReadState>(notification.class.ReadState, { attachedTo })
    if (readState !== undefined) {
      this.readStateByDoc.set(attachedTo, readState)
    }
    return readState
  }

  private async getEmployeesInfo (collaborators: AccountUuid[]): Promise<EmployeeInfo[]> {
    const existing = collaborators.map((it) => this.employees.get(it)).filter(notEmpty)
    const toLoad = collaborators.filter((it) => !this.employees.has(it))
    if (toLoad.length === 0) {
      return existing.filter((it) => it.active)
    }

    const loaded = await this.client.findAll(
      contact.mixin.Employee,
      { personUuid: { $in: toLoad }, active: true },
      { projection: { _id: 1, personUuid: 1, role: 1, active: 1 } }
    )

    const employees: EmployeeInfo[] = loaded.map((doc) => {
      const emp = this.client.hierarchy.as(doc, contact.mixin.Employee)
      return {
        _id: emp._id,
        personUuid: emp.personUuid,
        role: emp.role,
        active: emp.active ?? true
      }
    })

    for (const employee of employees) {
      if (employee.personUuid == null) continue
      this.employees.set(employee.personUuid, employee)
    }

    return existing.concat(employees).filter((it) => it.active)
  }

  public async findPersonSpace (_id: Ref<PersonSpace>): Promise<PersonSpace | undefined> {
    const spaces = Array.from(this.personSpaces.values())
    const cached = spaces.find((it) => it._id === _id)
    if (cached != null) return cached

    const space = await this.client.findOne(contact.class.PersonSpace, { _id })
    if (space != null) this.personSpaces.set(space.account, space)
    return space
  }

  public async getPersonSpaces (accounts: AccountUuid[]): Promise<PersonSpace[]> {
    const result: PersonSpace[] = []
    const toLoad: AccountUuid[] = []

    for (const account of accounts) {
      const space = this.personSpaces.get(account)
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
      this.personSpaces.set(space.account, space)
      if (toLoad.includes(space.account)) {
        result.push(space)
      }
    }

    return result
  }

  private async getSocialIds (persons: Ref<Employee>[]): Promise<SocialIdentityInfo[]> {
    const result: SocialIdentityInfo[] = []

    const toLoad: Ref<Employee>[] = []

    for (const person of persons) {
      const ids = this.socialIds.get(person)
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
      const ids = this.socialIds.get(ref) ?? []
      this.socialIds.set(ref, [...ids, id])
      if (toLoad.includes(ref)) {
        result.push(id)
      }
    }

    return result
  }

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
          online: statuses.find((s) => s.user === it)?.online ?? false
        }
        return info
      })
      .filter(notEmpty)
  }

  public async getSender (socialId: PersonId): Promise<Sender> {
    if (socialId === core.account.System) {
      return {
        socialId,
        account: systemAccountUuid
      }
    }

    const person = this.persons.get(socialId)
    if (person != null) {
      return { socialId, person, account: person.personUuid as AccountUuid }
    }

    const account = (await this.getAccountBySocialId(socialId)) ?? undefined

    if (account != null) {
      const pp = await this.client.findOne(contact.class.Person, { personUuid: account })

      if (pp != null) {
        this.persons.set(socialId, pp)
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
      this.persons.set(socialId, pp)
    }

    return { socialId, person: pp, account }
  }

  public async getAccountBySocialId (socialId: PersonId): Promise<AccountUuid | null> {
    const account = this.accountBySocialId.get(socialId)

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
      this.accountBySocialId.set(socialId, acc)
    }

    return acc
  }

  public async getUserStatuses (): Promise<UserStatus[]> {
    if (this.userStatuses.size > 0) {
      return Array.from(this.userStatuses.values())
    }

    const statuses = await this.client.findAll(core.class.UserStatus, {})

    for (const status of statuses) {
      this.userStatuses.set(status._id, status)
    }

    return statuses
  }

  private clearLargeCaches (): void {
    const maxSize = 1000
    if (this.collaborators.size > maxSize) {
      this.collaborators.clear()
    }
    if (this.docs.size > maxSize) {
      this.docs.clear()
    }
    if (this.contexts.size > maxSize) {
      this.contexts.clear()
    }
    if (this.readStateByDoc.size > maxSize) {
      this.readStateByDoc.clear()
    }
    if (this.persons.size > maxSize) {
      this.persons.clear()
    }
    if (this.employees.size > maxSize) {
      this.employees.clear()
    }
    if (this.socialIds.size > maxSize) {
      this.socialIds.clear()
    }
  }
}

export default WsCache
