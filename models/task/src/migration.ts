//
// Copyright © 2022 Hardcore Engineering Inc.
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

import activity, { type DocUpdateMessage } from '@hcengineering/activity'
import {
  ClassifierKind,
  DOMAIN_MODEL_TX,
  DOMAIN_SEQUENCE,
  DOMAIN_STATUS,
  DOMAIN_TX,
  TxFactory,
  TxOperations,
  generateId,
  groupByArray,
  toIdMap,
  type Attribute,
  type Class,
  type Doc,
  type DocumentUpdate,
  type Domain,
  type Mixin,
  type Ref,
  type Space,
  type Status,
  type Tx,
  type TxCreateDoc,
  type TxCUD,
  type TxRemoveDoc,
  type TxUpdateDoc,
  TxProcessor
} from '@hcengineering/core'
import notification, { type MessageNotificationType } from '@hcengineering/notification'
import {
  createOrUpdate,
  migrateSpace,
  migrateSpaceRanks,
  tryMigrate,
  tryUpgrade,
  type MigrateOperation,
  type MigrationClient,
  type MigrationUpgradeClient,
  type ModelLogger,
  type MigrationDocumentQuery,
  type MigrateUpdate
} from '@hcengineering/model'
import { DOMAIN_ACTIVITY } from '@hcengineering/model-activity'
import core, { DOMAIN_SPACE } from '@hcengineering/model-core'
import tags from '@hcengineering/model-tags'
import {
  taskId,
  type Project,
  type ProjectStatus,
  type ProjectType,
  type ProjectTypeDescriptor,
  type Task,
  type TaskType
} from '@hcengineering/task'

import { DOMAIN_TASK } from '.'
import task from './plugin'

/**
 * @public
 */
export async function createSequence (tx: TxOperations, _class: Ref<Class<Doc>>): Promise<void> {
  if ((await tx.findOne(core.class.Sequence, { attachedTo: _class })) === undefined) {
    await tx.createDoc(core.class.Sequence, core.space.Workspace, {
      attachedTo: _class,
      sequence: 0
    })
  }
}

