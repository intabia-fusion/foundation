import type { Class, Doc, Domain, Ref } from '@hcengineering/core'

export enum QueueWorkspaceEvent {
  Up = 'up',
  Down = 'down',
  Created = 'created',
  CreateFailed = 'create-failed',
  Upgraded = 'upgraded',
  Upgradefailed = 'upgrade-failed',
  Deleted = 'deleted',
  Archived = 'archived',
  Restored = 'restored',
  Restoring = 'restoring',
  FullReindex = 'full-fulltext-reindex',
  Reindex = 'fulltext-reindex',
  ClearIndex = 'clear-fulltext-index',
  LimitsChanged = 'limits-changed',
  UsageChanged = 'usage-changed',
  Maintenance = 'maintenance',
  ForceClose = 'force-close',
  PurchaseActivated = 'purchase-activated'
}

export interface QueueWorkspaceMessage {
  type: QueueWorkspaceEvent
}

export interface QueueWorkspaceReindexMessage extends QueueWorkspaceMessage {
  type: QueueWorkspaceEvent.Reindex

  domain: Domain
  classes: Ref<Class<Doc>>[]
}

/** Which limit a LimitsChanged event is about. 'plan' = plan/limits snapshot changed
 * (upgrade/downgrade): consumers re-read plan limits. */
export enum LimitCategory {
  Disk = 'disk',
  Tokens = 'tokens',
  Transcript = 'transcript',
  MeetingMinutes = 'meetingMinutes',
  Payment = 'payment',
  Plan = 'plan',
  Members = 'members'
}

export enum LimitStatus {
  Exhausted = 'exhausted',
  Ok = 'ok'
}

export interface QueueWorkspaceLimitsMessage extends QueueWorkspaceMessage {
  type: QueueWorkspaceEvent.LimitsChanged

  category: LimitCategory
  status: LimitStatus
}

/** Live usage update (e.g. a meeting-minutes tick) for UI to move without waiting for a full recompute. */
export interface QueueWorkspaceUsageMessage extends QueueWorkspaceMessage {
  type: QueueWorkspaceEvent.UsageChanged

  category: LimitCategory
  used: number
}

/** Global maintenance warning (new version incoming). Not workspace-scoped: every transactor
 * schedules the warning for all its clients; timeoutMinutes < 0 clears it. */
export interface QueueWorkspaceMaintenanceMessage extends QueueWorkspaceMessage {
  type: QueueWorkspaceEvent.Maintenance

  timeoutMinutes: number
  message?: string
}

/** A one-time catalog purchase was paid & activated; the owning pod interprets `effect`. */
export interface QueueWorkspacePurchaseMessage extends QueueWorkspaceMessage {
  type: QueueWorkspaceEvent.PurchaseActivated

  sku: string
  purchaseId: string
  // Catalog effect key and its magnitude, copied from the purchasable item by payment.
  effect?: string
  quantity?: number
}

export const workspaceEvents = {
  open: (): QueueWorkspaceMessage => ({ type: QueueWorkspaceEvent.Up }),
  down: (): QueueWorkspaceMessage => ({ type: QueueWorkspaceEvent.Down }),
  created: (): QueueWorkspaceMessage => ({ type: QueueWorkspaceEvent.Created }),
  upgraded: (): QueueWorkspaceMessage => ({ type: QueueWorkspaceEvent.Upgraded }),
  upgradeFailed: (): QueueWorkspaceMessage => ({ type: QueueWorkspaceEvent.Upgradefailed }),
  createFailed: (): QueueWorkspaceMessage => ({ type: QueueWorkspaceEvent.CreateFailed }),
  deleted: (): QueueWorkspaceMessage => ({ type: QueueWorkspaceEvent.Deleted }),
  archived: (): QueueWorkspaceMessage => ({ type: QueueWorkspaceEvent.Archived }),
  restoring: (): QueueWorkspaceMessage => ({ type: QueueWorkspaceEvent.Restoring }),
  restored: (): QueueWorkspaceMessage => ({ type: QueueWorkspaceEvent.Restored }),
  fullReindex: (): QueueWorkspaceMessage => ({ type: QueueWorkspaceEvent.FullReindex }),
  clearIndex: (): QueueWorkspaceMessage => ({ type: QueueWorkspaceEvent.ClearIndex }),
  limitsChanged: (category: LimitCategory, status: LimitStatus): QueueWorkspaceLimitsMessage => ({
    type: QueueWorkspaceEvent.LimitsChanged,
    category,
    status
  }),
  usageChanged: (category: LimitCategory, used: number): QueueWorkspaceUsageMessage => ({
    type: QueueWorkspaceEvent.UsageChanged,
    category,
    used
  }),
  purchaseActivated: (
    sku: string,
    purchaseId: string,
    effect?: string,
    quantity?: number
  ): QueueWorkspacePurchaseMessage => ({
    type: QueueWorkspaceEvent.PurchaseActivated,
    sku,
    purchaseId,
    effect,
    quantity
  }),
  reindex: (domain: Domain, classes: Ref<Class<Doc>>[]): QueueWorkspaceReindexMessage => ({
    type: QueueWorkspaceEvent.Reindex,
    domain,
    classes
  }),
  maintenance: (timeoutMinutes: number, message?: string): QueueWorkspaceMaintenanceMessage => ({
    type: QueueWorkspaceEvent.Maintenance,
    timeoutMinutes,
    message
  }),
  forceClose: (): QueueWorkspaceMessage => ({ type: QueueWorkspaceEvent.ForceClose })
}
