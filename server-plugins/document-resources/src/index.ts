//
// Copyright © 2024 Hardcore Engineering Inc.
//
//

import { Class, Doc, DocumentQuery, FindOptions, FindResult, Hierarchy, Ref, concatLink } from '@hcengineering/core'
import document, { Document, documentId } from '@hcengineering/document'
import { getMetadata } from '@hcengineering/platform'
import { workbenchId } from '@hcengineering/workbench'
import serverCore from '@hcengineering/server-core'
import slugify from 'slugify'
import { StringPresenterFn, PresenterControl } from '@hcengineering/server-activity'

function getDocumentId (doc: Document): string {
  const slug = slugify(doc.title, { lower: true })
  return `${slug}-${doc._id}`
}

/**
 * @public
 */
const documentUrlPresenter: StringPresenterFn<Document> = async (
  doc: Document,
  control: PresenterControl
): Promise<string> => {
  const front = control.branding?.front ?? getMetadata(serverCore.metadata.FrontUrl) ?? ''
  const path = `${workbenchId}/${control.workspace.url}/${documentId}/${getDocumentId(doc)}`
  return concatLink(front, path)
}

const documentLinkIdProvider: StringPresenterFn<Document> = async (doc: Document): Promise<string> => {
  return getDocumentId(doc)
}

/**
 * @public
 */
export async function findChildDocuments (
  doc: Doc,
  hiearachy: Hierarchy,
  findAll: <T extends Doc>(
    clazz: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: FindOptions<T>
  ) => Promise<FindResult<T>>
): Promise<Doc[]> {
  return await findAll(document.class.Document, { parent: doc._id as Ref<Document> })
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export default async () => ({
  function: {
    DocumentUrlPresenter: documentUrlPresenter,
    DocumentLinkIdProvider: documentLinkIdProvider,
    FindChildDocuments: findChildDocuments
  }
})
