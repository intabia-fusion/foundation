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

/* eslint-disable @typescript-eslint/unbound-method */

import type { AnyAttribute, Ref } from '@hcengineering/core'

import workflow from '../../plugin'
import { clearWorkflowConfig, extractRuleFieldReferences } from '../../transfer/utils'
import { createMockTx, projectTypeId } from './fixtures'

describe('transfer/utils', () => {
  describe('extractRuleFieldReferences', () => {
    it('returns empty array when props are undefined or rule is unknown', () => {
      expect(extractRuleFieldReferences(workflow.validator.FieldRequired, undefined)).toEqual([])
      expect(extractRuleFieldReferences('unknown-rule' as any, { fields: [] })).toEqual([])
    })

    it('extracts fields from FieldRequired and ClearFieldValue', () => {
      const fieldRequiredProps = {
        fields: [
          { attribute: 'attr-1' as Ref<AnyAttribute>, fieldKey: 'field1' },
          { attribute: 'attr-2' as Ref<AnyAttribute>, fieldKey: 'field2' }
        ]
      }

      const reqFields = extractRuleFieldReferences(workflow.validator.FieldRequired, fieldRequiredProps)
      expect(reqFields).toHaveLength(2)
      expect(reqFields[0].fieldKey).toBe('field1')

      const clearFields = extractRuleFieldReferences(workflow.postFunction.ClearFieldValue, fieldRequiredProps)
      expect(clearFields).toHaveLength(2)
      expect(clearFields[1].fieldKey).toBe('field2')
    })

    it('extracts target and source (this / parent) fields from UpdateFieldValue', () => {
      const updateProps = {
        fields: [
          {
            attribute: 'target-attr-1' as Ref<AnyAttribute>,
            fieldKey: 'target1',
            value: {
              type: 'this',
              attribute: 'source-this-attr' as Ref<AnyAttribute>,
              fieldKey: 'sourceThis'
            }
          },
          {
            attribute: 'target-attr-2' as Ref<AnyAttribute>,
            fieldKey: 'target2',
            value: {
              type: 'parent',
              attribute: 'source-parent-attr' as Ref<AnyAttribute>,
              fieldKey: 'sourceParent'
            }
          },
          {
            attribute: 'target-attr-3' as Ref<AnyAttribute>,
            fieldKey: 'target3',
            value: {
              type: 'const',
              value: 'static string'
            }
          }
        ]
      }

      const fields = extractRuleFieldReferences(workflow.postFunction.UpdateFieldValue, updateProps)
      // 3 target fields + 2 source fields ('this' and 'parent') = 5 field references
      expect(fields).toHaveLength(5)
      expect(fields.map((f) => f.fieldKey)).toEqual(['target1', 'sourceThis', 'target2', 'sourceParent', 'target3'])
    })
  })

  describe('clearWorkflowConfig', () => {
    it('removes workflows and screens for projectType', async () => {
      const client = createMockTx()
      await clearWorkflowConfig(client, projectTypeId)

      expect(client.findAll).toHaveBeenCalledWith(workflow.class.Workflow, { projectType: projectTypeId })
      expect(client.findAll).toHaveBeenCalledWith(workflow.class.Screen, { projectType: projectTypeId })
      expect(client.apply).toHaveBeenCalled()
    })
  })
})
