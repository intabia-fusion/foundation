/**
  Copyright © 2026 Intabia Fusion.

  Licensed under the Eclipse Public License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License. You may
  obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

  See the License for the specific language governing permissions and
  limitations under the License.
*/

import {
  type AnyAttribute,
  generateId,
  type Ref,
  type Status,
  type TxOperations,
  type WorkspaceUuid
} from '@hcengineering/core'
import workflow, {
  clearWorkflowConfig,
  exportWorkflowConfig,
  importWorkflowConfig,
  type AttributeConfig,
  type PostFunctionConfig,
  type ProjectWorkflowsConfig,
  type RequestConfig,
  type Screen,
  type ScreenConfig,
  type StatusConfig,
  type ValidatorConfig,
  type Workflow,
  type WorkflowConfig,
  type WorkflowConfigEntry,
  type WorkflowTransition
} from '@hcengineering/workflow'
import task, { type Project, type ProjectType, type TaskType } from '@hcengineering/task'
import tracker from '@hcengineering/tracker'

import {
  connect,
  createIssue,
  createProject,
  createProjectTypeWith,
  expectRejected,
  getStatus,
  setStatus,
  uniqueSuffix,
  type ProjectTypeContext
} from './workflow.fixtures'

const Statuses = ['Backlog', 'Todo', 'InProgress', 'Done']
const wsUuid = 'test-workspace-uuid' as WorkspaceUuid

function makeWorkflow (
  type: ProjectTypeContext,
  opts: {
    id?: Ref<Workflow>
    name: string
    taskTypeName: string
    taskTypeId?: Ref<TaskType>
    initialStatuses?: Ref<Status>[]
    transitions?: Array<{
      id?: Ref<WorkflowTransition>
      name: string
      from: Ref<Status>[] | null
      to: Ref<Status>
      requests?: RequestConfig[]
      validators?: ValidatorConfig[]
      postFunctions?: PostFunctionConfig[]
    }>
  }
): WorkflowConfigEntry {
  return {
    id: opts.id ?? generateId<Workflow>(),
    name: opts.name,
    taskTypeName: opts.taskTypeName,
    taskTypeId: opts.taskTypeId ?? type.taskTypes[opts.taskTypeName] ?? generateId<TaskType>(),
    initialStatuses: opts.initialStatuses,
    transitions: opts.transitions?.map((t) => ({
      id: t.id ?? generateId<WorkflowTransition>(),
      name: t.name,
      from: t.from,
      to: t.to,
      requests: t.requests,
      validators: t.validators,
      postFunctions: t.postFunctions
    }))
  }
}

function makeConfig (
  ptId: Ref<ProjectType>,
  workflows: WorkflowConfigEntry[] = [],
  opts: {
    version?: number
    screens?: ScreenConfig[]
    statuses?: StatusConfig[]
    attributes?: AttributeConfig[]
    projects?: ProjectWorkflowsConfig[]
  } = {}
): WorkflowConfig {
  return {
    version: opts.version ?? 1,
    exportDate: '2026-08-31T00:00:00.000Z',
    workspace: wsUuid,
    projectTypeId: ptId,
    screens: opts.screens,
    statuses: opts.statuses,
    attributes: opts.attributes,
    workflows,
    projects: opts.projects
  }
}

