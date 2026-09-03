//
// Copyright © 2020, 2021 Anticrm Platform Contributors.
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
  type Attribute,
  type Class,
  type ClassCollaborators,
  type Collaborator,
  type Data,
  type Doc,
  DOMAIN_BENCHMARK,
  DOMAIN_BLOB,
  DOMAIN_CONFIGURATION,
  DOMAIN_MIGRATION,
  DOMAIN_SPACE,
  DOMAIN_STATUS,
  DOMAIN_TRANSIENT,
  DOMAIN_TX,
  type IndexingConfiguration,
  type Ref
} from '@hcengineering/core'
import { type Builder, Collection } from '@hcengineering/model'
import { TBenchmarkDoc } from './benchmark'
import core from './component'
import {
  TArrOf,
  TAssociation,
  TAttachedDoc,
  TAttribute,
  TBlob,
  TClass,
  TClassCollaborators,
  TCollaborator,
  TCollection,
  TConfiguration,
  TConfigurationElement,
  TCustomSequence,
  TDoc,
  TDomainIndexConfiguration,
  TEnum,
  TEnumOf,
  TFullTextSearchContext,
  TIndexConfiguration,
  TInterface,
  TMigrationState,
  TMixin,
  TObj,
  TPluginConfiguration,
  TRefTo,
  TRelation,
  TRelationMetadata,
  TSequence,
  TTransientConfiguration,
  TTTransientTTL,
  TType,
  TTypeAccountUuid,
  TTypeAny,
  TTypeBlob,
  TTypeBoolean,
  TTypeCollaborativeDoc,
  TTypeDate,
  TTypeFileSize,
  TTypeHyperlink,
  TTypeIdentifier,
  TTypeIntlString,
  TTypeMarkup,
  TTypeNumber,
  TTypePersonId,
  TTypeRank,
  TTypeRecord,
  TTypeRelatedDocument,
  TTypeString,
  TTypeTimestamp,
  TVersion,
  TVersionableClass
} from './core'
import { definePermissions } from './permissions'
import {
  TAttributePermission,
  TClassPermission,
  TPermission,
  TRole,
  TSpace,
  TSpaceType,
  TSpaceTypeDescriptor,
  TSystemSpace,
  TTypedSpace
} from './security'
import { defineSpaceType } from './spaceType'
import { TDomainStatusPlaceholder, TStatus, TStatusCategory } from './status'
import { TUserStatus } from './transient'
import { TTx, TTxApplyIf, TTxCreateDoc, TTxCUD, TTxMixin, TTxRemoveDoc, TTxUpdateDoc, TTxWorkspaceEvent } from './tx'

export { coreId, DOMAIN_SPACE } from '@hcengineering/core'
export * from './core'
export {
  coreOperation,
  getAccountsFromTxes,
  getAccountUuidByOldAccount,
  getAccountUuidBySocialKey,
  getSocialIdBySocialKey,
  getSocialIdFromOldAccount,
  getSocialKeyByOldAccount,
  getSocialKeyByOldEmail,
  getUniqueAccounts,
  getUniqueAccountsFromOldAccounts
} from './migration'
export * from './security'
export * from './status'
export * from './tx'
export { core as default }

