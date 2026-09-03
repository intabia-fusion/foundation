import { systemAccountUuid, type WorkspaceUuid } from '@hcengineering/core'
import { getTransactorEndpoint } from '@hcengineering/server-client'
import { generateToken } from '@hcengineering/server-token'

export function getToolToken (workspace?: WorkspaceUuid): string {
  // No admin flag: account gates the tool by `service`, and selectWorkspace already grants the
  // system account Admin role. `admin: 'true'` is minted on human login only.
  return generateToken(systemAccountUuid, workspace, { service: 'tool' })
}

export async function getWorkspaceTransactorEndpoint (
  workspace: WorkspaceUuid,
  type: 'external' | 'internal' = 'external'
): Promise<string> {
  return await getTransactorEndpoint(getToolToken(workspace), type)
}

export async function sendTransactorEvent (
  workspace: WorkspaceUuid,
  operation: 'force-maintenance' | 'force-close',
  type: 'external' | 'internal' = 'external'
): Promise<void> {
  const token = getToolToken(workspace)
  const serverEndpoint = (await getTransactorEndpoint(token, type))
    .replaceAll('wss://', 'https://')
    .replace('ws://', 'http://')

  try {
    console.info('send transactor event', operation, 'to', serverEndpoint)
    await fetch(serverEndpoint + `/api/v1/manage?operation=${operation}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` }
    })
  } catch (err: any) {
    // Ignore error if transactor is not yet ready
  }
}
