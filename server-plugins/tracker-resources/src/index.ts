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
import core, {
  concatLink,
  Doc,
  DocumentUpdate,
  Ref,
  Space,
  Tx,
  TxCreateDoc,
  TxCUD,
  TxProcessor,
  TxRemoveDoc,
  TxUpdateDoc,
  WithLookup
} from '@hcengineering/core'
import { getMetadata, IntlString } from '@hcengineering/platform'
import serverCore, { TriggerControl } from '@hcengineering/server-core'
import tracker, {
  Component,
  Issue,
  IssueParentInfo,
  TimeSpendReport,
  reduceChildInfoTree,
  trackerId,
  type Project,
  IssuePriority,
  IssueStatus
} from '@hcengineering/tracker'
import { workbenchId } from '@hcengineering/workbench'
import { Presenter, PresenterControl, AttributePresenterFn } from '@hcengineering/server-activity'
import { formatDuration } from '@hcengineering/tracker'

const timeSpendReportTitlePresenter: Presenter<TimeSpendReport> = async (doc, control) => {
  const language = control.branding?.defaultLanguage ?? 'en'
  return formatDuration(doc.value, language)
}

async function updateSubIssues (
  updateTx: TxUpdateDoc<Issue>,
  control: TriggerControl,
  update: DocumentUpdate<Issue> | ((node: Issue) => DocumentUpdate<Issue>)
): Promise<TxUpdateDoc<Issue>[]> {
  const subIssues = await control.findAll(control.ctx, tracker.class.Issue, { 'parents.parentId': updateTx.objectId })

  return subIssues.map((issue) => {
    const docUpdate = typeof update === 'function' ? update(issue) : update
    return control.txFactory.createTxUpdateDoc(issue._class, issue.space, issue._id, docUpdate)
  })
}

const issueUrlPresenter: Presenter = async (doc: Doc, control: PresenterControl): Promise<string> => {
  const issue = doc as Issue
  const front = control.branding?.front ?? getMetadata(serverCore.metadata.FrontUrl) ?? ''
  const path = `${workbenchId}/${control.workspace.url}/${trackerId}/${issue.identifier}`
  return concatLink(front, path)
}

const issueIdentifierPresenter: Presenter = async (doc: Doc, control: PresenterControl): Promise<string> => {
  return await getIssueId(doc as Issue, control)
}

export async function getIssueId (doc: Issue, control: Pick<TriggerControl, 'ctx' | 'findAll'>): Promise<string> {
  const issue = doc
  const project = (await control.findAll(control.ctx, tracker.class.Project, { _id: issue.space }))[0]
  return `${project?.identifier ?? '?'}-${issue.number}`
}

/**
 * @public
 */
