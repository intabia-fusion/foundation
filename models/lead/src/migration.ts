//
// Copyright © 2023 Hardcore Engineering Inc.
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

import { DOMAIN_MODEL_TX, TxOperations, type Ref, type Status } from '@hcengineering/core'
import { leadId, type Lead } from '@hcengineering/lead'
import {
  findCachedSpace,
  tryMigrate,
  tryUpgrade,
  type MigrateOperation,
  type MigrationClient,
  type MigrationUpgradeClient,
  type ModelLogger
} from '@hcengineering/model'
import core, { DOMAIN_SPACE } from '@hcengineering/model-core'
import { DOMAIN_CONTACT } from '@hcengineering/model-contact'
import task, {
  createSequence,
  DOMAIN_TASK,
  migrateDefaultStatusesBase,
  migrateTaskTypesToClasses
} from '@hcengineering/model-task'

import lead from './plugin'
import { defaultLeadStatuses } from './spaceType'

async function createSpace (tx: TxOperations, client: MigrationUpgradeClient): Promise<void> {
  const current = await findCachedSpace(client, lead.space.DefaultFunnel)
  if (current === undefined) {
    await tx.createDoc(
      lead.class.Funnel,
      core.space.Space,
      {
        name: 'Funnel',
        description: 'Default funnel',
        private: false,
        archived: false,
        members: [],
        type: lead.template.DefaultFunnel
      },
      lead.space.DefaultFunnel
    )
  }
}

async function createDefaults (tx: TxOperations, client: MigrationUpgradeClient): Promise<void> {
  await createSpace(tx, client)
  await createSequence(tx, lead.class.Lead)
}

async function migrateIdentifiers (client: MigrationClient): Promise<void> {
  const docs = await client.find<Lead>(DOMAIN_TASK, { _class: lead.class.Lead, identifier: { $exists: false } })
  for (const doc of docs) {
    await client.update(
      DOMAIN_TASK,
      { _id: doc._id },
      {
        identifier: `LEAD-${doc.number}`
      }
    )
  }
}

async function migrateDefaultStatuses (client: MigrationClient, logger: ModelLogger): Promise<void> {
  const defaultTypeId = lead.template.DefaultFunnel
  const typeDescriptor = lead.descriptors.FunnelType
  const baseClass = lead.class.Funnel
  const defaultTaskTypeId = lead.taskType.Lead
  const taskTypeClass = task.class.TaskType
  const baseTaskClass = lead.class.Lead
  const statusAttributeOf = lead.attribute.State
  const statusClass = core.class.Status
  const getDefaultStatus = (oldStatus: Status): Ref<Status> | undefined => {
    return defaultLeadStatuses.find(
      (defStatus) =>
        defStatus.category === oldStatus.category &&
        (defStatus.name.toLowerCase() === oldStatus.name.trim().toLowerCase() ||
          (defStatus.name === 'Negotiation' && oldStatus.name === 'Negotation'))
    )?.id
  }

  await migrateDefaultStatusesBase<Lead>(
    client,
    logger,
    defaultTypeId,
    typeDescriptor,
    baseClass,
    defaultTaskTypeId,
    taskTypeClass,
    baseTaskClass,
    statusAttributeOf,
    statusClass,
    getDefaultStatus
  )
}

async function migrateDefaultTypeMixins (client: MigrationClient): Promise<void> {
  const oldSpaceTypeMixin = `${lead.template.DefaultFunnel}:type:mixin`
  const newSpaceTypeMixin = lead.mixin.DefaultFunnelTypeData
  const oldTaskTypeMixin = `${lead.taskType.Lead}:type:mixin`
  const newTaskTypeMixin = 'lead:mixin:LeadTypeData' as any

  await client.update(
    DOMAIN_MODEL_TX,
    {
      objectClass: core.class.Attribute,
      'attributes.attributeOf': oldSpaceTypeMixin
    },
    {
      'attributes.attributeOf': newSpaceTypeMixin
    }
  )

  await client.update(
    DOMAIN_SPACE,
    {
      _class: lead.class.Funnel,
      [oldSpaceTypeMixin]: { $exists: true }
    },
    {
      $rename: {
        [oldSpaceTypeMixin]: newSpaceTypeMixin
      }
    }
  )

  await client.update(
    DOMAIN_TASK,
    {
      _class: lead.class.Lead,
      [oldTaskTypeMixin]: { $exists: true }
    },
    {
      $rename: {
        [oldTaskTypeMixin]: newTaskTypeMixin
      }
    }
  )
}

async function migrateLeadTaskTypesToClasses (client: MigrationClient): Promise<void> {
  await migrateTaskTypesToClasses(client, lead.taskType.Lead, 'lead:mixin:LeadTypeData' as any, lead.class.LeadTaskType)
}

export const leadOperation: MigrateOperation = {
  async preMigrate (client: MigrationClient, logger: ModelLogger, mode): Promise<void> {
    await tryMigrate(mode, client, leadId, [
      {
        state: 'migrate-default-statuses',
        func: (client) => migrateDefaultStatuses(client, logger)
      }
    ])
  },
  async migrate (client: MigrationClient, mode): Promise<void> {
    await tryMigrate(mode, client, leadId, [
      {
        state: 'identifier',
        mode: 'upgrade',
        func: migrateIdentifiers
      },
      {
        state: 'migrate-default-type-mixins',
        func: async (client) => {
          await migrateDefaultTypeMixins(client)
        }
      },
      {
        state: 'migrate-customer-description',
        mode: 'upgrade',
        func: async (client) => {
          await client.update(
            DOMAIN_CONTACT,
            {
              [lead.mixin.Customer + '.description']: { $exists: true }
            },
            {
              $rename: {
                [lead.mixin.Customer + '.description']: lead.mixin.Customer + '.customerDescription'
              }
            }
          )
        }
      },
      {
        state: 'migrateTaskTypesToClasses-v6',
        mode: 'upgrade',
        func: migrateLeadTaskTypesToClasses
      }
    ])
  },
  async upgrade (state: Map<string, Set<string>>, client: () => Promise<MigrationUpgradeClient>, mode): Promise<void> {
    await tryUpgrade(mode, state, client, leadId, [
      {
        state: 'u-default-funnel',
        func: async (client) => {
          const ops = new TxOperations(client, core.account.System)
          await createDefaults(ops, client)
        }
      }
    ])
  }
}
