//
// Copyright © 2020, 2021 Anticrm Platform Contributors.
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

import type {
  AccountRole,
  Blob,
  Class,
  Configuration,
  Doc,
  Mixin,
  Rank,
  Ref,
  Space,
  AccountUuid,
  Domain,
  IntegrationKind,
  Timestamp
} from '@hcengineering/core'
import type { Metadata, Plugin } from '@hcengineering/platform'
import { Asset, IntlString, Resource, plugin } from '@hcengineering/platform'
import { TemplateField, TemplateFieldCategory } from '@hcengineering/templates'
import { Action, AnyComponent } from '@hcengineering/ui'
import { type Integration as AccountIntegration } from '@hcengineering/account-client'

import { SpaceTypeCreator, SpaceTypeEditor } from './spaceTypeEditor'

export type * from './spaceTypeEditor'
export * from './utils'
export * from './analytics'
export * from './webhookSecret'

export const DOMAIN_SETTING = 'setting' as Domain

/**
 * @public
 */
export type Handler = Resource<(integration: AccountIntegration) => Promise<void>>

/**
 * @public
 */
export interface IntegrationType extends Doc {
  label: IntlString
  description: IntlString
  descriptionComponent?: AnyComponent
  stateComponent?: AnyComponent
  icon: AnyComponent
  allowMultiple: boolean
  kind: IntegrationKind

  createComponent?: AnyComponent
  onDisconnect?: Handler
  onDisconnectAll?: Handler // Disconnect for all workspaces
  reconnectComponent?: AnyComponent
  configureComponent?: AnyComponent

  getActions?: Resource<(integration?: AccountIntegration) => Promise<Action[]>>
}

/**
 * @public
 */
export interface Integration extends Doc {
  type: Ref<IntegrationType>
  disabled: boolean
  value: string
  error?: IntlString | null
  shared?: AccountUuid[]
}

/**
 * @public
 */
export interface Editable extends Class<Doc> {
  value: boolean // true is editable, false is not
}

/**
 * @public
 *
 * Mixin to allow delete of Custom classes.
 */
export type UserMixin = Class<Doc>

/**
 * @public
 *
 * Mixin to keep ordering of classifiers (mixins) in the class editor.
 */
export interface ClassifierOrder extends Class<Doc> {
  rank: Rank
}

/**
 * @public
 */
export interface SettingsCategory extends Doc {
  name: string
  label: IntlString
  icon: Asset
  component: AnyComponent
  props?: Record<string, any>

  // If defined, will pass kind with key to component
  extraComponents?: Record<string, AnyComponent>

  group?: string

  // If defined, will sort using order.
  order?: number
  role: AccountRole

  // A feature to be used with hides
  feature?: string

  expandable?: boolean
  adminOnly?: boolean
}

/**
 * @public
 */
export interface InviteSettings extends Configuration {
  expirationTime: number
  emailMask: string
  limit: number
}

/**
 * @public
 */
export interface OfficeSettings extends Configuration {
  defaultStartWithTranscription: boolean
  defaultStartWithRecording: boolean
  defaultStartPrivate: boolean
}

/**
 * @public
 */
export interface WorkspaceSetting extends Doc {
  icon?: Ref<Blob> | null
}

export enum IntegrationError {
  EMAIL_IS_ALREADY_USED = 'EMAIL_IS_ALREADY_USED'
}

/**
 * @public
 * One signing secret. Up to two may be active on an endpoint at once, for rotation without downtime.
 */
export interface WebhookSecretEntry {
  id: string
  secret: string
  createdOn: Timestamp
}

/**
 * @public
 * A registered outgoing webhook recipient. Delivery worker reads/writes this via REST from the
 * transactor - it never loads the workspace model directly (see docs/memory/webhook_ingest_pod.md).
 */
export interface WebhookEndpoint extends Doc {
  url: string
  /** Domain event names this endpoint subscribes to, e.g. 'issue.created'. */
  events: string[]
  /** Oldest first; all active secrets sign each delivery, so a receiver can rotate without downtime. */
  secrets: WebhookSecretEntry[]
  enabled: boolean
  /** Whitelist. Empty means every non-private space: a private one is exported only when listed here,
   * so configuring an endpoint never hands out content its owner cannot read themselves. */
  spaces?: Ref<Space>[]
  /** Consecutive delivery failures since the last success; auto-disables the endpoint past a threshold. */
  failureCount: number
  lastDeliveryOn?: Timestamp
  lastError?: string
}

/**
 * @public
 * Domain event names outgoing webhooks can subscribe to - the single source of truth shared with
 * pod-webhook's eventTable.ts (its domainRules[].type is typed against this union, so the two
 * can't drift apart) and with the UI's event checkboxes.
 */
export const webhookEventTypes = [
  'issue.created',
  'issue.status_changed',
  'issue.assigned',
  'issue.commented',
  'message.posted',
  'document.created'
] as const

