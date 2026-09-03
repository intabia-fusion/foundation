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

import { PushKind, pushTarget } from '../mobile'

describe('pushTarget', () => {
  it('reads a device token out of its scheme', () => {
    expect(pushTarget('apns://abc123')).toEqual({ kind: PushKind.Apns, token: 'abc123' })
    expect(pushTarget('fcm://xyz789')).toEqual({ kind: PushKind.Fcm, token: 'xyz789' })
  })

  it('leaves every other endpoint on web push', () => {
    expect(pushTarget('https://web.push.apple.com/xyz')).toEqual({ kind: PushKind.Web })
    expect(pushTarget('https://fcm.googleapis.com/fcm/send/abc')).toEqual({ kind: PushKind.Web })
    expect(pushTarget('')).toEqual({ kind: PushKind.Web })
  })
})
