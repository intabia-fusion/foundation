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

import { uncompress } from 'snappyjs'

import { adminFetch } from '../../utils'

// Browsers forbid the standard Accept-Encoding header on fetch(),
// so we use a custom one that pods/stats recognises.
const ACCEPT_HEADER: HeadersInit = { 'X-Accept-Encoding': 'snappy' }

// GET a JSON resource from the stats service. If the server replies with
// X-Encoding: snappy, transparently decompress before parsing.
// Pass `signal` to cancel an in-flight fetch when starting a new one.
export async function fetchStatsJson<T> (url: string, signal?: AbortSignal): Promise<T> {
  const res = await adminFetch(url, { headers: ACCEPT_HEADER, signal })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`stats ${res.status} ${res.statusText}${body !== '' ? `: ${body.slice(0, 200)}` : ''}`)
  }
  if ((res.headers.get('x-encoding') ?? '').toLowerCase() === 'snappy') {
    const buf = await res.arrayBuffer()
    const decompressed = uncompress(buf)
    return JSON.parse(new TextDecoder().decode(decompressed)) as T
  }
  return (await res.json()) as T
}
