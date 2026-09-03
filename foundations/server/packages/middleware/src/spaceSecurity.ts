//
// Copyright © 2023 Hardcore Engineering Inc.
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
import core, {
  type Account,
  AccountRole,
  type AccountUuid,
  type AttachedDoc,
  type Class,
  type Collaborator,
  type Doc,
  type DocumentQuery,
  type FindResult,
  generateId,
  getClassCollaborators,
  type LookupData,
  type MeasureContext,
  type Position,
  type PullArray,
  type Ref,
  type SearchOptions,
  type SearchQuery,
  type SearchResult,
  type SessionData,
  shouldShowArchived,
  type Space,
  systemAccountUuid,
  type Tx,
  type TxApplyIf,
  type TxCreateDoc,
  type TxCUD,
  TxProcessor,
  type TxRemoveDoc,
  type TxUpdateDoc,
  type TxWorkspaceEvent,
  WorkspaceEvent
} from '@hcengineering/core'
import {
  BaseMiddleware,
  type Middleware,
  type PipelineContext,
  type ServerFindOptions,
  type TxMiddlewareResult
} from '@hcengineering/server-core'
import platform, { PlatformError, Severity, Status } from '@hcengineering/platform'
import contact from '@hcengineering/contact'
import { isOwner, isSystem } from './utils'

interface SpaceInfo {
  _id: Ref<Space>
  _class: Ref<Class<Space>>
  members: Set<AccountUuid>
  owners: Set<AccountUuid>
  private: boolean
  archived: boolean
  autoJoin: boolean
  systemCreated: boolean
}

/**
 * @public
 */

const guestRoles = new Set<AccountRole>([AccountRole.Guest, AccountRole.DocGuest, AccountRole.ReadOnlyGuest])

export class SpaceSecurityMiddleware extends BaseMiddleware implements Middleware {
  private readonly spacesMap = new Map<Ref<Space>, SpaceInfo>()
  private readonly systemSpaces = new Set<Ref<Space>>()

  wasInit: Promise<void> | boolean = false

  private readonly mainSpaces = new Set([
    core.space.Configuration,
    core.space.DerivedTx,
    core.space.Model,
    core.space.Space,
    core.space.Workspace,
    core.space.Tx
  ])

  private constructor (context: PipelineContext, next?: Middleware) {
    super(context, next)
  }

  static async create (
    ctx: MeasureContext,
    context: PipelineContext,
    next: Middleware | undefined
  ): Promise<SpaceSecurityMiddleware> {
    return new SpaceSecurityMiddleware(context, next)
  }

  /**
   * Write-side counterpart of addSecurity's read predicate (postgres/storage.ts addSecurity):
   * member of the space, or the space is public/system.
   */
  canWriteSpace (space: Ref<Space>, account: AccountUuid): boolean {
    if (space === core.space.Space || this.systemSpaces.has(space)) return true
    const info = this.spacesMap.get(space)
    if (info === undefined) return false
    return !info.private || info.members.has(account)
  }

  private addSpace (
    space: Pick<Space, '_id' | 'members' | 'owners' | 'private' | '_class' | 'archived' | 'autoJoin' | 'createdBy'>
  ): void {
    this.spacesMap.set(space._id, {
      _id: space._id,
      _class: space._class,
      members: new Set(space.members),
      owners: new Set(space.owners ?? []),
      private: space.private,
      archived: space.archived ?? false,
      autoJoin: space.autoJoin === true,
      systemCreated: space.createdBy === core.account.System
    })
  }

  async init (ctx: MeasureContext): Promise<void> {
    if (this.wasInit === true) {
      return
    }
    if (this.wasInit === false) {
      this.wasInit = (async () => {
        await ctx.with('init-space-security', {}, async (ctx) => {
          ctx.contextData = undefined
          const spaces =
            (await this.next?.findAll(
              ctx,
              core.class.Space,
              {},
              {
                projection: {
                  archived: 1,
                  private: 1,
                  _class: 1,
                  _id: 1,
                  members: 1,
                  owners: 1,
                  autoJoin: 1,
                  createdBy: 1
                }
              }
            )) ?? []
          this.spacesMap.clear()
          this.systemSpaces.clear()
          for (const space of spaces) {
            if (space._class === core.class.SystemSpace) {
              this.systemSpaces.add(space._id)
            } else {
              this.addSpace(space)
            }
          }
        })
      })()
    }
    if (this.wasInit instanceof Promise) {
      await this.wasInit
      this.wasInit = true
    }
  }

