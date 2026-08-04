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

// Registry of currently mounted collaborative editors, keyed by (objectId, attribute).
// Lets code outside the editor (e.g. the AI edit-proposal message presenter) reach an open
// document's editor to apply a change into the user's own undo stack. Cleared on unmount.
const editors = new Map<string, Editor>()

function editorKey (objectId: Ref<Doc>, attr: string): string {
  return `${objectId}:${attr}`
}

export function registerEditor (objectId: Ref<Doc>, attr: string, editor: Editor): void {
  editors.set(editorKey(objectId, attr), editor)
}

export function unregisterEditor (objectId: Ref<Doc>, attr: string): void {
  editors.delete(editorKey(objectId, attr))
}

/** The mounted editor for an object's attribute, or undefined when the document is not open. */
export function getRegisteredEditor (objectId: Ref<Doc>, attr: string): Editor | undefined {
  return editors.get(editorKey(objectId, attr))
}
