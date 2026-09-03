//
// Copyright © 2025 Hardcore Engineering Inc.
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
import { type Asset, type IntlString, type Metadata, plugin, type Plugin } from '@hcengineering/platform'
import { AnyComponent } from '@hcengineering/ui'

/** @public */
export const billingId = 'billing' as Plugin

export const billingPlugin = plugin(billingId, {
  metadata: {
    BillingURL: '' as Metadata<string>
  },
  component: {
    Settings: '' as AnyComponent,
    WorkbenchExtension: '' as AnyComponent,
    UsageExtension: '' as AnyComponent
  },
  string: {
    Billing: '' as IntlString,
    DriveSize: '' as IntlString,
    DriveCount: '' as IntlString,
    OfficeSessionsDuration: '' as IntlString,
    OfficeSessionsBandwidth: '' as IntlString,
    OfficeEgressDuration: '' as IntlString,
    MeetingMinutesUsage: '' as IntlString,
    MaxParticipants: '' as IntlString,
    AvgMeetingDuration: '' as IntlString,
    MaxMeetingDuration: '' as IntlString,
    AI: '' as IntlString,
    TotalTokens: '' as IntlString,
    TranscriptionTime: '' as IntlString,
    Images: '' as IntlString,
    Videos: '' as IntlString,
    Audio: '' as IntlString,
    PDFDocuments: '' as IntlString,
    Documents: '' as IntlString,
    Archives: '' as IntlString,
    OtherFiles: '' as IntlString,
    StorageByType: '' as IntlString,
    LargestFiles: '' as IntlString,
    UpgradePlan: '' as IntlString,
    LimitReached: '' as IntlString,
    SeatLimitReadonly: '' as IntlString,
    PayOrUpgrade: '' as IntlString,
    FreePlan: '' as IntlString,
    FreePlanHint: '' as IntlString,
    TrialPlan: '' as IntlString,
    TrialPlanHint: '' as IntlString,
    AITokens: '' as IntlString,
    PurchasedTokens: '' as IntlString,
    PurchasableCatalog: '' as IntlString,
    PurchaseHistory: '' as IntlString,
    ConfirmBuy: '' as IntlString,
    Buy: '' as IntlString,
    PurchaseStatusPending: '' as IntlString,
    PurchaseStatusActive: '' as IntlString,
    PurchaseStatusConsumed: '' as IntlString,
    PurchaseStatusFailed: '' as IntlString,
    PickModel: '' as IntlString,
    ByLevel: '' as IntlString,
    AddTokens: '' as IntlString,
    TokenWindowMonth: '' as IntlString,
    Calculator: '' as IntlString,
    PricePer1000: '' as IntlString,
    CostPer100k: '' as IntlString,
    CustomTokens: '' as IntlString,
    CustomTokensCost: '' as IntlString,
    PackagePrice: '' as IntlString,
    PackageMargin: '' as IntlString,
    PackagesTitle: '' as IntlString,
    PackageTokens: '' as IntlString,
    PackageEffPrice: '' as IntlString,
    Forecast: '' as IntlString,
    ForecastMonthly: '' as IntlString,
    TabModels: '' as IntlString,
    TabCalculator: '' as IntlString,
    TabUsage: '' as IntlString,
    Workers: '' as IntlString,
    NoData: '' as IntlString,
    Total: '' as IntlString,
    NoLimit: '' as IntlString,
    SetLimit: '' as IntlString,
    SetUsed: '' as IntlString,
    ResetUsed: '' as IntlString,
    ResetAllUsed: '' as IntlString,
    ResetAllUsedConfirm: '' as IntlString,
    ModelLimits: '' as IntlString,
    ResetsAt: '' as IntlString,
    TokenAvailable: '' as IntlString,
    TokenPurchased: '' as IntlString,
    SectionLLM: '' as IntlString,
    SectionASR: '' as IntlString,
    AsrByModel: '' as IntlString,
    DirectProvider: '' as IntlString
  },
  icon: {
    Billing: '' as Asset,
    Subscriptions: '' as Asset
  }
})

export default billingPlugin