  private removeSpace (_id: Ref<Space>): void {
    this.spacesMap.delete(_id)
  }

  private async handeCollaborator (ctx: MeasureContext<SessionData>, tx: TxCUD<Collaborator>): Promise<void> {
    if (!this.context.hierarchy.isDerived(tx.objectClass, core.class.Collaborator)) return
    if (tx._class === core.class.TxCreateDoc) {
      const collab = TxProcessor.createDoc2Doc<Collaborator>(tx as TxCreateDoc<Collaborator>)
      this.handleChangeCollaborator(ctx, collab)
    } else if (tx._class === core.class.TxRemoveDoc) {
      const collab = (await this.next?.findAll(ctx, core.class.Collaborator, {
        _id: tx.objectId
      })) as Collaborator[]
      if (collab.length === 0) return
      this.handleChangeCollaborator(ctx, collab[0])
    }
  }

  private handleChangeCollaborator (ctx: MeasureContext<SessionData>, collab: Collaborator): void {
    const collabSec = this.context.modelDb.findAllSync(core.class.ClassCollaborators, {
      attachedTo: collab.attachedToClass
    })[0]
    if (collabSec?.provideSecurity === true) {
      for (const val of ctx.contextData.socialStringsToUsers.values()) {
        if (
          val.accountUuid === collab.collaborator &&
          [AccountRole.Guest, AccountRole.ReadOnlyGuest].includes(val.role)
        ) {
          this.brodcastEvent(ctx, [val.accountUuid])
        }
      }
    }
  }

  private handleCreate (tx: TxCUD<Space>): void {
    const createTx = tx as TxCreateDoc<Space>
    if (!this.context.hierarchy.isDerived(createTx.objectClass, core.class.Space)) return
    if (createTx.objectClass === core.class.SystemSpace) {
      this.systemSpaces.add(createTx.objectId)
    } else {
      const res = TxProcessor.createDoc2Doc<Space>(createTx)
      this.addSpace(res)
    }
  }

  private pushMembersHandle (
    ctx: MeasureContext,
    addedMembers: AccountUuid | Position<AccountUuid>,
    space: SpaceInfo
  ): void {
    if (typeof addedMembers === 'object') {
      for (const member of addedMembers.$each) {
        space.members.add(member)
      }
      this.brodcastEvent(ctx, addedMembers.$each, space._id)
    } else {
      space.members.add(addedMembers)
      this.brodcastEvent(ctx, [addedMembers], space._id)
    }
  }

  private pullMembersHandle (
    ctx: MeasureContext,
    removedMembers: Partial<AccountUuid> | PullArray<AccountUuid>,
    space: SpaceInfo
  ): void {
    if (typeof removedMembers === 'object') {
      const { $in } = removedMembers as PullArray<AccountUuid>
      if ($in !== undefined) {
        for (const member of $in) {
          space.members.delete(member)
        }
        this.brodcastEvent(ctx, $in, space._id)
      }
    } else {
      space.members.delete(removedMembers)
      this.brodcastEvent(ctx, [removedMembers], space._id)
    }
  }

  private syncMembers (ctx: MeasureContext, members: AccountUuid[], space: SpaceInfo): void {
    const newMembers = new Set(members)
    const changed: AccountUuid[] = []
    for (const old of space.members) {
      if (!newMembers.has(old)) {
        changed.push(old)
      }
    }
    for (const newMem of newMembers) {
      if (!space.members.has(newMem)) {
        changed.push(newMem)
      }
    }
    space.members = newMembers
    if (changed.length > 0) {
      this.brodcastEvent(ctx, changed, space._id)
    }
  }

