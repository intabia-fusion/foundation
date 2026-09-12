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

import { randomUUID } from 'crypto'
import type { CapturedDelivery } from './types'

const MAX_ITEMS = 200

// In-memory, single process, newest first - a dev tool, no need to survive a restart.
export class DeliveryStore {
  private readonly items: CapturedDelivery[] = []

  add (headers: Record<string, string>, rawBody: string): CapturedDelivery {
    const item: CapturedDelivery = { id: randomUUID(), receivedAt: Date.now(), headers, rawBody }
    this.items.unshift(item)
    this.items.length = Math.min(this.items.length, MAX_ITEMS)
    return item
  }

  list (): CapturedDelivery[] {
    return this.items
  }

  get (id: string): CapturedDelivery | undefined {
    return this.items.find((item) => item.id === id)
  }

  clear (): void {
    this.items.length = 0
  }
}
