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

import type { Client } from '@hcengineering/core'
import { getEmbeddedLabel, type IntlString, type Resources } from '@hcengineering/platform'
import type { PresentationMiddleware } from '@hcengineering/presentation'

import ProjectTypeWorkflowsSectionEditor from './components/ProjectTypeWorkflowsSectionEditor.svelte'
import ProjectTypeScreensSectionEditor from './components/ProjectTypeScreensSectionEditor.svelte'
import WorkflowEditor from './components/editor/WorkflowEditor.svelte'
import WorkflowDiagramPopup from './components/editor/WorkflowDiagramPopup.svelte'
import ScreenEditor from './components/screen/ScreenEditor.svelte'
import ScreenRequestEditor from './components/requests/editors/ScreenRequestEditor.svelte'
import ScreenRequestPresenter from './components/requests/presenters/ScreenRequestPresenter.svelte'
import FieldRequired from './components/validators/editors/FieldRequared.svelte'
import SubtaskStatus from './components/validators/editors/SubtaskStatus.svelte'
import ParentStatus from './components/validators/editors/ParentStatus.svelte'
import FieldRequiredPresenter from './components/validators/presenters/FieldRequiredPresenter.svelte'
import SubtaskStatusPresenter from './components/validators/presenters/SubtaskStatusPresenter.svelte'
import ParentStatusPresenter from './components/validators/presenters/ParentStatusPresenter.svelte'
import UpdateFieldValue from './components/postFunctions/editors/UpdateFieldValue.svelte'
import ContextSubmenuPopup from './components/postFunctions/editors/update-field/ContextSubmenuPopup.svelte'
import ClearFieldValue from './components/postFunctions/editors/ClearFieldValue.svelte'
import UpdateFieldValuePresenter from './components/postFunctions/presenters/UpdateFieldValuePresenter.svelte'
import ClearFieldValuePresenter from './components/postFunctions/presenters/ClearFieldValuePresenter.svelte'
import AppendEditor from './components/transformEditors/AppendEditor.svelte'
import ReplaceEditor from './components/transformEditors/ReplaceEditor.svelte'
import SplitEditor from './components/transformEditors/SplitEditor.svelte'
import CutEditor from './components/transformEditors/CutEditor.svelte'
import NumberEditor from './components/transformEditors/NumberEditor.svelte'
import DateOffsetEditor from './components/transformEditors/DateOffsetEditor.svelte'
import DateDifferenceEditor from './components/transformEditors/DateDifferenceEditor.svelte'
import * as validators from './validators'
import { WorkflowMiddleware } from './middleware'

export function appendPresenter (props: Record<string, any>): IntlString {
  const val = props.value ?? props.append ?? ''
  return getEmbeddedLabel(`"${val}"`)
}

export function replacePresenter (props: Record<string, any>): IntlString {
  const search = props.search ?? props.from ?? ''
  const replacement = props.replacement ?? props.to ?? ''
  return getEmbeddedLabel(`"${search}" → "${replacement}"`)
}

export function splitPresenter (props: Record<string, any>): IntlString {
  const sep = props.separator ?? props.delimiter ?? ''
  return getEmbeddedLabel(`"${sep}"`)
}

export function cutPresenter (props: Record<string, any>): IntlString {
  const start = props.start ?? props.offset ?? 0
  const end = props.end ?? props.length ?? ''
  return getEmbeddedLabel(`(${start}, ${end})`)
}

export function numberPresenter (props: Record<string, any>): IntlString {
  const val = props.value ?? 0
  const op = props.operation ?? ''
  return getEmbeddedLabel(`${op} ${val}`.trim())
}

export function dateOffsetPresenter (props: Record<string, any>): IntlString {
  const sign = props.direction === 'before' ? '-' : '+'
  return getEmbeddedLabel(`${sign}${props.offset ?? 0} ${props.offsetType ?? ''}`)
}

export function dateDifferencePresenter (props: Record<string, any>): IntlString {
  return getEmbeddedLabel(`${props.unit ?? ''}`)
}

export { WorkflowDiagramPopup }

export default async (): Promise<Resources> => ({
  component: {
    ProjectTypeWorkflowsSectionEditor,
    ProjectTypeScreensSectionEditor,
    WorkflowEditor,
    WorkflowDiagramPopup,
    ScreenEditor,
    ContextSubmenuPopup
  },
  requestEditor: {
    ScreenRequest: ScreenRequestEditor
  },
  requestPresenter: {
    ScreenRequest: ScreenRequestPresenter
  },
  validatorExecutor: {
    FieldRequired: validators.FieldRequired,
    SubtaskStatus: validators.SubtaskStatus,
    ParentStatus: validators.ParentStatus
  },
  validatorEditor: {
    FieldRequired,
    SubtaskStatus,
    ParentStatus
  },
  validatorPresenter: {
    FieldRequired: FieldRequiredPresenter,
    SubtaskStatus: SubtaskStatusPresenter,
    ParentStatus: ParentStatusPresenter
  },
  postFunctionEditor: {
    UpdateFieldValue,
    ClearFieldValue
  },
  postFunctionPresenter: {
    UpdateFieldValue: UpdateFieldValuePresenter,
    ClearFieldValue: ClearFieldValuePresenter
  },
  transformEditor: {
    AppendEditor,
    ReplaceEditor,
    SplitEditor,
    CutEditor,
    NumberEditor,
    DateOffsetEditor,
    DateDifferenceEditor
  },
  propsLabelPresenter: {
    AppendPresenter: appendPresenter,
    ReplacePresenter: replacePresenter,
    SplitPresenter: splitPresenter,
    CutPresenter: cutPresenter,
    NumberPresenter: numberPresenter,
    DateOffsetPresenter: dateOffsetPresenter,
    DateDifferencePresenter: dateDifferencePresenter
  },
  function: {
    CreateMiddleware: (client: Client, next?: PresentationMiddleware) => WorkflowMiddleware.create(client, next)
  }
})
