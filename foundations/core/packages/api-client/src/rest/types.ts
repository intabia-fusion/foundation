//
// Copyright © 2025 Hardcore Engineering Inc.
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
  AttachedData,
  AttachedDoc,
  Data,
  DocumentUpdate,
  FindResult,
  Mixin,
  MixinData,
  MixinUpdate,
  SearchOptions,
  SearchQuery,
  SearchResult,
  Space,
  Timestamp,
  Tx,
  TxResult,
  type Account,
  type Class,
  type Doc,
  type DocumentQuery,
  type DomainParams,
  type DomainRequestOptions,
  type DomainResult,
  type FindOptions,
  type Hierarchy,
  type ModelDb,
  type OperationDomain,
  type PersonId,
  type PersonUuid,
  type Ref,
  type SocialIdType,
  type TxMeta,
  type WithLookup
} from '@hcengineering/core'
import type { MarkupFormat, MarkupRef } from '../markup'

/**
 * A list of client operations to perform on.
 */
export interface ClientOperations {
  //
  /// Low level operations
  //
  /**
   * Find some documents based on class.
   *
   * core.class.Doc is not allowed to be used.
   *
   * Will also return a model document, by request to server.
   */
  findAll: <T extends Doc>(
    _class: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: FindOptions<T>
  ) => Promise<FindResult<T>>

  /**
   * A juice to find one document, will use findAll with limit=1
   */
  findOne: <T extends Doc>(
    _class: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: FindOptions<T>
  ) => Promise<WithLookup<T> | undefined>

  /**
   * Perform any of supported transactions on transactor.
   */
  tx: (tx: Tx) => Promise<TxResult>

  // High level operations
  // Server will use token account for modifiedBy if not specified.

  /**
   * Construct a new document, not attached one.
   * use addCollection to create attached document, it requires few extra params.
   */
  createDoc: <T extends Doc>(
    _class: Ref<Class<T>>,
    space: Ref<Space>,
    attributes: Data<T>,
    id?: Ref<T>,
    modifiedOn?: Timestamp,
    modifiedBy?: PersonId,
    meta?: TxMeta
  ) => Promise<Ref<T>>

  /**
   * Construct a new attached document.
   */
  addCollection: <T extends Doc, P extends AttachedDoc>(
    _class: Ref<Class<P>>,
    space: Ref<Space>,
    attachedTo: Ref<T>,
    attachedToClass: Ref<Class<T>>,
    collection: Extract<keyof T, string> | string,
    attributes: AttachedData<P>,
    id?: Ref<P>,
    modifiedOn?: Timestamp,
    modifiedBy?: PersonId,
    meta?: TxMeta
  ) => Promise<Ref<P>>

  /**
   * Update a document or collection document.
   */
  update: <T extends Doc>(
    doc: T,
    update: DocumentUpdate<T>,
    retrieve?: boolean,
    modifiedOn?: Timestamp,
    modifiedBy?: PersonId
  ) => Promise<TxResult>

  /**
   * Update a top-level document by class/space/id. Server routes to updateDoc/updateCollection
   * based on class hierarchy — no model required on client.
   */
  updateDoc: <T extends Doc>(
    _class: Ref<Class<T>>,
    space: Ref<Space>,
    objectId: Ref<T>,
    update: DocumentUpdate<T>,
    retrieve?: boolean,
    modifiedOn?: Timestamp,
    modifiedBy?: PersonId
  ) => Promise<TxResult>

  /**
   * Update an attached (collection) document by class/space/id + attachment info.
   */
  updateCollection: <T extends Doc, P extends AttachedDoc>(
    _class: Ref<Class<P>>,
    space: Ref<Space>,
    objectId: Ref<P>,
    attachedTo: Ref<T>,
    attachedToClass: Ref<Class<T>>,
    collection: Extract<keyof T, string> | string,
    update: DocumentUpdate<P>,
    retrieve?: boolean,
    modifiedOn?: Timestamp,
    modifiedBy?: PersonId
  ) => Promise<TxResult>

  /**
   * Remove a document or collection document.
   *
   * For documents be aware all collection documents attached will be removed as well.
   */
  remove: <T extends Doc>(doc: T, modifiedOn?: Timestamp, modifiedBy?: PersonId) => Promise<TxResult>

  /**
   * Remove a top-level document by class/space/id. Server routes to removeDoc/removeCollection.
   */
  removeDoc: <T extends Doc>(
    _class: Ref<Class<T>>,
    space: Ref<Space>,
    objectId: Ref<T>,
    modifiedOn?: Timestamp,
    modifiedBy?: PersonId
  ) => Promise<TxResult>

  /**
   * Remove an attached (collection) document by class/space/id + attachment info.
   */
  removeCollection: <T extends Doc, P extends AttachedDoc>(
    _class: Ref<Class<P>>,
    space: Ref<Space>,
    objectId: Ref<P>,
    attachedTo: Ref<T>,
    attachedToClass: Ref<Class<T>>,
    collection: Extract<keyof T, string> | string,
    modifiedOn?: Timestamp,
    modifiedBy?: PersonId
  ) => Promise<TxResult>

  createMixin: <D extends Doc, M extends D>(
    objectId: Ref<D>,
    objectClass: Ref<Class<D>>,
    objectSpace: Ref<Space>,
    mixin: Ref<Mixin<M>>,
    attributes: MixinData<D, M>,
    modifiedOn?: Timestamp,
    modifiedBy?: PersonId
  ) => Promise<TxResult>

  updateMixin: <D extends Doc, M extends D>(
    objectId: Ref<D>,
    objectClass: Ref<Class<D>>,
    objectSpace: Ref<Space>,
    mixin: Ref<Mixin<M>>,
    attributes: MixinUpdate<D, M>,
    modifiedOn?: Timestamp,
    modifiedBy?: PersonId
  ) => Promise<TxResult>
}

export interface EnsurePersonOptions {
  addGuestEmployee?: boolean
}

export interface RestClient extends ClientOperations {
  getAccount: () => Promise<Account>
  getModel: (full?: boolean) => Promise<{ hierarchy: Hierarchy, model: ModelDb }>
  ensurePerson: (
    socialType: SocialIdType,
    socialValue: string,
    firstName: string,
    lastName: string,
    options?: EnsurePersonOptions
  ) => Promise<{ uuid: PersonUuid, socialId: PersonId, localPerson: string }>

  /**
   * Perform a document request, not matching any transactions.
   */
  domainRequest: <T>(
    domain: OperationDomain,
    params: DomainParams,
    options?: DomainRequestOptions
  ) => Promise<DomainResult<T>>

  /**
   * Perform a full text search request.
   */
  searchFulltext: (query: SearchQuery, options: SearchOptions) => Promise<SearchResult>

  /**
   * Upload a markup value (markdown/html/markup JSON) to the collaborator service
   * and obtain a blob reference that can be stored in the document attribute.
   * Requires a collaborator endpoint (pass it when constructing the client).
   */
  uploadMarkup: (
    objectClass: Ref<Class<Doc>>,
    objectId: Ref<Doc>,
    objectAttr: string,
    markup: string,
    format: MarkupFormat
  ) => Promise<MarkupRef>

  /**
   * Fetch a markup value from the collaborator service by its blob reference
   * and return it in the requested format.
   */
  fetchMarkup: (
    objectClass: Ref<Class<Doc>>,
    objectId: Ref<Doc>,
    objectAttr: string,
    markup: MarkupRef,
    format: MarkupFormat
  ) => Promise<string>
}