  private brodcastEvent (ctx: MeasureContext<SessionData>, users: AccountUuid[], space?: Ref<Space>): void {
    const targets = this.getTargets(users)
    const tx: TxWorkspaceEvent = {
      _class: core.class.TxWorkspaceEvent,
      _id: generateId(),
      event: WorkspaceEvent.SecurityChange,
      modifiedBy: core.account.System,
      modifiedOn: Date.now(),
      objectSpace: space ?? core.space.DerivedTx,
      space: core.space.DerivedTx,
      params: null
    }
    ctx.contextData.broadcast.txes.push(tx)
    ctx.contextData.broadcast.targets['security' + tx._id] = async (it) => {
      if (it._id === tx._id) {
        return {
          target: targets
        }
      }
    }
  }

  private broadcastNonMembers (ctx: MeasureContext<SessionData>, space: SpaceInfo): void {
    this.brodcastEvent(ctx, Array.from(space.members), space._id)
  }

  private broadcastAll (ctx: MeasureContext<SessionData>, space: SpaceInfo): void {
    const { socialStringsToUsers } = ctx.contextData
    const accounts = Array.from(new Set(Array.from(socialStringsToUsers.values()).map((v) => v.accountUuid)))

    this.brodcastEvent(ctx, accounts, space._id)
  }

  /**
   * Broadcast a SecurityChange event for `space` to every active session.
   * Use this for transitions that change visibility for arbitrary
   * non-members (private<->public, archived<->unarchived) — those receivers
   * are not in `socialStringsToUsers` of the current request, so the
   * targeted broadcastAll cannot reach them.
   */
  private broadcastSecurityToAll (ctx: MeasureContext<SessionData>, space: SpaceInfo): void {
    const tx: TxWorkspaceEvent = {
      _class: core.class.TxWorkspaceEvent,
      _id: generateId(),
      event: WorkspaceEvent.SecurityChange,
      modifiedBy: core.account.System,
      modifiedOn: Date.now(),
      objectSpace: space._id,
      space: core.space.DerivedTx,
      params: null
    }
    ctx.contextData.broadcast.txes.push(tx)
  }

  private pushOwnersHandle (
    ctx: MeasureContext,
    addedOwners: AccountUuid | Position<AccountUuid>,
    space: SpaceInfo
  ): void {
    if (typeof addedOwners === 'object') {
      for (const owner of addedOwners.$each) {
        space.owners.add(owner)
      }
    } else {
      space.owners.add(addedOwners)
    }
  }

  private pullOwnersHandle (
    ctx: MeasureContext,
    removedOwners: Partial<AccountUuid> | PullArray<AccountUuid>,
    space: SpaceInfo
  ): void {
    if (typeof removedOwners === 'object') {
      const { $in } = removedOwners as PullArray<AccountUuid>
      if ($in !== undefined) {
        for (const owner of $in) {
          space.owners.delete(owner)
        }
      }
    } else {
      space.owners.delete(removedOwners)
    }
  }

  private syncOwners (ctx: MeasureContext, owners: AccountUuid[], space: SpaceInfo): void {
    space.owners = new Set(owners)
  }

  private async handleUpdate (ctx: MeasureContext, tx: TxCUD<Space>): Promise<void> {
    await this.init(ctx)

    const updateDoc = tx as TxUpdateDoc<Space>
    if (!this.context.hierarchy.isDerived(updateDoc.objectClass, core.class.Space)) return

    const space = this.spacesMap.get(updateDoc.objectId)
    if (space !== undefined) {
      if (updateDoc.operations.private !== undefined) {
        space.private = updateDoc.operations.private
        // Visibility flip affects users that may not be in this request's
        // session. Use the global broadcast so their clients refresh.
        this.broadcastSecurityToAll(ctx, space)
      }

      if (updateDoc.operations.members !== undefined) {
        this.syncMembers(ctx, updateDoc.operations.members, space)
      }
      if (updateDoc.operations.$push?.members !== undefined) {
        this.pushMembersHandle(ctx, updateDoc.operations.$push.members, space)
      }

      if (updateDoc.operations.$pull?.members !== undefined) {
        this.pullMembersHandle(ctx, updateDoc.operations.$pull.members, space)
      }
      if (updateDoc.operations.archived !== undefined) {
        space.archived = updateDoc.operations.archived
        this.broadcastSecurityToAll(ctx, space)
      }
      // Handle owners updates
      if (updateDoc.operations.owners !== undefined) {
        this.syncOwners(ctx, updateDoc.operations.owners, space)
      }
      if (updateDoc.operations.$push?.owners !== undefined) {
        this.pushOwnersHandle(ctx, updateDoc.operations.$push.owners, space)
      }
      if (updateDoc.operations.$pull?.owners !== undefined) {
        this.pullOwnersHandle(ctx, updateDoc.operations.$pull.owners, space)
      }
    }
  }