export async function migrateDefaultStatusesBase<T extends Task> (
  client: MigrationClient,
  logger: ModelLogger,
  defaultTypeId: Ref<ProjectType>,
  typeDescriptor: Ref<ProjectTypeDescriptor>,
  baseClass: Ref<Class<Space>>,
  defaultTaskTypeId: Ref<TaskType>,
  taskTypeClass: Ref<Class<TaskType>>,
  baseTaskClass: Ref<Class<T>>,
  statusAttributeOf: Ref<Attribute<Status>>,
  statusClass: Ref<Class<Status>>,
  getDefaultStatus: (oldStatus: Status) => Ref<Status> | undefined,
  migrateProjects?: (getNewStatus: (oldStatus: Ref<Status>) => Ref<Status>) => Promise<void>
): Promise<void> {
  const h = client.hierarchy
  const baseTaskClasses = h.getDescendants(baseTaskClass).filter((it) => !h.isMixin(it))

  let counter = 0
  // There are several cases possible based on the history of the workspace
  // 1. One system default type - pretty fresh or already migrated workspace.
  // Proceed with the regular scenario.
  // 2. One custom default type (modifiedBy user or ConfigUser) - migrated system type.
  // 2.a. If modified by ConfigUser - proceed with the regular scenario. Update to become modified by system.
  // 2.b. If modified by user - update to use the new ID of the type.
  // 3. More than one type (one system and one custom) - the tool is running after the WS upgrade.
  // Not supported for now. Alternatively - Proceed with (2) scenario for the custom one. Delete it in the end.

  const defaultTypes = await client.find<TxCreateDoc<ProjectType>>(DOMAIN_MODEL_TX, {
    _class: core.class.TxCreateDoc,
    objectId: defaultTypeId,
    objectSpace: core.space.Model,
    'attributes.descriptor': typeDescriptor
  })

  if (defaultTypes.length === 2) {
    logger.log('Are you running the tool after the workspace has been upgraded?', '')
    logger.error('NOT SUPPORTED. EXITING.', '')
    return
  } else if (defaultTypes.length === 0) {
    return // already migrated or custom - nothing to do
  }

  const defaultType = defaultTypes[0]
  logger.log('Default type', defaultType)

  if (defaultType.modifiedBy !== core.account.System) {
    let moveToCustom = false
    if (defaultType.modifiedBy === core.account.ConfigUser) {
      // Can only move to system if the task is with the system id
      // and not modified by user
      if (defaultType.attributes.tasks.length === 1 && defaultType.attributes.tasks[0] === defaultTaskTypeId) {
        const defaultTaskType = (
          await client.find<TxCreateDoc<TaskType>>(DOMAIN_MODEL_TX, {
            _class: core.class.TxCreateDoc,
            objectId: defaultTaskTypeId,
            objectSpace: core.space.Model,
            'attributes.parent': defaultTypeId
          })
        )[0]

        if (defaultTaskType?.modifiedBy === core.account.ConfigUser) {
          logger.log('Moving the existing default type created by ConfigUser to a system one', '')
          logger.log('Moving the existing default task type created by ConfigUser to a system one', '')
          await client.update(
            DOMAIN_MODEL_TX,
            { _id: defaultTaskType._id },
            {
              modifiedBy: core.account.System
            }
          )

          await client.update(
            DOMAIN_MODEL_TX,
            { _id: defaultType._id },
            {
              modifiedBy: core.account.System
            }
          )
        } else if (defaultTaskType?.modifiedBy !== core.account.System) {
          logger.log('Default task type has been modified by user.', '')
          logger.error('NOT SUPPORTED. EXITING.', '')
          return
        }
      } else {
        moveToCustom = true
      }
    }

    if (defaultType.modifiedBy !== core.account.ConfigUser || moveToCustom) {
      // modified by user
      // Update to use the new ID of the type if no default task type
      if (defaultType.attributes.tasks.includes(defaultTaskTypeId)) {
        logger.log('Default type has been modified by user and it contains default task type', '')
        logger.error('NOT SUPPORTED. EXITING.', '')
        return
      }

      logger.log('Moving the existing default type to a custom one', '')
      const newId = defaultType.objectId + '-custom'
      await client.update(
        DOMAIN_MODEL_TX,
        { _id: defaultType._id },
        {
          'attributes.name': defaultType.attributes.name + ' (custom)',
          objectId: newId
        }
      )
      await client.update(
        DOMAIN_MODEL_TX,
        {
          objectId: defaultType.objectId,
          objectSpace: core.space.Model
        },
        {
          objectId: newId
        }
      )
      await client.update(
        DOMAIN_MODEL_TX,
        {
          objectId: { $in: defaultType.attributes.tasks },
          objectSpace: core.space.Model,
          'attributes.parent': defaultTypeId
        },
        {
          'attributes.parent': newId
        }
      )
      await client.update(
        DOMAIN_SPACE,
        {
          _class: baseClass,
          type: defaultTypeId
        },
        {
          type: newId
        }
      )
    }
  }

  const statusClasses = h.getDescendants(core.class.Status).filter((it) => !h.isMixin(it))

  // Check all statuses that haven't been already migrated
  // Check statuses of specific attribute
  const oldStatusesSpecific = await client.find<Status>(DOMAIN_STATUS, {
    _class: { $in: statusClasses },
    ofAttribute: statusAttributeOf,
    __superseded: { $exists: false }
  })

  // Also, check all statuses in the projects with generic task attribute
  const projectTypes = await client.model.findAll<ProjectType>(task.class.ProjectType, {
    space: core.space.Model,
    descriptor: typeDescriptor
  })

  const projectStatuses = new Set<Ref<Status>>()

  for (const pt of projectTypes) {
    for (const status of pt.statuses) {
      projectStatuses.add(status._id)
    }
  }

  const oldStatusesGenericProjects = await client.find<Status>(DOMAIN_STATUS, {
    _class: { $in: statusClasses },
    _id: { $in: [...projectStatuses] },
    ofAttribute: task.attribute.State,
    __superseded: { $exists: false }
  })

  const oldStatuses = [...oldStatusesSpecific, ...oldStatusesGenericProjects]

  // Build statuses mapping oldId -> {category, newId}
  const statusMapping: Record<Ref<Status>, Ref<Status>> = {}
  for (const s of oldStatuses) {
    const defaultStatusId = getDefaultStatus(s)

    if (defaultStatusId === undefined || defaultStatusId === s._id) {
      continue
    }

    statusMapping[s._id] = defaultStatusId
  }

  logger.log('Status mapping', statusMapping)

  if (Object.entries(statusMapping).length === 0) {
    logger.log('All statuses have been already migrated or running on upgraded workspace', '')
    return
  }

  const statusIdsBeingMigrated = Object.keys(statusMapping) as Ref<Status>[]

  // Migration

  function getNewProjectStatus (status: ProjectStatus): ProjectStatus {
    const newId = statusMapping[status._id]

    if (newId === undefined) {
      return status
    }

    return { ...status, _id: newId }
  }

  function getNewStatus (status: Ref<Status>): Ref<Status> {
    return statusMapping[status] ?? status
  }

  // For project types with the same descriptor
  // 1. Update all create TXes with statuses
  // 1. Update all update TXes with statuses
  // 2. Update all push TXes with statuses

  const projectTypeStatusesCreates = await client.find<TxCreateDoc<ProjectType>>(DOMAIN_MODEL_TX, {
    _class: core.class.TxCreateDoc,
    objectClass: task.class.ProjectType,
    objectSpace: core.space.Model,
    'attributes.descriptor': typeDescriptor
  })

  logger.log('projectTypeStatusesCreates: ', projectTypeStatusesCreates.length)

  counter = 0
  for (const ptsCreate of projectTypeStatusesCreates) {
    const newUpdateStatuses = ptsCreate.attributes.statuses?.map(getNewProjectStatus)

    if (areSameArrays(newUpdateStatuses, ptsCreate.attributes.statuses)) {
      continue
    }

    counter++
    await client.update(DOMAIN_MODEL_TX, { _id: ptsCreate._id }, { 'attributes.statuses': newUpdateStatuses })
  }
  logger.log('projectTypeStatusesCreates updated: ', counter)

  const projectTypeStatusesUpdates = await client.find<TxUpdateDoc<ProjectType>>(DOMAIN_MODEL_TX, {
    _class: core.class.TxUpdateDoc,
    objectId: { $in: projectTypeStatusesCreates.map((sc) => sc.objectId) },
    objectClass: task.class.ProjectType,
    objectSpace: core.space.Model,
    'operations.statuses': { $exists: true }
  })
  logger.log('projectTypeStatusesUpdates: ', projectTypeStatusesUpdates.length)

  counter = 0
  for (const ptsUpdate of projectTypeStatusesUpdates) {
    const newUpdateStatuses = ptsUpdate.operations.statuses?.map(getNewProjectStatus)

    if (areSameArrays(newUpdateStatuses, ptsUpdate.operations.statuses)) {
      continue
    }

    counter++
    await client.update(DOMAIN_MODEL_TX, { _id: ptsUpdate._id }, { 'operations.statuses': newUpdateStatuses })
  }
  logger.log('projectTypeStatusesUpdates updated: ', counter)

  const projectTypeStatusesPushes = await client.find<TxUpdateDoc<ProjectType>>(DOMAIN_MODEL_TX, {
    _class: core.class.TxUpdateDoc,
    objectId: { $in: projectTypeStatusesCreates.map((sc) => sc.objectId) },
    objectClass: task.class.ProjectType,
    objectSpace: core.space.Model,
    'operations.$push.statuses': { $exists: true }
  })

  logger.log('projectTypeStatusesPushes: ', projectTypeStatusesPushes.length)

  counter = 0
  for (const ptsUpdate of projectTypeStatusesPushes) {
    const pushedProjectStatus = ptsUpdate.operations.$push?.statuses
    if (pushedProjectStatus === undefined) {
      continue
    }

    const newPushStatus = getNewProjectStatus(pushedProjectStatus as ProjectStatus)

    if (pushedProjectStatus === newPushStatus) {
      continue
    }

    counter++
    await client.update(DOMAIN_MODEL_TX, { _id: ptsUpdate._id }, { 'operations.$push.statuses': newPushStatus })
  }
  logger.log('projectTypeStatusesPushes updated: ', counter)

  // All task types
  // 1. Update create TX
  // 2. Update all update TXes with statuses

  const allTaskTypes = await client.find<TxCreateDoc<TaskType>>(DOMAIN_MODEL_TX, {
    _class: core.class.TxCreateDoc,
    objectClass: taskTypeClass,
    'attributes.ofClass': { $in: baseTaskClasses }
  })

  logger.log('allTaskTypes: ', allTaskTypes.length)

  counter = 0
  for (const taskType of allTaskTypes) {
    const newTaskTypeStatuses = taskType.attributes.statuses.map(getNewStatus)

    if (areSameArrays(newTaskTypeStatuses, taskType.attributes.statuses)) {
      continue
    }

    counter++
    await client.update(DOMAIN_MODEL_TX, { _id: taskType._id }, { 'attributes.statuses': newTaskTypeStatuses })
  }
  logger.log('allTaskTypes updated: ', counter)

  const allTaskTypeStatusesUpdates = await client.find<TxUpdateDoc<TaskType>>(DOMAIN_MODEL_TX, {
    _class: core.class.TxUpdateDoc,
    objectClass: taskTypeClass,
    objectId: { $in: allTaskTypes.map((tt) => tt.objectId) },
    'operations.statuses': { $exists: true }
  })

  logger.log('allTaskTypeStatusesUpdates: ', allTaskTypeStatusesUpdates.length)

  counter = 0
  for (const ttsUpdate of allTaskTypeStatusesUpdates) {
    const newTaskTypeUpdateStatuses = ttsUpdate.operations.statuses?.map(getNewStatus)

    logger.log('newTaskTypeUpdateStatuses for ' + ttsUpdate._id, newTaskTypeUpdateStatuses)

    if (areSameArrays(newTaskTypeUpdateStatuses, ttsUpdate.operations.statuses)) {
      logger.log('Nothing to update', '')
      continue
    }

    counter++
    await client.update(DOMAIN_MODEL_TX, { _id: ttsUpdate._id }, { 'operations.statuses': newTaskTypeUpdateStatuses })
  }
  logger.log('allTaskTypeStatusesUpdates updated: ', counter)

  await migrateProjects?.(getNewStatus)

  // For all Tasks:
  // 1. status
  // 2. TxCollectionCUD:TxCreateDoc
  // 3. TxCollectionCUD:TxUpdateDoc
  // 3. DocUpdateMessage:action:update&attributeUpdates:attrKey:status

  const affectedBaseTasks = await client.find<Task>(DOMAIN_TASK, {
    _class: { $in: baseTaskClasses },
    status: { $in: statusIdsBeingMigrated }
  })

  logger.log('affectedBaseTasks: ', affectedBaseTasks.length)

  counter = 0
  for (const baseTask of affectedBaseTasks) {
    const newStatus = getNewStatus(baseTask.status)

    if (newStatus !== baseTask.status) {
      counter++
      await client.update(DOMAIN_TASK, { _id: baseTask._id }, { status: newStatus })
    }
  }
  logger.log('affectedBaseTasks updated: ', counter)

  const baseTaskUpdateMessages = await client.find<DocUpdateMessage>(DOMAIN_ACTIVITY, {
    _class: activity.class.DocUpdateMessage,
    action: 'update',
    objectClass: { $in: baseTaskClasses },
    'attributeUpdates.attrKey': 'status',
    'attributeUpdates.set.0.': { $in: statusIdsBeingMigrated }
  })

  logger.log('Base task update messages: ', baseTaskUpdateMessages.length)

  counter = 0
  for (const updateMessage of baseTaskUpdateMessages) {
    const statusSet = updateMessage.attributeUpdates?.set[0]
    const newStatusSet = statusSet != null ? getNewStatus(statusSet as Ref<Status>) : statusSet

    if (statusSet !== newStatusSet) {
      counter++
      await client.update(DOMAIN_ACTIVITY, { _id: updateMessage._id }, { 'attributeUpdates.set.0': newStatusSet })
    }
  }
  logger.log('Base task update messages updated: ', counter)

  logger.log('Updating statuses themselves:', '')
  const createdStatuses = new Set<Ref<Status>>()
  for (const statusIdBeingMigrated of statusIdsBeingMigrated) {
    const newStatus = getNewStatus(statusIdBeingMigrated)

    logger.log('Updating status from ' + statusIdBeingMigrated + ' to ' + newStatus, '')

    await client.update(DOMAIN_STATUS, { _id: statusIdBeingMigrated }, { __superseded: true })

    if (!createdStatuses.has(newStatus)) {
      const oldStatus = oldStatuses.find((s) => s._id === statusIdBeingMigrated)
      if (oldStatus === undefined) {
        logger.log('Old status not found: ', statusIdBeingMigrated)
        continue
      }

      try {
        createdStatuses.add(newStatus)
        await client.create(DOMAIN_STATUS, {
          ...oldStatus,
          _class: statusClass,
          _id: newStatus as any,
          ofAttribute: statusAttributeOf,
          __migratedFrom: statusIdBeingMigrated
        })
      } catch (e: any) {
        logger.log('Could not create new status: ', e.message)
        // Might be already created
      }
    }
  }
  logger.log('Statuses created: ', createdStatuses.size)
  logger.log('Statuses updated: ', statusIdsBeingMigrated.length)
}

