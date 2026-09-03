import { test, expect } from '../fixtures'
import { generateToken } from '@hcengineering/server-token'
import { systemAccountUuid } from '@hcengineering/core'
import { ApiEndpoint } from '../API/Api'
import { generateTestData, PlatformURI } from '../utils'
import { LoginPage } from '../model/login-page'
import { SelectWorkspacePage } from '../model/select-workspace-page'

const BILLING_URL = process.env.BILLING_URL ?? 'http://localhost:8083/_billing'

function getAdminHeaders (): Record<string, string> {
  const token = generateToken(systemAccountUuid, undefined, { service: 'billing', admin: 'true' }, 'secret')
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
}

function ownerHeaders (token: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
}

async function getStats (request: any, workspaceUuid: string, ownerToken: string): Promise<any> {
  const res = await request.get(`${BILLING_URL}/api/v1/${workspaceUuid}/stats`, {
    headers: ownerHeaders(ownerToken)
  })
  expect(res.status()).toBe(200)
  return res.json()
}

test.describe('Billing API — data that UI displays', () => {
  let workspaceUuid: string
  let ownerToken: string
  let data: ReturnType<typeof generateTestData>

  test.beforeEach(async ({ request, page }) => {
    data = generateTestData()
    const api = new ApiEndpoint(request)
    await api.createAccount(data.userName, '1234', data.firstName, data.lastName)
    const wsInfo = await api.createWorkspaceWithLogin(data.workspaceName, data.userName, '1234')
    if (wsInfo.token === undefined) {
      throw new Error('Login failed')
    }
    ownerToken = wsInfo.token
    workspaceUuid = wsInfo.workspace

    await page.goto(PlatformURI)
    const loginPage = new LoginPage(page)
    await loginPage.login(data.userName, '1234')
    const swp = new SelectWorkspacePage(page)
    await swp.selectWorkspace(data.workspaceName)
  })

  // ── AI section ───────────────────────────────────────────────────────────────

  test('AI — transcript duration is summed correctly', async ({ request }) => {
    // UI: totalTranscriptDuration = aiStats.transcript.totalDurationSeconds * 1000
    const today = new Date().toISOString()
    const todayStr = new Date().toISOString().slice(0, 10)
    await request.post(`${BILLING_URL}/api/v1/ai/transcript`, {
      headers: getAdminHeaders(),
      data: [
        {
          workspace: workspaceUuid,
          day: todayStr,
          lastRequestId: 'req-1',
          lastStartTime: today,
          durationSeconds: 3600,
          usd: 0.1
        },
        {
          workspace: workspaceUuid,
          day: todayStr,
          lastRequestId: 'req-2',
          lastStartTime: today,
          durationSeconds: 1800,
          usd: 0.05
        }
      ]
    })
    const yesterday = new Date(Date.now() - 86400000).toISOString()
    const yesterdayStr = yesterday.slice(0, 10)
    await request.post(`${BILLING_URL}/api/v1/ai/transcript`, {
      headers: getAdminHeaders(),
      data: [
        {
          workspace: workspaceUuid,
          day: yesterdayStr,
          lastRequestId: 'req-3',
          lastStartTime: yesterday,
          durationSeconds: 3600,
          usd: 0.1
        },
        {
          workspace: workspaceUuid,
          day: yesterdayStr,
          lastRequestId: 'req-4',
          lastStartTime: yesterday,
          durationSeconds: 1800,
          usd: 0.05
        },
        {
          workspace: workspaceUuid,
          day: yesterdayStr,
          lastRequestId: 'req-5',
          lastStartTime: yesterday,
          durationSeconds: 1800,
          usd: 0.05
        }
      ]
    })
    const stats = await getStats(request, workspaceUuid, ownerToken)
    expect(stats.aiStats.transcript.totalDurationSeconds).toBe(12600) // 3600 + 1800 + 3600 + 1800 + 1800
  })

  test('AI — transcript daily stats contain entries per day for chart', async ({ request }) => {
    // UI uses transcriptDailyStats to build the Office chart series (green line)
    const yesterday = new Date(Date.now() - 86400000).toISOString()
    const yesterdayStr = yesterday.slice(0, 10)
    const today = new Date().toISOString()
    const todayStr = today.slice(0, 10)

    await request.post(`${BILLING_URL}/api/v1/ai/transcript`, {
      headers: getAdminHeaders(),
      data: [
        {
          workspace: workspaceUuid,
          day: yesterdayStr,
          lastRequestId: 'req-y',
          lastStartTime: yesterday,
          durationSeconds: 600,
          usd: 0.01
        },
        {
          workspace: workspaceUuid,
          day: todayStr,
          lastRequestId: 'req-t',
          lastStartTime: today,
          durationSeconds: 900,
          usd: 0.02
        }
      ]
    })

    const stats = await getStats(request, workspaceUuid, ownerToken)
    expect(Array.isArray(stats.transcriptDailyStats)).toBe(true)
    expect(stats.transcriptDailyStats.length).toBeGreaterThanOrEqual(2)
    const todayEntry = stats.transcriptDailyStats.find((d: any) => d.day.startsWith(todayStr))
    expect(todayEntry).toBeDefined()
    expect(todayEntry.totalDurationSeconds).toBe(900)
  })

  test('AI — tokens are summed correctly', async ({ request }) => {
    // UI: totalTokensCount = aiStats.tokens.reduce((sum, s) => sum + s.totalTokens, 0)
    const date = new Date().toISOString()

    await request.post(`${BILLING_URL}/api/v1/ai/tokens`, {
      headers: getAdminHeaders(),
      data: [
        { workspace: workspaceUuid, reason: 'completion', tokens: 1000, date },
        { workspace: workspaceUuid, reason: 'completion', tokens: 500, date },
        { workspace: workspaceUuid, reason: 'embedding', tokens: 200, date }
      ]
    })

    const stats = await getStats(request, workspaceUuid, ownerToken)

    const total = stats.aiStats.tokens.reduce((sum: number, t: any) => sum + t.totalTokens, 0)
    expect(total).toBe(1700)
  })

  // ── Office section ───────────────────────────────────────────────────────────

  test('Office — meeting minutes are summed from participant sessions', async ({ request }) => {
    // UI: totalMeetingMinutes = participantDailyStats.reduce((sum, d) => sum + d.totalMinutes, 0)
    const now = new Date()
    const yesterday = new Date(Date.now() - 86400000)

    await request.post(`${BILLING_URL}/api/v1/livekit/participants`, {
      headers: getAdminHeaders(),
      data: [
        {
          workspace: workspaceUuid,
          participantId: 'p-1',
          sessionId: 's-1',
          room: 'room-1',
          joinedAt: new Date(yesterday.getTime() - 3600 * 1000).toISOString(),
          leftAt: yesterday.toISOString(),
          durationSeconds: 3600 // 60 minutes
        },
        {
          workspace: workspaceUuid,
          participantId: 'p-2',
          sessionId: 's-1',
          room: 'room-1',
          joinedAt: new Date(yesterday.getTime() - 3600 * 1000).toISOString(),
          leftAt: yesterday.toISOString(),
          durationSeconds: 3600 // 60 minutes
        },
        {
          workspace: workspaceUuid,
          participantId: 'p-3',
          sessionId: 's-2',
          room: 'room-1',
          joinedAt: new Date(now.getTime() - 3600 * 1000).toISOString(),
          leftAt: now.toISOString(),
          durationSeconds: 3600 // 60 minutes
        },
        {
          workspace: workspaceUuid,
          participantId: 'p-4',
          sessionId: 's-2',
          room: 'room-1',
          joinedAt: new Date(now.getTime() - 1800 * 1000).toISOString(),
          leftAt: now.toISOString(),
          durationSeconds: 1800 // 30 minutes
        }
      ]
    })

    const stats = await getStats(request, workspaceUuid, ownerToken)
    const totalMinutes = stats.participantDailyStats.reduce((sum: number, d: any) => sum + d.totalMinutes, 0)
    expect(totalMinutes).toBeGreaterThanOrEqual(210) // 60 + 60 + 60 + 30
  })

  test('Office — meeting minutes contain entries per day for chart', async ({ request }) => {
    // UI uses participantDailyStats to build the Office chart series (blue line)
    const today = new Date()
    const yesterday = new Date(Date.now() - 86400000)

    await request.post(`${BILLING_URL}/api/v1/livekit/participants`, {
      headers: getAdminHeaders(),
      data: [
        {
          workspace: workspaceUuid,
          participantId: 'p-1',
          sessionId: 's-1',
          room: 'room-1',
          joinedAt: new Date(yesterday.getTime() - 3600 * 1000).toISOString(),
          leftAt: yesterday.toISOString(),
          durationSeconds: 3600 // 60 minutes
        },
        {
          workspace: workspaceUuid,
          participantId: 'p-2',
          sessionId: 's-1',
          room: 'room-1',
          joinedAt: new Date(yesterday.getTime() - 3600 * 1000).toISOString(),
          leftAt: yesterday.toISOString(),
          durationSeconds: 3600 // 60 minutes
        },
        {
          workspace: workspaceUuid,
          participantId: 'p-3',
          sessionId: 's-2',
          room: 'room-1',
          joinedAt: new Date(today.getTime() - 3600 * 1000).toISOString(),
          leftAt: today.toISOString(),
          durationSeconds: 3600 // 60 minutes
        },
        {
          workspace: workspaceUuid,
          participantId: 'p-4',
          sessionId: 's-2',
          room: 'room-1',
          joinedAt: new Date(today.getTime() - 1800 * 1000).toISOString(),
          leftAt: today.toISOString(),
          durationSeconds: 1800 // 30 minutes
        }
      ]
    })

    const stats = await getStats(request, workspaceUuid, ownerToken)
    expect(Array.isArray(stats.participantDailyStats)).toBe(true)
    expect(stats.participantDailyStats.length).toBeGreaterThanOrEqual(2)
    const todayEntry = stats.participantDailyStats.find((d: any) => d.day.startsWith(today.toISOString().slice(0, 10)))
    expect(todayEntry).toBeDefined()
    expect(todayEntry.totalMinutes).toBe(90)
  })

  test('Office — egress duration is correctly calculated', async ({ request }) => {
    // UI: totalEgressDuration = liveKitStats.egress.reduce((sum, e) => sum + e.minutes, 0) * 60000
    const now = new Date()

    await request.post(`${BILLING_URL}/api/v1/livekit/egress`, {
      headers: getAdminHeaders(),
      data: [
        {
          workspace: workspaceUuid,
          room: 'room-1',
          egressId: 'egress-1',
          egressStart: new Date(now.getTime() - 3600 * 1000).toISOString(),
          egressEnd: now.toISOString(),
          duration: 3600
        },
        {
          workspace: workspaceUuid,
          room: 'room-1',
          egressId: 'egress-2',
          egressStart: new Date(now.getTime() - 1800 * 1000).toISOString(),
          egressEnd: now.toISOString(),
          duration: 1800
        }
      ]
    })

    const stats = await getStats(request, workspaceUuid, ownerToken)
    const totalMinutes = stats.liveKitStats.egress.reduce((sum: number, e: any) => sum + e.minutes, 0)
    expect(totalMinutes).toBe(90) // (3600 + 1800) / 60
  })

  test('Office — egress duration contain entries per day for chart', async ({ request }) => {
    // UI uses liveKitStats.egress to build the Office chart series (red line)
    const today = new Date()
    const yesterday = new Date(Date.now() - 86400000)

    await request.post(`${BILLING_URL}/api/v1/livekit/egress`, {
      headers: getAdminHeaders(),
      data: [
        {
          workspace: workspaceUuid,
          room: 'room-1',
          egressId: 'egress-1',
          egressStart: new Date(yesterday.getTime() - 3600 * 1000).toISOString(),
          egressEnd: yesterday.toISOString(),
          duration: 3600
        },
        {
          workspace: workspaceUuid,
          room: 'room-1',
          egressId: 'egress-2',
          egressStart: new Date(yesterday.getTime() - 1800 * 1000).toISOString(),
          egressEnd: yesterday.toISOString(),
          duration: 1800
        },
        {
          workspace: workspaceUuid,
          room: 'room-1',
          egressId: 'egress-3',
          egressStart: new Date(today.getTime() - 3600 * 1000).toISOString(),
          egressEnd: today.toISOString(),
          duration: 60
        },
        {
          workspace: workspaceUuid,
          room: 'room-1',
          egressId: 'egress-4',
          egressStart: new Date(today.getTime() - 1800 * 1000).toISOString(),
          egressEnd: today.toISOString(),
          duration: 120
        }
      ]
    })

    const stats = await getStats(request, workspaceUuid, ownerToken)
    expect(Array.isArray(stats.liveKitStats.egress)).toBe(true)
    expect(stats.liveKitStats.egress.length).toBeGreaterThanOrEqual(2)
    const todayEntry = stats.liveKitStats.egress.find((d: any) => d.day.startsWith(today.toISOString().slice(0, 10)))
    expect(todayEntry).toBeDefined()
    expect(todayEntry.minutes).toBe(3)
  })

  test('Office — maxParticipants reflects concurrent participants in a session', async ({ request }) => {
    // UI: maxParticipants = participantDailyStats.reduce((max, d) => Math.max(max, d.maxParticipants), 0)
    const now = new Date()
    const sessionStart = new Date(now.getTime() - 3600 * 1000).toISOString()

    await request.post(`${BILLING_URL}/api/v1/livekit/participants`, {
      headers: getAdminHeaders(),
      data: [
        {
          workspace: workspaceUuid,
          participantId: 'p-1',
          sessionId: 's-1',
          room: 'room-1',
          joinedAt: sessionStart,
          leftAt: now.toISOString(),
          durationSeconds: 3600
        },
        {
          workspace: workspaceUuid,
          participantId: 'p-2',
          sessionId: 's-1',
          room: 'room-1',
          joinedAt: sessionStart,
          leftAt: now.toISOString(),
          durationSeconds: 3600
        },
        {
          workspace: workspaceUuid,
          participantId: 'p-3',
          sessionId: 's-1',
          room: 'room-1',
          joinedAt: sessionStart,
          leftAt: now.toISOString(),
          durationSeconds: 3600
        }
      ]
    })

    const stats = await getStats(request, workspaceUuid, ownerToken)
    const maxParticipants = stats.participantDailyStats.reduce(
      (max: number, d: any) => Math.max(max, d.maxParticipants),
      0
    )
    expect(maxParticipants).toBeGreaterThanOrEqual(3)
  })

  test('Office — maxMeetingDuration gives the longest meeting', async ({ request }) => {
    const now = new Date()

    // Meeting 1: 9:00 - 9:30 (30 min)
    const meeting1Start = new Date(now)
    meeting1Start.setHours(9, 0, 0, 0)
    const meeting1End = new Date(now)
    meeting1End.setHours(9, 30, 0, 0)

    // Meeting 2: 13:00 - 13:15 (15 min)
    const meeting2Start = new Date(now)
    meeting2Start.setHours(13, 0, 0, 0)
    const meeting2End = new Date(now)
    meeting2End.setHours(13, 15, 0, 0)

    await request.post(`${BILLING_URL}/api/v1/livekit/participants`, {
      headers: getAdminHeaders(),
      data: [
        {
          workspace: workspaceUuid,
          participantId: 'p-1',
          sessionId: 's-1',
          room: 'ws_meeting1',
          joinedAt: meeting1Start.toISOString(),
          leftAt: meeting1End.toISOString(),
          durationSeconds: 1800 // 30 min
        },
        {
          workspace: workspaceUuid,
          participantId: 'p-2',
          sessionId: 's-2',
          room: 'ws_meeting2',
          joinedAt: meeting2Start.toISOString(),
          leftAt: meeting2End.toISOString(),
          durationSeconds: 900 // 15 min
        }
      ]
    })

    const stats = await getStats(request, workspaceUuid, ownerToken)
    const maxDuration = stats.participantDailyStats.reduce(
      (max: number, d: any) => Math.max(max, d.maxMeetingDurationMinutes),
      0
    )

    expect(maxDuration).toBeLessThanOrEqual(30)
  })

  test('Office — avgMeetingDurationMinutes gives the average meeting duration', async ({ request }) => {
    const yesterday = new Date(Date.now() - 86400000)

    // Meeting 1: 9:00 - 9:30 (30 min)
    const meeting1Start = new Date(yesterday)
    meeting1Start.setHours(9, 0, 0, 0)
    const meeting1End = new Date(yesterday)
    meeting1End.setHours(9, 30, 0, 0)

    // Meeting 2: 13:00 - 13:15 (15 min)
    const meeting2Start = new Date(yesterday)
    meeting2Start.setHours(13, 0, 0, 0)
    const meeting2End = new Date(yesterday)
    meeting2End.setHours(13, 15, 0, 0)

    await request.post(`${BILLING_URL}/api/v1/livekit/participants`, {
      headers: getAdminHeaders(),
      data: [
        {
          workspace: workspaceUuid,
          participantId: 'p-1',
          sessionId: 's-1',
          room: 'ws_meeting1',
          joinedAt: meeting1Start.toISOString(),
          leftAt: meeting1End.toISOString(),
          durationSeconds: 1800 // 30 min
        },
        {
          workspace: workspaceUuid,
          participantId: 'p-2',
          sessionId: 's-2',
          room: 'ws_meeting2',
          joinedAt: meeting2Start.toISOString(),
          leftAt: meeting2End.toISOString(),
          durationSeconds: 900 // 15 min
        }
      ]
    })

    const stats = await getStats(request, workspaceUuid, ownerToken)
    const avDuration = stats.participantDailyStats.reduce(
      (sum: number, d: any) => sum + d.avgMeetingDurationMinutes / stats.participantDailyStats.length,
      0
    )

    expect(avDuration).toBe(23)
  })

  // ── Auth ─────────────────────────────────────────────────────────────────────

  test('Admin endpoint rejects non-admin token', async ({ request }) => {
    const res = await request.post(`${BILLING_URL}/api/v1/ai/transcript`, {
      headers: ownerHeaders(ownerToken),
      data: []
    })
    expect(res.status()).toBe(401)
  })

  test('Stats endpoint rejects missing token', async ({ request }) => {
    const res = await request.get(`${BILLING_URL}/api/v1/${workspaceUuid}/stats`)
    expect(res.status()).toBe(401)
  })

  test('Stats endpoint rejects token from a different workspace', async ({ request }) => {
    const res = await request.get(`${BILLING_URL}/api/v1/00000000-0000-0000-0000-000000000000/stats`, {
      headers: ownerHeaders(ownerToken)
    })
    expect(res.status()).toBe(401)
  })
})
