import { systemAccountUuid, type WorkspaceUuid } from '@hcengineering/core'
import { generateToken } from '@hcengineering/server-token'
import { LocalUrl } from '../utils'

// ai-bot REST through nginx (/_aibot), sibling of LOCAL_URL's /_account.
const aiBotUrl = (): string => LocalUrl.replace(/_account\/?$/, '_aibot')

/** Set the workspace-wide AI level (AISpaceSettings). Uses a system token. */
export async function setWorkspaceAiLevel (workspace: WorkspaceUuid, level: string): Promise<void> {
  const token = generateToken(systemAccountUuid, workspace, { service: 'test', admin: 'true' }, 'secret')
  const res = await fetch(`${aiBotUrl()}/levels/workspace`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ level })
  })
  if (!res.ok) {
    throw new Error(`Failed to set AI level: ${res.status} ${await res.text()}`)
  }
}

/** Levels the pod currently offers. */
export async function getAiLevels (): Promise<Array<{ level: string, label: string }>> {
  const token = generateToken(systemAccountUuid, undefined, { service: 'test' }, 'secret')
  const res = await fetch(`${aiBotUrl()}/levels`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Failed to get AI levels: ${res.status}`)
  return await res.json()
}
