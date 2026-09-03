//
// Copyright © 2026 Intabia Fusion
//

import { type MeasureContext, type WorkspaceUuid } from '@hcengineering/core'
import { type PlatformQueueProducer } from '@hcengineering/server-core'

import { type ProviderPool } from './types'
import { type PoolThresholdHandler } from './usage'

interface AccountNotification {
  type: 'email'
  data: { html: string, to: string, text: string, subject: string }
}

// Build a PoolThresholdHandler that emails the admin list when a provider pool
// crosses 80%/100%. No-op when there are no recipients or no producer.
export function createPoolNotifier (
  producer: PlatformQueueProducer<AccountNotification> | undefined,
  adminEmails: string[]
): PoolThresholdHandler {
  return async (ctx: MeasureContext, pool: ProviderPool, percent: 80 | 100): Promise<void> => {
    if (producer === undefined || adminEmails.length === 0) return

    const used = pool.usedTokens.toLocaleString('en-US')
    const total = pool.purchasedTokens.toLocaleString('en-US')
    const subject =
      percent === 100
        ? `AI token pool exhausted: ${pool.providerId}`
        : `AI token pool at ${percent}%: ${pool.providerId}`
    const text =
      `Provider "${pool.providerId}" has used ${used} of ${total} purchased tokens (${percent}%+) ` +
      `for the current ${pool.period} period (started ${pool.periodStart}). ` +
      (percent === 100 ? 'Requests to this provider are now blocked until you top up.' : 'Consider topping up.')
    const html = `<p>${text}</p>`

    // One unreachable address must not hide the alert from the rest, nor keep the pool unmarked
    // and re-notifying every pass: this fails only when nothing got out at all.
    const sent = await Promise.allSettled(
      adminEmails.map(async (to) => {
        await producer.send(ctx, '' as WorkspaceUuid, [{ type: 'email', data: { html, text, subject, to } }], to)
      })
    )
    const failed = sent.filter((r) => r.status === 'rejected')
    if (failed.length > 0) {
      ctx.warn('pool threshold alert partially failed', { pool: pool.providerId, failed: failed.length })
    }
    if (failed.length === sent.length) {
      throw new Error(`failed to send pool threshold alert for ${pool.providerId}`)
    }
  }
}