async function migrateRanks (client: MigrationClient): Promise<void> {
  const classes = client.hierarchy.getDescendants(task.class.Project)
  for (const _class of classes) {
    const spaces = await client.find<Project>(DOMAIN_SPACE, { _class })
    for (const space of spaces) {
      await migrateSpaceRanks(client, DOMAIN_TASK, space)
    }
  }
}

function areSameArrays (arr1: any[] | undefined, arr2: any[] | undefined): boolean {
  if (arr1 === arr2) {
    return true
  }

  if (arr1 === undefined || arr2 === undefined) {
    return false
  }

  return arr1.length === arr2.length && arr1.every((elem, idx) => elem === arr2[idx])
}

export const taskOperation: MigrateOperation = {
  async migrate (client: MigrationClient, mode): Promise<void> {
    await tryMigrate(mode, client, taskId, [
      {
        state: 'migrate-tt-model-states',
        mode: 'upgrade',
        func: async (client) => {
          const prTaskTypes = client.model.findAllSync(task.class.TaskType, {})

          const allModelStatuses = toIdMap(client.model.findAllSync(core.class.Status, {}))
          for (const tt of prTaskTypes) {
            const missing = tt.statuses.filter((it) => !allModelStatuses.has(it))
            await client.update(
              DOMAIN_TX,
              { objectId: { $in: missing }, objectSpace: 'task:space:Statuses' },
              { objectSpace: core.space.Model }
            )
            await client.update(
              DOMAIN_MODEL_TX,
              { objectId: { $in: missing }, objectSpace: 'task:space:Statuses' },
              { objectSpace: core.space.Model }
            )
            await client.move(DOMAIN_TX, { objectId: { $in: missing }, objectSpace: core.space.Model }, DOMAIN_MODEL_TX)
          }
        }
      },
      {
        state: 'removeDeprecatedSpace',
        func: async (client: MigrationClient) => {
          await migrateSpace(client, task.space.Sequence, core.space.Workspace, ['kanban' as Domain])
        }
      },
      {
        state: 'migrateRanks',
        mode: 'upgrade',
        func: migrateRanks
      },
      {
        state: 'migrate_wrong_isdone',
        mode: 'upgrade',
        func: async (client: MigrationClient) => {
          const statuses = client.model.findAllSync(core.class.Status, {
            category: { $in: [task.statusCategory.Won, task.statusCategory.Lost] }
          })

          await client.update<Task>(
            DOMAIN_TASK,
            {
              _class: { $in: client.hierarchy.getDescendants(task.class.Task) },
              status: { $in: statuses.map((it) => it._id) },
              isDone: false
            },
            {
              isDone: true
            }
          )
          await client.update<Task>(
            DOMAIN_TASK,
            {
              _class: { $in: client.hierarchy.getDescendants(task.class.Task) },
              status: { $nin: statuses.map((it) => it._id) },
              isDone: true
            },
            {
              isDone: false
            }
          )
        }
      },
      {
        state: 'migrateSequnce',
        mode: 'upgrade',
        func: async (client: MigrationClient) => {
          await client.update(
            'kanban' as Domain,
            { _class: 'task:class:Sequence' as Ref<Class<Doc>> },
            { _class: core.class.Sequence }
          )
          await client.move('kanban' as Domain, { _class: core.class.Sequence }, DOMAIN_SEQUENCE)
        }
      },
      {
        state: 'migrateCustomTaskTypesToClasses-v6',
        mode: 'upgrade',
        func: async (client: MigrationClient) => {
          const taskTypeTxes = await client.find<TxCreateDoc<TaskType>>(DOMAIN_MODEL_TX, {
            _class: core.class.TxCreateDoc,
            objectClass: task.class.TaskType
          })
          const taskTypes = taskTypeTxes.map((it) => TxProcessor.createDoc2Doc(it))

          const targetClassIds = taskTypes.map((it) => it.targetClass)

          if (targetClassIds.length > 0) {
            const classTxes = await client.find<TxCreateDoc<Class<Doc>>>(DOMAIN_MODEL_TX, {
              _class: core.class.TxCreateDoc,
              objectClass: { $in: [core.class.Class, core.class.Mixin] },
              objectId: { $in: targetClassIds }
            })

            for (const classTx of classTxes) {
              if (classTx.attributes?.kind === ClassifierKind.MIXIN) {
                const extendsClass = classTx.attributes.extends
                const clazz = extendsClass != null ? client.hierarchy.findClass(extendsClass) : undefined

                await client.update(
                  DOMAIN_MODEL_TX,
                  { _id: classTx._id },
                  {
                    objectClass: core.class.Class,
                    attributes: {
                      ...classTx.attributes,
                      kind: ClassifierKind.CLASS,
                      color: classTx.attributes.color ?? clazz?.color,
                      shortLabel: classTx.attributes.shortLabel ?? clazz?.shortLabel,
                      sortingKey: classTx.attributes.sortingKey ?? clazz?.sortingKey,
                      filteringKey: classTx.attributes.filteringKey ?? clazz?.filteringKey,
                      titleKey: classTx.attributes.titleKey ?? clazz?.titleKey
                    }
                  }
                )
              }
            }
          }

          for (const tt of taskTypes) {
            const targetClass = tt.targetClass

            const iterator = await client.traverse<Task>(DOMAIN_TASK, { kind: tt._id })

            try {
              while (true) {
                const existingTasks = (await iterator.next(500)) ?? []
                if (existingTasks.length === 0) break

                const operations: { filter: MigrationDocumentQuery<Task>, update: MigrateUpdate<Task> }[] = []

                for (const doc of existingTasks) {
                  const updateData: Record<string, any> = {
                    _class: targetClass
                  }

                  const mixinData = (doc as any)[targetClass]
                  if (mixinData != null && typeof mixinData === 'object') {
                    for (const [key, value] of Object.entries(mixinData)) {
                      updateData[key] = value
                    }
                  }

                  operations.push({
                    filter: { _id: doc._id },
                    update: {
                      $set: updateData
                    }
                  })
                }

                if (operations.length > 0) {
                  await client.bulk(DOMAIN_TASK, operations)
                }
              }
            } finally {
              await iterator.close()
            }
          }
        }
      },
      {
        state: 'sync-task-type-target-class-icon-v1',
        mode: 'upgrade',
        func: async (client: MigrationClient) => {
          const taskTypes = await client.model.findAll(task.class.TaskType, {})

          for (const tt of taskTypes) {
            if (tt.icon != null || tt.color != null) {
              const classTxes = await client.find<TxCreateDoc<Class<Doc>>>(DOMAIN_MODEL_TX, {
                _class: core.class.TxCreateDoc,
                objectClass: core.class.Class,
                objectId: tt.targetClass
              })
              for (const classTx of classTxes) {
                await client.update(
                  DOMAIN_MODEL_TX,
                  { _id: classTx._id },
                  {
                    attributes: {
                      ...classTx.attributes,
                      icon: tt.icon ?? classTx.attributes.icon,
                      color: tt.color ?? classTx.attributes.color
                    }
                  }
                )
              }
            }
          }
        }
      },
      {
        state: 'migrate-task-type-hierarchy-root-and-any-parent-v1',
        mode: 'upgrade',
        func: async (client: MigrationClient) => {
          const allTxes = await client.find<TxCUD<TaskType>>(DOMAIN_MODEL_TX, {
            objectClass: task.class.TaskType
          })

          const txesByObjectId = groupByArray(allTxes, (it) => it.objectId)

          for (const [, docTxes] of txesByObjectId.entries()) {
            const currentDoc = TxProcessor.buildDoc2Doc<TaskType>(docTxes)
            if (currentDoc == null) continue

            const isRoot = currentDoc.isRootTaskType
            const allowedParents = currentDoc.allowedAsChildOf ?? []
            const allowAnyParent = currentDoc.allowAnyParent

            let needsAllowAnyParent = false
            if (isRoot !== true && allowedParents.length === 0 && allowAnyParent !== true) {
              needsAllowAnyParent = true
            }

            const needsIsRoot = isRoot !== true

            if (!needsAllowAnyParent && !needsIsRoot) {
              continue
            }

            const hasUpdateTxes = docTxes.some((t) => t._class === core.class.TxUpdateDoc)
            const createTx = docTxes.find((t) => t._class === core.class.TxCreateDoc) as
              | TxCreateDoc<TaskType>
              | undefined

            if (hasUpdateTxes) {
              const operations: DocumentUpdate<TaskType> = {}
              if (needsAllowAnyParent) {
                operations.allowAnyParent = true
              }
              if (needsIsRoot) {
                operations.isRootTaskType = true
              }

              const newUpdateTx: TxUpdateDoc<TaskType> = {
                _id: generateId(),
                _class: core.class.TxUpdateDoc,
                space: core.space.Model,
                objectSpace: core.space.Model,
                objectClass: task.class.TaskType,
                objectId: currentDoc._id,
                modifiedBy: core.account.System,
                modifiedOn: Date.now(),
                operations
              }
              await client.create(DOMAIN_MODEL_TX, newUpdateTx)
            } else if (createTx !== undefined) {
              const updateAttrs: Record<string, any> = {}
              if (needsAllowAnyParent) {
                updateAttrs['attributes.allowAnyParent'] = true
              }
              if (needsIsRoot) {
                updateAttrs['attributes.isRootTaskType'] = true
              }
              await client.update(DOMAIN_MODEL_TX, { _id: createTx._id }, updateAttrs)
            }
          }
        }
      },
      {
        state: 'delete-orphaned-task-type-classes-v1',
        mode: 'upgrade',
        func: deleteOrphanedTaskTypeClasses
      }
    ])
  },
  async upgrade (state: Map<string, Set<string>>, client: () => Promise<MigrationUpgradeClient>, mode): Promise<void> {
    await tryUpgrade(mode, state, client, taskId, [
      {
        state: 'u-task-001',
        func: async (client) => {
          const tx = new TxOperations(client, core.account.System)

          await createOrUpdate(
            tx,
            tags.class.TagCategory,
            core.space.Workspace,
            {
              icon: tags.icon.Tags,
              label: 'Text Label',
              targetClass: task.class.Task,
              tags: [],
              default: true
            },
            task.category.TaskTag
          )
        }
      }
    ])
  }
}

