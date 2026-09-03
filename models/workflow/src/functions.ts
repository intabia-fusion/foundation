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

import core from '@hcengineering/core'
import { type Builder } from '@hcengineering/model'

import workflow from './plugin'

export function defineValueFunctions (builder: Builder): void {
  // String Transforms
  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.TypeString,
      category: 'attribute',
      label: workflow.string.UpperCase,
      type: 'transform'
    },
    workflow.function.UpperCase
  )

  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.TypeString,
      category: 'attribute',
      label: workflow.string.LowerCase,
      type: 'transform'
    },
    workflow.function.LowerCase
  )

  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.TypeString,
      category: 'attribute',
      label: workflow.string.Trim,
      type: 'transform'
    },
    workflow.function.Trim
  )

  // Type Conversions -> String
  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.TypeNumber,
      to: core.class.TypeString,
      category: 'attribute',
      label: workflow.string.TextFromNumber,
      type: 'convert'
    },
    workflow.function.TextFromNumber
  )

  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.TypeDate,
      to: core.class.TypeString,
      category: 'attribute',
      label: workflow.string.TextFromDate,
      type: 'convert'
    },
    workflow.function.TextFromDate
  )

  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.TypeBoolean,
      to: core.class.TypeString,
      category: 'attribute',
      label: workflow.string.TextFromCheckbox,
      type: 'convert'
    },
    workflow.function.TextFromCheckbox
  )

  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.Obj,
      to: core.class.TypeString,
      category: 'attribute',
      label: workflow.string.ToString,
      type: 'convert'
    },
    workflow.function.ToString
  )

  // Type Conversions -> Number / Date
  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.TypeString,
      to: core.class.TypeNumber,
      category: 'attribute',
      label: workflow.string.NumberFromText,
      type: 'convert'
    },
    workflow.function.NumberFromText
  )

  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.TypeString,
      to: core.class.TypeDate,
      category: 'attribute',
      label: workflow.string.DateFromText,
      type: 'convert'
    },
    workflow.function.DateFromText
  )

  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.TypeDate,
      to: core.class.TypeNumber,
      category: 'attribute',
      label: workflow.string.NumberFromDate,
      type: 'convert'
    },
    workflow.function.NumberFromDate
  )

  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.TypeNumber,
      to: core.class.TypeDate,
      category: 'attribute',
      label: workflow.string.DateFromNumber,
      type: 'convert'
    },
    workflow.function.DateFromNumber
  )

  // Date Date Part Extractions
  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.TypeDate,
      to: core.class.TypeNumber,
      category: 'attribute',
      label: workflow.string.YearFromDate,
      type: 'convert'
    },
    workflow.function.YearFromDate
  )

  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.TypeDate,
      to: core.class.TypeNumber,
      category: 'attribute',
      label: workflow.string.MonthFromDate,
      type: 'convert'
    },
    workflow.function.MonthFromDate
  )

  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.TypeDate,
      to: core.class.TypeNumber,
      category: 'attribute',
      label: workflow.string.DayFromDate,
      type: 'convert'
    },
    workflow.function.DayFromDate
  )

  // Number Transformations
  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.TypeNumber,
      category: 'attribute',
      label: workflow.string.Round,
      type: 'transform'
    },
    workflow.function.Round
  )

  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.TypeNumber,
      category: 'attribute',
      label: workflow.string.Absolute,
      type: 'transform'
    },
    workflow.function.Absolute
  )

  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.TypeNumber,
      category: 'attribute',
      label: workflow.string.Ceil,
      type: 'transform'
    },
    workflow.function.Ceil
  )

  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.TypeNumber,
      category: 'attribute',
      label: workflow.string.Floor,
      type: 'transform'
    },
    workflow.function.Floor
  )

  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.TypeNumber,
      category: 'attribute',
      label: workflow.string.Sqrt,
      type: 'transform'
    },
    workflow.function.Sqrt
  )

  // Array Aggregates
  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.ArrOf,
      category: 'array',
      label: workflow.string.FirstValue,
      type: 'convert'
    },
    workflow.function.FirstValue
  )

  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.ArrOf,
      category: 'array',
      label: workflow.string.LastValue,
      type: 'convert'
    },
    workflow.function.LastValue
  )

  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.ArrOf,
      category: 'array',
      label: workflow.string.Random,
      type: 'convert'
    },
    workflow.function.Random
  )

  // Editors-based String Transforms
  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.TypeString,
      category: 'attribute',
      label: workflow.string.Prepend,
      type: 'transform',
      editor: workflow.transformEditor.AppendEditor,
      propsLabelPresenter: workflow.propsLabelPresenter.AppendPresenter
    },
    workflow.function.Prepend
  )

  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.TypeString,
      category: 'attribute',
      label: workflow.string.Append,
      type: 'transform',
      editor: workflow.transformEditor.AppendEditor,
      propsLabelPresenter: workflow.propsLabelPresenter.AppendPresenter
    },
    workflow.function.Append
  )

  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.TypeString,
      category: 'attribute',
      label: workflow.string.Replace,
      type: 'transform',
      editor: workflow.transformEditor.ReplaceEditor,
      propsLabelPresenter: workflow.propsLabelPresenter.ReplacePresenter
    },
    workflow.function.Replace
  )

  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.TypeString,
      category: 'attribute',
      label: workflow.string.ReplaceAll,
      type: 'transform',
      editor: workflow.transformEditor.ReplaceEditor,
      propsLabelPresenter: workflow.propsLabelPresenter.ReplacePresenter
    },
    workflow.function.ReplaceAll
  )

  // builder.createDoc(
  //   workflow.class.WorkflowValueFunction,
  //   core.space.Model,
  //   {
  //     of: core.class.TypeString,
  //     category: 'attribute',
  //     label: workflow.string.Split,
  //     type: 'transform',
  //     editor: workflow.transformEditor.SplitEditor,
  //     propsLabelPresenter: workflow.propsLabelPresenter.SplitPresenter
  //   },
  //   workflow.function.Split
  // )

  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.TypeString,
      category: 'attribute',
      label: workflow.string.Cut,
      type: 'transform',
      editor: workflow.transformEditor.CutEditor,
      propsLabelPresenter: workflow.propsLabelPresenter.CutPresenter
    },
    workflow.function.Cut
  )

  // Editors-based Number Transforms
  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.TypeNumber,
      category: 'attribute',
      label: workflow.string.Add,
      type: 'transform',
      editor: workflow.transformEditor.NumberEditor,
      propsLabelPresenter: workflow.propsLabelPresenter.NumberPresenter
    },
    workflow.function.Add
  )

  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.TypeNumber,
      category: 'attribute',
      label: workflow.string.Subtract,
      type: 'transform',
      editor: workflow.transformEditor.NumberEditor,
      propsLabelPresenter: workflow.propsLabelPresenter.NumberPresenter
    },
    workflow.function.Subtract
  )

  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.TypeNumber,
      category: 'attribute',
      label: workflow.string.Multiply,
      type: 'transform',
      editor: workflow.transformEditor.NumberEditor,
      propsLabelPresenter: workflow.propsLabelPresenter.NumberPresenter
    },
    workflow.function.Multiply
  )

  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.TypeNumber,
      category: 'attribute',
      label: workflow.string.Divide,
      type: 'transform',
      editor: workflow.transformEditor.NumberEditor,
      propsLabelPresenter: workflow.propsLabelPresenter.NumberPresenter
    },
    workflow.function.Divide
  )

  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.TypeNumber,
      category: 'attribute',
      label: workflow.string.Modulo,
      type: 'transform',
      editor: workflow.transformEditor.NumberEditor,
      propsLabelPresenter: workflow.propsLabelPresenter.NumberPresenter
    },
    workflow.function.Modulo
  )

  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.TypeNumber,
      category: 'attribute',
      label: workflow.string.Power,
      type: 'transform',
      editor: workflow.transformEditor.NumberEditor,
      propsLabelPresenter: workflow.propsLabelPresenter.NumberPresenter
    },
    workflow.function.Power
  )

  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.TypeNumber,
      category: 'attribute',
      label: workflow.string.Min,
      type: 'transform',
      editor: workflow.transformEditor.NumberEditor,
      propsLabelPresenter: workflow.propsLabelPresenter.NumberPresenter
    },
    workflow.function.Min
  )

  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.TypeNumber,
      category: 'attribute',
      label: workflow.string.Max,
      type: 'transform',
      editor: workflow.transformEditor.NumberEditor,
      propsLabelPresenter: workflow.propsLabelPresenter.NumberPresenter
    },
    workflow.function.Max
  )

  // Editors-based Date Transforms & Conversions
  // builder.createDoc(
  //   workflow.class.WorkflowValueFunction,
  //   core.space.Model,
  //   {
  //     of: core.class.TypeDate,
  //     category: 'attribute',
  //     label: workflow.string.Offset,
  //     type: 'transform',
  //     editor: workflow.transformEditor.DateOffsetEditor,
  //     propsLabelPresenter: workflow.propsLabelPresenter.DateOffsetPresenter
  //   },
  //   workflow.function.Offset
  // )

  builder.createDoc(
    workflow.class.WorkflowValueFunction,
    core.space.Model,
    {
      of: core.class.TypeDate,
      to: core.class.TypeNumber,
      category: 'attribute',
      label: workflow.string.DateDifference,
      type: 'convert',
      editor: workflow.transformEditor.DateDifferenceEditor,
      propsLabelPresenter: workflow.propsLabelPresenter.DateDifferencePresenter
    },
    workflow.function.DateDifference
  )
}
