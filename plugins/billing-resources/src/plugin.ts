//
// Copyright © 2025 Hardcore Engineering Inc.
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

import billing, { billingId } from '@hcengineering/billing'
import { type IntlString, mergeIds } from '@hcengineering/platform'

export default mergeIds(billingId, billing, {
  string: {
    AllPlans: '' as IntlString,
    ActivePlan: '' as IntlString,
    ResourceUsage: '' as IntlString,
    Subscriptions: '' as IntlString,
    ChangePlan: '' as IntlString,
    Subscribe: '' as IntlString,
    AdditionalSpace: '' as IntlString,
    Connect: '' as IntlString,
    Disconnect: '' as IntlString,
    Monthly: '' as IntlString,
    Yearly: '' as IntlString,
    MonthlyPerUser: '' as IntlString,
    PaymentMonth: '' as IntlString,
    PaymentYear: '' as IntlString,
    UsersCount: '' as IntlString,
    Active: '' as IntlString,
    Disabled: '' as IntlString,
    CancelScheduled: '' as IntlString,
    TrialPeriod: '' as IntlString,
    TrialEndsHint: '' as IntlString,
    NoActivePlan: '' as IntlString,
    SelectPlanToBegin: '' as IntlString,
    SubscriptionEnds: '' as IntlString,
    SubscriptionRenews: '' as IntlString,
    SubscriptionValidUntil: '' as IntlString,
    AdditionalPackage: '' as IntlString,
    ProcessingPayment: '' as IntlString,
    Downgrade: '' as IntlString,
    CancelSubscription: '' as IntlString,
    ConfirmUpgrade: '' as IntlString,
    ConfirmDowngrade: '' as IntlString,
    ConfirmCancel: '' as IntlString,
    UpgradeDescription: '' as IntlString,
    DowngradeDescription: '' as IntlString,
    ConfirmDowngradeToFree: '' as IntlString,
    DowngradeToFreeDescription: '' as IntlString,
    ContactSales: '' as IntlString,
    ContactSalesSubject: '' as IntlString,
    CancelDescription: '' as IntlString,
    CancelUnpaidDescription: '' as IntlString,
    UncancelSubscription: '' as IntlString,
    ConfirmUncancel: '' as IntlString,
    UncancelDescription: '' as IntlString,
    PriceDifference: '' as IntlString,
    ConfirmConnectPackage: '' as IntlString,
    ConfirmConnectPlan: '' as IntlString,
    ReplacePackageDescription: '' as IntlString,
    ConfirmCancelPackage: '' as IntlString,
    ConfirmCancelPackageDescription: '' as IntlString,
    ConfirmCancelUnpaidPackageDescription: '' as IntlString,
    DialogCancel: '' as IntlString,
    DialogConfirm: '' as IntlString,
    StorageUsage: '' as IntlString,
    TrafficUsage: '' as IntlString,
    Usage: '' as IntlString,
    Of: '' as IntlString,
    RestrictedPlans: '' as IntlString,
    SubscriptionOperationFailed: '' as IntlString,
    SubscriptionErrorMessage: '' as IntlString,
    OtherCheckoutActiveTitle: '' as IntlString,
    OtherCheckoutActiveMessage: '' as IntlString,
    OtherCheckoutActiveTooltip: '' as IntlString,
    CancelAndSwitch: '' as IntlString,
    CheckoutAlreadyPaidTitle: '' as IntlString,
    CheckoutAlreadyPaidMessage: '' as IntlString,
    LargestSpaces: '' as IntlString,
    UpgradeToAccessPackages: '' as IntlString,
    MembersUsage: '' as IntlString,
    ProjectsUsage: '' as IntlString,
    PaymentFailed: '' as IntlString,
    PaymentFailedDescription: '' as IntlString,
    RetryPayment: '' as IntlString,
    RetriesExhausted: '' as IntlString,
    RetriesExhaustedDescription: '' as IntlString,
    ChangeSeats: '' as IntlString,
    ChangeSeatsTitle: '' as IntlString,
    ChangeSeatsDescription: '' as IntlString,
    SeatMinHint: '' as IntlString,
    SeatChargeNow: '' as IntlString,
    SeatDowngradeExtends: '' as IntlString,
    SeatDowngradeExtendsOneOff: '' as IntlString,
    NewRecurringPrice: '' as IntlString,
    UpgradePackage: '' as IntlString,
    SeatsUnchanged: '' as IntlString,
    ReplacePackageSwitch: '' as IntlString,
    BillingPeriodLabel: '' as IntlString,
    YearlyOfferHint: '' as IntlString,
    AgreeMonthlyCharge: '' as IntlString,
    AgreeYearlyCharge: '' as IntlString,
    NoAutoRenewalHint: '' as IntlString
  }
})
