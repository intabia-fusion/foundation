//
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

import { type IntlString, type Plugin, plugin } from '@hcengineering/platform'
import { type AnyComponent } from '@hcengineering/ui'

export const adminId = 'admin' as Plugin

// 'totp' is reserved for the TOTP verification step (foundation admin-panel branch).
export const adminPages = ['login', 'totp', 'panel'] as const
export type AdminPage = (typeof adminPages)[number]

export default plugin(adminId, {
  component: {
    AdminApp: '' as AnyComponent
  },
  string: {
    Workspaces: '' as IntlString,
    Accounts: '' as IntlString,
    AI: '' as IntlString
  }
})
