//
// Copyright © 2020, 2021 Anticrm Platform Contributors.
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
  type MigrateOperation,
  type MigrateUpdate,
  type MigrationClient,
  type MigrationDocumentQuery,
  type MigrationUpgradeClient,
  tryMigrate
} from '@hcengineering/model'
import { DOMAIN_PREFERENCE } from '@hcengineering/preference'
import view, { type Filter, type FilteredView, type Viewlet, type ViewletPreference, viewId } from '@hcengineering/view'
import { getSocialIdFromOldAccount, getSocialKeyByOldAccount, getUniqueAccounts } from '@hcengineering/model-core'
import core, {
  type AccountUuid,
  type Class,
  type Doc,
  type PersonId,
  type Ref,
  DOMAIN_MODEL
} from '@hcengineering/core'

import { DOMAIN_VIEW } from '.'

async function removeDoneStatePref (client: MigrationClient): Promise<void> {
  const prefs = await client.find<ViewletPreference>(DOMAIN_PREFERENCE, {
    _class: view.class.ViewletPreference,
    config: 'doneState'
  })
  for (const pref of prefs) {
    await client.update(DOMAIN_PREFERENCE, { _id: pref._id }, { config: pref.config.filter((p) => p !== 'doneState') })
  }
  const lookupPrefs = await client.find<ViewletPreference>(DOMAIN_PREFERENCE, {
    _class: view.class.ViewletPreference,
    config: '$lookup.doneState'
  })
  for (const pref of lookupPrefs) {
    await client.update(
      DOMAIN_PREFERENCE,
      { _id: pref._id },
      { config: pref.config.filter((p) => p !== '$lookup.doneState') }
    )
  }
}

async function removeDoneStateFilter (client: MigrationClient): Promise<void> {
  const filters = await client.find<FilteredView>(DOMAIN_VIEW, {
    _class: view.class.FilteredView
  })
  for (const filter of filters) {
    let changed = false
    const options = filter.viewOptions
    if (options != null) {
      if (options.orderBy[0] === 'doneState') {
        options.orderBy[0] = 'status'
        changed = true
      }
      if (options.groupBy.includes('doneState')) {
        changed = true
        options.groupBy = options.groupBy.filter((g) => g !== 'doneState')
        if (options.groupBy.length === 0) {
          options.groupBy[0] = 'status'
        }
      }
    }
    let filters = JSON.parse(filter.filters) as Filter[]
    const initLength = filters.length
    filters = filters.filter((p) => p.key.key !== 'doneState')
    if (initLength !== filters.length) {
      changed = true
    }
    if (changed) {
      await client.update(DOMAIN_VIEW, { _id: filter._id }, { viewOptions: options, filters: JSON.stringify(filters) })
    }
  }
}

async function migrateAccountsToSocialIds (client: MigrationClient): Promise<void> {
  const socialKeyByAccount = await getSocialKeyByOldAccount(client)

  client.logger.log('processing view filtered view users ', {})
  const iterator = await client.traverse(DOMAIN_VIEW, { _class: view.class.FilteredView })

  try {
    let processed = 0
    while (true) {
      const docs = await iterator.next(200)
      if (docs === null || docs.length === 0) {
        break
      }

      const operations: { filter: MigrationDocumentQuery<FilteredView>, update: MigrateUpdate<FilteredView> }[] = []

      for (const doc of docs) {
        const filteredView = doc as FilteredView

        if (filteredView.users === undefined || filteredView.users.length === 0) continue

        const newUsers = filteredView.users.map((u) => socialKeyByAccount[u] ?? u)

        operations.push({
          filter: { _id: filteredView._id },
          update: {
            users: newUsers as any
          }
        })
      }

      if (operations.length > 0) {
        await client.bulk(DOMAIN_VIEW, operations)
      }

      processed += docs.length
      client.logger.log('...processed', { count: processed })
    }
  } finally {
    await iterator.close()
  }
  client.logger.log('finished processing view filtered view users ', {})
}

async function migrateSocialIdsToGlobalAccounts (client: MigrationClient): Promise<void> {
  const accountUuidBySocialKey = new Map<string, AccountUuid | null>()

  client.logger.log('processing view filtered view users ', {})
  const iterator = await client.traverse(DOMAIN_VIEW, { _class: view.class.FilteredView })

  try {
    let processed = 0
    while (true) {
      const docs = await iterator.next(200)
      if (docs === null || docs.length === 0) {
        break
      }

      const operations: { filter: MigrationDocumentQuery<FilteredView>, update: MigrateUpdate<FilteredView> }[] = []

      for (const doc of docs) {
        const filteredView = doc as FilteredView

        if (filteredView.users === undefined || filteredView.users.length === 0) continue

        const newUsers = await getUniqueAccounts(client, filteredView.users, accountUuidBySocialKey)

        operations.push({
          filter: { _id: filteredView._id },
          update: {
            users: newUsers
          }
        })
      }

      if (operations.length > 0) {
        await client.bulk(DOMAIN_VIEW, operations)
      }

      processed += docs.length
      client.logger.log('...processed', { count: processed })
    }
  } finally {
    await iterator.close()
  }
  client.logger.log('finished processing view filtered view users ', {})
}

