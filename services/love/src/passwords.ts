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
import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto'

// 100k iterations, not the 1000 in server/account/src/utils.ts - that hash protects an account
// locked after 5 failed logins, this one is visible to every space member and offline brute force is cheap.
const ITERATIONS = 100_000
const KEY_LENGTH = 32
const SALT_LENGTH = 32

export interface StoredGuestPassword {
  hash: string
  salt: string
}

export function hashGuestPassword (password: string): StoredGuestPassword {
  const salt = randomBytes(SALT_LENGTH)
  const hash = pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, 'sha256')
  return { hash: hash.toString('base64'), salt: salt.toString('base64') }
}

export function verifyGuestPassword (password: string, stored?: StoredGuestPassword): boolean {
  if (stored === undefined || stored.hash === '' || stored.salt === '') return false
  const expected = Buffer.from(stored.hash, 'base64')
  const salt = Buffer.from(stored.salt, 'base64')
  const actual = pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, 'sha256')
  // Lengths must match before timingSafeEqual - it throws otherwise.
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}
