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

const root = globalThis as Record<string, any>

// Window alias so browser-targeted modules evaluate cleanly in Node
root.window = root

// Unref background timers (e.g. presentation memory sampler) so Jest exits immediately
function unrefTimer (origFn: (...args: any[]) => any): (...args: any[]) => any {
  return (fn: (...args: any[]) => void, ms?: number, ...args: any[]): any => {
    const timer = origFn(fn, ms, ...args)
    timer?.unref?.()
    return timer
  }
}

if (typeof root.setInterval === 'function') root.setInterval = unrefTimer(root.setInterval)
if (typeof root.setTimeout === 'function') root.setTimeout = unrefTimer(root.setTimeout)

// Disable BroadcastChannel so presentation drafts don't keep open MessagePort handles
delete root.BroadcastChannel

// Minimal DOM / Browser stubs
const noop = (): void => {}
const emptyObj = (): Record<string, unknown> => ({ style: {} })
const storageMock = { getItem: () => null, setItem: noop, removeItem: noop, clear: noop }

root.location = { pathname: '/', search: '', hash: '', href: 'http://localhost/' }
root.localStorage = storageMock
root.sessionStorage = storageMock
root.addEventListener = noop
root.removeEventListener = noop
root.dispatchEvent = () => true
root.getComputedStyle = () => ({ getPropertyValue: () => '', fontSize: '16px' })
root.document = {
  documentElement: { style: {} },
  body: { style: {} },
  createElement: emptyObj,
  createElementNS: emptyObj,
  createTextNode: emptyObj,
  createDocumentFragment: () => ({ appendChild: noop }),
  addEventListener: noop,
  removeEventListener: noop
}