export async function OnProjectRemove (txes: Tx[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []
  for (const tx of txes) {
    const ctx = tx as TxRemoveDoc<Project>
    const classes = [tracker.class.Issue, tracker.class.Component, tracker.class.Milestone, tracker.class.IssueTemplate]
    for (const cls of classes) {
      const docs = await control.findAll(control.ctx, cls, { space: ctx.objectId })
      for (const doc of docs) {
        const tx = control.txFactory.createTxRemoveDoc(cls, doc.space, doc._id)
        result.push(tx)
      }
    }
  }
  control.ctx.contextData.broadcast.targets.projectRemove = async (it) => {
    return {
      target: []
    }
  }
  return result
}

/**
 * @public
 */
export async function OnComponentRemove (txes: Tx[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []
  for (const tx of txes) {
    const ctx = tx as TxRemoveDoc<Component>

    const issues = await control.findAll(control.ctx, tracker.class.Issue, {
      component: ctx.objectId
    })
    if (issues === undefined) {
      continue
    }
    for (const issue of issues) {
      const issuePush = {
        ...issue,
        component: null
      }
      const tx = control.txFactory.createTxUpdateDoc(issue._class, issue.space, issue._id, issuePush)
      result.push(tx)
    }
  }
  return result
}

/**
 * @public
 */
export async function OnIssueUpdate (txes: Tx[], control: TriggerControl): Promise<Tx[]> {
  const result: Tx[] = []
  for (const actualTx of txes) {
    // Check TimeReport operations
    if (
      actualTx._class === core.class.TxCreateDoc ||
      actualTx._class === core.class.TxUpdateDoc ||
      actualTx._class === core.class.TxRemoveDoc
    ) {
      const cud = actualTx as TxCUD<TimeSpendReport>
      if (cud.objectClass === tracker.class.TimeSpendReport) {
        result.push(...(await doTimeReportUpdate(cud, control)))
      }
    }

    if (actualTx._class === core.class.TxCreateDoc) {
      const createTx = actualTx as TxCreateDoc<Issue>
      if (control.hierarchy.isDerived(createTx.objectClass, tracker.class.Issue)) {
        const issue = TxProcessor.createDoc2Doc(createTx)
        updateIssueParentEstimations(issue, result, control, [], issue.parents)
        continue
      }
    }

    if (actualTx._class === core.class.TxUpdateDoc) {
      const updateTx = actualTx as TxUpdateDoc<Issue>
      if (control.hierarchy.isDerived(updateTx.objectClass, tracker.class.Issue)) {
        result.push(...(await doIssueUpdate(updateTx, control)))
        continue
      }
    }
    if (actualTx._class === core.class.TxRemoveDoc) {
      const removeTx = actualTx as TxRemoveDoc<Issue>
      if (control.hierarchy.isDerived(removeTx.objectClass, tracker.class.Issue)) {
        const parentIssue = await control.findAll(control.ctx, tracker.class.Issue, {
          'childInfo.childId': removeTx.objectId
        })
        const parents: IssueParentInfo[] = parentIssue.map((it) => ({
          parentId: it._id,
          parentTitle: it.title,
          identifier: it.identifier,
          space: it.space
        }))
        updateIssueParentEstimations(
          {
            _id: removeTx.objectId,
            estimation: 0,
            reportedTime: 0,
            space: removeTx.space
          },
          result,
          control,
          parents,
          []
        )
      }
    }
  }
  return result
}

async function doTimeReportUpdate (cud: TxCUD<TimeSpendReport>, control: TriggerControl): Promise<Tx[]> {
  const { attachedTo: attachedToId, attachedToClass } = cud
  if (attachedToClass === undefined || attachedToId === undefined) {
    return []
  }
  const attachedTo = attachedToId as Ref<Issue>
  switch (cud._class) {
    case core.class.TxCreateDoc: {
      const ccud = cud as TxCreateDoc<TimeSpendReport>
      const [currentIssue] = await control.findAll(control.ctx, tracker.class.Issue, { _id: attachedTo }, { limit: 1 })
      const res = [
        control.txFactory.createTxUpdateDoc<Issue>(
          attachedToClass,
          cud.objectSpace,
          attachedTo,
          {
            $inc: { reportedTime: ccud.attributes.value }
          },
          false,
          currentIssue.modifiedOn
        )
      ]
      currentIssue.reportedTime += ccud.attributes.value
      {
        const { totalEstimation, totalReportedTime } = reduceChildInfoTree(
          currentIssue.childInfo ?? [],
          currentIssue.estimation,
          currentIssue.reportedTime
        )
        currentIssue.remainingTime = Math.max(0, Math.max(currentIssue.estimation, totalEstimation) - totalReportedTime)
      }
      updateIssueParentEstimations(currentIssue, res, control, currentIssue.parents, currentIssue.parents)
      return res
    }
    case core.class.TxUpdateDoc: {
      const upd = cud as TxUpdateDoc<TimeSpendReport>
      if (upd.operations.value !== undefined) {
        const logTxes = Array.from(
          await control.findAll(control.ctx, core.class.TxCUD, {
            objectId: cud.objectId
          })
        ).filter((it) => it._id !== cud._id)
        const doc = TxProcessor.buildDoc2Doc<TimeSpendReport>(logTxes)

        const res: Tx[] = []
        const [currentIssue] = await control.findAll(
          control.ctx,
          tracker.class.Issue,
          { _id: attachedTo },
          { limit: 1 }
        )
        if (doc != null) {
          res.push(
            control.txFactory.createTxUpdateDoc<Issue>(
              attachedToClass,
              cud.objectSpace,
              attachedTo,
              {
                $inc: { reportedTime: upd.operations.value - doc.value }
              },
              false,
              currentIssue.modifiedOn
            )
          )
          currentIssue.reportedTime -= doc.value
          currentIssue.reportedTime += upd.operations.value
          {
            const { totalEstimation, totalReportedTime } = reduceChildInfoTree(
              currentIssue.childInfo ?? [],
              currentIssue.estimation,
              currentIssue.reportedTime
            )
            currentIssue.remainingTime = Math.max(
              0,
              Math.max(currentIssue.estimation, totalEstimation) - totalReportedTime
            )
          }
        }

        updateIssueParentEstimations(currentIssue, res, control, currentIssue.parents, currentIssue.parents)
        return res
      }
      break
    }
    case core.class.TxRemoveDoc: {
      if (!control.removedMap.has(attachedTo)) {
        const logTxes = Array.from(
          await control.findAll(control.ctx, core.class.TxCUD, {
            objectId: cud.objectId
          })
        ).filter((it) => it._id !== cud._id)
        const doc = TxProcessor.buildDoc2Doc<TimeSpendReport>(logTxes)
        if (doc != null) {
          const [currentIssue] = await control.findAll(
            control.ctx,
            tracker.class.Issue,
            { _id: attachedTo },
            { limit: 1 }
          )
          const res = [
            control.txFactory.createTxUpdateDoc<Issue>(
              attachedToClass,
              cud.objectSpace,
              attachedTo,
              {
                $inc: { reportedTime: -1 * doc.value }
              },
              false,
              currentIssue.modifiedOn
            )
          ]
          currentIssue.reportedTime -= doc.value
          {
            const { totalEstimation, totalReportedTime } = reduceChildInfoTree(
              currentIssue.childInfo ?? [],
              currentIssue.estimation,
              currentIssue.reportedTime
            )
            currentIssue.remainingTime = Math.max(
              0,
              Math.max(currentIssue.estimation, totalEstimation) - totalReportedTime
            )
          }
          updateIssueParentEstimations(currentIssue, res, control, currentIssue.parents, currentIssue.parents)
          return res
        }
      }
    }
  }
  return []
}

async function doIssueUpdate (updateTx: TxUpdateDoc<Issue>, control: TriggerControl): Promise<Tx[]> {
  const res: Tx[] = []

  let currentIssue: WithLookup<Issue> | undefined

  async function getCurrentIssue (): Promise<WithLookup<Issue>> {
    if (currentIssue !== undefined) {
      return currentIssue
    }
    // We need to remove estimation information from out parent issue
    ;[currentIssue] = await control.findAll(control.ctx, tracker.class.Issue, { _id: updateTx.objectId }, { limit: 1 })
    return currentIssue
  }

  if (Object.prototype.hasOwnProperty.call(updateTx.operations, 'attachedTo')) {
    const [newParent] = await control.findAll(
      control.ctx,
      tracker.class.Issue,
      { _id: updateTx.operations.attachedTo },
      { limit: 1 }
    )

    const updatedParents: IssueParentInfo[] =
      newParent !== undefined
        ? [
            {
              parentId: newParent._id,
              parentTitle: newParent.title,
              space: newParent.space,
              identifier: newParent.identifier
            },
            ...newParent.parents
          ]
        : []

    function update (issue: Issue): DocumentUpdate<Issue> {
      const parentInfoIndex = issue.parents.findIndex(({ parentId }) => parentId === updateTx.objectId)
      const parentsUpdate =
        parentInfoIndex === -1
          ? {}
          : { parents: [...issue.parents].slice(0, parentInfoIndex + 1).concat(updatedParents) }

      return { ...parentsUpdate }
    }

    res.push(
      control.txFactory.createTxUpdateDoc(updateTx.objectClass, updateTx.objectSpace, updateTx.objectId, {
        parents: updatedParents
      }),
      ...(await updateSubIssues(updateTx, control, update))
    )

    // Remove from parent estimation list.
    const issue = await getCurrentIssue()
    updateIssueParentEstimations(issue, res, control, issue.parents, updatedParents, updateTx.operations.attachedTo)
  }

  if (
    Object.prototype.hasOwnProperty.call(updateTx.operations, 'estimation') ||
    Object.prototype.hasOwnProperty.call(updateTx.operations, 'reportedTime') ||
    (Object.prototype.hasOwnProperty.call(updateTx.operations, '$inc') &&
      Object.prototype.hasOwnProperty.call(updateTx.operations.$inc, 'reportedTime'))
  ) {
    const issue = await getCurrentIssue()

    issue.estimation = updateTx.operations.estimation ?? issue.estimation
    issue.reportedTime = updateTx.operations.reportedTime ?? issue.reportedTime
    {
      const { totalEstimation, totalReportedTime } = reduceChildInfoTree(
        issue.childInfo ?? [],
        issue.estimation,
        issue.reportedTime
      )
      issue.remainingTime = Math.max(0, Math.max(issue.estimation, totalEstimation) - totalReportedTime)
    }

    res.push(
      control.txFactory.createTxUpdateDoc(tracker.class.Issue, issue.space, issue._id, {
        remainingTime: issue.remainingTime
      })
    )

    updateIssueParentEstimations(issue, res, control, issue.parents, issue.parents)
  }

  if (Object.prototype.hasOwnProperty.call(updateTx.operations, 'title')) {
    function update (issue: Issue): DocumentUpdate<Issue> {
      const parentInfoIndex = issue.parents.findIndex(({ parentId }) => parentId === updateTx.objectId)
      const updatedParentInfo = { ...issue.parents[parentInfoIndex], parentTitle: updateTx.operations.title as string }
      const updatedParents = [...issue.parents]

      updatedParents[parentInfoIndex] = updatedParentInfo

      return { parents: updatedParents }
    }

    res.push(...(await updateSubIssues(updateTx, control, update)))
  }

  return res
}
function updateIssueParentEstimations (
  issue: {
    _id: Ref<Issue>
    space: Ref<Space>
    estimation: number
    reportedTime: number
    attachedTo?: Ref<Issue>
  },
  res: Tx[],
  control: TriggerControl,
  sourceParents: IssueParentInfo[],
  targetParents: IssueParentInfo[],
  overrideParentId?: Ref<Issue>
): void {
  for (const pinfo of sourceParents) {
    res.push(
      control.txFactory.createTxUpdateDoc(tracker.class.Issue, pinfo.space, pinfo.parentId, {
        $pull: {
          childInfo: { childId: issue._id }
        }
      })
    )
  }
  for (const pinfo of targetParents) {
    res.push(
      control.txFactory.createTxUpdateDoc(tracker.class.Issue, pinfo.space, pinfo.parentId, {
        $push: {
          childInfo: {
            childId: issue._id,
            estimation: issue.estimation,
            reportedTime: issue.reportedTime,
            parentId: overrideParentId ?? issue.attachedTo
          }
        }
      })
    )
  }
}

async function issueLinkIdProvider (issue: Issue): Promise<string> {
  return issue.identifier
}

const issueStatusPresenter: AttributePresenterFn = async (
  _,
  value: Ref<IssueStatus>,
  control: PresenterControl
): Promise<
  | {
    intlString?: IntlString
    value: any
  }
  | undefined
> => {
  if (value === null || value === undefined) return undefined
  try {
    const status = (await control.findAll(control.ctx, tracker.class.IssueStatus, { _id: value }))[0]
    if (status !== undefined) {
      return {
        value: status.name ?? String(value)
      }
    }
  } catch (e) {
    // ignore
  }
  return { value: String(value) }
}

const priorityKeys: Record<number, any> = {
  [IssuePriority.NoPriority]: tracker.string.NoPriority,
  [IssuePriority.Urgent]: tracker.string.Urgent,
  [IssuePriority.High]: tracker.string.High,
  [IssuePriority.Medium]: tracker.string.Medium,
  [IssuePriority.Low]: tracker.string.Low
}

const issuePriorityPresenter: AttributePresenterFn = async (
  _,
  value: any
): Promise<{
  intlString?: IntlString
  value: any
}> => {
  const priority = Number(value)
  const key = priorityKeys[priority]

  return {
    intlString: key,
    value
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export default async () => ({
  function: {
    IssueIdentifierPresenter: issueIdentifierPresenter,
    IssueUrlPresenter: issueUrlPresenter,
    IssueLinkIdProvider: issueLinkIdProvider,
    IssueStatusPresenter: issueStatusPresenter,
    IssuePriorityPresenter: issuePriorityPresenter,
    TimeSpendReportTitlePresenter: timeSpendReportTitlePresenter
  },
  trigger: {
    OnIssueUpdate,
    OnComponentRemove,
    OnProjectRemove
  }
})
