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

import core, {
  TxProcessor,
  type Doc,
  type MeasureContext,
  type Ref,
  type Space,
  type SessionData,
  type Tx,
  type TxApplyIf,
  type TxCUD
} from '@hcengineering/core'
import platform, { PlatformError, Severity, Status } from '@hcengineering/platform'
import {
  BaseMiddleware,
  type Middleware,
  type PipelineContext,
  type TxMiddlewareResult
} from '@hcengineering/server-core'

/** Writes carried by an API key token: allowed at all, through which route, into which spaces.
 * Membership and reads stay with SpaceSecurityMiddleware. */
export class ApiKeyPermissionsMiddleware extends BaseMiddleware implements Middleware {
  static async create (
    ctx: MeasureContext,
    context: PipelineContext,
    next: Middleware | undefined
  ): Promise<ApiKeyPermissionsMiddleware> {
    return new ApiKeyPermissionsMiddleware(context, next)
  }

  async tx (ctx: MeasureContext<SessionData>, txes: Tx[]): Promise<TxMiddlewareResult> {
    const apiKey = ctx.contextData.apiKey
    if (apiKey === undefined) {
      return await this.provideTx(ctx, txes)
    }
    for (const tx of txes) {
      this.checkTx(tx, apiKey, ctx.contextData.opsApi === true)
    }
    return await this.provideTx(ctx, txes)
  }

  private checkTx (
    tx: Tx,
    apiKey: { canWrite: boolean, opsOnly: boolean, spaces: Ref<Space>[] },
    opsApi: boolean
  ): void {
    if (tx._class === core.class.TxApplyIf) {
      for (const t of (tx as TxApplyIf).txes) {
        this.checkTx(t, apiKey, opsApi)
      }
      return
    }
    if (!TxProcessor.isExtendsCUD(tx._class)) {
      return
    }
    if (!apiKey.canWrite) {
      throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    }
    // Raw CUD carries no operation name, so a key granted operations writes only via /api/v1/ops.
    if (apiKey.opsOnly && !opsApi) {
      throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    }
    const cudTx = tx as TxCUD<Doc>
    // Derived tx come from triggers, not from the key - the same exemption GuestPermissionsMiddleware makes.
    if (cudTx.space === core.space.DerivedTx) {
      return
    }
    if (apiKey.spaces.length > 0 && !apiKey.spaces.includes(cudTx.objectSpace)) {
      throw new PlatformError(new Status(Severity.ERROR, platform.status.Forbidden, {}))
    }
  }
}