  private handleRemove (tx: TxCUD<Space>): void {
    const removeTx = tx as TxRemoveDoc<Space>
    if (!this.context.hierarchy.isDerived(removeTx.objectClass, core.class.Space)) return
    if (removeTx._class !== core.class.TxRemoveDoc) return
    this.removeSpace(tx.objectId)
  }

  private async handleTx (ctx: MeasureContext<SessionData>, tx: TxCUD<Space>): Promise<void> {
    await this.init(ctx)
    if (tx._class === core.class.TxCreateDoc) {
      this.handleCreate(tx)
    } else if (tx._class === core.class.TxUpdateDoc) {
      await this.handleUpdate(ctx, tx)
    } else if (tx._class === core.class.TxRemoveDoc) {
      this.handleRemove(tx)
    }
  }

  getTargets (accounts: AccountUuid[]): AccountUuid[] {
    const res = Array.from(new Set(accounts))
    // We need to add system account for targets for integrations to work properly
    res.push(systemAccountUuid)

    return res
  }

  private async checkSpacePermissions (ctx: MeasureContext<SessionData>, tx: TxCUD<Space>): Promise<void> {
    // Skip permission checks for system account and owner role
    const account = ctx.contextData.account
    if (account.uuid === systemAccountUuid || account.role === AccountRole.Owner) {
      return
    }

    await this.init(ctx)

    // Handle create - check if private is set to true without being owner
    if (tx._class === core.class.TxCreateDoc) {
      const createTx = tx as TxCreateDoc<Space>
      const attrs = createTx.attributes

      // Check if creating private space without being owner
      if (attrs.private) {
        const owners = attrs.owners ?? []
        const members = attrs.members ?? []
        // Allow if creator is in owners list, or if no owners and creator is a member (e.g. DM)
        if (owners.length > 0 && !owners.includes(account.uuid)) {
          throw new Error('Only owners can create private spaces')
        }
        if (owners.length === 0 && !members.includes(account.uuid)) {
          throw new Error('Cannot create private space without being a member or owner')
        }
      }
      return
    }

    const space = this.spacesMap.get(tx.objectId)
    if (space === undefined) return

    // For public spaces without owners, skip permission checks (no privacy to protect)
    // For private spaces without owners (e.g. Direct Messages), allow members to perform
    // regular operations (including $push/$pull members) but restrict sensitive changes
    // (private/owners/delete) to admins only
    if (space.owners.size === 0) {
      if (!space.private) return

      if (tx._class === core.class.TxUpdateDoc) {
        const updateTx = tx as TxUpdateDoc<Space>
        const ops = updateTx.operations
        const hasSensitiveUpdate =
          ops.private !== undefined ||
          ops.owners !== undefined ||
          ops.$push?.owners !== undefined ||
          ops.$pull?.owners !== undefined
        if (hasSensitiveUpdate && account.role !== AccountRole.Admin) {
          throw new Error('Only admins can change private/owners on spaces without owners')
        }
        // Allow regular updates (e.g. $push/$pull members, name, description, etc.) for space members
        return
      }

      if (tx._class === core.class.TxRemoveDoc && account.role !== AccountRole.Admin) {
        throw new Error('Only admins can delete private spaces without owners')
      }
      return
    }

    const isOwner = space.owners.has(account.uuid)

    // Only owners can change private status
    if (tx._class === core.class.TxUpdateDoc) {
      const updateTx = tx as TxUpdateDoc<Space>
      const ops = updateTx.operations

      if (ops.private !== undefined && !isOwner) {
        throw new Error('Only owners can change space privacy')
      }

      // Only owners can change owners
      const hasOwnersUpdate =
        ops.owners !== undefined || ops.$push?.owners !== undefined || ops.$pull?.owners !== undefined

      if (hasOwnersUpdate && !isOwner) {
        throw new Error('Only owners can change space owners')
      }

      // Prevent leaving a space without any owner: an empty owners list makes the space
      // unmanaged and would later let any member modify privacy/members.
      if (hasOwnersUpdate) {
        let nextOwners = new Set(space.owners)
        if (Array.isArray(ops.owners)) {
          nextOwners = new Set(ops.owners)
        }
        const pushOwners = ops.$push?.owners
        if (pushOwners !== undefined) {
          if (typeof pushOwners === 'object' && Array.isArray((pushOwners as any).$each)) {
            for (const o of (pushOwners as any).$each as AccountUuid[]) nextOwners.add(o)
          } else {
            nextOwners.add(pushOwners as AccountUuid)
          }
        }
        const pullOwners = ops.$pull?.owners
        if (pullOwners !== undefined) {
          if (typeof pullOwners === 'object' && Array.isArray((pullOwners as any).$in)) {
            for (const o of (pullOwners as any).$in as AccountUuid[]) nextOwners.delete(o)
          } else {
            nextOwners.delete(pullOwners as AccountUuid)
          }
        }
        if (nextOwners.size === 0) {
          throw new Error('Space must keep at least one owner')
        }
      }

      // In private spaces with owners, only owners can change members.
      // Two exceptions:
      // 1. self-push into autoJoin spaces — workspace join, chat unhide, etc.
      // 2. self-leave — a member may remove only themselves from members.
      if (space.private && !isOwner) {
        const hasMembersUpdate =
          ops.members !== undefined || ops.$push?.members !== undefined || ops.$pull?.members !== undefined
        if (hasMembersUpdate) {
          const pushVal = ops.$push?.members
          const pushedSelfOnly =
            pushVal !== undefined &&
            (pushVal === account.uuid ||
              (typeof pushVal === 'object' &&
                (pushVal as any).$each?.length === 1 &&
                (pushVal as any).$each[0] === account.uuid))
          const onlyPushSelfToAutoJoin =
            space.autoJoin && pushedSelfOnly && ops.members === undefined && ops.$pull?.members === undefined

          const pullVal = ops.$pull?.members
          const pulledSelfOnly =
            pullVal !== undefined &&
            (pullVal === account.uuid ||
              (typeof pullVal === 'object' &&
                (pullVal as any).$in?.length === 1 &&
                (pullVal as any).$in[0] === account.uuid))
          const onlyPullSelf = pulledSelfOnly && ops.members === undefined && ops.$push?.members === undefined

          if (!onlyPushSelfToAutoJoin && !onlyPullSelf) {
            throw new Error('Only owners can change members of private spaces')
          }
        }
      }
    }

    // Only owners can delete private spaces
    if (tx._class === core.class.TxRemoveDoc) {
      if (space.private && !isOwner) {
        throw new Error('Only owners can delete private spaces')
      }
    }
  }

