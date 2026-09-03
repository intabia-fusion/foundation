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
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

import { mergeIds, type Resource, type IntlString } from '@hcengineering/platform'
import workflow, { workflowId } from '@hcengineering/workflow'
import {} from '@hcengineering/ui'
import { type Ref } from '@hcengineering/core'
import { type PresentationMiddlewareCreator, type PresentationMiddlewareFactory } from '@hcengineering/presentation'

export default mergeIds(workflowId, workflow, {
  function: {
    CreateMiddleware: '' as Resource<PresentationMiddlewareCreator>
  },
  string: {
    DayFromDate: '' as IntlString,
    MonthFromDate: '' as IntlString,
    YearFromDate: '' as IntlString,
    TextFromNumber: '' as IntlString,
    TextFromDate: '' as IntlString,
    TextFromCheckbox: '' as IntlString,
    NumberFromText: '' as IntlString,
    DateFromText: '' as IntlString,
    NumberFromDate: '' as IntlString,
    DateFromNumber: '' as IntlString,
    UpperCase: '' as IntlString,
    LowerCase: '' as IntlString,
    Trim: '' as IntlString,
    Round: '' as IntlString,
    Absolute: '' as IntlString,
    Ceil: '' as IntlString,
    Floor: '' as IntlString,
    Sqrt: '' as IntlString,
    FirstValue: '' as IntlString,
    LastValue: '' as IntlString,
    Random: '' as IntlString,
    ToString: '' as IntlString,
    Prepend: '' as IntlString,
    Append: '' as IntlString,
    Replace: '' as IntlString,
    ReplaceAll: '' as IntlString,
    Split: '' as IntlString,
    Cut: '' as IntlString,
    Add: '' as IntlString,
    Subtract: '' as IntlString,
    Multiply: '' as IntlString,
    Divide: '' as IntlString,
    Modulo: '' as IntlString,
    Power: '' as IntlString,
    Min: '' as IntlString,
    Max: '' as IntlString,
    Offset: '' as IntlString,
    DateDifference: '' as IntlString
  },
  pipeline: {
    WorkflowMiddleware: '' as Ref<PresentationMiddlewareFactory>
  }
})