export async function migrateMixinToClassInModel (
  client: MigrationClient,
  oldMixin: Ref<Mixin<Doc>>,
  newClass: Ref<Class<Doc>>
): Promise<void> {
  const txes1 = await client.find<TxCreateDoc<MessageNotificationType>>(DOMAIN_MODEL_TX, {
    _class: core.class.TxCreateDoc,
    objectClass: notification.class.MessageNotificationType,
    'attributes.objectClass': oldMixin
  } as any)

  const txes2 = await client.find<TxCreateDoc<MessageNotificationType>>(DOMAIN_MODEL_TX, {
    _class: core.class.TxCreateDoc,
    objectClass: notification.class.MessageNotificationType,
    'attributes.attachedToClass': oldMixin
  } as any)

  const txes = new Map([...txes1, ...txes2].map((it) => [it._id, it]))

  for (const [, tx] of txes.entries()) {
    const updateData: DocumentUpdate<TxCreateDoc<any>> = {}

    updateData.attributes = {
      ...tx.attributes,
      objectClass: tx.attributes.objectClass === oldMixin ? newClass : tx.attributes.objectClass,
      attachedToClass: tx.attributes.attachedToClass === oldMixin ? newClass : tx.attributes.attachedToClass
    }
    await client.update(DOMAIN_MODEL_TX, { _id: tx._id }, updateData)
  }

  // Migrate custom Attribute definitions bound to oldMixin
  const attrTxes = await client.find<TxCreateDoc<Attribute<Task>>>(DOMAIN_MODEL_TX, {
    _class: core.class.TxCreateDoc,
    objectClass: core.class.Attribute,
    'attributes.attributeOf': oldMixin
  })

  for (const attrTx of attrTxes) {
    await client.update(
      DOMAIN_MODEL_TX,
      { _id: attrTx._id },
      {
        attributes: {
          ...attrTx.attributes,
          attributeOf: newClass
        }
      }
    )
  }

  // Migrate AttributePermission objects bound to oldMixin
  const permTxes = await client.find<TxCreateDoc<any>>(DOMAIN_MODEL_TX, {
    objectClass: oldMixin
  } as any)

  for (const permTx of permTxes) {
    await client.update(
      DOMAIN_MODEL_TX,
      { _id: permTx._id },
      {
        objectClass: newClass
      }
    )
  }
}