  /** Same bypasses addSecurity uses for reads. Owner is not one of them: it only skips the filter for the Space domain. */
  // Callers must have awaited init(): both tx() and handleBroadcast() do.
  private checkWriteAccess (ctx: MeasureContext<SessionData>, cudTx: TxCUD<Doc>): void {
    if (cudTx.space === core.space.DerivedTx) return
    const account = ctx.contextData.account
    if (account.uuid === systemAccountUuid || account.role === AccountRole.Admin) return
    // Guests are judged by GuestPermissionsMiddleware, which knows the collaborator rules addSecurity
    // mirrors for reads; membership alone would cut off collaborators who are not space members.
    if (guestRoles.has(account.role)) return
    if (!this.canWriteSpace(cudTx.objectSpace, account.uuid)) {
      throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    }
  }

  private async processTx (ctx: MeasureContext<SessionData>, tx: Tx): Promise<void> {
    const h = this.context.hierarchy
    // ApplyTxMiddleware unwraps these downstream, so the inner txes never come back through here.
    if (tx._class === core.class.TxApplyIf) {
      const processed: Set<Ref<Tx>> | undefined = ctx.contextData.contextCache.get('processed')
      for (const t of (tx as TxApplyIf).txes) {
        processed?.add(t._id)
        await this.processTx(ctx, t)
      }
      return
    }
    if (TxProcessor.isExtendsCUD(tx._class)) {
      const cudTx = tx as TxCUD<Doc>
      const isSpace = h.isDerived(cudTx.objectClass, core.class.Space)
      if (isSpace) {
        await this.checkSpacePermissions(ctx, cudTx as TxCUD<Space>)
        await this.handleTx(ctx, cudTx as TxCUD<Space>)
      } else {
        this.checkWriteAccess(ctx, cudTx)
        await this.handeCollaborator(ctx, cudTx as TxCUD<Collaborator>)
      }
    }
  }

