//
// Copyright © 2025 Hardcore Engineering Inc.
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

import {
  AiTokensData,
  AiTokensUsage,
  AiTokensGroupBy,
  AiTokensBreakdown,
  AiWorkspaceBreakdown,
  ProviderTokenTotal,
  ProviderPool,
  ProviderPoolConfig,
  AiModelRegistryEntry,
  AiTranscriptData,
  AiTranscriptDailyUsage,
  AiTranscriptUsage,
  AiTranscriptGroupBy,
  AiTranscriptBreakdown,
  AiTranscriptUsageData,
  BillingDB,
  LiveKitEgressData,
  LiveKitEgressUsageData,
  LiveKitParticipantSessionData,
  LiveKitSessionData,
  LiveKitSessionsUsageData,
  LiveKitUsageData,
  ParticipantDailyUsage,
  ParticipantMinutesUsage,
  type TokenBalance,
  type LimitCategory,
  type UsageMetric,
  type WorkspaceLimitState
} from '../types'
import postgres, { type Row, Sql } from 'postgres'
import { MeasureContext, type WorkspaceUuid } from '@hcengineering/core'
import { LoggedDB } from './logged'
import { RetryDB } from './retry'
import { DBFlavor, getMigrations } from './migrations'
import { computePoolTransition } from '../pool'

const BATCH_SIZE = 100

// Shared by getAiTranscriptBreakdown / getAiTokensBreakdown.
const GROUP_BY_COLUMN: Record<AiTokensGroupBy, string> = {
  model: 'model',
  level: 'level',
  provider: 'provider_id',
  workspace: 'workspace',
  client: 'client_id'
}

export async function getDbFlavor (sql: Sql<any>): Promise<DBFlavor> {
  const [{ version }] = await sql`SELECT version()`

  if (/cockroach/i.test(version)) {
    return 'cockroach'
  }

  if (/postgresql/i.test(version)) {
    return 'postgres'
  }

  return 'unknown'
}

export async function createDb (ctx: MeasureContext, connectionString: string): Promise<BillingDB> {
  const sql = postgres(connectionString, {
    max: 5,
    connection: {
      application_name: 'billing'
    },
    fetch_types: false,
    prepare: false,
    types: {
      // https://jdbc.postgresql.org/documentation/publicapi/constant-values.html
      int8: {
        to: 0,
        from: [20],
        serialize: (value: string) => value.toString(),
        parse: (value: number) => Number(value)
      }
    }
  })

  const db = await PostgresDB.create(ctx, sql)
  return new LoggedDB(ctx, new RetryDB(db, { retries: 5 }))
}

class PostgresDB implements BillingDB {
  private constructor (
    private readonly sql: Sql,
    private readonly flavor: DBFlavor
  ) {}

  private get stringType (): string {
    return this.flavor === 'cockroach' ? 'string' : 'text'
  }

  private get int8Type (): string {
    return this.flavor === 'cockroach' ? 'int8' : 'bigint'
  }

  static async create (ctx: MeasureContext, sql: Sql): Promise<PostgresDB> {
    const flavor = await getDbFlavor(sql)
    ctx.info('detected database flavor', { flavor })

    if (flavor === 'unknown') {
      throw new Error('Unknown database flavor. Only PostgreSQL and CockroachDB are supported.')
    }

    const db = new PostgresDB(sql, flavor)
    await db.initSchema(ctx)
    return db
  }

  async execute<T extends any[] = (Row & Iterable<Row>)[]>(query: string, params?: any[], sql?: Sql): Promise<T> {
    // Reject non-finite numbers before they reach the driver: a NaN/Infinity usage delta must not
    // corrupt a counter (previously guarded by the manual escaper).
    if (params !== undefined) {
      for (const p of params) {
        if (typeof p === 'number' && !Number.isFinite(p)) {
          throw new Error('Invalid numeric parameter')
        }
      }
    }
    // Native driver bind ($1..$N) — the driver parameterizes, no string interpolation of values.
    return await (sql ?? this.sql).unsafe<T>(query, params as any)
  }

  // Accumulating upserts (`col = col + EXCLUDED.col`) are not idempotent, so a batch loop that dies
  // half way and gets retried at method level would double-count what already committed. One batch
  // is atomic on its own; several go in a transaction.
  private async executeAll (statements: Array<{ query: string, params: any[] }>): Promise<void> {
    if (statements.length === 0) return
    if (statements.length === 1) {
      await this.execute(statements[0].query, statements[0].params)
      return
    }
    await this.sql.begin(async (tx) => {
      for (const st of statements) {
        await this.execute(st.query, st.params, tx as unknown as Sql)
      }
    })
  }

  async initSchema (ctx: MeasureContext): Promise<void> {
    await this.execute('CREATE SCHEMA IF NOT EXISTS billing')
    await this.execute(`
        CREATE TABLE IF NOT EXISTS billing.migrations (
          name       VARCHAR(255) NOT NULL,
          created_on TIMESTAMP    NOT NULL DEFAULT now()
        )
    `)

    const appliedMigrations = (await this.execute<Row[]>('SELECT name FROM billing.migrations')).map((row) => row.name)
    ctx.info('applied migrations', { migrations: appliedMigrations })

    for (const [name, sql] of getMigrations(this.flavor)) {
      if (appliedMigrations.includes(name)) {
        continue
      }

      try {
        ctx.warn('applying migration', { migration: name })
        await this.execute(sql)
        await this.execute('INSERT INTO billing.migrations (name) VALUES ($1)', [name])
      } catch (err: any) {
        ctx.error('failed to apply migration', { migration: name, error: err })
        throw err
      }
    }
  }

  async getLiveKitStats (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    start: Date,
    end: Date
  ): Promise<LiveKitUsageData> {
    return {
      sessions: await this.getDailySessionTotals(ctx, workspace, start, end),
      egress: await this.getDailyEgressTotals(ctx, workspace, start, end)
    }
  }

