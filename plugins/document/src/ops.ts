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

import {
  type Blob,
  type CollaborativeDoc,
  type Data,
  type DocumentUpdate,
  generateId,
  makeCollabId,
  type Markup,
  type Ref,
  type TxOperations
} from '@hcengineering/core'
import { makeRank } from '@hcengineering/rank'
import { isEmptyMarkup } from '@hcengineering/text-core'
import { type IconProps } from '@hcengineering/view'

import document, { type Document, getFirstRank, type Teamspace } from '.'

/** Uploads markup and returns the resulting blob ref, e.g. `presentation.createMarkup` on the UI. */
export type UploadMarkup = (collabId: CollaborativeDoc, markup: Markup) => Promise<Ref<Blob>>

/** Input of the create-document helper. */
export interface NewDocument extends IconProps {
  title: string
  content?: Markup
  /** Already-uploaded content; when set, `createDocument` skips `uploadMarkup`. */
  contentRef?: Ref<Blob>
  parent?: Ref<Document>
}

/** Create a document (with ready-made content), same fields as the create-document dialog. */
export async function createDocument (
  client: TxOperations,
  teamspace: Ref<Teamspace>,
  data: NewDocument,
  uploadMarkup?: UploadMarkup,
  id?: Ref<Document>
): Promise<Ref<Document>> {
  const parent = data.parent ?? document.ids.NoParent
  const lastRank = await getFirstRank(client, teamspace, parent)
  const _id = id ?? generateId<Document>()

  const value: Data<Document> = {
    title: data.title,
    content: null,
    parent,
    rank: makeRank(lastRank, undefined),
    attachments: 0,
    embeddings: 0,
    labels: 0,
    comments: 0,
    references: 0,
    icon: data.icon,
    color: data.color
  }

  if (data.contentRef !== undefined) {
    value.content = data.contentRef
  } else if (data.content !== undefined && !isEmptyMarkup(data.content)) {
    if (uploadMarkup === undefined) {
      throw new Error('uploadMarkup is required to create a document with content')
    }
    value.content = await uploadMarkup(makeCollabId(document.class.Document, _id, 'content'), data.content)
  }

  await client.createDoc(document.class.Document, teamspace, value, _id)
  return _id
}

/** Input of the document-update helper. */
export interface DocumentUpdateData {
  title?: string
  content?: Markup
  /** Already-uploaded content; when set, `updateDocument` skips `uploadMarkup`. */
  contentRef?: Ref<Blob>
}

/** Update a document's title and/or content, same fields as the document header/editor. */
export async function updateDocument (
  client: TxOperations,
  doc: Document,
  data: DocumentUpdateData,
  uploadMarkup?: UploadMarkup
): Promise<void> {
  const update: DocumentUpdate<Document> = {}
  if (data.title !== undefined) update.title = data.title
  if (data.contentRef !== undefined) {
    update.content = data.contentRef
  } else if (data.content !== undefined) {
    if (uploadMarkup === undefined) {
      throw new Error('uploadMarkup is required to update document content')
    }
    update.content = await uploadMarkup(makeCollabId(doc._class, doc._id, 'content'), data.content)
  }
  if (Object.keys(update).length === 0) return
  await client.update(doc, update)
}