  async tx (ctx: MeasureContext<SessionData>, txes: Tx[]): Promise<TxMiddlewareResult> {
    await this.init(ctx)
    const processed = new Set<Ref<Tx>>()
    ctx.contextData.contextCache.set('processed', processed)
    for (const tx of txes) {
      processed.add(tx._id)
      await this.processTx(ctx, tx)
    }
    return await this.provideTx(ctx, txes)
  }

  override async handleBroadcast (ctx: MeasureContext<SessionData>): Promise<void> {
    await this.init(ctx)
    const processed: Set<Ref<Tx>> = ctx.contextData.contextCache.get('processed') ?? new Set<Ref<Tx>>()
    ctx.contextData.contextCache.set('processed', processed)
    for (const txd of ctx.contextData.broadcast.txes) {
      if (!processed.has(txd._id)) {
        await this.processTx(ctx, txd)
      }
    }

    ctx.contextData.broadcast.targets.spaceSec = async (tx) => {
      const cud = tx as TxCUD<Doc>
      if (cud.objectClass === undefined) return undefined

      const isSpaceTx = this.context.hierarchy.isDerived(cud.objectClass, core.class.Space)
      const isPersonSpaceTx = this.context.hierarchy.isDerived(cud.objectClass, contact.class.PersonSpace)

      const space = this.getTxSpaceInfo(ctx, cud)

      const isPrivateSpaceTx = isSpaceTx ? space?.private === true : false
      const bypassMainSpaces = isPersonSpaceTx || isPrivateSpaceTx

      // For system and main spaces broadcast to all users except guests that are not collaborators for objects with collab security enabled
      if (!bypassMainSpaces && (this.systemSpaces.has(tx.objectSpace) || this.mainSpaces.has(tx.objectSpace))) {
        const collabSec = getClassCollaborators(this.context.modelDb, this.context.hierarchy, cud.objectClass)
        if (collabSec?.provideSecurity === true) {
          const guests = new Set<AccountUuid>()
          for (const val of ctx.contextData.socialStringsToUsers.values()) {
            if ([AccountRole.Guest, AccountRole.ReadOnlyGuest].includes(val.role)) {
              guests.add(val.accountUuid)
            }
          }
          const collabs = (await this.next?.findAll(ctx, core.class.Collaborator, {
            attachedTo: cud.objectId
          })) as Collaborator[]
          for (const collab of collabs) {
            guests.delete(collab.collaborator)
          }
          return { exclude: Array.from(guests) }
        }
        return undefined
      }

      if (space === undefined) return undefined

      const getCollabTargets = async (_id: Ref<Doc>): Promise<AccountUuid[]> => {
        const guests = new Set<AccountUuid>()
        for (const val of ctx.contextData.socialStringsToUsers.values()) {
          if ([AccountRole.Guest, AccountRole.ReadOnlyGuest].includes(val.role)) {
            guests.add(val.accountUuid)
          }
        }
        const collaboratorObjs = (await this.next?.findAll(ctx, core.class.Collaborator, {
          attachedTo: _id
        })) as Collaborator[]

        return collaboratorObjs.map((it) => it.collaborator).filter((it) => guests.has(it))
      }

      // For all other spaces broadcast to space members
      // + guests that are collaborators for objects with collab security enabled
      // + guests that are collaborators for attached objects with collab security enabled
      let collabTargets: AccountUuid[] = []
      const collabSec = getClassCollaborators(this.context.modelDb, this.context.hierarchy, cud.objectClass)
      if (collabSec?.provideSecurity === true) {
        collabTargets = await getCollabTargets(cud.objectId)
      } else if (cud.attachedTo != null && cud.attachedToClass != null) {
        const attachedCollabSec = getClassCollaborators(
          this.context.modelDb,
          this.context.hierarchy,
          cud.attachedToClass
        )
        if (attachedCollabSec?.provideSecurity === true) {
          collabTargets = await getCollabTargets(cud.attachedTo)
        }
      }

      const spaceTargets = space.members.size === 0 ? [] : this.getTargets(Array.from(space.members))

      // Public spaces are visible to everyone at the space list level,
      // but their objects are only visible/broadcasted to members.
      if (!space.private) {
        if (isSpaceTx) {
          return collabTargets.length === 0 ? undefined : { target: collabTargets }
        }
        const target = [...new Set([...collabTargets, ...spaceTargets])]
        return target.length === 0 ? undefined : { target }
      }

      if (this.context.hierarchy.isDerived(space._class, contact.class.PersonSpace)) {
        // Personal space: broadcast ONLY to members. Do NOT add workspace owners.
        const target = [...new Set(spaceTargets)]
        return target.length === 0 ? undefined : { target }
      }

      // Workspace owners can see every private space (see getAllAllowedSpaces),
      // but are not in space.members, so they would miss the broadcast and not
      // get live updates for private spaces until refresh. Add them explicitly
      // only for space-level transactions.
      const ownerTargets: AccountUuid[] = []
      if (isSpaceTx) {
        for (const val of ctx.contextData.socialStringsToUsers.values()) {
          if (val.role === AccountRole.Owner) {
            ownerTargets.push(val.accountUuid)
          }
        }
      }

      const target = [...new Set([...collabTargets, ...spaceTargets, ...ownerTargets])]

      return target.length === 0 ? undefined : { target }
    }

    await this.next?.handleBroadcast(ctx)
  }

