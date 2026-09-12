import { type IntlString, type Metadata, plugin, type Plugin } from '@hcengineering/platform'
import {
  type PlatformQueueProducer,
  type QueueSubscriptionMessage,
  type QueueWorkspaceMessage
} from '@hcengineering/server-core'
import { type TierLimits } from './types'

/**
 * @public
 */
export const accountId = 'account' as Plugin

export interface EmailNotification {
  html: string
  to: string
  text: string
  subject: string
}
export interface AccountNotification {
  type: 'email'
  data: any
}

export interface CrmNotification {
  firstName: string
  lastName: string
  email: string
  phone: string | null
  cookies?: string
}

/**
 * @public
 */
export const accountPlugin = plugin(accountId, {
  metadata: {
    FrontURL: '' as Metadata<string>,
    ProductName: '' as Metadata<string>,
    Transactors: '' as Metadata<string>,
    OtpTimeToLiveSec: '' as Metadata<number>,
    OtpRetryDelaySec: '' as Metadata<number>,
    // Activation link in the sign up email. Outlives the OTP code so a delayed email is still usable.
    SignUpLinkTimeToLiveSec: '' as Metadata<number>,
    // Dev/testing only: fixed admin-operation OTP code (ADMIN_OTP_DEV_CODE). Never set in prod.
    AdminOtpDevCode: '' as Metadata<string>,
    WsLivenessDays: '' as Metadata<number>,
    AllowReadonlyGuests: '' as Metadata<boolean>,
    // Free fallback limits (defaults, FREE_PLAN_LIMITS env overrides). Always present — applied to every
    // tier subscription on read; an unpaid workspace runs on these instead of full read-only. Not persisted.
    FreePlanLimits: '' as Metadata<TierLimits>,
    // Self-host edition gating. account is the single holder of LICENSE_KEY; other pods ask account.
    // LicenseMaxUsers: 0 = unlimited (dev/licensed-unlimited), >0 = hard cap on the free path
    // (community=15 or licensed maxUsers). LicenseEdition: dev|community|licensed. LicenseCanRunPayment:
    // whether the payment pods may run (dev always true; licensed per key; community false).
    LicenseMaxUsers: '' as Metadata<number>,
    LicenseEdition: '' as Metadata<string>,
    LicenseCanRunPayment: '' as Metadata<boolean>,
    MailQueue: '' as Metadata<PlatformQueueProducer<AccountNotification>>,
    CrmQueue: '' as Metadata<PlatformQueueProducer<CrmNotification>>,
    WorkspaceQueue: '' as Metadata<PlatformQueueProducer<QueueWorkspaceMessage>>,
    FulltextQueue: '' as Metadata<PlatformQueueProducer<QueueWorkspaceMessage>>,
    // Admin-initiated subscription events for pod-payment (free-plan fallback after an admin cancel).
    SubscriptionQueue: '' as Metadata<PlatformQueueProducer<QueueSubscriptionMessage>>
  },
  string: {
    ConfirmationText: '' as IntlString,
    ConfirmationHTML: '' as IntlString,
    ConfirmationSubject: '' as IntlString,
    RecoveryText: '' as IntlString,
    RecoveryHTML: '' as IntlString,
    RecoverySubject: '' as IntlString,
    InviteText: '' as IntlString,
    InviteHTML: '' as IntlString,
    InviteSubject: '' as IntlString,
    ResendInviteText: '' as IntlString,
    ResendInviteHTML: '' as IntlString,
    ResendInviteSubject: '' as IntlString,
    OtpText: '' as IntlString,
    OtpHTML: '' as IntlString,
    OtpSubject: '' as IntlString,
    SignUpOtpText: '' as IntlString,
    SignUpOtpHTML: '' as IntlString,
    AdminOtpText: '' as IntlString,
    AdminOtpHTML: '' as IntlString,
    AdminOtpSubject: '' as IntlString,
    ApiKeyCreatedText: '' as IntlString,
    ApiKeyCreatedHTML: '' as IntlString,
    ApiKeyCreatedSubject: '' as IntlString,
    ApiKeyRevokedText: '' as IntlString,
    ApiKeyRevokedHTML: '' as IntlString,
    ApiKeyRevokedSubject: '' as IntlString
  }
})
