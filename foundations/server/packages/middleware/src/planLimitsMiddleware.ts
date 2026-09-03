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
import { type MeasureContext, type WorkspaceUuid } from '@hcengineering/core'
import {
  BaseMiddleware,
  type LimitsProvider,
  type Middleware,
  type PipelineContext,
  type PlanLimits
} from '@hcengineering/server-core'
import { LIMITS_PROVIDER_VAR, PLAN_LIMITS_MAP_KEY, PLAN_LIMITS_VAR } from './planLimits'

// Whether limits are wired is a property of the deployment, so report it once per process.
let noProviderReported = false

const ZERO_LIMITS: PlanLimits = {
  usersLimit: 0,
  storageLimitGB: 0,
  tokenLimit: 0,
  transcriptLimit: 0
}

/**
 * Boots the PlanLimits snapshot for the workspace into contextVars so downstream consumers
 * (seat enforcement) can read it. Does not enforce anything by itself.
 */
export class PlanLimitsBootMiddleware extends BaseMiddleware implements Middleware {
  private constructor (context: PipelineContext, next?: Middleware) {
    super(context, next)
  }

  /** Shared host map, refreshed live on 'plan' LimitsChanged events. */
  private sharedMap (): Map<WorkspaceUuid, PlanLimits> | undefined {
    return this.context.contextVars[PLAN_LIMITS_MAP_KEY] as Map<WorkspaceUuid, PlanLimits> | undefined
  }

  private sharedLimits (): PlanLimits | undefined {
    return this.sharedMap()?.get(this.context.workspace.uuid)
  }

  static async create (
    ctx: MeasureContext,
    context: PipelineContext,
    next: Middleware | undefined
  ): Promise<PlanLimitsBootMiddleware> {
    const mw = new PlanLimitsBootMiddleware(context, next)
    await mw.bootResolveLimits(ctx)
    return mw
  }

  private async bootResolveLimits (ctx: MeasureContext): Promise<void> {
    try {
      const provider = this.context.contextVars[LIMITS_PROVIDER_VAR] as LimitsProvider | undefined
      if (provider === undefined) {
        // A deployment-wide condition - warning once says as much as warning per workspace.
        if (!noProviderReported) {
          noProviderReported = true
          ctx.warn('PlanLimitsBootMiddleware: LimitsProvider not set in contextVars, limits disabled')
        }
        this.context.contextVars[PLAN_LIMITS_VAR] = ZERO_LIMITS
        return
      }
      // Shared host map (refreshed by the host consumer on plan changes) wins over a fresh resolve.
      const shared = this.sharedLimits()
      const limits = shared ?? (await provider.getPlanLimits(this.context.workspace.uuid))
      this.sharedMap()?.set(this.context.workspace.uuid, limits)
      this.context.contextVars[PLAN_LIMITS_VAR] = limits
      ctx.info('PlanLimitsBootMiddleware: limits resolved', {
        workspace: this.context.workspace.uuid,
        usersLimit: limits.usersLimit
      })
    } catch (err: any) {
      // fail-open: zero limits = unlimited
      ctx.error('PlanLimitsBootMiddleware: failed to resolve limits, using zero (unlimited)', { err })
      this.context.contextVars[PLAN_LIMITS_VAR] = ZERO_LIMITS
    }
  }
}
