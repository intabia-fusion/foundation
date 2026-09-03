<!--
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
-->
<script lang="ts">
  import core, { Class, ClassifierKind, Data, Ref, RefTo, Status, generateId, toIdMap } from '@hcengineering/core'
  import { IntlString, Resource, getEmbeddedLabel, getResource } from '@hcengineering/platform'
  import presentation, { getClient, hasResource } from '@hcengineering/presentation'
  import {
    ProjectType,
    ProjectTypeDescriptor,
    Task,
    TaskType,
    TaskTypeDescriptor,
    createState,
    findStatusAttr
  } from '@hcengineering/task'
  import {
    DropdownIntlItem,
    Icon,
    IconError,
    Modal,
    ModernEditbox,
    Label,
    ButtonMenu,
    Toggle,
    IconInfo,
    ButtonIcon
  } from '@hcengineering/ui'
  import { clearSettingsStore } from '@hcengineering/setting-resources'

  import task from '../../plugin'
  import TaskTypeRefEditor from './TaskTypeRefEditor.svelte'

  const client = getClient()
  export let type: ProjectType
  export let descriptor: ProjectTypeDescriptor
  export let taskTypes: TaskType[]
  export let taskType: TaskType | undefined

  function defaultTaskType (type: ProjectType): Data<TaskType> {
    return {
      name: '',
      parent: type._id,
      descriptor: '' as Ref<TaskTypeDescriptor>,
      ofClass: task.class.Task,
      targetClass: task.class.Task,
      statusCategories: [
        task.statusCategory.UnStarted,
        task.statusCategory.Active,
        task.statusCategory.Won,
        task.statusCategory.Lost
      ],
      statusClass: core.class.Status,
      statuses: [],
      isRootTaskType: true,
      allowAnyParent: true,
      allowedAsChildOf: []
    }
  }

  const taskTypeDescriptors = client
    .getModel()
    .findAllSync(
      task.class.TaskTypeDescriptor,
      descriptor.allowedTaskTypeDescriptors
        ? { allowCreate: true, _id: { $in: descriptor.allowedTaskTypeDescriptors } }
        : { allowCreate: true }
    )
    .filter((p) => hasResource(p._id as any as Resource<any>))

  let { name, targetClass, statusCategories, statuses } =
    taskType !== undefined ? { ...taskType } : { ...defaultTaskType(type) }

  let isRootTaskType: boolean = taskType?.isRootTaskType ?? true
  let allowAnyParent: boolean = taskType?.allowAnyParent ?? true
  let allowedAsChildOf: Ref<TaskType>[] = taskType?.allowedAsChildOf ?? []

  function findStatusClass (_class: Ref<Class<Task>>): Ref<Class<Status>> | undefined {
    const h = getClient().getHierarchy()
    const attrs = h.getAllAttributes(_class)
    for (const it of attrs.values()) {
      if (it.type._class === core.class.RefTo && h.isDerived((it.type as RefTo<any>).to, core.class.Status)) {
        return (it.type as RefTo<any>).to
      }
    }
  }

  let taskTypeDescriptor: TaskTypeDescriptor = taskTypeDescriptors[0]
  let errorMessage: IntlString | undefined = undefined

  async function save (): Promise<void> {
    if (type === undefined) return

    const trimmedName = name.trim()
    if (trimmedName.length === 0) {
      errorMessage = task.string.TaskTypeNameEmpty
      return
    }

    const duplicate = taskTypes.find(
      (tt) => tt._id !== taskType?._id && tt.name.trim().toLocaleLowerCase() === trimmedName.toLocaleLowerCase()
    )

    if (duplicate !== undefined) {
      errorMessage = task.string.TaskTypeNameAlreadyExists
      return
    }

    if (!isRootTaskType && !allowAnyParent && allowedAsChildOf.length === 0) {
      errorMessage = task.string.HierarchyWarningNoParentAndNoRoot
      return
    }

    errorMessage = undefined

    const descr = taskTypeDescriptors.find((it) => it._id === taskTypeDescriptor._id)
    if (descr === undefined) return

    const ofClass = descr.baseClass
    const _taskType = {
      name,
      ofClass,
      descriptor: taskTypeDescriptor._id,
      targetClass,
      statusCategories,
      statuses,
      isRootTaskType,
      allowAnyParent,
      allowedAsChildOf,
      statusClass: findStatusClass(ofClass) ?? core.class.Status,
      parent: type._id,
      icon: descr.icon
    }

    if (taskType === undefined) {
      if (descr.statusCategoriesFunc !== undefined) {
        const f = await getResource(descr.statusCategoriesFunc)
        if (f !== undefined) {
          _taskType.statusCategories = f(type)
        }
      }
      if (descr.defaultStatusesFunc !== undefined) {
        const f = await getResource(descr.defaultStatusesFunc)
        if (f !== undefined) {
          _taskType.statuses = f(type)
        }
      }
    }

    const taskTypeId: Ref<TaskType> = taskType?._id ?? generateId()
    if (_taskType.statuses.length === 0) {
      const categories = toIdMap(
        await client.findAll(core.class.StatusCategory, { _id: { $in: _taskType.statusCategories } })
      )
      const statusAttr =
        findStatusAttr(client.getHierarchy(), ofClass) ?? client.getHierarchy().getAttribute(task.class.Task, 'status')
      for (const st of _taskType.statusCategories) {
        const std = categories.get(st)
        if (std !== undefined) {
          const s = await createState(client, _taskType.statusClass, {
            name: std.defaultStatusName,
            ofAttribute: statusAttr._id,
            category: std._id
          })
          _taskType.statuses.push(s)
        }
      }
    }

    for (const s of _taskType.statuses) {
      if (type.statuses.find((it) => it._id === s) === undefined) {
        await client.update(type, {
          $push: { statuses: { _id: s, taskType: taskTypeId } }
        })
      }
    }

    if (taskType !== undefined) {
      await client.diffUpdate(taskType, _taskType)
    } else {
      const ofClassClass = client.getHierarchy().getClass(ofClass)
      // Create target class for custom field.
      _taskType.targetClass = await client.createDoc(core.class.Class, core.space.Model, {
        extends: ofClass,
        kind: ClassifierKind.CLASS,
        label: getEmbeddedLabel(name),
        icon: ofClassClass.icon,
        color: ofClassClass.color,
        shortLabel: ofClassClass.shortLabel,
        sortingKey: ofClassClass.sortingKey,
        filteringKey: ofClassClass.filteringKey,
        titleKey: ofClassClass.titleKey
      })

      await client.createMixin(_taskType.targetClass, core.class.Class, core.space.Model, task.mixin.TaskTypeClass, {
        taskType: taskTypeId,
        projectType: type._id
      })

      await client.createDoc(task.class.TaskType, core.space.Model, _taskType, taskTypeId)
    }

    if (!type.tasks.includes(taskTypeId)) {
      await client.update(type, { $push: { tasks: taskTypeId } })
    }

    clearSettingsStore()
  }

  const descriptorItems: DropdownIntlItem[] = taskTypeDescriptors.map((it) => ({
    id: it._id,
    icon: it.icon,
    label: it.name
  }))
