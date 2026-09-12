//
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//

import { MeasureMetricsContext } from '@hcengineering/core'
import { wrapPipeline } from '../utils'

// wrapPipeline reuses one SessionData; if tx() doesn't drain broadcast, per-tx scanners
// (permissions) turn O(n^2). Guards the drain.
describe('wrapPipeline broadcast drain', () => {
  function makePipeline (): any {
    return {
      context: {
        modelDb: {},
        hierarchy: { updateLookupMixin: (_c: any, v: any) => v },
        lowLevelStorage: {}
      },
      // Simulate a middleware appending derived txes/queue entries during tx.
      tx: async (ctx: any) => {
        ctx.contextData.broadcast.txes.push({})
        ctx.contextData.broadcast.queue.push({})
        return [{}]
      },
      handleBroadcast: async () => {}
    }
  }

  it('drains txes/queue after every tx (no accumulation across calls)', async () => {
    const ctx = new MeasureMetricsContext('test', {})
    const client = wrapPipeline(ctx, makePipeline(), { uuid: 'ws', url: '', dataId: 'ws' } as any)
    const bc = (ctx.contextData as any).broadcast

    await client.tx({} as any)
    expect(bc.txes.length).toBe(0)
    expect(bc.queue.length).toBe(0)

    await client.tx({} as any)
    expect(bc.txes.length).toBe(0)
    expect(bc.queue.length).toBe(0)
  })
})

// Without a caller's SessionData, every in-process write runs as an admin system account - which is
// what every middleware scoping writes (space security, api key grants, seat limits) keys off.
describe('wrapPipeline session identity', () => {
  function makePipeline (): any {
    return {
      context: { modelDb: {}, hierarchy: { updateLookupMixin: (_c: any, v: any) => v }, lowLevelStorage: {} },
      tx: async () => [{}],
      handleBroadcast: async () => {}
    }
  }

  const wsIds = { uuid: 'ws', url: '', dataId: 'ws' } as any

  it('falls back to the system identity when no session data is given', () => {
    const ctx = new MeasureMetricsContext('test', {})
    wrapPipeline(ctx, makePipeline(), wsIds)

    expect((ctx.contextData as any).admin).toBe(true)
    expect((ctx.contextData as any).apiKey).toBeUndefined()
  })

  it('keeps the caller session data, so the key grant reaches the middleware', async () => {
    const ctx = new MeasureMetricsContext('test', {})
    const sessionData: any = {
      account: { uuid: 'user-1' },
      admin: false,
      apiKey: { ops: ['issue:create'], spaces: ['space-1'] },
      broadcast: { targets: {}, txes: [], queue: [], sessions: {} }
    }
    const client = wrapPipeline(ctx, makePipeline(), wsIds, false, sessionData)

    expect(ctx.contextData).toBe(sessionData)
    await client.tx({} as any)
    expect(ctx.contextData).toBe(sessionData)
  })
})

// LookupMiddleware strips scalar query fields from results; the ws/rest clients revert that, and so
// must the in-process one - otherwise findOne(X, { _id }) hands back a doc with no _id.
describe('wrapPipeline reverts stripped query fields', () => {
  function pipelineReturning (docs: any[]): any {
    return {
      context: {
        modelDb: {},
        hierarchy: { updateLookupMixin: (_c: any, v: any) => v },
        lowLevelStorage: {}
      },
      findAll: async () => Object.assign([...docs], { total: docs.length })
    }
  }

  const stripped = { space: 'space-1', modifiedBy: 'social-1', modifiedOn: 0 }

  it('puts _id back when the query pinned it', async () => {
    const ctx = new MeasureMetricsContext('test', {})
    const client = wrapPipeline(ctx, pipelineReturning([{ ...stripped }]), {
      uuid: 'ws',
      url: '',
      dataId: 'ws'
    } as any)

    const res = await client.findOne('test:class:Doc' as any, { _id: 'doc-1' as any })

    expect(res?._id).toBe('doc-1')
    expect(res?._class).toBe('test:class:Doc')
  })

  it('leaves a value the doc already carries alone', async () => {
    const ctx = new MeasureMetricsContext('test', {})
    const client = wrapPipeline(ctx, pipelineReturning([{ ...stripped, _id: 'doc-1', name: 'kept' }]), {
      uuid: 'ws',
      url: '',
      dataId: 'ws'
    } as any)

    const [res] = await client.findAll('test:class:Doc' as any, { name: 'other' } as any)

    expect((res as any).name).toBe('kept')
    expect(res._id).toBe('doc-1')
  })
})
