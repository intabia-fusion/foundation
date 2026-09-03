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

import { derived, writable } from 'svelte/store'
import { deviceOptionsStore } from '@hcengineering/ui'

import { type AITaskProposalMessage } from '@hcengineering/ai-bot'

// Room for the assistant beside the dialog. `isMobile` is not enough: it comes from the device,
// so a narrow desktop window still reports false. Below this the toggle is hidden too.
export const ASSIST_MIN_WIDTH = 768

export const issueAssistFits = derived(
  deviceOptionsStore,
  (device) => !device.isMobile && device.docWidth > ASSIST_MIN_WIDTH
)

// Toggle sits in the dialog header, panel in the card's aside slot - state lives outside both.
export const issueAssistOpened = writable(false)

// Applies a proposal to the form: registered by the panel, called by the proposal card.
export const issueDraftApplier = writable<((proposal: AITaskProposalMessage) => void) | undefined>(undefined)
