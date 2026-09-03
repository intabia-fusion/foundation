import { expect } from '@playwright/test'
import { systemAccountUuid, type WorkspaceUuid } from '@hcengineering/core'
import { generateToken } from '@hcengineering/server-token'
import { ChannelPage } from '../model/channel-page'
import { ChunterPage } from '../model/chunter-page'
import { LeftSideMenuPage } from '../model/left-side-menu-page'
import { LocalUrl } from '../utils'
import { retryIntervals } from '../retry'

// ai-bot REST through nginx (/_aibot), sibling of LOCAL_URL's /_account.
const aiBotUrl = (): string => LocalUrl.replace(/_account\/?$/, '_aibot')

// createDirectChat only uses firstName/lastName; email/password satisfy SignUpData.
export const BOT = { firstName: 'Julia', lastName: 'AI', email: '', password: '' }
export const BOT_DIRECT = `${BOT.lastName} ${BOT.firstName}` // rendered as "AI Julia"

/** Opens a direct chat with the AI bot; it provisions itself asynchronously, so retry until it appears. */
export async function openBotDirect (
  leftSideMenuPage: LeftSideMenuPage,
  chunterPage: ChunterPage,
  channelPage: ChannelPage
): Promise<void> {
  await leftSideMenuPage.clickChunter()
  await expect(async () => {
    await chunterPage.createDirectChat(BOT)
  }).toPass({ intervals: retryIntervals, timeout: 60000 })
  await channelPage.clickChooseChannel(BOT_DIRECT)
}

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
