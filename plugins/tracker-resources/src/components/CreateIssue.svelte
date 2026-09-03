<!--
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
-->
<script lang="ts">
  import activity from '@hcengineering/activity'
  import { Analytics } from '@hcengineering/analytics'
  import { Attachment } from '@hcengineering/attachment'
  import { AttachmentPresenter, AttachmentStyledBox } from '@hcengineering/attachment-resources'
  import { Employee } from '@hcengineering/contact'
  import core, {
    AccountRole,
    Class,
    Doc,
    DocData,
    fillDefaults,
    generateId,
    getCurrentAccount,
    makeCollabId,
    makeDocCollabId,
    type Markup,
    type PersonId,
    Ref,
    SortingOrder,
    toIdMap
  } from '@hcengineering/core'
  import { getResource, translate } from '@hcengineering/platform'
  import preference, { SpacePreference } from '@hcengineering/preference'
  import {
    Card,
    ComponentExtensions,
    createMarkup,
    createQuery,
    DocCreateExtComponent,
    DocCreateExtensionManager,
    DraftController,
    getClient,
    getMarkup,
    KeyedAttribute,
    MessageBox,
    MultipleDraftController,
    SpaceSelector
  } from '@hcengineering/presentation'
  import tags, { type TagElement, TagReference } from '@hcengineering/tags'
  import { TaskType } from '@hcengineering/task'
  import { TaskKindSelector, taskTypeStore } from '@hcengineering/task-resources'
  import { EmptyMarkup, isEmptyMarkup } from '@hcengineering/text'
  import {
    Component as ComponentType,
    Issue,
    IssueDraft,
    IssueParentInfo,
    IssuePriority,
    IssueStatus,
    IssueTemplate,
    Milestone,
    Project,
    ProjectTargetPreference,
    TrackerEvents
  } from '@hcengineering/tracker'
  import {
    addNotification,
    Button,
    ButtonWithDropdown,
    Component,
    createFocusManager,
    DatePresenter,
    EditBox,
    FocusHandler,
    IconAttachment,
    IconDropdown,
    Label,
    navigate,
    showPopup,
    themeStore
  } from '@hcengineering/ui'
  import view, { type ObjectPanel } from '@hcengineering/view'
  import { getObjectLinkFragment, ObjectBox } from '@hcengineering/view-resources'
  import { createEventDispatcher, onDestroy } from 'svelte'

  import { activeComponent, activeMilestone, generateIssueShortLink, updateIssueRelation } from '../issues'
  import tracker from '../plugin'
  import SetParentIssueActionPopup from './SetParentIssueActionPopup.svelte'
  import SubIssues from './SubIssues.svelte'
  import ComponentSelector from './components/ComponentSelector.svelte'
  import AssigneeEditor from './issues/AssigneeEditor.svelte'
  import IssueNotification from './issues/IssueNotification.svelte'
  import ParentIssue from './issues/ParentIssue.svelte'
  import PriorityEditor from './issues/PriorityEditor.svelte'
  import StatusEditor from './issues/StatusEditor.svelte'
  import EstimationEditor from './issues/timereport/EstimationEditor.svelte'
  import MilestoneSelector from './milestones/MilestoneSelector.svelte'
  import ProjectPresenter from './projects/ProjectPresenter.svelte'

  export let space: Ref<Project> | undefined
  export let status: Ref<IssueStatus> | undefined = undefined
  export let priority: IssuePriority | undefined = undefined
  export let assignee: Ref<Employee> | null = null
  export let component: Ref<ComponentType> | null = null
  export let milestone: Ref<Milestone> | null = null
  export let relatedTo: Doc | undefined
  export let shouldSaveDraft: boolean = true
  export let parentIssue: Issue | undefined
  export let originalIssue: Issue | undefined

  const mDraftController = new MultipleDraftController(tracker.ids.IssueDraft)
  const id: Ref<Issue> = generateId()
  const draftController = new DraftController<IssueDraft>(
    shouldSaveDraft ? (mDraftController.getNext() ?? id) : undefined,
    tracker.ids.IssueDraft
  )

  let draft = shouldSaveDraft ? draftController.get() : undefined

  onDestroy(
    draftController.subscribe((val) => {
      draft = shouldSaveDraft ? val : undefined
    })
  )
  const me = getCurrentAccount()
  const client = getClient()
  const hierarchy = client.getHierarchy()
  const parentQuery = createQuery()

  let _space = draft?.space ?? space
  // let project: Project | undefined
  let object = getDefaultObjectFromDraft() ?? getDefaultObject(id)
  let isAssigneeTouched = false
  let kind: Ref<TaskType> | undefined = undefined

  $: if (kind !== undefined && parentIssue !== undefined) {
    const taskType = $taskTypeStore.get(kind)

    if (taskType !== undefined && taskType.allowAnyParent !== true) {
      const allowed = taskType.allowedAsChildOf ?? []
      if (!allowed.includes(parentIssue.kind)) {
        clearParentIssue()
      }
    }
  }

  let templateId: Ref<IssueTemplate> | undefined = draft?.template?.template
  let appliedTemplateId: Ref<IssueTemplate> | undefined = draft?.template?.template

  let template: IssueTemplate | undefined = undefined
  const templateQuery = createQuery()

  function objectChange (object: IssueDraft, empty: any): void {
    if (shouldSaveDraft) {
      draftController.save(object, empty)
    }
  }

  $: if (object.parentIssue !== undefined) {
    parentQuery.query(
      tracker.class.Issue,
      {
        _id: object.parentIssue
      },
      (res) => {
        ;[parentIssue] = res
      }
    )
  } else {
    parentQuery.unsubscribe()
    parentIssue = undefined
  }

  function getDefaultObjectFromDraft (): IssueDraft | undefined {
    if (draft == null) {
      return
    }

    const _parentIssue = parentIssue
    return {
      ...draft,
      ...(status != null ? { status } : {}),
      ...(priority != null ? { priority } : {}),
      ...(assignee != null ? { assignee } : {}),
      ...(component != null ? { component } : {}),
      ...(milestone != null ? { milestone } : {}),
      ...(_parentIssue !== undefined ? { parentIssue: _parentIssue._id } : {})
    }
  }

  function getDefaultObject (id: Ref<Issue> | undefined = undefined, ignoreOriginal = false): IssueDraft {
    const base: IssueDraft = {
      _id: id ?? generateId(),
      title: '',
      description: EmptyMarkup,
      kind: '' as Ref<TaskType>,
      priority: priority ?? IssuePriority.NoPriority,
      space: _space as Ref<Project>,
      component: component ?? $activeComponent ?? null,
      dueDate: null,
      attachments: 0,
      estimation: 0,
      milestone: milestone ?? $activeMilestone ?? null,
      status,
      assignee,
      labels: [],
      parentIssue: parentIssue?._id,
      subIssues: []
    }
    if (originalIssue !== undefined && !ignoreOriginal) {
      const res: IssueDraft = {
        ...base,
        status: originalIssue.status,
        priority: originalIssue.priority,
        component: originalIssue.component,
        dueDate: originalIssue.dueDate,
        assignee: originalIssue.assignee,
        estimation: originalIssue.estimation,
        parentIssue: originalIssue.parents[0]?.parentId,
        title: `${originalIssue.title} (copy)`
      }
      void getMarkup(makeDocCollabId(originalIssue, 'description'), originalIssue.description).then((res) => {
        object.description = res
      })
      void client.findAll(tags.class.TagReference, { attachedTo: originalIssue._id }).then((p) => {
        object.labels = p
      })
      if (originalIssue.relations?.[0] !== undefined) {
        void client.findOne(tracker.class.Issue, { _id: originalIssue.relations[0]._id as Ref<Issue> }).then((p) => {
          relatedTo = p
        })
      }

      return res
    }
    return base
  }
  $: taskType = kind !== undefined ? $taskTypeStore.get(kind) : undefined
  $: issueClass =
    taskType?.targetClass != null && hierarchy.hasClass(taskType.targetClass)
      ? taskType.targetClass
      : (taskType?.ofClass ?? tracker.class.Issue)

  $: fillDefaults(hierarchy, object, issueClass)

  let currentProject: Project | undefined

  let descriptionBox: AttachmentStyledBox | undefined

  $: updateIssueStatusId(object, currentProject)
  $: updateAssigneeId(object, currentProject)
  $: canSave =
    descriptionBox != null &&
    getTitle(object.title ?? '').length > 0 &&
    object.status !== undefined &&
    kind !== undefined &&
    currentProject !== undefined

  $: empty = {
    assignee: assignee ?? currentProject?.defaultAssignee,
    status: status ?? currentProject?.defaultIssueStatus,
    parentIssue: parentIssue?._id,
    description: EmptyMarkup,
    component: component ?? $activeComponent ?? null,
    milestone: milestone ?? $activeMilestone ?? null,
    priority: priority ?? IssuePriority.NoPriority,
    space: _space
  }

  $: objectChange(object, empty)

  $: if (_space !== undefined && object.space !== _space) {
    object.space = _space
  }

  function resetObject (): void {
    templateId = undefined
    template = undefined
    object = getDefaultObject(undefined, true)
    fillDefaults(hierarchy, object, issueClass ?? tracker.class.Issue)
  }

  $: if (templateId !== undefined) {
    templateQuery.query(tracker.class.IssueTemplate, { _id: templateId }, (res) => {
      template = res[0]
    })
  } else {
    template = undefined
    templateQuery.unsubscribe()
  }

  function tagAsRef (tag: TagElement): TagReference {
    return {
      _class: tags.class.TagReference,
      _id: generateId(),
      attachedTo: '' as Ref<Doc>,
      attachedToClass: tracker.class.Issue,
      collection: 'labels',
      space: core.space.Workspace,
      modifiedOn: 0,
      modifiedBy: '' as PersonId,
      title: tag.title,
      tag: tag._id,
      color: tag.color
    }
  }

  async function updateTemplate (template: IssueTemplate): Promise<void> {
    if (object.template?.template === template._id) {
      return
    }
    const { _class, _id, space, children, comments, attachments, labels, description, ...templBase } = template

    const allLabels = new Set<Ref<TagElement>>()
    for (const label of labels ?? []) {
      allLabels.add(label)
    }
    for (const child of children) {
      for (const label of child.labels ?? []) {
        allLabels.add(label)
      }
    }
    const tagElements = toIdMap(await client.findAll(tags.class.TagElement, { _id: { $in: Array.from(allLabels) } }))

    object.subIssues = template.children.map((p) => {
      return {
        ...p,
        kind: p.kind ?? kind ?? ('' as Ref<TaskType>),
        _id: generateId(),
        space: _space as Ref<Project>,
        subIssues: [],
        dueDate: null,
        labels:
          p.labels !== undefined
            ? p.labels
              .map((p) => {
                const val = tagElements.get(p)
                return val !== undefined ? tagAsRef(val) : undefined
              })
              .filter((p) => p !== undefined)
            : [],
        status: currentProject?.defaultIssueStatus
      }
    })

    object = {
      ...object,
      description: description ?? EmptyMarkup,
      ...templBase,
      template: {
        template: template._id
      }
    }
    appliedTemplateId = templateId
    object.labels =
      labels !== undefined
        ? labels
          .map((p) => {
            const val = tagElements.get(p)
            return val !== undefined ? tagAsRef(val) : undefined
          })
          .filter((p) => p !== undefined)
        : []

    if (object.kind !== undefined) {
      kind = object.kind
    }
    fillDefaults(hierarchy, object, issueClass)
  }

  $: if (template !== undefined) {
    void updateTemplate(template)
  }

  const dispatch = createEventDispatcher()
  const spaceQuery = createQuery()

  const key: KeyedAttribute = {
    key: 'labels',
    attr: client.getHierarchy().getAttribute(tracker.class.Issue, 'labels')
  }

  $: if (_space !== undefined) {
    spaceQuery.query(tracker.class.Project, { _id: _space, members: getCurrentAccount().uuid }, (res) => {
      resetDefaultAssigneeId()
      currentProject = res[0]
    })
  } else {
    currentProject = undefined
  }

  const docCreateManager = DocCreateExtensionManager.create(tracker.class.Issue)

  function updateIssueStatusId (object: IssueDraft, currentProject: Project | undefined): void {
    if (currentProject?.defaultIssueStatus !== undefined && object.status === undefined) {
      object.status = currentProject.defaultIssueStatus
    }
  }

  function resetDefaultAssigneeId (): void {
    if (!isAssigneeTouched && !(object.assignee == null) && object.assignee === currentProject?.defaultAssignee) {
      object = { ...object, assignee: assignee ?? null }
    }
  }

  function updateAssigneeId (object: IssueDraft, currentProject: Project | undefined): void {
    if (!isAssigneeTouched && object.assignee == null && currentProject !== undefined) {
      if (currentProject.defaultAssignee !== undefined) {
        object.assignee = currentProject.defaultAssignee
      } else {
        object.assignee = null
      }
    }
  }
  function clearParentIssue (): void {
    object.parentIssue = undefined
    parentQuery.unsubscribe()
    parentIssue = undefined
  }

  function getTitle (value: string): string {
    return value.trim()
  }

  /** Remembers the assistant conversation in the draft, so an unfinished issue reopens with it. */
  function setAssistConversation (id: Ref<Doc> | undefined): void {
    object.assistConversation = id
  }

  /**
   * Apply a draft proposed by the AI assistant. The description goes in through the editor's own
   * setContent, so it lands as a regular transaction and Ctrl+Z undoes it like any other edit -
   * re-creating the editor would throw its history away.
   */
  function applyAssistedDraft (draft: {
    title: string
    description: Markup
    subIssues: string[]
    priority?: number
    estimation?: number
    dueDate?: string
    labels?: string[]
  }): void {
    if (draft.title.trim() !== '') object.title = draft.title
    object.description = draft.description
    descriptionBox?.setContent(draft.description)
    if (draft.priority !== undefined) object.priority = draft.priority as IssuePriority
    if (draft.estimation !== undefined) object.estimation = draft.estimation
    if (draft.dueDate !== undefined) {
      const parsed = Date.parse(draft.dueDate)
      if (!isNaN(parsed)) object.dueDate = parsed
    }
    if (draft.labels !== undefined) void applyAssistedLabels(draft.labels)
    // Reuse existing rows by title, so a re-apply keeps fields the user already filled in.
    const prevByTitle = new Map(object.subIssues.map((s) => [s.title, s]))
    object.subIssues = draft.subIssues.map((title) => {
      const prev = prevByTitle.get(title)
      // Consumed, so two draft rows sharing a title get two objects instead of one aliased twice.
      if (prev !== undefined) {
        prevByTitle.delete(title)
        return prev
      }
      return {
        ...getDefaultObject(generateId()),
        title,
        description: '',
        kind: kind ?? ('' as Ref<TaskType>),
        space: _space as Ref<Project>,
        subIssues: [],
        dueDate: null,
        labels: []
      }
    })
  }

  let subIssuesComponent: SubIssues

  export function canClose (): boolean {
    return true
  }

  export function onOutsideClick (): void {
    if (shouldSaveDraft) {
      draftController.save(object, empty)
    }
  }

  const projectPreferences = createQuery()
  let preferences: ProjectTargetPreference[] = []
  $: projectPreferences.query(tracker.class.ProjectTargetPreference, {}, (res) => {
    preferences = res
  })

  async function updateCurrentProjectPref (currentProject: Ref<Project>): Promise<void> {
    if (me?.role === AccountRole.ReadOnlyGuest || me?.role === AccountRole.Guest) return
    const spacePreferences = await client.findOne(tracker.class.ProjectTargetPreference, { attachedTo: currentProject })
    if (spacePreferences === undefined) {
      await client.createDoc(tracker.class.ProjectTargetPreference, currentProject, {
        attachedTo: currentProject,
        props: [],
        usedOn: Date.now()
      })
    } else {
      if (spacePreferences.usedOn + 60 * 1000 < Date.now()) {
        await client.update(spacePreferences, {
          usedOn: Date.now()
        })
      }
    }
  }

  $: if (_space !== undefined) {
    void updateCurrentProjectPref(_space)
  }

  /** What the last successful create produced; the dropdown actions work on it. */
  let created: { id: Ref<Issue>, identifier: string } | undefined
  // Bumped when the form starts over, so the assistant drops the finished conversation.
  let assistSession = 0

  async function createIssue (): Promise<void> {
    created = undefined
    const _id: Ref<Issue> = generateId()
    if (
      !canSave ||
      object.status === undefined ||
      _space === undefined ||
      kind === undefined ||
      currentProject === undefined
    ) {
      return
    }

    // TODO: We need a measure client and mark all operations with it as measure under one root,
    // to prevent other operations to infer our measurement.
    try {
      const operations = client.apply(undefined, 'tracker.createIssue')

      const incResult = await client.updateDoc(
        tracker.class.Project,
        core.space.Space,
        _space,
        {
          $inc: { sequence: 1 }
        },
        true
      )

      const number = (incResult as any).object.sequence

      const identifier = `${currentProject?.identifier}-${number}`

      const value: DocData<Issue> = {
        title: getTitle(object.title),
        description: null,
        assignee: object.assignee,
        component: object.component,
        milestone: object.milestone,
        number,
        status: object.status,
        priority: object.priority,
        rank: '',
        comments: 0,
        subIssues: 0,
        collaborators: 0,
        dueDate: object.dueDate,
        parents:
          parentIssue != null
            ? [
                {
                  parentId: parentIssue._id,
                  parentTitle: parentIssue.title,
                  space: parentIssue.space,
                  identifier: parentIssue.identifier
                },
                ...parentIssue.parents
              ]
            : [],
        reportedTime: 0,
        remainingTime: 0,
        estimation: object.estimation,
        reports: 0,
        relations: relatedTo !== undefined ? [{ _id: relatedTo._id, _class: relatedTo._class }] : [],
        childInfo: [],
        kind,
        identifier
      }

      if (!isEmptyMarkup(object.description)) {
        const collabId = makeCollabId(issueClass, _id, 'description')
        value.description = await createMarkup(collabId, object.description)
      }

      await docCreateManager.commit(operations, _id, currentProject, value, 'pre')

      await operations.addCollection(
        issueClass,
        _space,
        parentIssue?._id ?? tracker.ids.NoParent,
        parentIssue?._class ?? tracker.class.Issue,
        'subIssues',
        value,
        _id
      )
      await docCreateManager.commit(operations, _id, currentProject, value, 'post')
      for (const label of object.labels) {
        await operations.addCollection(label._class, label.space, _id, issueClass, 'labels', {
          title: label.title,
          color: label.color,
          tag: label.tag
        })
      }

      if (relatedTo !== undefined && client.getHierarchy().isDerived(relatedTo._class, tracker.class.Issue)) {
        // The new issue is not committed yet, so pass its ref directly instead of findOne
        await updateIssueRelation(operations, relatedTo as Issue, { _id, _class: issueClass }, 'relations', '$push')
      }

      await descriptionBox?.createAttachments(_id, operations)
      const result = await operations.commit()

      if (relatedTo !== undefined && !client.getHierarchy().isDerived(relatedTo._class, tracker.class.Issue)) {
        const doc = await client.findOne(issueClass, { _id })
        if (doc !== undefined) {
          const update = await getResource(activity.backreference.Update)
          await update(doc, 'relations', [relatedTo], tracker.string.AddedReference)
        }
      }

      const parents: IssueParentInfo[] =
        parentIssue != null
          ? [
              { parentId: _id, parentTitle: value.title, space: parentIssue.space, identifier },
              {
                parentId: parentIssue._id,
                parentTitle: parentIssue.title,
                space: parentIssue.space,
                identifier: parentIssue.identifier
              },
              ...parentIssue.parents
            ]
          : [{ parentId: _id, parentTitle: value.title, space: _space, identifier }]
      await subIssuesComponent.save(parents, _id)
      addNotification(
        await translate(tracker.string.IssueCreated, {}, $themeStore.language),
        getTitle(object.title),
        IssueNotification,
        {
          issueId: _id,
          subTitlePostfix: (await translate(tracker.string.CreatedOne, {}, $themeStore.language)).toLowerCase(),
          issueUrl: currentProject != null && generateIssueShortLink(value.identifier)
        }
      )

      draftController.remove()
      descriptionBox?.removeDraft(false)
      isAssigneeTouched = false
      const d1 = Date.now()
      const analyticsProps = await docCreateManager.getAnalyticsProps(currentProject, value)
      Analytics.handleEvent(TrackerEvents.IssueCreated, {
        ok: true,
        id: value.identifier,
        project: currentProject.identifier,
        ...analyticsProps
      })
      console.log('createIssue measure', result, Date.now() - d1)
      created = { id: _id, identifier: value.identifier }
    } catch (err: any) {
      resetObject()
      draftController.remove()
      descriptionBox?.removeDraft(false)
      console.error(err)
      Analytics.handleEvent(TrackerEvents.IssueCreated, { ok: false, project: currentProject.identifier })
      Analytics.handleError(err)
    }
  }

  // "Create" alone closes the dialog (Card does that after okAction). These two do something
  // else afterwards, so they run the create themselves.
  async function createAndOpen (): Promise<void> {
    await createIssue()
    if (created === undefined) return
    const issue = await client.findOne(tracker.class.Issue, { _id: created.id })
    dispatch('close')
    if (issue === undefined) return
    const hierarchy = client.getHierarchy()
    // ObjectPanel.component is AnyComponent; tracker's own `Component` class shadows the name here.
    const panel = hierarchy.classHierarchyMixin<Doc, ObjectPanel>(issue._class, view.mixin.ObjectPanel)
    const loc = await getObjectLinkFragment(hierarchy, issue, {}, panel?.component ?? view.component.EditDoc)
    navigate(loc)
  }

  async function createAndNew (): Promise<void> {
    await createIssue()
    if (created === undefined) return
    // Same dialog, empty form: the point is entering several issues in a row. The assistant
    // starts over too - its conversation was about the issue that is now created.
    resetObject()
    objectId = generateId()
    descriptionBox?.removeDraft(false)
    assistSession++
  }

  // Plain "create" is the main button itself, so the dropdown only carries what it cannot do.
  $: createActions = [
    { id: 'create-open', label: tracker.string.CreateAndOpen },
    { id: 'create-new', label: tracker.string.CreateAndNew }
  ]

  /** Only labels that already exist are applied: the assistant must not invent taxonomy. */
  async function applyAssistedLabels (names: string[]): Promise<void> {
    const wanted = names.map((n) => n.trim()).filter((n) => n !== '')
    if (wanted.length === 0) return
    const elements = await client.findAll(tags.class.TagElement, { title: { $in: wanted } })
    const existing = new Set(object.labels.map((l) => l.tag))
    for (const element of elements) {
      if (existing.has(element._id)) continue
      object.labels = [...object.labels, tagAsRef(element)]
    }
  }

  async function setParentIssue (): Promise<void> {
    showPopup(
      SetParentIssueActionPopup,
      { value: { ...object, space: _space, attachedTo: parentIssue?._id }, kind },
      'top',
      (selectedIssue) => {
        if (selectedIssue !== undefined) {
          parentIssue = selectedIssue
          object.parentIssue = parentIssue?._id
        }
      }
    )
  }

  const handleComponentIdChanged = (componentId: Ref<ComponentType> | null | undefined): void => {
    if (componentId === undefined) {
      return
    }

    object.component = componentId
  }

  const handleMilestoneIdChanged = (milestoneId: Ref<Milestone> | null | undefined): void => {
    if (milestoneId === undefined) {
      return
    }

    object.milestone = milestoneId
  }

  function addTagRef (tag: TagElement): void {
    object.labels = [...object.labels, tagAsRef(tag)]
  }
  function handleTemplateChange (evt: CustomEvent<Ref<IssueTemplate>>): void {
    if (templateId == null) {
      templateId = evt.detail
      return
    }
    // Template is already specified, ask to replace.
    showPopup(
      MessageBox,
      {
        label: tracker.string.TemplateReplace,
        message: tracker.string.TemplateReplaceConfirm,
        okLabel: tracker.string.Apply
      },
      'top',
      (result?: boolean) => {
        if (result === true) {
          templateId = evt.detail ?? undefined

          if (templateId === undefined) {
            object.subIssues = []
            resetObject()
          }
        }
      }
    )
  }

  async function showConfirmationDialog (): Promise<void> {
    draftController.save(object, empty)
    const isFormEmpty = draft === undefined

    if (isFormEmpty) {
      dispatch('close')
    } else {
      showPopup(
        MessageBox,
        {
          label: tracker.string.NewIssueDialogClose,
          message: tracker.string.NewIssueDialogCloseNote
        },
        'top',
        (result?: boolean) => {
          if (result === true) {
            dispatch('close')
            resetObject()
            draftController.remove()
            descriptionBox?.removeDraft(true)
          }
        }
      )
    }
  }

  $: objectId = object._id
  const manager = createFocusManager()

  let attachments: Map<Ref<Attachment>, Attachment> = new Map<Ref<Attachment>, Attachment>()

  function isMemberOfProject (project: Project | undefined): boolean {
    if (project == null) return false
    const members = project.members
    if (!Array.isArray(members)) return true
    return members.includes(me.uuid)
  }

  async function findDefaultSpace (): Promise<Project | undefined> {
    let targetRef: Ref<Project> | undefined
    if (relatedTo !== undefined) {
      const targets = await client.findAll(tracker.class.RelatedIssueTarget, {})
      // Find a space target first
      targetRef =
        targets.find((t) => t.rule.kind === 'spaceRule' && t.rule.space === relatedTo?.space && t.target !== undefined)
          ?.target ?? undefined
      // Find a class target as second
      targetRef =
        targetRef ??
        targets.find(
          (t) =>
            t.rule.kind === 'classRule' &&
            client.getHierarchy().isDerived(relatedTo?._class as Ref<Class<Doc>>, t.rule.ofClass)
        )?.target ??
        undefined
    }

    if (targetRef === undefined) {
      // Use last created issue in first.
      const projects = await client.findAll(
        tracker.class.ProjectTargetPreference,
        {},
        { sort: { usedOn: SortingOrder.Descending } }
      )
      if (projects.length > 0) {
        targetRef = projects[0]?.attachedTo
      }
    }

    // Find first starred project
    if (targetRef === undefined) {
      const prefs = await client.findAll<SpacePreference>(
        preference.class.SpacePreference,
        {},
        { sort: { modifiedOn: SortingOrder.Ascending } }
      )
      const projects = await client.findAll<Project>(tracker.class.Project, {
        _id: {
          $in: Array.from(prefs.map((it) => it.attachedTo as Ref<Project>).filter((it) => it != null))
        }
      })
      if (projects.length > 0) {
        const candidate = projects[0]
        return isMemberOfProject(candidate) ? candidate : undefined
      }
    }

    if (targetRef !== undefined) {
      const candidate = await client.findOne(tracker.class.Project, { _id: targetRef })
      return isMemberOfProject(candidate) ? candidate : undefined
    }
  }

  $: extraProps = {
    status: object.status,
    priority: object.priority,
    assignee: object.assignee,
    component: object.component,
    milestone: object.milestone,
    relatedTo,
    parentIssue,
    originalIssue,
    preferences
  }

  $: parentType = parentIssue?.kind
