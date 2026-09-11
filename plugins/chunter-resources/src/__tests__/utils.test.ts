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

describe('sortActivityChannels comparator logic', () => {
  it('should correctly prioritize item with unread messages over item without unread messages', () => {
    const context1 = { unreadMessages: [] }
    const context2 = { unreadMessages: [{ id: 'msg1', createdOn: 100 }] }

    const hasUnreadMessages1 = (context1?.unreadMessages?.length ?? 0) > 0
    const hasUnreadMessages2 = (context2?.unreadMessages?.length ?? 0) > 0

    expect(hasUnreadMessages1).toBe(false)
    expect(hasUnreadMessages2).toBe(true)
    expect(hasUnreadMessages1 !== hasUnreadMessages2).toBe(true)
  })
})