describe('workflow config transfer', () => {
  let client: TxOperations

  beforeAll(async () => {
    client = await connect()
  })

  async function freshType (): Promise<ProjectTypeContext> {
    return await createProjectTypeWith(client, [
      { name: 'Issue', statuses: Statuses },
      { name: 'Bug', statuses: Statuses }
    ])
  }

  function field (key: string): { attribute: Ref<AnyAttribute>, fieldKey: string } {
    const attr = client.getHierarchy().getAttribute(tracker.class.Issue, key)
    return { attribute: attr._id, fieldKey: key }
  }

  describe('workflows', () => {
    it('imports a workflow and finds it by name', async () => {
      const type = await freshType()
      const wfId = generateId<Workflow>()
      const res = await importWorkflowConfig(
        client,
        type.projectTypeId,
        makeConfig(type.projectTypeId, [makeWorkflow(type, { id: wfId, name: 'Main', taskTypeName: 'Issue' })])
      )
      expect(res.workflows[wfId]).toBeDefined()
      const doc = await client.findOne(workflow.class.Workflow, { _id: res.workflows[wfId] })
      expect(doc?.name).toEqual('Main')
      expect(doc?.taskType).toEqual(type.taskTypes.Issue)
      expect(doc?.projectType).toEqual(type.projectTypeId)
    })

    it('imports several workflows at once', async () => {
      const type = await freshType()
      const wfIssuesId = generateId<Workflow>()
      const wfBugsId = generateId<Workflow>()
      const res = await importWorkflowConfig(
        client,
        type.projectTypeId,
        makeConfig(type.projectTypeId, [
          makeWorkflow(type, { id: wfIssuesId, name: 'For issues', taskTypeName: 'Issue' }),
          makeWorkflow(type, { id: wfBugsId, name: 'For bugs', taskTypeName: 'Bug' })
        ])
      )
      expect(Object.keys(res.workflows)).toHaveLength(2)
      expect(res.workflows[wfIssuesId]).toBeDefined()
      expect(res.workflows[wfBugsId]).toBeDefined()
      const docs = await client.findAll(workflow.class.Workflow, { projectType: type.projectTypeId })
      expect(docs.map((d) => d.name).sort()).toEqual(['For bugs', 'For issues'])
    })

    it('imports transitions with their statuses', async () => {
      const type = await freshType()
      const wfId = generateId<Workflow>()
      const res = await importWorkflowConfig(
        client,
        type.projectTypeId,
        makeConfig(type.projectTypeId, [
          makeWorkflow(type, {
            id: wfId,
            name: 'Main',
            taskTypeName: 'Issue',
            transitions: [
              { name: 'Start', from: [type.statuses.Backlog, type.statuses.Todo], to: type.statuses.InProgress }
            ]
          })
        ])
      )
      const transition = await client.findOne(workflow.class.WorkflowTransition, {
        attachedTo: res.workflows[wfId]
      })
      expect(transition?.from).toEqual([type.statuses.Backlog, type.statuses.Todo])
      expect(transition?.to).toEqual(type.statuses.InProgress)
    })

    it('keeps a null "from" as null', async () => {
      const type = await freshType()
      const wfId = generateId<Workflow>()
      const res = await importWorkflowConfig(
        client,
        type.projectTypeId,
        makeConfig(type.projectTypeId, [
          makeWorkflow(type, {
            id: wfId,
            name: 'Main',
            taskTypeName: 'Issue',
            transitions: [{ name: 'Any', from: null, to: type.statuses.Done }]
          })
        ])
      )
      const transition = await client.findOne(workflow.class.WorkflowTransition, { attachedTo: res.workflows[wfId] })
      expect(transition?.from).toBeNull()
    })

    it('imports initial statuses', async () => {
      const type = await freshType()
      const wfId = generateId<Workflow>()
      const res = await importWorkflowConfig(
        client,
        type.projectTypeId,
        makeConfig(type.projectTypeId, [
          makeWorkflow(type, {
            id: wfId,
            name: 'Main',
            taskTypeName: 'Issue',
            initialStatuses: [type.statuses.Backlog, type.statuses.Todo]
          })
        ])
      )
      const doc = await client.findOne(workflow.class.Workflow, { _id: res.workflows[wfId] })
      expect(doc?.initialStatuses).toEqual([type.statuses.Backlog, type.statuses.Todo])
    })

    it('keeps the order of transitions', async () => {
      const type = await freshType()
      const wfId = generateId<Workflow>()
      const res = await importWorkflowConfig(
        client,
        type.projectTypeId,
        makeConfig(type.projectTypeId, [
          makeWorkflow(type, {
            id: wfId,
            name: 'Main',
            taskTypeName: 'Issue',
            transitions: [
              { name: 'First', from: [type.statuses.Backlog], to: type.statuses.Todo },
              { name: 'Second', from: [type.statuses.Todo], to: type.statuses.InProgress },
              { name: 'Third', from: [type.statuses.InProgress], to: type.statuses.Done }
            ]
          })
        ])
      )
      const transitions = await client.findAll(
        workflow.class.WorkflowTransition,
        { attachedTo: res.workflows[wfId] },
        { sort: { rank: 1 } }
      )
      expect(transitions.map((t) => t.name)).toEqual(['First', 'Second', 'Third'])
    })

    it('reuses a workflow with the same name instead of duplicating it', async () => {
      const type = await freshType()
      const wfId = generateId<Workflow>()
      const config = makeConfig(type.projectTypeId, [
        makeWorkflow(type, { id: wfId, name: 'Main', taskTypeName: 'Issue' })
      ])
      const first = await importWorkflowConfig(client, type.projectTypeId, config)
      const second = await importWorkflowConfig(client, type.projectTypeId, config)
      expect(second.workflows[wfId]).toEqual(first.workflows[wfId])
      const docs = await client.findAll(workflow.class.Workflow, { projectType: type.projectTypeId, name: 'Main' })
      expect(docs).toHaveLength(1)
    })

    it('rejects an unknown task type', async () => {
      const type = await freshType()
      const err = await expectRejected(async () => {
        await importWorkflowConfig(
          client,
          type.projectTypeId,
          makeConfig(type.projectTypeId, [
            {
              id: generateId<Workflow>(),
              name: 'Main',
              taskTypeName: 'Epic',
              taskTypeId: generateId<TaskType>()
            }
          ])
        )
      })
      expect(err).toContain('unknown task type "Epic"')
    })

    it('rejects an unknown status', async () => {
      const type = await freshType()
      const err = await expectRejected(async () => {
        await importWorkflowConfig(
          client,
          type.projectTypeId,
          makeConfig(type.projectTypeId, [
            makeWorkflow(type, {
              name: 'Main',
              taskTypeName: 'Issue',
              transitions: [{ name: 'Bad', from: [type.statuses.Backlog], to: 'status-shipped' as Ref<Status> }]
            })
          ])
        )
      })
      expect(err).toContain('unknown status "status-shipped"')
    })

    it('rejects an unknown initial status', async () => {
      const type = await freshType()
      const err = await expectRejected(async () => {
        await importWorkflowConfig(
          client,
          type.projectTypeId,
          makeConfig(type.projectTypeId, [
            makeWorkflow(type, {
              name: 'Main',
              taskTypeName: 'Issue',
              initialStatuses: ['status-nope' as Ref<Status>]
            })
          ])
        )
      })
      expect(err).toContain('unknown status "status-nope"')
    })

    it('rejects an unsupported config version', async () => {
      const type = await freshType()
      const err = await expectRejected(async () => {
        await importWorkflowConfig(client, type.projectTypeId, makeConfig(type.projectTypeId, [], { version: 99 }))
      })
      expect(err).toContain('unsupported version 99')
    })
  })

  describe('project mapping', () => {
    it('binds a workflow to a project by identifier', async () => {
      const type = await freshType()
      const ctx = await createProject(type, 'Backlog')
      const wfId = generateId<Workflow>()
      const res = await importWorkflowConfig(
        client,
        type.projectTypeId,
        makeConfig(type.projectTypeId, [makeWorkflow(type, { id: wfId, name: 'Main', taskTypeName: 'Issue' })], {
          projects: [{ project: ctx.projectId, identifier: ctx.identifier, workflows: { Issue: 'Main' } }]
        })
      )
      const project = await client.findOne(task.class.Project, { _id: ctx.projectId })
      const mapping = client.getHierarchy().as(project as Project, workflow.mixin.ProjectWorkflow).workflows
      expect(mapping?.[type.taskTypes.Issue]).toEqual(res.workflows[wfId])
    })

    it('binds two task types of one project', async () => {
      const type = await freshType()
      const ctx = await createProject(type, 'Backlog')
      const wfIssuesId = generateId<Workflow>()
      const wfBugsId = generateId<Workflow>()
      const res = await importWorkflowConfig(
        client,
        type.projectTypeId,
        makeConfig(
          type.projectTypeId,
          [
            makeWorkflow(type, { id: wfIssuesId, name: 'For issues', taskTypeName: 'Issue' }),
            makeWorkflow(type, { id: wfBugsId, name: 'For bugs', taskTypeName: 'Bug' })
          ],
          {
            projects: [
              {
                project: ctx.projectId,
                identifier: ctx.identifier,
                workflows: { Issue: 'For issues', Bug: 'For bugs' }
              }
            ]
          }
        )
      )
      const project = await client.findOne(task.class.Project, { _id: ctx.projectId })
      const mapping = client.getHierarchy().as(project as Project, workflow.mixin.ProjectWorkflow).workflows
      expect(mapping?.[type.taskTypes.Issue]).toEqual(res.workflows[wfIssuesId])
      expect(mapping?.[type.taskTypes.Bug]).toEqual(res.workflows[wfBugsId])
    })

    it('binds one workflow to two projects', async () => {
      const type = await freshType()
      const first = await createProject(type, 'Backlog')
      const second = await createProject(type, 'Backlog')
      const wfId = generateId<Workflow>()
      const res = await importWorkflowConfig(
        client,
        type.projectTypeId,
        makeConfig(type.projectTypeId, [makeWorkflow(type, { id: wfId, name: 'Main', taskTypeName: 'Issue' })], {
          projects: [
            { project: first.projectId, identifier: first.identifier, workflows: { Issue: 'Main' } },
            { project: second.projectId, identifier: second.identifier, workflows: { Issue: 'Main' } }
          ]
        })
      )
      for (const ctx of [first, second]) {
        const project = await client.findOne(task.class.Project, { _id: ctx.projectId })
        const mapping = client.getHierarchy().as(project as Project, workflow.mixin.ProjectWorkflow).workflows
        expect(mapping?.[type.taskTypes.Issue]).toEqual(res.workflows[wfId])
      }
    })

    it('rejects an unknown project identifier', async () => {
      const type = await freshType()
      const err = await expectRejected(async () => {
        await importWorkflowConfig(
          client,
          type.projectTypeId,
          makeConfig(type.projectTypeId, [makeWorkflow(type, { name: 'Main', taskTypeName: 'Issue' })], {
            projects: [{ project: generateId<Project>(), identifier: 'NOSUCH', workflows: { Issue: 'Main' } }]
          })
        )
      })
      expect(err).toContain('unknown project "NOSUCH"')
    })

    it('rejects a mapping to a workflow that is not in the config', async () => {
      const type = await freshType()
      const ctx = await createProject(type, 'Backlog')
      const err = await expectRejected(async () => {
        await importWorkflowConfig(
          client,
          type.projectTypeId,
          makeConfig(type.projectTypeId, [makeWorkflow(type, { name: 'Main', taskTypeName: 'Issue' })], {
            projects: [{ project: ctx.projectId, identifier: ctx.identifier, workflows: { Issue: 'Other' } }]
          })
        )
      })
      expect(err).toContain('unknown workflow "Other"')
    })

    it('takes effect immediately on the running workspace', async () => {
      const type = await freshType()
      const ctx = await createProject(type, 'Backlog')
      await importWorkflowConfig(
        client,
        type.projectTypeId,
        makeConfig(
          type.projectTypeId,
          [
            makeWorkflow(type, {
              name: 'Main',
              taskTypeName: 'Issue',
              transitions: [{ name: 'Start', from: [type.statuses.Backlog], to: type.statuses.Todo }]
            })
          ],
          { projects: [{ project: ctx.projectId, identifier: ctx.identifier, workflows: { Issue: 'Main' } }] }
        )
      )
      const issue = await createIssue(ctx, { status: 'Backlog' })
      await setStatus(ctx, issue, 'Todo')
      expect(await getStatus(ctx, issue)).toEqual('Todo')
      const err = await expectRejected(async () => {
        await setStatus(ctx, issue, 'Done')
      })
      expect(err).toContain('ForbiddenTransition')
    })
  })

  describe('screens', () => {
    const screenId = 'screen-closing' as Ref<Screen>
    const screenConfig: ScreenConfig = {
      id: screenId,
      name: 'Closing screen',
      description: 'Fields to fill when closing',
      targetClass: tracker.class.Issue,
      tabs: [
        {
          name: 'General',
          fields: [
            { attribute: '' as Ref<AnyAttribute>, fieldKey: '', required: true },
            { attribute: '' as Ref<AnyAttribute>, fieldKey: '', required: false }
          ]
        }
      ]
    }

    function config (ctx: ProjectTypeContext): { conf: WorkflowConfig, wfId: Ref<Workflow> } {
      const wfId = generateId<Workflow>()
      return {
        wfId,
        conf: makeConfig(ctx.projectTypeId, [makeWorkflow(ctx, { id: wfId, name: 'Main', taskTypeName: 'Issue' })], {
          screens: [
            {
              ...screenConfig,
              tabs: [
                {
                  name: 'General',
                  fields: [
                    { ...field('dueDate'), required: true },
                    { ...field('estimation'), required: false }
                  ]
                }
              ]
            }
          ]
        })
      }
    }

    it('imports a screen with its tabs and fields', async () => {
      const type = await freshType()
      const { conf } = config(type)
      const res = await importWorkflowConfig(client, type.projectTypeId, conf)
      const screen = await client.findOne(workflow.class.Screen, { _id: res.screens[screenId] })
      expect(screen?.name).toEqual('Closing screen')
      expect(screen?.description).toEqual('Fields to fill when closing')
      expect(screen?.targetClass).toEqual(tracker.class.Issue)

      const tabs = await client.findAll(workflow.class.ScreenTab, { attachedTo: screen?._id })
      expect(tabs).toHaveLength(1)
      const fields = await client.findAll(
        workflow.class.ScreenField,
        { attachedTo: tabs[0]._id },
        { sort: { rank: 1 } }
      )
      expect(fields.map((f) => f.fieldKey)).toEqual(['dueDate', 'estimation'])
      expect(fields.map((f) => f.required)).toEqual([true, false])
    })

    it('reuses a screen with the same name', async () => {
      const type = await freshType()
      const { conf } = config(type)
      const first = await importWorkflowConfig(client, type.projectTypeId, conf)
      const second = await importWorkflowConfig(client, type.projectTypeId, conf)
      expect(second.screens[screenId]).toEqual(first.screens[screenId])
      const screens = await client.findAll(workflow.class.Screen, { projectType: type.projectTypeId })
      expect(screens).toHaveLength(1)
    })

    it('resolves a screen reference inside a transition rule', async () => {
      const type = await freshType()
      const { conf, wfId } = config(type)
      conf.workflows = [
        makeWorkflow(type, {
          id: wfId,
          name: 'Main',
          taskTypeName: 'Issue',
          transitions: [
            {
              name: 'Close',
              from: [type.statuses.Backlog],
              to: type.statuses.Done,
              requests: [
                {
                  id: 'req-screen-1',
                  rule: workflow.request.ScreenRequest,
                  ruleClass: workflow.class.WorkflowRequest,
                  props: { screen: '$screen:Closing screen' }
                }
              ]
            }
          ]
        })
      ]
      const res = await importWorkflowConfig(client, type.projectTypeId, conf)
      const transition = await client.findOne(workflow.class.WorkflowTransition, { attachedTo: res.workflows[wfId] })
      expect(transition?.requests?.[0].props.screen).toEqual(res.screens[screenId])
    })

    it('rejects an unknown screen reference', async () => {
      const type = await freshType()
      const err = await expectRejected(async () => {
        await importWorkflowConfig(
          client,
          type.projectTypeId,
          makeConfig(type.projectTypeId, [
            makeWorkflow(type, {
              name: 'Main',
              taskTypeName: 'Issue',
              transitions: [
                {
                  name: 'Close',
                  from: [type.statuses.Backlog],
                  to: type.statuses.Done,
                  requests: [
                    {
                      id: 'req-screen-missing',
                      rule: workflow.request.ScreenRequest,
                      ruleClass: workflow.class.WorkflowRequest,
                      props: { screen: '$screen:Missing' }
                    }
                  ]
                }
              ]
            })
          ])
        )
      })
      expect(err).toContain('unresolved references $screen:Missing')
    })
  })

  describe('rule references', () => {
    it('resolves statuses and task types inside validator props', async () => {
      const type = await freshType()
      const wfId = generateId<Workflow>()
      const res = await importWorkflowConfig(
        client,
        type.projectTypeId,
        makeConfig(type.projectTypeId, [
          makeWorkflow(type, {
            id: wfId,
            name: 'Main',
            taskTypeName: 'Issue',
            transitions: [
              {
                name: 'Close',
                from: [type.statuses.Backlog],
                to: type.statuses.Done,
                validators: [
                  {
                    id: 'val-subtask-1',
                    rule: workflow.validator.SubtaskStatus,
                    ruleClass: workflow.class.WorkflowValidator,
                    props: { statuses: { '$taskType:Bug': ['$status:Done'] } }
                  }
                ]
              }
            ]
          })
        ])
      )
      const transition = await client.findOne(workflow.class.WorkflowTransition, { attachedTo: res.workflows[wfId] })
      const statuses = transition?.validators?.[0].props.statuses
      expect(statuses[type.taskTypes.Bug]).toEqual([type.statuses.Done])
    })

    it('keeps a null entry of a status map', async () => {
      const type = await freshType()
      const wfId = generateId<Workflow>()
      const res = await importWorkflowConfig(
        client,
        type.projectTypeId,
        makeConfig(type.projectTypeId, [
          makeWorkflow(type, {
            id: wfId,
            name: 'Main',
            taskTypeName: 'Issue',
            transitions: [
              {
                name: 'Close',
                from: [type.statuses.Backlog],
                to: type.statuses.Done,
                validators: [
                  {
                    id: 'val-parent-1',
                    rule: workflow.validator.ParentStatus,
                    ruleClass: workflow.class.WorkflowValidator,
                    props: { statuses: { '$taskType:Issue': null } }
                  }
                ]
              }
            ]
          })
        ])
      )
      const transition = await client.findOne(workflow.class.WorkflowTransition, { attachedTo: res.workflows[wfId] })
      expect(transition?.validators?.[0].props.statuses[type.taskTypes.Issue]).toBeNull()
    })

    it('leaves attribute references untouched', async () => {
      const type = await freshType()
      const wfId = generateId<Workflow>()
      const res = await importWorkflowConfig(
        client,
        type.projectTypeId,
        makeConfig(type.projectTypeId, [
          makeWorkflow(type, {
            id: wfId,
            name: 'Main',
            taskTypeName: 'Issue',
            transitions: [
              {
                name: 'Close',
                from: [type.statuses.Backlog],
                to: type.statuses.Done,
                validators: [
                  {
                    id: 'val-field-1',
                    rule: workflow.validator.FieldRequired,
                    ruleClass: workflow.class.WorkflowValidator,
                    props: { fields: [field('dueDate')] }
                  }
                ]
              }
            ]
          })
        ])
      )
      const transition = await client.findOne(workflow.class.WorkflowTransition, { attachedTo: res.workflows[wfId] })
      expect(transition?.validators?.[0].props.fields[0]).toEqual(field('dueDate'))
    })

    it('gives every imported rule an id', async () => {
      const type = await freshType()
      const wfId = generateId<Workflow>()
      const res = await importWorkflowConfig(
        client,
        type.projectTypeId,
        makeConfig(type.projectTypeId, [
          makeWorkflow(type, {
            id: wfId,
            name: 'Main',
            taskTypeName: 'Issue',
            transitions: [
              {
                name: 'Close',
                from: [type.statuses.Backlog],
                to: type.statuses.Done,
                validators: [
                  {
                    id: 'val-rule-id-1',
                    rule: workflow.validator.FieldRequired,
                    ruleClass: workflow.class.WorkflowValidator,
                    props: { fields: [field('dueDate')] }
                  }
                ]
              }
            ]
          })
        ])
      )
      const transition = await client.findOne(workflow.class.WorkflowTransition, { attachedTo: res.workflows[wfId] })
      expect(transition?.validators?.[0].id).toBeTruthy()
    })
  })

  describe('export', () => {
    it('exports an empty project type', async () => {
      const type = await freshType()
      const config = await exportWorkflowConfig(client, type.projectTypeId, {
        workspace: wsUuid,
        projectTypeId: generateId()
      })
      expect(config.version).toEqual(1)
      expect(config.workflows).toEqual([])
      expect(config.screens).toBeUndefined()
      expect(config.projects).toBeUndefined()
    })

    it('exports workflows by task type name', async () => {
      const type = await freshType()
      await importWorkflowConfig(
        client,
        type.projectTypeId,
        makeConfig(type.projectTypeId, [makeWorkflow(type, { name: 'Main', taskTypeName: 'Bug' })])
      )
      const config = await exportWorkflowConfig(client, type.projectTypeId, {
        workspace: wsUuid,
        projectTypeId: generateId()
      })
      expect(config.workflows).toHaveLength(1)
      expect(config.workflows[0].taskTypeName).toEqual('Bug')
    })

    it('exports transitions by status name', async () => {
      const type = await freshType()
      await importWorkflowConfig(
        client,
        type.projectTypeId,
        makeConfig(type.projectTypeId, [
          makeWorkflow(type, {
            name: 'Main',
            taskTypeName: 'Issue',
            transitions: [
              { name: 'Start', from: [type.statuses.Backlog, type.statuses.Todo], to: type.statuses.InProgress }
            ]
          })
        ])
      )
      const config = await exportWorkflowConfig(client, type.projectTypeId, {
        workspace: wsUuid,
        projectTypeId: generateId()
      })
      expect(config.workflows[0].transitions).toEqual([
        { id: expect.any(String), name: 'Start', from: ['Backlog', 'Todo'], to: 'InProgress' }
      ])
    })

    it('exports the project mapping by identifier', async () => {
      const type = await freshType()
      const ctx = await createProject(type, 'Backlog')
      await importWorkflowConfig(
        client,
        type.projectTypeId,
        makeConfig(type.projectTypeId, [makeWorkflow(type, { name: 'Main', taskTypeName: 'Issue' })], {
          projects: [{ project: ctx.projectId, identifier: ctx.identifier, workflows: { Issue: 'Main' } }]
        })
      )
      const config = await exportWorkflowConfig(client, type.projectTypeId, {
        workspace: wsUuid,
        projectTypeId: generateId()
      })
      expect(config.projects).toEqual([
        { project: ctx.projectId, identifier: ctx.identifier, workflows: { Issue: 'Main' } }
      ])
    })

    it('exports rule props back into name tokens', async () => {
      const type = await freshType()
      await importWorkflowConfig(
        client,
        type.projectTypeId,
        makeConfig(type.projectTypeId, [
          makeWorkflow(type, {
            name: 'Main',
            taskTypeName: 'Issue',
            transitions: [
              {
                name: 'Close',
                from: [type.statuses.Backlog],
                to: type.statuses.Done,
                validators: [
                  {
                    id: 'val-1',
                    rule: workflow.validator.SubtaskStatus,
                    ruleClass: workflow.class.WorkflowValidator,
                    props: { statuses: { '$taskType:Bug': ['$status:Done'] } }
                  }
                ]
              }
            ]
          })
        ])
      )
      const config = await exportWorkflowConfig(client, type.projectTypeId, {
        workspace: wsUuid,
        projectTypeId: generateId()
      })
      const props = config.workflows[0].transitions?.[0].validators?.[0].props
      expect(props?.statuses).toEqual({ '$taskType:Bug': ['$status:Done'] })
    })

    it('exports screens with their fields', async () => {
      const type = await freshType()
      await importWorkflowConfig(
        client,
        type.projectTypeId,
        makeConfig(type.projectTypeId, [], {
          screens: [
            {
              id: 'screen-closing' as Ref<Screen>,
              name: 'Closing screen',
              targetClass: tracker.class.Issue,
              tabs: [{ name: 'General', fields: [{ ...field('dueDate'), required: true }] }]
            }
          ]
        })
      )
      const config = await exportWorkflowConfig(client, type.projectTypeId, {
        workspace: wsUuid,
        projectTypeId: generateId()
      })
      expect(config.screens).toHaveLength(1)
      expect(config.screens?.[0].tabs?.[0].fields?.[0]).toEqual({
        ...field('dueDate'),
        mixin: undefined,
        required: true
      })
    })
  })

  describe('round trip', () => {
    const full = (
      identifier: string,
      projectId: Ref<Project>,
      ptId: Ref<ProjectType>,
      ctx: ProjectTypeContext
    ): WorkflowConfig => ({
      version: 1,
      exportDate: '2026-08-31T00:00:00.000Z',
      workspace: wsUuid,
      projectTypeId: ptId,
      screens: [
        {
          id: 'screen-closing' as Ref<Screen>,
          name: 'Closing screen',
          description: 'Fill before closing',
          targetClass: tracker.class.Issue,
          tabs: [{ name: 'General', fields: [{ ...field('dueDate'), required: true }] }]
        }
      ],
      workflows: [
        makeWorkflow(ctx, {
          id: 'wf-main' as Ref<Workflow>,
          name: 'Main',
          taskTypeName: 'Issue',
          taskTypeId: ctx.taskTypes.Issue,
          initialStatuses: [ctx.statuses.Backlog],
          transitions: [
            {
              id: 'trans-plan' as Ref<WorkflowTransition>,
              name: 'Plan',
              from: [ctx.statuses.Backlog],
              to: ctx.statuses.Todo
            },
            {
              id: 'trans-start' as Ref<WorkflowTransition>,
              name: 'Start',
              from: [ctx.statuses.Todo],
              to: ctx.statuses.InProgress
            },
            {
              id: 'trans-close' as Ref<WorkflowTransition>,
              name: 'Close',
              from: null,
              to: ctx.statuses.Done,
              requests: [
                {
                  id: 'req-screen-close',
                  rule: workflow.request.ScreenRequest,
                  ruleClass: workflow.class.WorkflowRequest,
                  props: { screen: '$screen:Closing screen' }
                }
              ],
              validators: [
                {
                  id: 'val-subtask-bug',
                  rule: workflow.validator.SubtaskStatus,
                  ruleClass: workflow.class.WorkflowValidator,
                  props: { statuses: { '$taskType:Bug': ['$status:Done'] } }
                }
              ]
            }
          ]
        }),
        makeWorkflow(ctx, {
          id: 'wf-bugs' as Ref<Workflow>,
          name: 'Bugs',
          taskTypeName: 'Bug',
          taskTypeId: ctx.taskTypes.Bug,
          transitions: [
            {
              id: 'trans-fix' as Ref<WorkflowTransition>,
              name: 'Fix',
              from: [ctx.statuses.Backlog],
              to: ctx.statuses.Done
            }
          ]
        })
      ],
      projects: [{ project: projectId, identifier, workflows: { Issue: 'Main', Bug: 'Bugs' } }]
    })

    it('exports what it imported', async () => {
      const type = await freshType()
      const ctx = await createProject(type, 'Backlog')
      const source = full(ctx.identifier, ctx.projectId, type.projectTypeId, type)
      await importWorkflowConfig(client, type.projectTypeId, source)
      const exported = await exportWorkflowConfig(client, type.projectTypeId, {
        workspace: wsUuid,
        projectTypeId: generateId()
      })

      expect(exported.workflows.map((w: any) => w.name).sort((a: string, b: string) => a.localeCompare(b))).toEqual([
        'Bugs',
        'Main'
      ])
      const main = exported.workflows.find((w: any) => w.name === 'Main')
      expect(main?.initialStatuses).toEqual(['Backlog'])
      expect(main?.transitions?.map((t: any) => t.name)).toEqual(['Plan', 'Start', 'Close'])
      expect(main?.transitions?.[2].from).toBeNull()
      expect(exported.projects).toEqual([
        { project: ctx.projectId, identifier: ctx.identifier, workflows: { Issue: 'Main', Bug: 'Bugs' } }
      ])
      expect(exported.screens?.[0].name).toEqual('Closing screen')
    })

    it('reimports an exported config into a second project type', async () => {
      const source = await freshType()
      const sourceCtx = await createProject(source, 'Backlog')
      await importWorkflowConfig(
        client,
        source.projectTypeId,
        full(sourceCtx.identifier, sourceCtx.projectId, source.projectTypeId, source)
      )
      const exported = await exportWorkflowConfig(client, source.projectTypeId, {
        workspace: wsUuid,
        projectTypeId: generateId()
      })

      const target = await freshType()
      const targetCtx = await createProject(target, 'Backlog')
      const retargeted: WorkflowConfig = {
        ...exported,
        projectTypeId: target.projectTypeId,
        projects: [
          { project: targetCtx.projectId, identifier: targetCtx.identifier, workflows: { Issue: 'Main', Bug: 'Bugs' } }
        ]
      }
      await importWorkflowConfig(client, target.projectTypeId, retargeted)

      const reexported = await exportWorkflowConfig(client, target.projectTypeId, {
        workspace: wsUuid,
        projectTypeId: generateId()
      })
      expect(reexported.workflows.map((w: any) => w.name).sort((a: string, b: string) => a.localeCompare(b))).toEqual([
        'Bugs',
        'Main'
      ])
      const main = reexported.workflows.find((w: any) => w.name === 'Main')
      expect(main?.transitions?.map((t: any) => t.to)).toEqual(['Todo', 'InProgress', 'Done'])
      expect(main?.transitions?.[2].validators?.[0].props.statuses).toEqual({ '$taskType:Bug': ['$status:Done'] })
      // Two project types plus two projects: the default 5s is not enough on CI.
    }, 60000)

    it('produces a working workflow in the second project type', async () => {
      const source = await freshType()
      const sourceCtx = await createProject(source, 'Backlog')
      await importWorkflowConfig(
        client,
        source.projectTypeId,
        full(sourceCtx.identifier, sourceCtx.projectId, source.projectTypeId, source)
      )
      const exported = await exportWorkflowConfig(client, source.projectTypeId, {
        workspace: wsUuid,
        projectTypeId: generateId()
      })

      const target = await freshType()
      const targetCtx = await createProject(target, 'Backlog')
      const retargeted: WorkflowConfig = {
        ...exported,
        projectTypeId: target.projectTypeId,
        projects: [{ project: targetCtx.projectId, identifier: targetCtx.identifier, workflows: { Issue: 'Main' } }]
      }
      await importWorkflowConfig(client, target.projectTypeId, retargeted)

      const issue = await createIssue(targetCtx, { status: 'Backlog' })
      await setStatus(targetCtx, issue, 'Todo')
      expect(await getStatus(targetCtx, issue)).toEqual('Todo')
      // The config has no edge back from Todo, so the imported graph must reject it.
      const err = await expectRejected(async () => {
        await setStatus(targetCtx, issue, 'Backlog')
      })
      expect(err).toContain('ForbiddenTransition')
    }, 60000)

    it('survives a JSON round trip', async () => {
      const type = await freshType()
      const ctx = await createProject(type, 'Backlog')
      await importWorkflowConfig(
        client,
        type.projectTypeId,
        full(ctx.identifier, ctx.projectId, type.projectTypeId, type)
      )
      const exported = await exportWorkflowConfig(client, type.projectTypeId, {
        workspace: wsUuid,
        projectTypeId: generateId()
      })
      const revived: WorkflowConfig = JSON.parse(JSON.stringify(exported))
      expect(revived.workflows).toHaveLength(2)

      const target = await freshType()
      const res = await importWorkflowConfig(client, target.projectTypeId, {
        ...revived,
        projectTypeId: target.projectTypeId,
        projects: undefined
      })
      expect(Object.keys(res.workflows).sort()).toEqual(revived.workflows.map((w) => w.id).sort())
    })
  })

  describe('clear', () => {
    it('removes every workflow and screen of the project type', async () => {
      const type = await freshType()
      await importWorkflowConfig(
        client,
        type.projectTypeId,
        makeConfig(
          type.projectTypeId,
          [
            makeWorkflow(type, {
              name: 'Main',
              taskTypeName: 'Issue',
              transitions: [{ name: 'A', from: null, to: type.statuses.Done }]
            })
          ],
          {
            screens: [
              {
                id: 'screen-s' as Ref<Screen>,
                name: 'S',
                targetClass: tracker.class.Issue,
                tabs: [{ name: 'General' }]
              }
            ]
          }
        )
      )
      await clearWorkflowConfig(client, type.projectTypeId)
      expect(await client.findAll(workflow.class.Workflow, { projectType: type.projectTypeId })).toHaveLength(0)
      expect(await client.findAll(workflow.class.Screen, { projectType: type.projectTypeId })).toHaveLength(0)
    })

    it('leaves another project type alone', async () => {
      const kept = await freshType()
      const dropped = await freshType()
      for (const type of [kept, dropped]) {
        await importWorkflowConfig(
          client,
          type.projectTypeId,
          makeConfig(type.projectTypeId, [
            makeWorkflow(type, { name: `Main ${uniqueSuffix()}`, taskTypeName: 'Issue' })
          ])
        )
      }
      await clearWorkflowConfig(client, dropped.projectTypeId)
      expect(await client.findAll(workflow.class.Workflow, { projectType: kept.projectTypeId })).toHaveLength(1)
    })

    it('lets a fresh config be imported afterwards', async () => {
      const type = await freshType()
      const wfIdA = generateId<Workflow>()
      const wfIdB = generateId<Workflow>()
      await importWorkflowConfig(
        client,
        type.projectTypeId,
        makeConfig(type.projectTypeId, [
          makeWorkflow(type, {
            id: wfIdA,
            name: 'Main',
            taskTypeName: 'Issue',
            transitions: [{ name: 'A', from: [type.statuses.Backlog], to: type.statuses.Todo }]
          })
        ])
      )
      await clearWorkflowConfig(client, type.projectTypeId)
      const res = await importWorkflowConfig(
        client,
        type.projectTypeId,
        makeConfig(type.projectTypeId, [
          makeWorkflow(type, {
            id: wfIdB,
            name: 'Main',
            taskTypeName: 'Issue',
            transitions: [{ name: 'B', from: [type.statuses.Backlog], to: type.statuses.Done }]
          })
        ])
      )
      const transitions = await client.findAll(workflow.class.WorkflowTransition, { attachedTo: res.workflows[wfIdB] })
      expect(transitions.map((t) => t.name)).toEqual(['B'])
    })
  })
})