/**
 * @public
 */
export type WebhookEventType = (typeof webhookEventTypes)[number]

/**
 * @public
 * One example delivery body per event, shown in the settings dialog so the receiver's author sees
 * the exact shape. `data` keys must match eventTable.ts's dataFields - a pod-webhook test asserts it.
 */
export const webhookEventSamples: Record<WebhookEventType, Record<string, unknown>> = {
  'issue.created': {
    action: 'create',
    type: 'issue.created',
    actor: '64f10a1b2c3d4e5f6a7b8c8f',
    data: {
      id: '64f10a1b2c3d4e5f6a7b8c91',
      identifier: 'FUSIO-123',
      title: 'Payment webhook retries indefinitely',
      status: '64f10a1b2c3d4e5f6a7b8c92',
      assignee: '64f10a1b2c3d4e5f6a7b8c93',
      priority: 2
    },
    organizationId: '9c858f36-6b1a-4d3a-8f2e-1a2b3c4d5e6f'
  },
  // `data.identifier` is present only if pod-webhook still has this issue's create cached in-process
  // (see txTranslator.ts's `ponytail:` note) - unknown after a restart, same as `updatedFrom`.
  'issue.status_changed': {
    action: 'update',
    type: 'issue.status_changed',
    actor: '64f10a1b2c3d4e5f6a7b8c8f',
    data: {
      id: '64f10a1b2c3d4e5f6a7b8c91',
      identifier: 'FUSIO-123',
      status: '64f10a1b2c3d4e5f6a7b8c94'
    },
    updatedFrom: {
      status: '64f10a1b2c3d4e5f6a7b8c92'
    },
    organizationId: '9c858f36-6b1a-4d3a-8f2e-1a2b3c4d5e6f'
  },
  'issue.assigned': {
    action: 'update',
    type: 'issue.assigned',
    actor: '64f10a1b2c3d4e5f6a7b8c8f',
    data: {
      id: '64f10a1b2c3d4e5f6a7b8c91',
      identifier: 'FUSIO-123',
      assignee: '64f10a1b2c3d4e5f6a7b8c93'
    },
    updatedFrom: {
      assignee: null
    },
    organizationId: '9c858f36-6b1a-4d3a-8f2e-1a2b3c4d5e6f'
  },
  'issue.commented': {
    action: 'create',
    type: 'issue.commented',
    actor: '64f10a1b2c3d4e5f6a7b8c8f',
    data: {
      id: '64f10a1b2c3d4e5f6a7b8c95',
      message: 'Reproduced on staging, looking into the retry loop now.'
    },
    organizationId: '9c858f36-6b1a-4d3a-8f2e-1a2b3c4d5e6f'
  },
  'message.posted': {
    action: 'create',
    type: 'message.posted',
    actor: '64f10a1b2c3d4e5f6a7b8c8f',
    data: {
      id: '64f10a1b2c3d4e5f6a7b8c96',
      message: 'Deploy finished, all green.'
    },
    organizationId: '9c858f36-6b1a-4d3a-8f2e-1a2b3c4d5e6f'
  },
  'document.created': {
    action: 'create',
    type: 'document.created',
    actor: '64f10a1b2c3d4e5f6a7b8c8f',
    data: {
      id: '64f10a1b2c3d4e5f6a7b8c97',
      title: 'Q3 Roadmap'
    },
    organizationId: '9c858f36-6b1a-4d3a-8f2e-1a2b3c4d5e6f'
  }
}

/**
 * @public
 * One HTTP delivery attempt's outcome, kept for the endpoint's "recent deliveries" list. Bounded
 * per endpoint (oldest trimmed on write, see pod-webhook's delivery.ts) - a debugging aid, not the
 * source of truth for endpoint health (that's WebhookEndpoint.failureCount/lastError).
 */
export interface WebhookDelivery extends Doc {
  endpoint: Ref<WebhookEndpoint>
  deliveryId: string
  attempt: number
  /** HTTP status on a completed request; absent for a network/SSRF error (see `error`). */
  status?: number
  /** Set on failure only - either a transport error message or `http <status>` for a non-2xx. */
  error?: string
}

/**
 * @public
 * A message counter, one doc per (direction, target, type). Kept as its own satellite doc rather than
 * a `Record<type, number>` field on WebhookEndpoint/an API key - `$inc` only writes flat top-level
 * numeric properties (see docs/memory/webhook_outgoing_delivery.md), a map field would need a
 * read-modify-write and lose increments under concurrent deliveries.
 */
export interface WebhookStat extends Doc {
  direction: 'in' | 'out'
  /** keyId for an incoming stat, Ref<WebhookEndpoint> for an outgoing one. */
  target: string
  /** ApiKeyOperation for incoming, WebhookEventType for outgoing. */
  type: string
  count: number
  lastOn: Timestamp
}