  private getTxSpaceInfo (ctx: MeasureContext<SessionData>, tx: TxCUD<Doc>): SpaceInfo | undefined {
    const isSpaceTx = this.context.hierarchy.isDerived(tx.objectClass, core.class.Space)
    const spaceId = isSpaceTx ? (tx.objectId as Ref<Space>) : tx.objectSpace
    const spaceInfo = this.spacesMap.get(spaceId)
    if (spaceInfo != null) return spaceInfo
    const removedSpace = ctx.contextData.removedMap?.get(spaceId) as Space | undefined
    if (removedSpace != null) {
      return {
        _id: removedSpace._id,
        _class: removedSpace._class,
        members: new Set(removedSpace.members ?? []),
        owners: new Set(removedSpace.owners ?? []),
        private: removedSpace.private,
        archived: removedSpace.archived,
        autoJoin: removedSpace.autoJoin === true,
        systemCreated: removedSpace.createdBy === core.account.System
      }
    }
  }

  private getAllAllowedSpaces (account: Account, showArchived: boolean, forSearch: boolean = false): Ref<Space>[] {
    const includeSystem = !forSearch || ![AccountRole.Guest, AccountRole.ReadOnlyGuest].includes(account.role)
    const includePublic = account.role !== AccountRole.ReadOnlyGuest

    const result: Ref<Space>[] = [account.uuid as unknown as Ref<Space>, ...this.mainSpaces]

    if (includeSystem) {
      result.push(...this.systemSpaces)
    }

    // Workspace owner sees every space regardless of membership/privacy,
    // mirroring filterLookup's availableForOwner branch.
    const isWorkspaceOwner = account.role === AccountRole.Owner

    for (const space of this.spacesMap.values()) {
      if (!showArchived && space.archived) continue
      if (isWorkspaceOwner || space.members.has(account.uuid) || (includePublic && !space.private)) {
        result.push(space._id)
      }
    }

    return result
  }

