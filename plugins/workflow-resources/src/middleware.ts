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
// See the License for the specific language governing permissions and
// limitations under the License.
//

import core, {
  type Client,
  type Doc,
  type DocumentUpdate,
  getCurrentAccount,
  notEmpty,
  type Ref,
  type Tx,
  type TxCUD,
  type TxResult,
  type TxUpdateDoc,
  TxOperations,
  type WithLookup
} from '@hcengineering/core'
import { BasePresentationMiddleware, type PresentationMiddleware } from '@hcengineering/presentation'
import task, { type Project, type Task } from '@hcengineering/task'
import {
  type ProjectWorkflow,
  type Screen,
  type ScreenTab,
  type Workflow,
  type WorkflowTransition
} from '@hcengineering/workflow'
import platform, { PlatformError, Severity, Status } from '@hcengineering/platform'
import { showPopup } from '@hcengineering/ui'

import plugin from './plugin'
import ScreenModal from './components/screen/ScreenModal.svelte'
import { type ScreenModalResult } from './types'

interface TransitionResult {
  proceed: boolean
  extraTxes?: Array<TxCUD<Doc>>
}

export class WorkflowMiddleware extends BasePresentationMiddleware implements PresentationMiddleware {
  private constructor (client: Client, next?: PresentationMiddleware) {
    super(client, next)
  }

  static create (client: Client, next?: PresentationMiddleware): WorkflowMiddleware {
    return new WorkflowMiddleware(client, next)
  }

  private get txFactory (): TxOperations['txFactory'] {
    return new TxOperations(this.client, getCurrentAccount().primarySocialId).txFactory
  }

  async notifyTx (...tx: Tx[]): Promise<void> {
    await this.provideNotifyTx(...tx)
  }

  async close (): Promise<void> {
    await this.provideClose()
  }

  async tx (tx: Tx): Promise<TxResult> {
    if (tx._class !== core.class.TxUpdateDoc) return await this.provideTx(tx)

    const updateTx = tx as TxUpdateDoc<Task>
    const hierarchy = this.client.getHierarchy()

    if (!hierarchy.isDerived(updateTx.objectClass, task.class.Task)) return await this.provideTx(tx)

    const res = await this.handleStatusTransition(updateTx)
    if (!res.proceed) {
      throw new PlatformError(
        new Status(
          Severity.OK,
          platform.status.OK,
          {
            reason: 'Transition canceled by user'
          },
          undefined,
          { propagate: true }
        )
      )
    }

    if (res.extraTxes != null && res.extraTxes.length > 0) {
      const allTxes: Array<TxCUD<Doc>> = [updateTx, ...res.extraTxes]
      const batchTx = this.txFactory.createTxApplyIf(core.space.Tx, 'workflow', [], [], allTxes, 'workflow')
      return await this.provideTx(batchTx)
    }

    return await this.provideTx(tx)
  }

  private async handleStatusTransition (updateTx: TxUpdateDoc<Task>): Promise<TransitionResult> {
    const toStatus = updateTx.operations.status
    if (toStatus == null) return { proceed: true }

    const taskDoc = await this.client.findOne(task.class.Task, { _id: updateTx.objectId })
    if (taskDoc == null || taskDoc.status === toStatus) return { proceed: true }

    const workflow = await this.getWorkflowForTask(taskDoc)
    if (workflow == null) return { proceed: true }

    const fromStatus = taskDoc.status
    const transitions = (workflow.$lookup?.transitions ?? []) as WorkflowTransition[]

    const transition =
      transitions.find((t) => t.to === toStatus && t.from != null && t.from.includes(fromStatus)) ??
      transitions.find((t) => t.to === toStatus && (t.from == null || t.from.length === 0))

    if (transition == null) return { proceed: false }

    const screenRequests = (transition.requests ?? []).filter((r) => r.rule === plugin.request.ScreenRequest)
    if (screenRequests.length === 0) return { proceed: true }

    const screenIds = screenRequests.map((it) => it.props?.screen as Ref<Screen> | undefined).filter(notEmpty)
    if (screenIds.length === 0) return { proceed: true }

    const screens = await this.client.findAll(
      plugin.class.Screen,
      { _id: { $in: screenIds } },
      {
        lookup: {
          _id: { tabs: plugin.class.ScreenTab }
        }
      }
    )
    if (screens.length === 0) return { proceed: true }

    // Reorder screens to preserve the sequence defined in transition screenRequests
    const screenMap = new Map(screens.map((s) => [s._id, s]))
    const orderedScreens = screenIds.map((id) => screenMap.get(id)).filter(notEmpty)

    const tabs = orderedScreens.flatMap((it) => (it.$lookup?.tabs ?? []) as ScreenTab[])
    const tabIds = tabs.map((t) => t._id)
    const allFields = await this.client.findAll(plugin.class.ScreenField, { attachedTo: { $in: tabIds } })
    if (allFields.length === 0) return { proceed: true }

    const hierarchy = this.client.getHierarchy()
    const clone = hierarchy.clone(taskDoc)
    const extraTxes: Array<TxCUD<Doc>> = []

    let screenUpdates: DocumentUpdate<Task> = {}

    for (const screen of orderedScreens) {
      const _tabs = tabs.filter((it) => it.attachedTo === screen._id)
      const _tabIds = new Set(_tabs.map((t) => t._id))
      const _fields = allFields.filter((it) => _tabIds.has(it.attachedTo))

      // Skip screens with no fields to avoid popping up an empty modal
      if (_fields.length === 0) continue

      const res = await new Promise<ScreenModalResult<Task> | null>((resolve) => {
        showPopup(
          ScreenModal,
          {
            screen,
            tabs: _tabs,
            fields: _fields,
            object: clone
          },
          'center',
          (result) => {
            resolve(result as ScreenModalResult<Task> | null)
          }
        )
      })

      if (res == null) return { proceed: false }

      if (res.update != null && Object.keys(res.update).length > 0) {
        screenUpdates = {
          ...res.update
        }
      }

      if (res.txes != null && res.txes.length > 0) {
        extraTxes.push(...res.txes)
      }
    }

    if (Object.keys(screenUpdates).length > 0) {
      updateTx.operations = {
        ...updateTx.operations,
        ...screenUpdates
      }
    }

    return { proceed: true, extraTxes }
  }

  private async getWorkflowForTask (taskDoc: Task): Promise<WithLookup<Workflow> | undefined> {
    const hierarchy = this.client.getHierarchy()
    const taskType = taskDoc.kind

    const project = await this.client.findOne(task.class.Project, { _id: taskDoc.space as Ref<Project> })
    if (project == null || !hierarchy.hasMixin(project, plugin.mixin.ProjectWorkflow)) {
      return undefined
    }

    const projectWorkflow = hierarchy.as<Project, ProjectWorkflow>(project, plugin.mixin.ProjectWorkflow)
    const mappedWorkflowId = projectWorkflow?.workflows?.[taskType]
    if (mappedWorkflowId == null) return undefined

    return await this.client.findOne(
      plugin.class.Workflow,
      { _id: mappedWorkflowId },
      {
        lookup: {
          _id: { transitions: plugin.class.WorkflowTransition }
        }
      }
    )
  }
}