</script>

<FocusHandler {manager} />

<Card
  label={tracker.string.NewIssue}
  okAction={createIssue}
  {canSave}
  okLabel={tracker.string.SaveIssue}
  on:close={() => dispatch('close')}
  onCancel={showConfirmationDialog}
  hideAttachments={attachments.size === 0}
  hideSubheader={parentIssue == null}
  headerNoPadding
  noFade={true}
  on:changeContent
>
  <svelte:fragment slot="header">
    <SpaceSelector
      _class={tracker.class.Project}
      query={{
        archived: false,
        members: getCurrentAccount().uuid
      }}
      label={tracker.string.Project}
      bind:space={_space}
      on:object={(evt) => {
        currentProject = evt.detail ?? undefined
      }}
      kind={'regular'}
      size={'small'}
      component={ProjectPresenter}
      defaultIcon={tracker.icon.Home}
      clearInvalidValue={true}
      {findDefaultSpace}
    />
    <ObjectBox
      _class={tracker.class.IssueTemplate}
      value={templateId}
      docQuery={{
        space: _space
      }}
      on:change={handleTemplateChange}
      kind={'regular'}
      size={'small'}
      label={tracker.string.NoIssueTemplate}
      icon={tracker.icon.IssueTemplates}
      searchField={'title'}
      allowDeselect={true}
      showNavigate={false}
      docProps={{ disabled: true, noUnderline: true }}
      focusIndex={20000}
    />
    <DocCreateExtComponent manager={docCreateManager} kind={'header'} space={currentProject} props={extraProps} />
  </svelte:fragment>
  <svelte:fragment slot="title" let:label>
    <div class="flex-row-center gap-2 pt-1 pb-1 pr-1">
      <span class="overflow-label">
        <Label {label} />
      </span>
      <TaskKindSelector
        projectType={currentProject?.type}
        bind:value={kind}
        {parentType}
        baseClass={tracker.class.Issue}
        size={'small'}
        showAlways={true}
        width="10rem"
      />
      {#if relatedTo}
        <div class="lower mr-2">
          <Label label={tracker.string.RelatedTo} />
        </div>
        <Component
          is={view.component.ObjectPresenter}
          props={{
            value: relatedTo,
            _class: relatedTo._class,
            objectId: relatedTo._id,
            inline: true,
            shouldShowAvatar: false,
            noUnderline: true
          }}
        />
      {/if}
      <DocCreateExtComponent manager={docCreateManager} kind={'title'} space={currentProject} props={extraProps} />
    </div>
  </svelte:fragment>
  <svelte:fragment slot="header-actions">
    <ComponentExtensions extension={tracker.extensions.CreateIssueHeaderActions} />
  </svelte:fragment>
  <svelte:fragment slot="subheader">
    {#if parentIssue}
      <ParentIssue issue={parentIssue} on:close={clearParentIssue} />
    {/if}
  </svelte:fragment>
  <svelte:fragment slot="aside">
    <ComponentExtensions
      extension={tracker.extensions.CreateIssueAssist}
      props={{
        title: object.title,
        description: object.description,
        subIssues: object.subIssues.map((s) => s.title),
        projectName: currentProject?.name,
        objectId: _space,
        objectClass: tracker.class.Project,
        apply: applyAssistedDraft,
        created,
        resultClass: tracker.class.Issue,
        session: assistSession,
        conversationId: object.assistConversation,
        onConversation: setAssistConversation
      }}
    />
  </svelte:fragment>
  <div id="issue-name" class="m-3 clear-mins">
    <EditBox
      focusIndex={1}
      bind:value={object.title}
      placeholder={tracker.string.IssueTitlePlaceholder}
      kind={'large-style'}
      autoFocus
      fullSize
    />
  </div>
  <div id="issue-description">
    {#key [objectId, appliedTemplateId]}
      <AttachmentStyledBox
        bind:this={descriptionBox}
        focusIndex={2}
        objectId={object._id}
        {shouldSaveDraft}
        _class={tracker.class.Issue}
        space={_space}
        alwaysEdit
        showButtons={false}
        kind={'indented'}
        isScrollable={false}
        kitOptions={{ reference: true, leftMenu: false }}
        enableAttachments={false}
        bind:content={object.description}
        placeholder={tracker.string.IssueDescriptionPlaceholder}
        on:changeSize={() => dispatch('changeContent')}
        on:attach={(ev) => {
          if (ev.detail.action === 'saved') {
            object.attachments = ev.detail.value
          }
        }}
        on:attachments={(ev) => {
          if (ev.detail.size > 0) attachments = ev.detail.values
          else if (ev.detail.size === 0 && ev.detail.values != null) {
            attachments.clear()
            attachments = attachments
          }
        }}
      />
    {/key}
  </div>
  {#if _space}
    <SubIssues
      bind:this={subIssuesComponent}
      projectId={_space}
      project={currentProject}
      milestone={object.milestone}
      component={object.component}
      bind:subIssues={object.subIssues}
    />
  {/if}
  <DocCreateExtComponent manager={docCreateManager} kind={'body'} space={currentProject} props={extraProps} />
  <svelte:fragment slot="pool">
    <div id="status-editor">
      {#if kind !== undefined}
        <StatusEditor
          focusIndex={3}
          value={{ ...object, kind }}
          isCreate={true}
          kind={'regular'}
          size={'large'}
          defaultIssueStatus={currentProject?.defaultIssueStatus}
          shouldShowLabel={true}
          short
          on:refocus={() => {
            manager.setFocusPos(3)
          }}
          on:change={({ detail }) => {
            if (object.status !== detail) {
              object.status = detail
            }
          }}
        />
      {/if}
    </div>
    <div id="priority-editor">
      <PriorityEditor
        focusIndex={4}
        value={object}
        shouldShowLabel
        isEditable
        kind={'regular'}
        size={'large'}
        justify="center"
        on:change={({ detail }) => {
          object.priority = detail
          manager.setFocusPos(4)
        }}
      />
    </div>
    <div id="assignee-editor">
      <AssigneeEditor
        focusIndex={5}
        {object}
        kind={'regular'}
        size={'large'}
        short
        on:change={({ detail }) => {
          isAssigneeTouched = true
          object.assignee = detail
          manager.setFocusPos(5)
        }}
      />
    </div>
    <Component
      is={tags.component.TagsDropdownEditor}
      props={{
        focusIndex: 6,
        items: object.labels,
        key,
        targetClass: tracker.class.Issue,
        countLabel: tracker.string.NumberLabels,
        kind: 'regular',
        size: 'large'
      }}
      on:open={(evt) => {
        addTagRef(evt.detail)
      }}
      on:delete={(evt) => {
        object.labels = object.labels.filter((it) => it.tag !== evt.detail._id)
      }}
    />
    <ComponentSelector
      focusIndex={7}
      value={object.component}
      space={_space}
      onChange={handleComponentIdChanged}
      isEditable={true}
      kind={'regular'}
      size={'large'}
    />
    <div id="estimation-editor" class="new-line">
      <EstimationEditor focusIndex={8} kind={'regular'} size={'large'} value={object} />
    </div>
    <div id="milestone-editor" class="new-line">
      <MilestoneSelector
        focusIndex={9}
        value={object.milestone}
        space={_space}
        onChange={handleMilestoneIdChanged}
        kind={'regular'}
        size={'large'}
        short
      />
    </div>
    <div id="duedate-editor" class="new-line">
      <DatePresenter
        focusIndex={10}
        bind:value={object.dueDate}
        labelNull={tracker.string.DueDate}
        kind={'regular'}
        size={'large'}
        editable
      />
    </div>
    <div id="parentissue-editor" class="new-line">
      <Button
        focusIndex={11}
        icon={tracker.icon.Parent}
        label={object.parentIssue != null ? tracker.string.RemoveParent : tracker.string.SetParent}
        kind={'regular'}
        size={'large'}
        notSelected={object.parentIssue === undefined}
        on:click={object.parentIssue != null ? clearParentIssue : setParentIssue}
      />
    </div>
    <DocCreateExtComponent manager={docCreateManager} kind={'pool'} space={currentProject} props={extraProps} />
  </svelte:fragment>
  <svelte:fragment slot="attachments">
    {#if attachments.size > 0}
      {#each Array.from(attachments.values()) as attachment}
        <AttachmentPresenter
          value={attachment}
          showPreview
          removable
          on:remove={(result) => {
            if (result.detail !== undefined) descriptionBox?.removeAttachmentById(result.detail._id)
          }}
        />
      {/each}
    {/if}
  </svelte:fragment>
  <svelte:fragment slot="footer">
    <Button
      focusIndex={12}
      icon={IconAttachment}
      iconProps={{ fill: 'var(--theme-dark-color)' }}
      size={'large'}
      kind={'ghost'}
      on:click={() => {
        descriptionBox?.handleAttach()
      }}
    />
    <DocCreateExtComponent manager={docCreateManager} kind={'footer'} space={currentProject} props={extraProps} />
  </svelte:fragment>
  <svelte:fragment slot="buttons">
    <DocCreateExtComponent manager={docCreateManager} kind={'buttons'} space={currentProject} props={extraProps} />
  </svelte:fragment>
  <!-- Rendered directly, not through DocCreateExtComponent: an extension that replaces the create
       button would drop the create-and-open / create-and-new actions with it. -->
  <svelte:fragment slot="after-buttons" let:handleOkClick let:okProcessing let:canSave let:okLabel>
    <ButtonWithDropdown
      loading={okProcessing}
      disabled={canSave !== true}
      label={okLabel}
      kind={'primary'}
      size={'large'}
      justify={'center'}
      dropdownIcon={IconDropdown}
      dropdownItems={createActions}
      mainButtonId={'issue-create-button'}
      on:click={handleOkClick}
      on:dropdown-selected={(ev) => {
        if (ev.detail === 'create-open') void createAndOpen()
        else if (ev.detail === 'create-new') void createAndNew()
      }}
    />
  </svelte:fragment>
</Card>