  override async findAll<T extends Doc>(
    ctx: MeasureContext<SessionData>,
    _class: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: ServerFindOptions<T>
  ): Promise<FindResult<T>> {
    await this.init(ctx)

    // Security filtering is handled at the database (PostgreSQL) level via addSecurity().
    // This middleware only needs to filter lookup results client-side.
    const findResult = await this.provideFindAll(ctx, _class, query, options)
    const account = ctx.contextData.account
    if (account.role !== AccountRole.DocGuest) {
      if (options?.lookup !== undefined) {
        const showArchived: boolean = shouldShowArchived(query, options)
        for (const object of findResult) {
          if (object.$lookup !== undefined) {
            this.filterLookup(ctx, object.$lookup, showArchived)
          }
        }
      }
    }
    return findResult
  }

  override async searchFulltext (
    ctx: MeasureContext<SessionData>,
    query: SearchQuery,
    options: SearchOptions
  ): Promise<SearchResult> {
    await this.init(ctx)
    const newQuery = { ...query }
    const account = ctx.contextData.account
    if (!isSystem(account, ctx)) {
      newQuery.spaces = this.getAllAllowedSpaces(account, false, true)
    }
    return await this.provideSearchFulltext(ctx, newQuery, options)
  }

  filterLookup<T extends Doc>(ctx: MeasureContext, lookup: LookupData<T>, showArchived: boolean): void {
    if (Object.keys(lookup).length === 0) return
    const account = ctx.contextData.account
    if (isSystem(account, ctx)) return
    const owner = isOwner(account, ctx)
    const h = this.context.hierarchy
    const allowedSpaces = new Set(this.getAllAllowedSpaces(account, showArchived))
    for (const key in lookup) {
      const val = lookup[key]
      if (Array.isArray(val)) {
        const arr: AttachedDoc[] = []
        for (const value of val) {
          const isSpace = '_class' in value && h.isDerived(value._class, core.class.Space)
          const availableForOwner = owner && isSpace
          const availableSpace = isSpace && allowedSpaces.has(value._id)
          const availableDoc = !isSpace && allowedSpaces.has(value.space)
          if (availableForOwner || availableSpace || availableDoc) {
            arr.push(value)
          }
        }
        lookup[key] = arr as any
      } else if (val !== undefined) {
        const isSpace = '_class' in val && h.isDerived(val._class, core.class.Space)
        const availableForOwner = owner && isSpace
        const availableSpace = isSpace && allowedSpaces.has(val._id as Ref<Space>)
        const availableDoc = !isSpace && allowedSpaces.has(val.space)
        if (!availableForOwner && !availableSpace && !availableDoc) {
          // allow attached lookups for guests when collaborator security is enabled
          // do not check if collaborator of the doc because it's being checked on the storage (DB) level
          // as otherwise there will be no doc here at all
          if (key === 'attachedTo' && ctx.contextData.modelDb?.hierarchy != null) {
            const attachedVal = val as AttachedDoc
            if (attachedVal.attachedToClass == null) {
              lookup[key] = undefined
              continue
            }

            const collabSec = getClassCollaborators(
              ctx.contextData.modelDb,
              ctx.contextData.modelDb.hierarchy,
              attachedVal.attachedToClass
            )
            const collabSecEnabled =
              collabSec?.provideSecurity === true &&
              [AccountRole.Guest, AccountRole.ReadOnlyGuest].includes(account.role)
            if (!collabSecEnabled) {
              lookup[key] = undefined
            }
          } else {
            lookup[key] = undefined
          }
        }
      }
    }
  }
}