  async getDailySessionTotals (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    start: Date,
    end: Date
  ): Promise<LiveKitSessionsUsageData[]> {
    const query = `
      SELECT
          DATE_TRUNC('day', session_start) AS day,
          COALESCE(SUM(bandwidth), 0) AS bandwidth,
          COALESCE(SUM(minutes), 0) AS minutes
      FROM billing.livekit_session
      WHERE
          workspace = $1
          AND session_start >= $2
          AND session_start <= $3
      GROUP BY DATE_TRUNC('day', session_start)
      ORDER BY day;
    `

    const params = [workspace, start, end]

    const sessionTotals = await this.execute<{ day: string, bandwidth: string, minutes: string }[]>(query, params)
    return sessionTotals.map((s) => {
      return { day: s.day, bandwidth: parseInt(s.bandwidth), minutes: parseInt(s.minutes) }
    })
  }

  async getDailyEgressTotals (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    start: Date,
    end: Date
  ): Promise<LiveKitEgressUsageData[]> {
    const query = `
      SELECT
          DATE_TRUNC('day', egress_start) AS day,
          COALESCE(SUM(duration) / 60.0, 0) AS minutes
      FROM billing.livekit_egress
      WHERE
          workspace = $1
          AND egress_start >= $2
          AND egress_start <= $3
      GROUP BY DATE_TRUNC('day', egress_start)
      ORDER BY day;
    `

    const params = [workspace, start, end]

    const egressTotals = await this.execute<{ day: string, minutes: string }[]>(query, params)

    return egressTotals.map((e) => {
      return { day: e.day, minutes: parseInt(e.minutes) }
    })
  }

  async listLiveKitSessions (ctx: MeasureContext, workspace: WorkspaceUuid): Promise<LiveKitSessionData[] | null> {
    const query = `
        SELECT workspace, session_id, session_start, session_end, room, bandwidth, minutes
        FROM billing.livekit_session
        WHERE workspace = $1
      `
    const rows = await this.execute<any[]>(query, [workspace])

    return rows.map((row) => ({
      workspace: row.workspace,
      room: row.room,
      sessionId: row.session_id,
      sessionStart: row.session_start,
      sessionEnd: row.session_end,
      bandwidth: Number(row.bandwidth),
      minutes: Number(row.minutes)
    }))
  }

  async listLiveKitEgress (ctx: MeasureContext, workspace: WorkspaceUuid): Promise<LiveKitEgressData[] | null> {
    const query = `
        SELECT workspace, egress_id, egress_start, egress_end, room, duration
        FROM billing.livekit_egress
        WHERE workspace = $1
      `
    const rows = await this.execute<any[]>(query, [workspace])
    return rows.map((row) => ({
      workspace: row.workspace,
      room: row.room,
      egressId: row.egress_id,
      egressStart: row.egress_start,
      egressEnd: row.egress_end,
      duration: Number(row.duration)
    }))
  }

  async setLiveKitSessions (ctx: MeasureContext, data: LiveKitSessionData[]): Promise<void> {
    const uniqueSessions = new Map<string, LiveKitSessionData>()
    for (const item of data) {
      uniqueSessions.set(`${item.workspace}::${item.sessionId}`, item)
    }
    const uniqueSessionsValues = uniqueSessions.values()
    for (let i = 0; i < uniqueSessions.size; i += BATCH_SIZE) {
      const batch = uniqueSessionsValues.take(BATCH_SIZE)
      const values = []
      const params = []
      let paramIndex = 1

      for (const item of batch) {
        const { workspace, sessionId, sessionStart, sessionEnd, room, bandwidth, minutes } = item
        values.push(
          `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`
        )
        params.push(workspace, sessionId, sessionStart, sessionEnd, room, bandwidth ?? 0, minutes)
      }

      if (values.length === 0) continue

      const query =
        this.flavor === 'cockroach'
          ? `
          UPSERT INTO billing.livekit_session (workspace, session_id, session_start, session_end, room, bandwidth, minutes)
          VALUES ${values.join(',')}
        `
          : `
          INSERT INTO billing.livekit_session (workspace, session_id, session_start, session_end, room, bandwidth, minutes)
          VALUES ${values.join(',')}
          ON CONFLICT (workspace, session_id)
          DO UPDATE SET
            session_start = EXCLUDED.session_start,
            session_end = EXCLUDED.session_end,
            room = EXCLUDED.room,
            bandwidth = EXCLUDED.bandwidth,
            minutes = EXCLUDED.minutes
        `
      await this.execute(query, params)
    }
  }

  async setLiveKitEgress (ctx: MeasureContext, data: LiveKitEgressData[]): Promise<void> {
    const uniqueSessions = new Map<string, LiveKitEgressData>()
    for (const item of data) {
      uniqueSessions.set(`${item.workspace}::${item.egressId}`, item)
    }
    const uniqueSessionsValues = uniqueSessions.values()
    for (let i = 0; i < uniqueSessions.size; i += BATCH_SIZE) {
      const batch = uniqueSessionsValues.take(BATCH_SIZE)
      const values = []
      const params = []
      let paramIndex = 1

      for (const item of batch) {
        const { workspace, egressId, egressStart, egressEnd, room, duration } = item
        values.push(
          `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`
        )
        // duration is an integer column; egress seconds arrive fractional
        params.push(workspace, egressId, egressStart, egressEnd, room, Math.round(duration))
      }

      if (values.length === 0) continue

      const query =
        this.flavor === 'cockroach'
          ? `
          UPSERT INTO billing.livekit_egress (workspace, egress_id, egress_start, egress_end, room, duration)
          VALUES ${values.join(',')}
        `
          : `
          INSERT INTO billing.livekit_egress (workspace, egress_id, egress_start, egress_end, room, duration)
          VALUES ${values.join(',')}
          ON CONFLICT (workspace, egress_id)
          DO UPDATE SET
            egress_start = EXCLUDED.egress_start,
            egress_end = EXCLUDED.egress_end,
            room = EXCLUDED.room,
            duration = EXCLUDED.duration
        `
      await this.execute(query, params)
    }
  }

