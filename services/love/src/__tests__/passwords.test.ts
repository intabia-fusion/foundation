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
import { hashGuestPassword, verifyGuestPassword } from '../passwords'

describe('hashGuestPassword / verifyGuestPassword', () => {
  it('verifies the correct password', () => {
    const stored = hashGuestPassword('sunny-otter-42')
    expect(verifyGuestPassword('sunny-otter-42', stored)).toBe(true)
  })

  it('rejects a wrong password', () => {
    const stored = hashGuestPassword('sunny-otter-42')
    expect(verifyGuestPassword('wrong-guess', stored)).toBe(false)
  })

  it('rejects an empty password against a real one', () => {
    const stored = hashGuestPassword('sunny-otter-42')
    expect(verifyGuestPassword('', stored)).toBe(false)
  })

  it('rejects when no password is stored', () => {
    expect(verifyGuestPassword('anything', undefined)).toBe(false)
  })

  it('would accept an empty password if one were ever stored', () => {
    // Exactly why POST /meetingPassword refuses '': hashing it makes the link open to anyone
    // who sends an empty string. Removing a password is `null`, not ''.
    expect(verifyGuestPassword('', hashGuestPassword(''))).toBe(true)
  })

  it('salts each hash differently', () => {
    const a = hashGuestPassword('same-password')
    const b = hashGuestPassword('same-password')
    expect(a.salt).not.toBe(b.salt)
    expect(a.hash).not.toBe(b.hash)
  })
})
