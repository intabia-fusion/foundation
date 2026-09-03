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

import { type Doc, type Ref } from '@hcengineering/core'
import { type Editor } from '@tiptap/core'
import { derived, get, writable, type Readable } from 'svelte/store'

// Mounted collaborative editors keyed by (objectId, attribute), for code outside the editor to reach one.
// A store, not a plain Map: a component showing "open the document" has to learn when one mounts.
const editors = writable(new Map<string, Editor>())

function editorKey (objectId: Ref<Doc>, attr: string): string {
  return `${objectId}:${attr}`
}

export function registerEditor (objectId: Ref<Doc>, attr: string, editor: Editor): void {
  editors.update((map) => new Map(map).set(editorKey(objectId, attr), editor))
}

export function unregisterEditor (objectId: Ref<Doc>, attr: string): void {
  editors.update((map) => {
    const next = new Map(map)
    next.delete(editorKey(objectId, attr))
    return next
  })
}

/** The mounted editor for an object's attribute, or undefined when the document is not open. */
export function getRegisteredEditor (objectId: Ref<Doc>, attr: string): Editor | undefined {
  return get(editors).get(editorKey(objectId, attr))
}

/** Same lookup, but reactive: emits when that editor mounts or unmounts. */
export function registeredEditor (objectId: Ref<Doc>, attr: string): Readable<Editor | undefined> {
  return derived(editors, (map) => map.get(editorKey(objectId, attr)))
}