  async pushParticipantSessions (ctx: MeasureContext, data: LiveKitParticipantSessionData[]): Promise<void> {
    const uniqueSessions = new Map<string, LiveKitParticipantSessionData>()
    for (const item of data) {
      uniqueSessions.set(`${item.workspace}::${item.participantId}::${item.sessionId}`, item)
    }
    const uniqueValues = uniqueSessions.values()
    for (let i = 0; i < uniqueSessions.size; i += BATCH_SIZE) {
      const batch = uniqueValues.take(BATCH_SIZE)
      const values = []
      const params = []
      let paramIndex = 1

      for (const item of batch) {
        values.push(
          `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`
        )
        params.push(
          item.workspace,
          item.participantId,
          item.sessionId,
          item.room,
          item.joinedAt,
          item.leftAt,
          item.durationSeconds
        )
      }

      if (values.length === 0) continue

      const query =
        this.flavor === 'cockroach'
          ? `
          UPSERT INTO billing.livekit_participant_session (workspace, participant_id, session_id, room, joined_at, left_at, duration_seconds)
          VALUES ${values.join(',')}
        `
          : `
          INSERT INTO billing.livekit_participant_session (workspace, participant_id, session_id, room, joined_at, left_at, duration_seconds)
          VALUES ${values.join(',')}
          ON CONFLICT (workspace, participant_id, session_id)
          DO UPDATE SET
            left_at = EXCLUDED.left_at,
            duration_seconds = EXCLUDED.duration_seconds
        `
      await this.execute(query, params)
    }
  }

  async getParticipantMinutes (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    start: Date,
    end: Date
  ): Promise<ParticipantMinutesUsage> {
    const query = `
      SELECT
        COALESCE(SUM(duration_seconds), 0) / 60.0 AS total_minutes
      FROM billing.livekit_participant_session
      WHERE
        workspace = $1
        AND joined_at >= $2
        AND joined_at <= $3
        AND duration_seconds > 0
    `
    const params = [workspace, start, end]
    const result = await this.execute<{ total_minutes: string }[]>(query, params)
    return {
      totalMinutes: Math.round(Number(result[0]?.total_minutes ?? 0))
    }
  }

  async getParticipantDailyStats (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    start: Date,
    end: Date
  ): Promise<ParticipantDailyUsage[]> {
    const query = `
      WITH room_stats AS (
        SELECT 
          workspace,
          room,
          COUNT(*) AS participant_count,
          EXTRACT(EPOCH FROM (MAX(left_at) - MIN(joined_at))) / 60.0 AS meeting_duration_minutes
        FROM billing.livekit_participant_session
        WHERE workspace = $1 AND joined_at >= $2 AND joined_at <= $3 AND duration_seconds > 0
        GROUP BY workspace, room
      )
      SELECT
        DATE_TRUNC('day', ps.joined_at) AS day,
        COALESCE(SUM(ps.duration_seconds), 0) / 60.0 AS total_minutes,
        MAX(rs.participant_count) AS max_participants,
        COALESCE(AVG(rs.meeting_duration_minutes), 0) AS avg_meeting_duration_minutes,
        COALESCE(MAX(rs.meeting_duration_minutes), 0) AS max_meeting_duration_minutes
      FROM billing.livekit_participant_session ps
      JOIN room_stats rs ON ps.workspace = rs.workspace AND ps.room = rs.room
      WHERE
        ps.workspace = $1
        AND ps.joined_at >= $2
        AND ps.joined_at <= $3
        AND ps.duration_seconds > 0
      GROUP BY DATE_TRUNC('day', ps.joined_at)
      ORDER BY day;
    `
    const result = await this.execute<
    {
      day: string
      total_minutes: string
      max_participants: string
      avg_meeting_duration_minutes: string
      max_meeting_duration_minutes: string
    }[]
    >(query, [workspace, start, end])

    return result.map((row) => ({
      day: row.day,
      totalMinutes: Math.round(Number(row.total_minutes ?? 0)),
      maxParticipants: Number(row.max_participants ?? 0),
      avgMeetingDurationMinutes: Math.round(Number(row.avg_meeting_duration_minutes ?? 0)),
      maxMeetingDurationMinutes: Math.round(Number(row.max_meeting_duration_minutes ?? 0))
    }))
  }

