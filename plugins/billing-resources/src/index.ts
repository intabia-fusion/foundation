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

import type { Resources } from '@hcengineering/platform'
import Settings from './components/Settings.svelte'
import WorkbenchExtension from './components/WorkbenchExtension.svelte'
import UsageExtension from './components/UsageExtension.svelte'
import ReadOnlyBanner from './components/ReadOnlyBanner.svelte'

export { isLimited, setIsLimited, planLimits, seatCount, seatLimitReached } from './stores/subscription'
export { checkWorkspaceLimits, getBillingClient } from './utils'
export { formatMinutes } from './billingFormat'
export { ReadOnlyBanner }
export { default as ModelsTab } from './components/ModelsTab.svelte'
export { default as CalculatorTab } from './components/CalculatorTab.svelte'
export { default as ClientsTab } from './components/ClientsTab.svelte'
export { default as WorkspaceTokenInfo } from './components/WorkspaceTokenInfo.svelte'

export default async (): Promise<Resources> => ({
  component: {
    Settings,
    UsageExtension,
    WorkbenchExtension
  }
})