async function migrateAccsInSavedFilters (client: MigrationClient): Promise<void> {
  const hierarchy = client.hierarchy
  const socialKeyByAccount = await getSocialKeyByOldAccount(client)
  const socialIdBySocialKey = new Map<string, PersonId | null>()
  const socialIdByOldAccount = new Map<string, PersonId | null>()

  client.logger.log('processing view filtered view accounts in filters ', {})
  const affectedViews = await client.find<FilteredView>(DOMAIN_VIEW, {
    _class: view.class.FilteredView,
    filters: { $regex: '%core:class:Account%' }
  })
  for (const view of affectedViews) {
    const filters = JSON.parse(view.filters)
    const newFilters = []
    let needUpdate = false
    for (const filter of filters) {
      const key = filter?.key
      if (key == null) {
        newFilters.push(filter)
        continue
      }

      const type = key.attribute?.type
      const objClass = key._class
      const objKey = key.key

      if (type == null || objClass == null || objKey == null) {
        newFilters.push(filter)
        continue
      }

      if (type._class !== 'core:class:RefTo' || type.to !== 'core:class:Account') {
        newFilters.push(filter)
        continue
      }

      const newAttrType = hierarchy.getAttribute(objClass, objKey)

      if (newAttrType.type._class !== core.class.TypePersonId) {
        newFilters.push(filter)
        continue
      }

      const newFilter = { ...filter }
      newFilter.key.attribute.type = {
        _class: newAttrType.type._class,
        label: newAttrType.type.label
      }
      const oldValue = newFilter.value
      newFilter.value = []
      for (const accId of oldValue) {
        const socialId = await getSocialIdFromOldAccount(
          client,
          accId,
          socialKeyByAccount,
          socialIdBySocialKey,
          socialIdByOldAccount
        )

        newFilter.value.push(socialId ?? accId)
      }

      newFilters.push(newFilter)
      needUpdate = true
    }

    if (needUpdate) {
      await client.update(DOMAIN_VIEW, { _id: view._id }, { filters: JSON.stringify(newFilters) })
    }
  }

  client.logger.log('finished processing view filtered view accounts in filters ', {})
}

async function cleanupCustomAttributesPref (client: MigrationClient): Promise<void> {
  const hierarchy = client.hierarchy
  client.logger.log('processing cleanup of non-existent customAttributes in viewlet preferences', {})

  const prefs = await client.find<ViewletPreference>(DOMAIN_PREFERENCE, {
    _class: view.class.ViewletPreference
  })

  const modelViewlets = client.model.findAllSync<Viewlet>(view.class.Viewlet, {})
  const dbViewlets = await client.find<Viewlet>(DOMAIN_MODEL, {
    _class: view.class.Viewlet
  })

  const viewletAttachMap = new Map<Ref<Viewlet>, Ref<Class<Doc>>>()
  for (const v of modelViewlets) {
    if (v._id != null && v.attachTo != null) {
      viewletAttachMap.set(v._id, v.attachTo)
    }
  }
  for (const v of dbViewlets) {
    if (v._id != null && v.attachTo != null) {
      viewletAttachMap.set(v._id, v.attachTo)
    }
  }

  for (const pref of prefs) {
    if (pref.customAttributes == null || pref.customAttributes.length === 0) continue

    let attachTo = viewletAttachMap.get(pref.attachedTo)
    if (attachTo === undefined && hierarchy.hasClass(pref.attachedTo as unknown as Ref<Class<Doc>>)) {
      attachTo = pref.attachedTo as unknown as Ref<Class<Doc>>
    }

    if (attachTo === undefined) continue

    const validCustomAttributes = pref.customAttributes.filter((key) => {
      const pos = key.lastIndexOf('.')
      if (pos !== -1) {
        const mixinClass = key.substring(0, pos) as Ref<Class<Doc>>
        const attrName = key.substring(pos + 1)
        return hierarchy.findAttribute(mixinClass, attrName) !== undefined
      }
      return hierarchy.findAttribute(attachTo, key) !== undefined
    })

    if (validCustomAttributes.length !== pref.customAttributes.length) {
      await client.update(
        DOMAIN_PREFERENCE,
        { _id: pref._id },
        { customAttributes: validCustomAttributes.length > 0 ? validCustomAttributes : undefined }
      )
    }
  }
}

export const viewOperation: MigrateOperation = {
  async migrate (client: MigrationClient, mode): Promise<void> {
    await tryMigrate(mode, client, viewId, [
      {
        state: 'remove-done-state-pref',
        mode: 'upgrade',
        func: removeDoneStatePref
      },
      {
        state: 'remove-done-state-filter',
        mode: 'upgrade',
        func: removeDoneStateFilter
      },
      {
        state: 'accounts-to-social-ids',
        mode: 'upgrade',
        func: migrateAccountsToSocialIds
      },
      {
        state: 'social-ids-to-global-accounts',
        mode: 'upgrade',
        func: migrateSocialIdsToGlobalAccounts
      },
      {
        state: 'accs-in-saved-filters',
        mode: 'upgrade',
        func: migrateAccsInSavedFilters
      },
      {
        state: 'cleanup-non-existent-custom-attributes-v1',
        mode: 'upgrade',
        func: cleanupCustomAttributesPref
      }
    ])
  },
  async upgrade (state: Map<string, Set<string>>, client: () => Promise<MigrationUpgradeClient>): Promise<void> {}
}