  async pushAiTranscriptData (ctx: MeasureContext, data: AiTranscriptData[]): Promise<void> {
    const aggregated = new Map<string, AiTranscriptData>()
    for (const item of data) {
      const key = `${item.workspace}::${item.day}`
      const existing = aggregated.get(key)
      if (existing !== undefined) {
        existing.durationSeconds += item.durationSeconds
        existing.usd += item.usd
      } else {
        aggregated.set(key, { ...item })
      }
    }
    const deduped = Array.from(aggregated.values())
    const statements: Array<{ query: string, params: any[] }> = []

    for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
      const batch = deduped.slice(i, i + BATCH_SIZE)
      if (batch.length === 0) continue

      const values: string[] = []
      const params: any[] = []
      let paramIndex = 1

      for (const item of batch) {
        const { workspace, lastRequestId, lastStartTime, durationSeconds, usd, day } = item
        values.push(
          `($${paramIndex++}::uuid, DATE($${paramIndex++}::timestamp), $${paramIndex++}::${this.stringType}, $${paramIndex++}::timestamp, $${paramIndex++}::float, $${paramIndex++}::decimal)`
        )
        params.push(workspace, day, lastRequestId, lastStartTime, durationSeconds, usd)
      }

      const query = `
      INSERT INTO billing.ai_transcript_usage
        (workspace, day, last_request_id, last_start_time, total_duration_seconds, total_usd)
      VALUES ${values.join(',')}
      ON CONFLICT (workspace, day)
      DO UPDATE SET
        total_duration_seconds = billing.ai_transcript_usage.total_duration_seconds + EXCLUDED.total_duration_seconds,
        total_usd = billing.ai_transcript_usage.total_usd + EXCLUDED.total_usd,
        last_request_id = CASE
          WHEN EXCLUDED.last_start_time > billing.ai_transcript_usage.last_start_time
          THEN EXCLUDED.last_request_id
          ELSE billing.ai_transcript_usage.last_request_id
        END,
        last_start_time = GREATEST(billing.ai_transcript_usage.last_start_time, EXCLUDED.last_start_time);
    `

      statements.push({ query, params })
    }
    await this.executeAll(statements)
  }

  async getAiTranscriptStats (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    start?: Date,
    end?: Date
  ): Promise<AiTranscriptUsage> {
    const baseSql = `
    SELECT
      SUM(total_duration_seconds) AS total_duration_seconds
    FROM billing.ai_transcript_usage
  `

    let where = 'WHERE workspace = $1::uuid'
    const params: any[] = [workspace]
    let paramIndex = params.length + 1

    if (start != null) {
      const s = new Date(start)
      s.setHours(0, 0, 0, 0)

      where += ` AND day >= $${paramIndex++}::date`
      params.push(s)
    }

    if (end != null) {
      const e = new Date(end)
      e.setHours(23, 59, 59, 999)

      where += ` AND day <= $${paramIndex++}::date`
      params.push(e)
    }

    const sql = [baseSql, where].join(' ')
    const result = await this.execute(sql, params)

    return {
      totalDurationSeconds: Number(result[0]?.total_duration_seconds ?? 0)
    }
  }

  async getAiTranscriptDailyStats (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    start: Date,
    end: Date
  ): Promise<AiTranscriptDailyUsage[]> {
    const query = `
      SELECT
        day,
        total_duration_seconds
      FROM billing.ai_transcript_usage
      WHERE
        workspace = $1::uuid
        AND day >= $2::date
        AND day <= $3::date
      ORDER BY day;
    `
    const params = [workspace, start, end]
    const result = await this.execute<{ day: string, total_duration_seconds: string }[]>(query, params)
    return result.map((row) => ({
      day: row.day,
      totalDurationSeconds: Number(row.total_duration_seconds ?? 0)
    }))
  }

  async getAiTranscriptLastData (ctx: MeasureContext): Promise<AiTranscriptData | undefined> {
    const sql = `
    SELECT *
    FROM billing.ai_transcript_usage
    ORDER BY day DESC
    LIMIT 1`

    const result = await this.execute(sql)
    const last = result[0]

    if (last == null) return undefined

    return {
      workspace: last.workspace,
      day: last.day,
      lastRequestId: last.last_request_id,
      lastStartTime: last.last_start_time,
      durationSeconds: Number(last?.total_duration_seconds ?? 0),
      usd: Number(last.usd)
    }
  }

  // Per-model ASR detail (admin breakdown), separate table from the deepgram-polling
  // ai_transcript_usage. Mirrors pushAiTokensData.
  async pushTranscriptUsage (ctx: MeasureContext, data: AiTranscriptUsageData[]): Promise<void> {
    const aggregated = new Map<string, AiTranscriptUsageData & { day: string }>()
    for (const item of data) {
      const providerId = item.providerId ?? ''
      const model = item.model ?? ''
      const level = item.level ?? ''
      const clientId = item.clientId ?? ''
      const day = new Date(item.date)
      day.setUTCHours(0, 0, 0, 0)
      const dayStr = day.toISOString()
      const key = `${item.workspace}::${dayStr}::${providerId}::${model}::${level}::${clientId}`
      const existing = aggregated.get(key)
      if (existing !== undefined) {
        existing.durationSeconds += item.durationSeconds
      } else {
        aggregated.set(key, { ...item, providerId, model, level, clientId, day: dayStr })
      }
    }
    const deduped = Array.from(aggregated.values())
    const statements: Array<{ query: string, params: any[] }> = []

    for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
      const batch = deduped.slice(i, i + BATCH_SIZE)
      if (batch.length === 0) continue

      const values: string[] = []
      const params: any[] = []
      let paramIndex = 1

      for (const item of batch) {
        values.push(
          `($${paramIndex++}::uuid, DATE($${paramIndex++}::timestamp), $${paramIndex++}::${this.stringType}, $${paramIndex++}::${this.stringType}, $${paramIndex++}::${this.stringType}, $${paramIndex++}::${this.stringType}, $${paramIndex++}::float)`
        )
        params.push(
          item.workspace,
          item.day,
          item.providerId,
          item.model,
          item.level,
          item.clientId ?? '',
          item.durationSeconds
        )
      }

      const sql = `
      INSERT INTO billing.ai_transcript_usage_detail
        (workspace, day, provider_id, model, level, client_id, total_duration_seconds)
      VALUES ${values.join(',')}
      ON CONFLICT (workspace, day, provider_id, model, level, client_id)
      DO UPDATE SET
        total_duration_seconds = billing.ai_transcript_usage_detail.total_duration_seconds
          + EXCLUDED.total_duration_seconds;
    `
      statements.push({ query: sql, params })
    }
    await this.executeAll(statements)
  }

  async getAiTranscriptBreakdown (
    ctx: MeasureContext,
    groupBy: AiTranscriptGroupBy,
    start?: Date,
    end?: Date
  ): Promise<AiTranscriptBreakdown[]> {
    const column = GROUP_BY_COLUMN[groupBy]
    const params: any[] = []
    let where = 'WHERE 1 = 1'
    let paramIndex = 1
    if (start != null) {
      where += ` AND day >= $${paramIndex++}::date`
      params.push(start)
    }
    if (end != null) {
      where += ` AND day <= $${paramIndex++}::date`
      params.push(end)
    }

    const sql = `
    SELECT ${column} AS grp, SUM(total_duration_seconds) AS total_duration_seconds
    FROM billing.ai_transcript_usage_detail
    ${where}
    GROUP BY ${column}
    ORDER BY total_duration_seconds DESC`
    const result = await this.execute(sql, params)

    return result.map((row: any) => {
      const durationSeconds = Number(row.total_duration_seconds ?? 0)
      const grp = row.grp
      switch (groupBy) {
        case 'model':
          return { model: grp, durationSeconds }
        case 'level':
          return { level: grp, durationSeconds }
        case 'provider':
          return { providerId: grp, durationSeconds }
        case 'client':
          return { clientId: grp, durationSeconds }
        default:
          return { workspace: grp, durationSeconds }
      }
    })
  }

  async pushAiTokensData (ctx: MeasureContext, data: AiTokensData[]): Promise<void> {
    // Bucket by the hour the usage happened in, so rolling windows (5h / week) are exact.
    const aggregated = new Map<string, AiTokensData & { hour: string }>()
    for (const item of data) {
      const providerId = item.providerId ?? ''
      const model = item.model ?? ''
      const level = item.level ?? ''
      const hour = truncToHour(item.date)
      const clientId = item.clientId ?? ''
      const key = `${item.workspace}::${hour}::${item.reason}::${providerId}::${model}::${level}::${clientId}`
      const existing = aggregated.get(key)
      if (existing !== undefined) {
        existing.tokens += item.tokens
        existing.rawTokens = (existing.rawTokens ?? 0) + (item.rawTokens ?? 0)
      } else {
        aggregated.set(key, { ...item, providerId, model, level, clientId, hour })
      }
    }
    const deduped = Array.from(aggregated.values())
    const statements: Array<{ query: string, params: any[] }> = []

    for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
      const batch = deduped.slice(i, i + BATCH_SIZE)
      if (batch.length === 0) continue

      const values: string[] = []
      const params: any[] = []
      let paramIndex = 1

      for (const item of batch) {
        const { workspace, reason, tokens, hour } = item

        values.push(
          `($${paramIndex++}::uuid, $${paramIndex++}::timestamp, $${paramIndex++}::${this.stringType}, $${paramIndex++}::${this.int8Type}, $${paramIndex++}::${this.int8Type}, $${paramIndex++}::${this.stringType}, $${paramIndex++}::${this.stringType}, $${paramIndex++}::${this.stringType}, $${paramIndex++}::${this.stringType})`
        )

        params.push(
          workspace,
          hour,
          reason,
          tokens,
          item.rawTokens ?? 0,
          item.providerId ?? '',
          item.model ?? '',
          item.level ?? '',
          item.clientId ?? ''
        )
      }

      const sql = `
      INSERT INTO billing.ai_tokens_usage (workspace, hour, reason, total_tokens, raw_tokens, provider_id, model, level, client_id)
      VALUES ${values.join(',')}
      ON CONFLICT (workspace, hour, reason, provider_id, model, level, client_id)
      DO UPDATE SET
        total_tokens = billing.ai_tokens_usage.total_tokens + EXCLUDED.total_tokens,
        raw_tokens = billing.ai_tokens_usage.raw_tokens + EXCLUDED.raw_tokens;
    `

      statements.push({ query: sql, params })
    }
    await this.executeAll(statements)
  }

  // Build a "AND hour >= / < " clause from optional start/end. `end` is exclusive so two adjacent
  // ranges never count the boundary hour twice.
  private hourRange (params: any[], startIndex: number, start?: Date, end?: Date): string {
    let where = ''
    let paramIndex = startIndex
    if (start != null) {
      where += ` AND hour >= $${paramIndex++}::timestamp`
      params.push(new Date(start))
    }
    if (end != null) {
      where += ` AND hour < $${paramIndex++}::timestamp`
      params.push(new Date(end))
    }
    return where
  }

  async getAiTokensStats (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    start?: Date,
    end?: Date
  ): Promise<AiTokensUsage[]> {
    const params: any[] = [workspace]
    const where = 'WHERE workspace = $1::uuid' + this.hourRange(params, 2, start, end)

    const sql = `
    SELECT reason, SUM(total_tokens) AS total_tokens
    FROM billing.ai_tokens_usage
    ${where}
    GROUP BY reason
    ORDER BY reason ASC`
    const result = await this.execute(sql, params)

    return result.map((row: any) => ({
      reason: row.reason,
      totalTokens: Number(row.total_tokens ?? 0)
    }))
  }

  async accumulateUsageDelta (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    metric: UsageMetric,
    amount: number,
    ref: string
  ): Promise<boolean> {
    // RETURNING ref yields a row only when the insert actually happened (new ref); empty on duplicate.
    const query = `
      INSERT INTO billing.usage_delta_dedup (workspace, metric, ref, amount)
      VALUES ($1::uuid, $2, $3, $4)
      ON CONFLICT (workspace, metric, ref) DO NOTHING
      RETURNING ref
    `
    // amount is a bigint column; transcript seconds arrive fractional
    const rows = await this.execute<any[]>(query, [workspace, metric, ref, Math.round(amount)])
    return rows.length > 0
  }

  async cleanupUsageDeltaDedup (ctx: MeasureContext, retentionDays: number): Promise<void> {
    // Dedup refs only need to outlive the queue redelivery window; prune the rest.
    const query = `
      DELETE FROM billing.usage_delta_dedup
      WHERE created_at < now() - ($1 * INTERVAL '1 day')
    `
    await this.execute(query, [retentionDays])
  }

  async getLimitState (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    category: LimitCategory
  ): Promise<WorkspaceLimitState | undefined> {
    const query = `
      SELECT ${LIMIT_STATE_COLUMNS}
      FROM billing.workspace_limit_state
      WHERE workspace = $1::uuid AND category = $2
    `
    const rows = await this.execute<any[]>(query, [workspace, category])
    const row = rows[0]
    return row == null ? undefined : rowToLimitState(row)
  }

  async upsertLimitState (ctx: MeasureContext, state: WorkspaceLimitState): Promise<void> {
    const query =
      this.flavor === 'cockroach'
        ? `
          UPSERT INTO billing.workspace_limit_state
            (workspace, category, used, limit_value, exhausted, updated_at)
          VALUES ($1::uuid, $2, $3, $4, $5, now())
        `
        : `
          INSERT INTO billing.workspace_limit_state
            (workspace, category, used, limit_value, exhausted, updated_at)
          VALUES ($1::uuid, $2, $3, $4, $5, now())
          ON CONFLICT (workspace, category)
          DO UPDATE SET
            used = EXCLUDED.used,
            limit_value = EXCLUDED.limit_value,
            exhausted = EXCLUDED.exhausted,
            updated_at = now()
        `
    // used/limit_value are bigint columns; transcript seconds arrive fractional
    await this.execute(query, [
      state.workspace,
      state.category,
      Math.round(state.used),
      Math.round(state.limitValue),
      state.exhausted
    ])
  }

  async getAllExhaustedStates (ctx: MeasureContext): Promise<WorkspaceLimitState[]> {
    const query = `
      SELECT ${LIMIT_STATE_COLUMNS}
      FROM billing.workspace_limit_state
      WHERE exhausted = TRUE
    `
    const rows = await this.execute<any[]>(query, [])
    return rows.map(rowToLimitState)
  }

  async getAiTokensBreakdown (
    ctx: MeasureContext,
    groupBy: AiTokensGroupBy,
    providerId?: string,
    start?: Date,
    end?: Date
  ): Promise<AiTokensBreakdown[]> {
    const column = GROUP_BY_COLUMN[groupBy]
    const params: any[] = []
    let where = ''
    let paramIndex = 1
    if (providerId != null && providerId !== '') {
      where = `WHERE provider_id = $${paramIndex++}::${this.stringType}`
      params.push(providerId)
    } else {
      where = 'WHERE 1 = 1'
    }
    where += this.hourRange(params, paramIndex, start, end)

    const sql = `
    SELECT ${column} AS grp, SUM(total_tokens) AS total_tokens, SUM(raw_tokens) AS raw_tokens
    FROM billing.ai_tokens_usage
    ${where}
    GROUP BY ${column}
    ORDER BY total_tokens DESC`
    const result = await this.execute(sql, params)

    return result.map((row: any) => {
      const total = Number(row.total_tokens ?? 0)
      const raw = Number(row.raw_tokens ?? 0)
      const grp = row.grp
      switch (groupBy) {
        case 'model':
          return { model: grp, totalTokens: total, rawTokens: raw }
        case 'level':
          return { level: grp, totalTokens: total, rawTokens: raw }
        case 'provider':
          return { providerId: grp, totalTokens: total, rawTokens: raw }
        case 'client':
          return { clientId: grp, totalTokens: total, rawTokens: raw }
        default:
          return { workspace: grp, totalTokens: total, rawTokens: raw }
      }
    })
  }

  // Per-workspace period total + rolling-window usage + per-model/level split, merged in memory.
  async getWorkspaceBreakdown (
    ctx: MeasureContext,
    start?: Date,
    end?: Date,
    limit?: number,
    offset?: number
  ): Promise<AiWorkspaceBreakdown[]> {
    const now = Date.now()
    const sinceMonth = new Date(now - 24 * 30 * 60 * 60 * 1000)

    const totalsParams: any[] = [sinceMonth]
    const totalsWhere = `WHERE 1 = 1${this.hourRange(totalsParams, 2, start, end)}`
    // Highest spenders first; page with limit/offset (default: all).
    let pageClause = ''
    if (limit !== undefined) {
      totalsParams.push(limit)
      pageClause += ` LIMIT $${totalsParams.length}`
      totalsParams.push(offset ?? 0)
      pageClause += ` OFFSET $${totalsParams.length}`
    }
    const totalsSql = `
    SELECT workspace,
      SUM(total_tokens) AS total_tokens,
      SUM(raw_tokens) AS raw_tokens,
      SUM(CASE WHEN hour >= $1::timestamp THEN total_tokens ELSE 0 END) AS used_month
    FROM billing.ai_tokens_usage
    ${totalsWhere}
    GROUP BY workspace
    ORDER BY total_tokens DESC${pageClause}`
    const totals = await this.execute<any[]>(totalsSql, totalsParams)

    const splitBy = async (
      column: 'model' | 'level'
    ): Promise<Map<string, Array<{ key: string, totalTokens: number }>>> => {
      const params: any[] = []
      const where = `WHERE 1 = 1${this.hourRange(params, 1, start, end)}`
      const sql = `
      SELECT workspace, ${column} AS grp, SUM(total_tokens) AS total_tokens, SUM(raw_tokens) AS raw_tokens
      FROM billing.ai_tokens_usage
      ${where}
      GROUP BY workspace, ${column}
      ORDER BY total_tokens DESC`
      const rows = await this.execute<any[]>(sql, params)
      const map = new Map<string, Array<{ key: string, totalTokens: number, rawTokens?: number }>>()
      for (const r of rows) {
        const list = map.get(r.workspace) ?? []
        list.push({ key: r.grp ?? '', totalTokens: Number(r.total_tokens ?? 0), rawTokens: Number(r.raw_tokens ?? 0) })
        map.set(r.workspace, list)
      }
      return map
    }
    const [byModel, byLevel] = await Promise.all([splitBy('model'), splitBy('level')])

    return totals.map((row: any) => ({
      workspace: row.workspace as WorkspaceUuid,
      totalTokens: Number(row.total_tokens ?? 0),
      rawTokens: Number(row.raw_tokens ?? 0),
      usedRolling30d: Number(row.used_month ?? 0),
      byModel: byModel.get(row.workspace) ?? [],
      byLevel: byLevel.get(row.workspace) ?? []
    }))
  }

  // Per-level token totals within a calendar billing period (for the usage popup breakdown).
  async getWorkspaceLevelUsage (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    start: Date,
    end: Date
  ): Promise<Array<{ level: string, label: string, tokens: number }>> {
    // Label via subquery, not a JOIN: several registry rows may share a level, and joining
    // them would multiply every usage row before the SUM.
    const sql = `
    SELECT u.level,
      (SELECT MAX(r.label) FROM billing.ai_model_registry r WHERE r.level = u.level) AS label,
      SUM(u.total_tokens) AS tokens
    FROM billing.ai_tokens_usage u
    WHERE u.workspace = $1::uuid AND u.hour >= $2::timestamp AND u.hour < $3::timestamp
    GROUP BY u.level
    ORDER BY tokens DESC`
    const result = await this.execute(sql, [workspace, start, end])
    return result.map((row: any) => ({
      level: row.level ?? '',
      label: row.label ?? row.level ?? '',
      tokens: Number(row.tokens ?? 0)
    }))
  }

  async getProviderTokenTotals (ctx: MeasureContext, start?: Date, end?: Date): Promise<ProviderTokenTotal[]> {
    const params: any[] = []
    const where = "WHERE provider_id <> ''" + this.hourRange(params, 1, start, end)

    const sql = `
    SELECT provider_id, model, SUM(total_tokens) AS total_tokens, SUM(raw_tokens) AS raw_tokens
    FROM billing.ai_tokens_usage
    ${where}
    GROUP BY provider_id, model`
    const result = await this.execute(sql, params)

    return result.map((row: any) => ({
      providerId: row.provider_id,
      model: row.model ?? '',
      totalTokens: Number(row.total_tokens ?? 0),
      rawTokens: Number(row.raw_tokens ?? 0)
    }))
  }

  private mapPool (row: any): ProviderPool {
    return {
      providerId: row.provider_id,
      model: row.model ?? '',
      kind: row.kind,
      purchasedTokens: Number(row.purchased_tokens ?? 0),
      period: row.period,
      periodStart: new Date(row.period_start).toISOString(),
      usedTokens: Number(row.used_tokens ?? 0),
      exhausted: row.exhausted === true,
      notified80: row.notified80 === true,
      notified100: row.notified100 === true
    }
  }

  async listProviderPools (ctx: MeasureContext): Promise<ProviderPool[]> {
    const result = await this.execute('SELECT * FROM billing.provider_pool ORDER BY provider_id ASC, model ASC', [])
    return result.map((row: any) => this.mapPool(row))
  }

  private async getProviderPool (
    ctx: MeasureContext,
    providerId: string,
    model: string
  ): Promise<ProviderPool | undefined> {
    const result = await this.execute(
      `SELECT * FROM billing.provider_pool WHERE provider_id = $1::${this.stringType} AND model = $2::${this.stringType}`,
      [providerId, model]
    )
    return result.length > 0 ? this.mapPool(result[0]) : undefined
  }

  async upsertProviderPool (ctx: MeasureContext, config: ProviderPoolConfig): Promise<void> {
    const periodStart = config.periodStart ?? new Date().toISOString()

    // A new config / new period resets used + notify flags (recompute repopulates used).
    const sql = `
    INSERT INTO billing.provider_pool
      (provider_id, model, kind, purchased_tokens, period, period_start, used_tokens, exhausted, notified80, notified100)
    VALUES ($1::${this.stringType}, $2::${this.stringType}, $3::${this.stringType}, $4::${this.int8Type}, $5::${this.stringType}, $6::timestamp, 0, false, false, false)
    ON CONFLICT (provider_id, model) DO UPDATE SET
      kind = EXCLUDED.kind,
      purchased_tokens = EXCLUDED.purchased_tokens,
      period = EXCLUDED.period,
      period_start = EXCLUDED.period_start,
      used_tokens = 0,
      exhausted = false,
      notified80 = false,
      notified100 = false`
    await this.execute(sql, [
      config.providerId,
      config.model,
      config.kind,
      config.purchasedTokens,
      config.period,
      periodStart
    ])
  }

  async addPurchasedTokens (ctx: MeasureContext, providerId: string, model: string, delta: number): Promise<void> {
    // Top-up: increment the purchased budget and clear exhausted/notify flags so the
    // pool reopens and 80%/100% can fire again against the new total.
    const sql = `
    UPDATE billing.provider_pool SET
      purchased_tokens = purchased_tokens + $3::${this.int8Type},
      exhausted = false,
      notified80 = false,
      notified100 = false
    WHERE provider_id = $1::${this.stringType} AND model = $2::${this.stringType}`
    await this.execute(sql, [providerId, model, delta])
  }

  async updateProviderPoolState (
    ctx: MeasureContext,
    providerId: string,
    model: string,
    usedTokens: number
  ): Promise<{ pool: ProviderPool, crossed80: boolean, crossed100: boolean }> {
    const existing = await this.getProviderPool(ctx, providerId, model)
    if (existing === undefined) {
      throw new Error(`provider pool not found: ${providerId}/${model}`)
    }

    const { exhausted, crossed80, crossed100 } = computePoolTransition(existing, usedTokens)

    // The notified flags are NOT set here: markPoolNotified writes them once the alert is out,
    // so a failed send is retried on the next pass instead of being lost.
    const sql = `
    UPDATE billing.provider_pool SET
      used_tokens = $3::${this.int8Type},
      exhausted = $4
    WHERE provider_id = $1::${this.stringType} AND model = $2::${this.stringType}`
    await this.execute(sql, [providerId, model, usedTokens, exhausted])

    return { pool: { ...existing, usedTokens, exhausted }, crossed80, crossed100 }
  }

  async markPoolNotified (ctx: MeasureContext, providerId: string, model: string, percent: 80 | 100): Promise<void> {
    // 100% implies 80%: a pool that jumps straight past both sends one alert, and leaving
    // notified80 false would fire a stale 80% alert on the next pass.
    const columns = percent === 100 ? 'notified100 = true, notified80 = true' : 'notified80 = true'
    await this.execute(
      `UPDATE billing.provider_pool SET ${columns}
       WHERE provider_id = $1::${this.stringType} AND model = $2::${this.stringType}`,
      [providerId, model]
    )
  }

  async replaceAiModelRegistry (ctx: MeasureContext, entries: AiModelRegistryEntry[]): Promise<void> {
    // An empty array is treated as a bad/unloaded config, not "delete everything" — skip.
    if (entries.length === 0) return

    for (const e of entries) {
      const sql = `
      INSERT INTO billing.ai_model_registry (provider_id, model, level, label, updated_at)
      VALUES ($1::${this.stringType}, $2::${this.stringType}, $3::${this.stringType}, $4::${this.stringType}, now())
      ON CONFLICT (provider_id, model) DO UPDATE SET
        level = EXCLUDED.level,
        label = EXCLUDED.label,
        updated_at = now()`
      await this.execute(sql, [e.providerId, e.model, e.level, e.label])
    }

    // Drop models no longer in the config so stale labels don't linger in admin UI.
    const params: any[] = []
    const keys = entries
      .map((e) => {
        params.push(e.providerId, e.model)
        return `($${params.length - 1}::${this.stringType}, $${params.length}::${this.stringType})`
      })
      .join(', ')
    await this.execute(
      `DELETE FROM billing.ai_model_registry WHERE (provider_id, model) NOT IN (VALUES ${keys})`,
      params
    )
  }

  async listAiModelRegistry (ctx: MeasureContext): Promise<AiModelRegistryEntry[]> {
    const result = await this.execute(
      'SELECT provider_id, model, level, label FROM billing.ai_model_registry ORDER BY provider_id ASC, model ASC',
      []
    )
    return result.map((row: any) => ({
      providerId: row.provider_id,
      model: row.model,
      level: row.level ?? '',
      label: row.label ?? ''
    }))
  }

  // Reset a pool's used counter by starting a fresh period at now(): the next
  // recompute sums only usage after this instant, so used drops to 0 and the pool reopens.
  async resetProviderPoolUsed (ctx: MeasureContext, providerId: string, model: string): Promise<void> {
    const sql = `
    UPDATE billing.provider_pool SET
      period_start = now(),
      used_tokens = 0,
      exhausted = false,
      notified80 = false,
      notified100 = false
    WHERE provider_id = $1::${this.stringType} AND model = $2::${this.stringType}`
    await this.execute(sql, [providerId, model])
  }

  async resetAllProviderPoolsUsed (ctx: MeasureContext): Promise<void> {
    await this.execute(
      `UPDATE billing.provider_pool SET
        period_start = now(), used_tokens = 0, exhausted = false, notified80 = false, notified100 = false`,
      []
    )
  }

  // Clear a workspace's token limit state so it is no longer blocked; recompute repopulates used.
  async resetWorkspaceUsed (ctx: MeasureContext, workspace: WorkspaceUuid, periodStart: Date): Promise<void> {
    // The hourly recompute rebuilds `used` from ai_tokens_usage, so clearing only the cached
    // state made the button look like it did nothing: the block was back within the hour.
    await this.execute('DELETE FROM billing.ai_tokens_usage WHERE workspace = $1::uuid AND hour >= $2::timestamp', [
      workspace,
      periodStart
    ])
    await this.clearAbsorption(workspace)
    await this.execute(
      "UPDATE billing.workspace_limit_state SET used = 0, exhausted = false, updated_at = now() WHERE workspace = $1::uuid AND category = 'tokens'",
      [workspace]
    )
  }

  // `usedMonth` subtracts what the balance absorbed: a stale counter would understate usage.
  private async clearAbsorption (workspace: WorkspaceUuid): Promise<void> {
    await this.execute(
      'UPDATE billing.token_balance SET absorbed_period = 0, absorbed_until = NULL WHERE workspace = $1::uuid',
      [workspace]
    )
  }

  // Test helper: make the workspace's token usage exactly `value`. Clears this month's usage rows
  // (the source recompute reads from) and inserts one synthetic record, then updates the cached state.
  async setWorkspaceUsed (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    value: number,
    level: string,
    periodStart: Date
  ): Promise<void> {
    await this.execute('DELETE FROM billing.ai_tokens_usage WHERE workspace = $1::uuid AND hour >= $2::timestamp', [
      workspace,
      periodStart
    ])
    await this.clearAbsorption(workspace)
    if (value > 0) {
      await this.execute(
        `INSERT INTO billing.ai_tokens_usage (workspace, hour, reason, total_tokens, raw_tokens, provider_id, model, level)
         VALUES ($1::uuid, now(), 'admin-test', $2::${this.int8Type}, $2::${this.int8Type}, '', '', $3::${this.stringType})`,
        [workspace, value, level]
      )
    }
    await this.execute(
      `UPDATE billing.workspace_limit_state SET used = $2::${this.int8Type}, updated_at = now() WHERE workspace = $1::uuid AND category = 'tokens'`,
      [workspace, value]
    )
  }

  async getTokenBalance (ctx: MeasureContext, workspace: WorkspaceUuid): Promise<TokenBalance | undefined> {
    // Read the naive timestamps back as UTC: the driver parses a bare `timestamp` as local time,
    // so a pod outside UTC would round-trip period_start to a different instant than it wrote.
    const result = await this.execute(
      `SELECT workspace, remaining_tokens, absorbed_period,
        absorbed_until AT TIME ZONE 'UTC' AS absorbed_until,
        period_start AT TIME ZONE 'UTC' AS period_start
      FROM billing.token_balance WHERE workspace = $1::uuid`,
      [workspace]
    )
    if (result.length === 0) return undefined
    const row = result[0]
    return {
      workspace: row.workspace as WorkspaceUuid,
      remainingTokens: Number(row.remaining_tokens ?? 0),
      absorbedUntil: row.absorbed_until != null ? new Date(row.absorbed_until).toISOString() : null,
      absorbedPeriod: Number(row.absorbed_period ?? 0),
      periodStart: new Date(row.period_start).toISOString()
    }
  }

  async grantAiTokens (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    grantId: string,
    amount: number
  ): Promise<boolean> {
    // Ledger insert + balance increment in one statement; ON CONFLICT on the ledger PK makes
    // a redelivered grant a no-op.
    const sql = `
    WITH ins AS (
      INSERT INTO billing.ai_token_topup (purchase_id, workspace, amount, granted_at)
      VALUES ($1, $2::uuid, $3::${this.int8Type}, now())
      ON CONFLICT (purchase_id) DO NOTHING
      RETURNING amount
    )
    INSERT INTO billing.token_balance (workspace, remaining_tokens, absorbed_until, period_start)
    SELECT $2::uuid, ins.amount, date_trunc('hour', now() AT TIME ZONE 'UTC'), now() AT TIME ZONE 'UTC' FROM ins
    ON CONFLICT (workspace) DO UPDATE SET
      remaining_tokens = billing.token_balance.remaining_tokens + EXCLUDED.remaining_tokens
    RETURNING remaining_tokens`
    const result = await this.execute(sql, [grantId, workspace, amount])
    return result.length > 0
  }

  async settleTokenBalance (
    ctx: MeasureContext,
    workspace: WorkspaceUuid,
    charge: number,
    absorbedUntil: string | null,
    absorbedPeriod: number,
    newPeriodStart: string
  ): Promise<boolean> {
    // Relative decrement + guard on the old period_start (WHERE sees the pre-update row): a second
    // settle finds it already rolled forward and changes nothing, and a concurrent grant's
    // increment survives because the balance is never written as an absolute.
    const result = await this.execute(
      `UPDATE billing.token_balance SET
        remaining_tokens = remaining_tokens - $2::${this.int8Type},
        absorbed_until = $3::timestamp,
        absorbed_period = $4::${this.int8Type},
        period_start = $5::timestamp
      WHERE workspace = $1::uuid AND period_start < $5::timestamp
      RETURNING workspace`,
      [workspace, charge, absorbedUntil, absorbedPeriod, newPeriodStart]
    )
    return result.length > 0
  }
}

export default PostgresDB

const LIMIT_STATE_COLUMNS = 'workspace, category, used, limit_value, exhausted'

function rowToLimitState (row: any): WorkspaceLimitState {
  return {
    workspace: row.workspace as WorkspaceUuid,
    category: row.category as LimitCategory,
    used: Number(row.used) ?? 0,
    limitValue: Number(row.limit_value) ?? 0,
    // postgres bool may arrive as boolean or 't'/'true' string depending on driver
    exhausted: row.exhausted === true || row.exhausted === 'true' || row.exhausted === 't'
  }
}

// Truncate an ISO date string to the start of its hour (UTC), for hourly bucketing.
function truncToHour (date: string): string {
  const d = new Date(date)
  d.setUTCMinutes(0, 0, 0)
  return d.toISOString()
}
