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

import { webhookEventSamples, webhookEventTypes } from '@hcengineering/setting'
import { domainRules } from '../eventTable'

// Drift guard: a new event or a changed dataFields must fail the build, not silently desync the
// sample shown in the settings dialog from what pod-webhook actually sends.
describe('webhookEventSamples matches eventTable.ts', () => {
  test('every WebhookEventType has a sample', () => {
    for (const type of webhookEventTypes) {
      expect(webhookEventSamples[type]).toBeDefined()
    }
  })

  test('a create rule sample data has exactly the id key plus the rule dataFields', () => {
    for (const rule of domainRules) {
      if (rule.kind !== 'create') continue
      const data = webhookEventSamples[rule.type].data as Record<string, unknown>
      expect(new Set(Object.keys(data))).toEqual(new Set(['id', ...rule.dataFields]))
    }
  })
})