</script>

<Modal
  label={task.string.TaskType}
  type="type-aside"
  okAction={save}
  canSave
  okLabel={taskType !== undefined ? presentation.string.Save : presentation.string.Create}
  on:changeContent
  onCancel={() => {
    clearSettingsStore()
  }}
>
  <div class="hulyModal-content__titleGroup">
    <ModernEditbox
      bind:value={name}
      label={task.string.TaskTypeName}
      size="large"
      kind="ghost"
      error={errorMessage !== undefined}
      autoFocus
      limit={32}
      on:input={() => {
        if (errorMessage !== undefined) {
          errorMessage = undefined
        }
      }}
    />
    {#if errorMessage !== undefined}
      <div class="name-error">
        <Icon icon={IconError} size="small" />
        <span><Label label={errorMessage} /></span>
      </div>
    {/if}
  </div>
  <div class="hulyModal-content__settingsSet">
    {#if taskTypeDescriptors.length > 1}
      <div class="hulyModal-content__settingsSet-line">
        <span class="label">
          <Label label={task.string.Type} />
        </span>
        <ButtonMenu
          selected={taskTypeDescriptor._id}
          items={descriptorItems}
          icon={taskTypeDescriptor.icon}
          label={taskTypeDescriptor.name}
          kind="secondary"
          size="medium"
          on:selected={(evt) => {
            if (evt.detail != null) {
              const tt = taskTypeDescriptors.find((tt) => tt._id === evt.detail)
              if (tt) taskTypeDescriptor = tt
            }
          }}
        />
      </div>
    {/if}

    <div class="hulyModal-content__settingsSet-line">
      <span class="label label-with-info">
        <Label label={task.string.AllowRootTask} />
        <ButtonIcon
          icon={IconInfo}
          size="extra-small"
          kind="tertiary"
          tooltip={{ label: task.string.AllowRootTaskTooltip }}
        />
      </span>
      <Toggle bind:on={isRootTaskType} />
    </div>

    <div class="hulyModal-content__settingsSet-line">
      <span class="label label-with-info">
        <Label label={task.string.AllowAnyParentSubtask} />
        <ButtonIcon
          icon={IconInfo}
          size="extra-small"
          kind="tertiary"
          tooltip={{ label: task.string.AllowAnyParentTooltip }}
        />
      </span>
      <Toggle bind:on={allowAnyParent} />
    </div>

    {#if !allowAnyParent}
      <TaskTypeRefEditor
        value={allowedAsChildOf}
        types={taskTypes}
        onChange={(evt) => {
          allowedAsChildOf = evt
        }}
      />
    {/if}

    {#if !isRootTaskType && !allowAnyParent && allowedAsChildOf.length === 0}
      <div class="hierarchy-warning-box">
        <Icon icon={IconError} size="small" />
        <span><Label label={task.string.HierarchyWarningNoParentAndNoRoot} /></span>
      </div>
    {/if}
  </div>
</Modal>

<style lang="scss">
  .hulyModal-content__titleGroup {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    width: 100%;

    .name-error {
      display: flex;
      align-items: center;
      gap: 0.375rem;
      margin-top: 0.375rem;
      font-size: 0.8125rem;
      font-weight: 400;
      color: var(--global-error-TextColor);
    }
  }

  .label-with-info {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .hierarchy-warning-box {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 0.75rem;
    background: rgba(239, 68, 68, 0.08);
    border: 1px solid rgba(239, 68, 68, 0.25);
    border-radius: var(--small-BorderRadius, 0.25rem);
    color: var(--global-negative-TextColor, #ef4444);
    font-size: 0.75rem;
    line-height: 1.25;
    margin-top: 0.5rem;
  }
</style>