export function createModel (builder: Builder): void {
  builder.createModel(
    TObj,
    TDoc,
    TClass,
    TMixin,
    TInterface,
    TTx,
    TTxCUD,
    TTxCreateDoc,
    TAttachedDoc,
    TTxMixin,
    TTxUpdateDoc,
    TTxRemoveDoc,
    TTxApplyIf,
    TTxWorkspaceEvent,
    TSpace,
    TSystemSpace,
    TTypedSpace,
    TSpaceType,
    TSpaceTypeDescriptor,
    TRole,
    TPermission,
    TAttributePermission,
    TClassPermission,
    TAttribute,
    TType,
    TEnumOf,
    TTypeMarkup,
    TTypePersonId,
    TTypeAccountUuid,
    TTypeCollaborativeDoc,
    TArrOf,
    TRefTo,
    TTypeDate,
    TTypeFileSize,
    TTypeTimestamp,
    TTypeNumber,
    TTypeIdentifier,
    TTypeBoolean,
    TTypeString,
    TTypeRank,
    TTypeRecord,
    TTypeBlob,
    TTypeHyperlink,
    TCollection,
    TVersion,
    TTypeIntlString,
    TPluginConfiguration,
    TUserStatus,
    TEnum,
    TTypeAny,
    TTypeRelatedDocument,
    TFullTextSearchContext,
    TConfiguration,
    TConfigurationElement,
    TIndexConfiguration,
    TStatus,
    TSequence,
    TCustomSequence,
    TDomainStatusPlaceholder,
    TStatusCategory,
    TMigrationState,
    TBlob,
    TRelation,
    TRelationMetadata,
    TAssociation,
    TDomainIndexConfiguration,
    TBenchmarkDoc,
    TTransientConfiguration,
    TClassCollaborators,
    TCollaborator,
    TVersionableClass,
    TTTransientTTL
  )

  builder.createDoc(core.class.DomainIndexConfiguration, core.space.Model, {
    domain: DOMAIN_TX,
    disabled: [
      { _class: 1 },
      { space: 1 },
      { objectClass: 1 },
      { createdBy: 1 },
      { createdBy: -1 },
      { createdOn: -1 },
      { modifiedBy: 1 }
    ],
    indexes: [
      {
        keys: {
          objectSpace: 1
        }
      }
    ]
  })

  builder.createDoc(core.class.DomainIndexConfiguration, core.space.Model, {
    domain: DOMAIN_TRANSIENT,
    disableCollection: true,
    disabled: [
      { _id: 1 },
      { space: 1 },
      { objectClass: 1 },
      { modifiedBy: 1 },
      { createdBy: 1 },
      { createdBy: -1 },
      { createdOn: -1 }
    ]
  })

  builder.mixin<Class<Collaborator>, IndexingConfiguration<Collaborator>>(
    core.class.Collaborator,
    core.class.Class,
    core.mixin.IndexConfiguration,
    {
      searchDisabled: true,
      indexes: []
    }
  )

  builder.createDoc(core.class.DomainIndexConfiguration, core.space.Model, {
    domain: DOMAIN_BENCHMARK,
    disableCollection: true,
    disabled: []
  })

  builder.createDoc(core.class.DomainIndexConfiguration, core.space.Model, {
    domain: DOMAIN_CONFIGURATION,
    disabled: [
      { _class: 1 },
      { space: 1 },
      { modifiedOn: 1 },
      { modifiedBy: 1 },
      { createdBy: 1 },
      { createdBy: -1 },
      { createdOn: -1 }
    ]
  })

  builder.createDoc(core.class.DomainIndexConfiguration, core.space.Model, {
    domain: DOMAIN_MIGRATION,
    disabled: [
      { _class: 1 },
      { space: 1 },
      { modifiedOn: 1 },
      { modifiedBy: 1 },
      { createdBy: 1 },
      { createdBy: -1 },
      { createdOn: -1 }
    ]
  })

  builder.createDoc(core.class.DomainIndexConfiguration, core.space.Model, {
    domain: DOMAIN_STATUS,
    disabled: [
      { modifiedOn: 1 },
      { modifiedBy: 1 },
      { createdBy: 1 },
      { createdBy: -1 },
      { createdOn: -1 },
      { space: 1 }
    ]
  })
  builder.createDoc(core.class.DomainIndexConfiguration, core.space.Model, {
    domain: DOMAIN_SPACE,
    disabled: [{ space: 1 }, { modifiedBy: 1 }, { createdBy: 1 }, { createdBy: -1 }, { createdOn: -1 }]
  })

  builder.createDoc(core.class.DomainIndexConfiguration, core.space.Model, {
    domain: DOMAIN_BLOB,
    disabled: [
      { _class: 1 },
      { space: 1 },
      { modifiedBy: 1 },
      { createdBy: 1 },
      { createdBy: -1 },
      { createdOn: -1 },
      { modifiedOn: 1 }
    ]
  })

  builder.createDoc(core.class.FullTextSearchContext, core.space.Model, {
    toClass: core.class.Space
  })

  definePermissions(builder)
  defineSpaceType(builder)

  builder.createDoc(core.class.FullTextSearchContext, core.space.Model, {
    toClass: core.class.MigrationState,
    forceIndex: false
  })
  builder.mixin(core.class.Configuration, core.class.Class, core.mixin.IndexConfiguration, {
    indexes: [],
    searchDisabled: true
  })
  builder.mixin(core.class.MigrationState, core.class.Class, core.mixin.IndexConfiguration, {
    indexes: [],
    searchDisabled: true
  })
}

export function defineCollaborators<T extends Doc> (
  builder: Builder,
  _class: Ref<Class<T>>,
  data: Omit<Data<ClassCollaborators<T>>, 'attachedTo'>
): void {
  builder.createDoc<ClassCollaborators<T>>(core.class.ClassCollaborators, core.space.Model, {
    attachedTo: _class,
    ...data
  })

  builder.createDoc(
    core.class.Attribute,
    core.space.Model,
    {
      name: 'collaborators',
      attributeOf: _class,
      type: Collection(core.class.Collaborator),
      label: core.string.Collaborators,
      activity: {
        set: core.string.AddedCollaborator,
        unset: core.string.RemovedCollaborator
      },
      rank: ''
    },
    `${_class}_collaborators` as Ref<Attribute<T>>
  )
}