export async function migrateTaskTypesToClasses (
  client: MigrationClient,
  taskTypeId: Ref<TaskType>,
  oldMixin: Ref<Mixin<Doc>>,
  targetClass: Ref<Class<Task>>
): Promise<void> {
  const ttTxes = await client.find<TxCreateDoc<TaskType>>(DOMAIN_MODEL_TX, {
    _class: core.class.TxCreateDoc,
    objectClass: task.class.TaskType,
    objectId: taskTypeId
  })
  for (const ttTx of ttTxes) {
    await client.update(
      DOMAIN_MODEL_TX,
      { _id: ttTx._id },
      {
        attributes: {
          ...ttTx.attributes,
          targetClass
        }
      }
    )
  }

  await migrateMixinToClassInModel(client, oldMixin, targetClass)

  const iterator = await client.traverse<Task>(DOMAIN_TASK, {
    kind: taskTypeId
  })

  try {
    while (true) {
      const existingTasks = (await iterator.next(500)) ?? []
      if (existingTasks.length === 0) break

      const operations: { filter: MigrationDocumentQuery<Task>, update: MigrateUpdate<Task> }[] = []

      for (const doc of existingTasks) {
        const updateData: Record<string, any> = {
          _class: targetClass
        }

        const mixinData = (doc as any)[oldMixin]
        if (mixinData != null && typeof mixinData === 'object') {
          for (const [key, value] of Object.entries(mixinData)) {
            updateData[key] = value
          }
        }

        operations.push({
          filter: { _id: doc._id },
          update: {
            $set: updateData
          }
        })
      }

      if (operations.length > 0) {
        await client.bulk(DOMAIN_TASK, operations)
      }
    }
  } finally {
    await iterator.close()
  }
}

