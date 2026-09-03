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
import { registerEditor, registeredEditor, unregisterEditor } from '../editorRegistry'

const objectId = 'doc-1' as Ref<Doc>
const editor = {} as unknown as Editor

describe('editor registry', () => {
  it('notifies subscribers when an editor mounts and unmounts', () => {
    const seen: boolean[] = []
    const stop = registeredEditor(objectId, 'content').subscribe((e) => seen.push(e !== undefined))
    registerEditor(objectId, 'content', editor)
    unregisterEditor(objectId, 'content')
    stop()
    expect(seen).toEqual([false, true, false])
  })

  it('ignores an editor mounted for another attribute', () => {
    const seen: boolean[] = []
    const stop = registeredEditor(objectId, 'content').subscribe((e) => seen.push(e !== undefined))
    registerEditor(objectId, 'description', editor)
    stop()
    unregisterEditor(objectId, 'description')
    expect(seen).toEqual([false])
  })
})