/**
 * @public
 */
export const settingId = 'setting' as Plugin

export default plugin(settingId, {
  ids: {
    SettingApp: '' as Ref<Doc>,
    Profile: '' as Ref<Doc>,
    Password: '' as Ref<Doc>,
    Setting: '' as Ref<Doc>,
    Integrations: '' as Ref<Doc>,
    Relations: '' as Ref<Doc>,
    Support: '' as Ref<Doc>,
    Privacy: '' as Ref<Doc>,
    Terms: '' as Ref<Doc>,
    ClassSetting: '' as Ref<Doc>,
    General: '' as Ref<Doc>,
    Members: '' as Ref<Doc>,
    InviteSettings: '' as Ref<Doc>,
    WorkspaceSetting: '' as Ref<Doc>,
    ManageSpaces: '' as Ref<Doc>,
    Spaces: '' as Ref<Doc>,
    Backup: '' as Ref<Doc>,
    ApiKeys: '' as Ref<Doc>,
    Export: '' as Ref<Doc>,
    OfficeSettings: '' as Ref<Doc>,
    DisablePermissionsConfiguration: '' as Ref<Configuration>,
    Mailboxes: '' as Ref<Doc>
  },
  mixin: {
    Editable: '' as Ref<Mixin<Editable>>,
    UserMixin: '' as Ref<Mixin<UserMixin>>,
    ClassifierOrder: '' as Ref<Mixin<ClassifierOrder>>,
    SpaceTypeEditor: '' as Ref<Mixin<SpaceTypeEditor>>,
    SpaceTypeCreator: '' as Ref<Mixin<SpaceTypeCreator>>
  },
  class: {
    SettingsCategory: '' as Ref<Class<SettingsCategory>>,
    WorkspaceSettingCategory: '' as Ref<Class<SettingsCategory>>,
    Integration: '' as Ref<Class<Integration>>,
    IntegrationType: '' as Ref<Class<IntegrationType>>,
    InviteSettings: '' as Ref<Class<InviteSettings>>,
    OfficeSettings: '' as Ref<Class<OfficeSettings>>,
    WorkspaceSetting: '' as Ref<Class<WorkspaceSetting>>,
    WebhookEndpoint: '' as Ref<Class<WebhookEndpoint>>,
    WebhookDelivery: '' as Ref<Class<WebhookDelivery>>,
    WebhookStat: '' as Ref<Class<WebhookStat>>
  },
  component: {
    Settings: '' as AnyComponent,
    Profile: '' as AnyComponent,
    Password: '' as AnyComponent,
    WorkspaceSettings: '' as AnyComponent,
    Integrations: '' as AnyComponent,
    Support: '' as AnyComponent,
    Privacy: '' as AnyComponent,
    Terms: '' as AnyComponent,
    ClassSetting: '' as AnyComponent,
    PermissionPresenter: '' as AnyComponent,
    AttributePermissionPresenter: '' as AnyComponent,
    ClassPermissionPresenter: '' as AnyComponent,
    SpaceTypeDescriptorPresenter: '' as AnyComponent,
    SpaceTypeGeneralSectionEditor: '' as AnyComponent,
    SpaceTypePropertiesSectionEditor: '' as AnyComponent,
    SpaceTypeRolesSectionEditor: '' as AnyComponent,
    RoleEditor: '' as AnyComponent,
    RoleAssignmentEditor: '' as AnyComponent,
    RelationSetting: '' as AnyComponent,
    Backup: '' as AnyComponent,
    ApiKeys: '' as AnyComponent,
    CreateAttributePopup: '' as AnyComponent,
    CreateRelation: '' as AnyComponent,
    EditRelation: '' as AnyComponent,
    Mailboxes: '' as AnyComponent,
    AddEmailSocialId: '' as AnyComponent,
    OfficeSettings: '' as AnyComponent
  },
  string: {
    ConfirmOperation: '' as IntlString,
    Confirm: '' as IntlString,
    OtpCode: '' as IntlString,
    OtpSent: '' as IntlString,
    OtpSendFailed: '' as IntlString,
    SendCode: '' as IntlString,
    Settings: '' as IntlString,
    Setting: '' as IntlString,
    Spaces: '' as IntlString,
    WorkspaceSettings: '' as IntlString,
    Integrations: '' as IntlString,
    Support: '' as IntlString,
    Privacy: '' as IntlString,
    Terms: '' as IntlString,
    Categories: '' as IntlString,
    Delete: '' as IntlString,
    Disconnect: '' as IntlString,
    DisconnectAll: '' as IntlString,
    Add: '' as IntlString,
    Proceed: '' as IntlString,
    SendConfirmation: '' as IntlString,
    NewEmail: '' as IntlString,
    AccountSettings: '' as IntlString,
    ChangePassword: '' as IntlString,
    Saving: '' as IntlString,
    Saved: '' as IntlString,
    Signout: '' as IntlString,
    InviteWorkspace: '' as IntlString,
    SelectWorkspace: '' as IntlString,
    Reconnect: '' as IntlString,
    ClassSetting: '' as IntlString,
    Classes: '' as IntlString,
    Members: '' as IntlString,
    Configure: '' as IntlString,
    InviteSettings: '' as IntlString,
    General: '' as IntlString,
    Properties: '' as IntlString,
    TaskTypes: '' as IntlString,
    Automations: '' as IntlString,
    Collections: '' as IntlString,
    SpaceTypes: '' as IntlString,
    Roles: '' as IntlString,
    OwnerOrMaintainerRequired: '' as IntlString,
    Backup: '' as IntlString,
    BackupLast: '' as IntlString,
    BackupTotalSnapshots: '' as IntlString,
    BackupTotalFiles: '' as IntlString,
    BackupSize: '' as IntlString,
    BackupLinkInfo: '' as IntlString,
    BackupBearerTokenInfo: '' as IntlString,
    BackupSnapshots: '' as IntlString,
    BackupFileDownload: '' as IntlString,
    BackupFiles: '' as IntlString,
    BackupNoBackup: '' as IntlString,
    NonBackupedBlobs: '' as IntlString,
    AddAttribute: '' as IntlString,
    Mailboxes: '' as IntlString,
    CreateMailbox: '' as IntlString,
    CreateMailboxPlaceholder: '' as IntlString,
    MailboxNoDomains: '' as IntlString,
    MailboxLimitReached: '' as IntlString,
    SeatLimitReached: '' as IntlString,
    SeatLimitReachedDescription: '' as IntlString,
    OfficeSettings: '' as IntlString,
    OfficeDefaultSettings: '' as IntlString,
    DefaultStartWithTranscription: '' as IntlString,
    DefaultStartWithRecording: '' as IntlString,
    DefaultStartPrivate: '' as IntlString,
    MailboxErrorInvalidName: '' as IntlString,
    MailboxErrorDomainNotFound: '' as IntlString,
    MailboxErrorNameRulesViolated: '' as IntlString,
    MailboxErrorMailboxExists: '' as IntlString,
    MailboxErrorMailboxCountLimit: '' as IntlString,
    DeleteMailbox: '' as IntlString,
    MailboxDeleteConfirmation: '' as IntlString,
    IntegrationFailed: '' as IntlString,
    IntegrationError: '' as IntlString,
    EmailIsUsed: '' as IntlString,
    Customize: '' as IntlString,
    CodeSent: '' as IntlString,
    SendAgain: '' as IntlString,
    SendAgainIn: '' as IntlString,
    AllIntegrations: '' as IntlString,
    ConnectedIntegrations: '' as IntlString,
    AvailableIntegrations: '' as IntlString,
    Connect: '' as IntlString,
    Integrate: '' as IntlString,
    FailedToLoadIntegrations: '' as IntlString,
    FailedToDisconnect: '' as IntlString,
    ServiceIsUnavailable: '' as IntlString,
    Integrated: '' as IntlString,
    Connected: '' as IntlString,
    Disconnected: '' as IntlString,
    Available: '' as IntlString,
    NotConnectedIntegration: '' as IntlString,
    IntegrationIsUnstable: '' as IntlString
  },
  emailTemplate: {
    IntegrationDisabledNotificationText: '' as IntlString,
    IntegrationDisabledNotificationHtml: '' as IntlString,
    IntegrationDisabledNotificationSubject: '' as IntlString
  },
  icon: {
    AccountSettings: '' as Asset,
    Members: '' as Asset,
    Password: '' as Asset,
    Setting: '' as Asset,
    Integrations: '' as Asset,
    Support: '' as Asset,
    Privacy: '' as Asset,
    Terms: '' as Asset,
    Signout: '' as Asset,
    SelectWorkspace: '' as Asset,
    Clazz: '' as Asset,
    Enums: '' as Asset,
    InviteSettings: '' as Asset,
    InviteWorkspace: '' as Asset,
    Views: '' as Asset,
    Relations: '' as Asset,
    Mailbox: '' as Asset,
    OfficeSettings: '' as Asset,
    Reset: '' as Asset
  },
  templateFieldCategory: {
    Integration: '' as Ref<TemplateFieldCategory>
  },
  templateField: {
    OwnerFirstName: '' as Ref<TemplateField>,
    OwnerLastName: '' as Ref<TemplateField>,
    OwnerPosition: '' as Ref<TemplateField>,
    Value: '' as Ref<TemplateField>
  },
  metadata: {
    BackupUrl: '' as Metadata<string>,
    WebhookServiceUrl: '' as Metadata<string>
  }
})
