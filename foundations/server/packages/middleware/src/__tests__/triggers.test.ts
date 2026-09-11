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

import core, { type MeasureContext, type SessionData, type Tx } from '@hcengineering/core'
import type { PipelineContext } from '@hcengineering/server-core'
import { TriggersMiddleware } from '../triggers'

describe('TriggersMiddleware isTriggerCtx lifecycle', () => {
  it('should set isTriggerCtx during derived tx execution and restore previous value on completion or error', async () => {
    let capturedInsideDerived: boolean | undefined
    let derivedCallCount = 0

    const mockDerivedPipeline = {
      tx: async (ctx: MeasureContext<SessionData>, txes: Tx[]): Promise<any> => {
        derivedCallCount++
        capturedInsideDerived = ctx.contextData?.isTriggerCtx
        if (txes.some((t) => t.space === ('error_space' as any))) {
          throw new Error('Derived tx processing failed')
        }
      }
    }

    const mockPipelineContext: Partial<PipelineContext> = {
      hierarchy: {} as any,
      derived: mockDerivedPipeline as any
    }

    const middleware = new TriggersMiddleware(mockPipelineContext as PipelineContext, undefined)
    const sessionData: Record<string, any> = {}
    const ctx = {
      contextData: sessionData
    } as unknown as MeasureContext<SessionData>

    try {
      // 1. Verify normal execution flow
      const sampleTx: Tx = {
        _class: core.class.TxCreateDoc,
        space: core.space.Tx,
        objectClass: core.class.Doc,
        objectId: 'doc1',
        modifiedOn: 100
      } as any

      expect((ctx.contextData as any)?.isTriggerCtx).toBeUndefined()

      // Call private processDerivedTxes via instance
      await (middleware as any).processDerivedTxes(ctx, [sampleTx])

      expect(derivedCallCount).toBe(1)
      expect(capturedInsideDerived).toBe(true)
      expect((ctx.contextData as any)?.isTriggerCtx).toBeUndefined()

      // 2. Verify error resilience (finally block cleanup when derived.tx throws)
      const errorTx: Tx = {
        _class: core.class.TxCreateDoc,
        space: 'error_space' as any,
        objectClass: core.class.Doc,
        objectId: 'doc2',
        modifiedOn: 200
      } as any

      let thrownError: Error | undefined
      try {
        await (middleware as any).processDerivedTxes(ctx, [errorTx])
      } catch (err: any) {
        thrownError = err
      }

      expect(thrownError?.message).toBe('Derived tx processing failed')
      expect(derivedCallCount).toBe(2)
      expect(capturedInsideDerived).toBe(true)
      // CRITICAL: isTriggerCtx must NOT leak after exception in derived.tx!
      expect((ctx.contextData as any)?.isTriggerCtx).toBeUndefined()

      // 3. Verify restoring non-undefined previous flag
      ;(ctx.contextData as any).isTriggerCtx = false
      await (middleware as any).processDerivedTxes(ctx, [sampleTx])
      expect((ctx.contextData as any).isTriggerCtx).toBe(false)
    } finally {
      await middleware.close()
    }
  })
})