export async function deleteOrphanedTaskTypeClasses (client: MigrationClient): Promise<void> {
  const allTaskTypeTxes = await client.find<TxCUD<TaskType>>(DOMAIN_MODEL_TX, {
    objectClass: task.class.TaskType
  })

  const txesByTaskTypeId = groupByArray(allTaskTypeTxes, (it) => it.objectId)
  const deletedTaskType = new Map<Ref<TaskType>, TaskType>()

  for (const [taskTypeId, docTxes] of txesByTaskTypeId.entries()) {
    const hasRemoveTx = docTxes.some((it) => it._class === core.class.TxRemoveDoc)
    if (!hasRemoveTx) continue

    const type = TxProcessor.buildDoc2Doc(docTxes.filter((it) => it._class !== core.class.TxRemoveDoc))
    if (type == null) continue
    deletedTaskType.set(taskTypeId, type as TaskType)
  }

  if (deletedTaskType.size === 0) return

  const txFactory = new TxFactory(core.account.System)
  const txesToCreate: Tx[] = []

  for (const [, taskType] of deletedTaskType.entries()) {
    if (taskType.targetClass != null && taskType.targetClass !== taskType.ofClass) {
      const classRemoveTxes = await client.find<TxRemoveDoc<Class<Doc>>>(DOMAIN_MODEL_TX, {
        _class: core.class.TxRemoveDoc,
        objectClass: core.class.Class,
        objectId: taskType.targetClass
      })
      if (classRemoveTxes.length === 0) {
        txesToCreate.push(txFactory.createTxRemoveDoc(core.class.Class, core.space.Model, taskType.targetClass))
      }

      const attrTxes = await client.find<TxCreateDoc<Attribute<Doc>>>(DOMAIN_MODEL_TX, {
        _class: core.class.TxCreateDoc,
        objectClass: core.class.Attribute,
        'attributes.attributeOf': taskType.targetClass
      })

      for (const attrTx of attrTxes) {
        const attrRemoveTxes = await client.find<TxRemoveDoc<Attribute<Doc>>>(DOMAIN_MODEL_TX, {
          _class: core.class.TxRemoveDoc,
          objectClass: core.class.Attribute,
          objectId: attrTx.objectId
        })
        if (attrRemoveTxes.length === 0) {
          txesToCreate.push(txFactory.createTxRemoveDoc(core.class.Attribute, core.space.Model, attrTx.objectId))
        }
      }
    }
  }

  if (txesToCreate.length > 0) {
    await client.create(DOMAIN_MODEL_TX, txesToCreate)
  }
}
