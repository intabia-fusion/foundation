//
// Copyright © 2023 Hardcore Engineering Inc.
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

import core, { type BackupClient, type Client as CoreClient, TxFactory, type WorkspaceUuid } from '@hcengineering/core'
import { connect } from '@hcengineering/server-tool'

function toLen (val: string, sep: string, len: number): string {
  while (val.length < len) {
    val += sep
  }
  return val
}
/** Splits a comma separated option into trimmed names; an empty option yields no names. */
function names (value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((it) => it.trim())
    .filter((it) => it !== '')
}

export async function changeConfiguration (
  workspaceId: WorkspaceUuid,
  transactorUrl: string,
  cmd: { enable?: string, disable?: string, list?: boolean }
): Promise<void> {
  const connection = (await connect(transactorUrl, workspaceId, undefined, {
    mode: 'backup'
  })) as unknown as CoreClient & BackupClient
  try {
    const config = await connection.findAll(core.class.PluginConfiguration, {})
    if (cmd.list === true) {
      for (const c of config) {
        console.log(toLen(c.pluginId, '-', 20), c.enabled, c.hidden === true ? '(hidden)' : '')
      }
    }
    const ops = new TxFactory(core.account.ConfigUser)

    const setEnabled = async (selected: string[], enabled: boolean): Promise<void> => {
      if (selected.length === 0) return
      const all = selected.includes('*')
      for (const pp of config.filter((it) => all || selected.includes(it.pluginId))) {
        if (pp.enabled === enabled) continue
        console.log(enabled ? 'Enabling' : 'Disabling', pp.pluginId)
        await connection.tx(
          ops.createTxUpdateDoc(core.class.PluginConfiguration, core.space.Model, pp._id, { enabled })
        )
      }
    }

    await setEnabled(names(cmd.enable), true)
    await setEnabled(names(cmd.disable), false)
  } finally {
    await connection.close()
  }
}
