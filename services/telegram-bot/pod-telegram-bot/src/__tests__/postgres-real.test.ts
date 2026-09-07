//
// Copyright © 2026 Hardcore Engineering Inc.
//
// Licensed under the Eclipse Public License, Version 2.0 (the 'License');
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an 'AS IS' BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//

/**
 * A set of tests against a real PostgreSQL database.
 * CockroachDB used to be covered here as a second flavor; it is dropped for now, see docs/memory/cockroach-dropped.md.
 */

import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { type AccountUuid, type WorkspaceUuid } from '@hcengineering/core'
import { PostgresDB } from '../db'
import { type ChannelRecord, type MessageRecord, type OtpRecord, type ReplyRecord } from '../types'

jest.mock('../config', () => ({
  default: {
    AccountsURL: 'http://localhost:4020',
    AccountsUrl: 'http://localhost:4020',
    App: 'Test',
    BotPort: 8443,
    BotToken: 'test-bot-token',
    DbUrl: 'postgresql://localhost/defaultdb',
    Domain: '',
    OtpRetryDelaySec: 60,
    OtpTimeToLiveSec: 300,
    Port: 4020,
    QueueConfig: '{}',
    QueueRegion: 'local',
    Secret: 'test-secret',
    ServiceId: 'telegram-bot-test'
  }
}))

jest.setTimeout(90000)

describe('PostgresDB real database tests', () => {
  // 5433 is the port the test stand publishes postgres on (see tests/docker-compose.yaml).
  const postgresDB: string = process.env.DB_URL ?? 'postgresql://postgres:postgres@localhost:5433/postgres'

  let pgDbUri = postgresDB

  // Administrative client for creating/dropping test databases
  let adminClientPG: postgres.Sql

  let dbUuid: string

  let pgClient: postgres.Sql

  let pgDb: PostgresDB

  const testAccount = randomUUID() as AccountUuid
  const testWorkspace = randomUUID() as WorkspaceUuid

  beforeAll(async () => {
    // Get admin client for database creation/deletion
    adminClientPG = postgres(postgresDB, {
      connection: {
        application_name: 'telegram-bot-test-admin-pg'
      }
    })
  })

  afterAll(async () => {
    await adminClientPG.end({ timeout: 0 })
  })

  beforeEach(async () => {
    // Create a unique database for each test to ensure isolation
    dbUuid = 'telegrambotdb' + Date.now().toString()
    const c = postgresDB.split('/')
    c[c.length - 1] = dbUuid
    pgDbUri = c.join('/')

    try {
      await initPostgreSQL(adminClientPG, dbUuid)
    } catch (err) {
      console.error('Failed to create test database:', err)
      throw err
    }

    pgClient = postgres(pgDbUri, {
      connection: {
        application_name: 'telegram-bot-test-pg'
      },
      fetch_types: true,
      prepare: true
    })

    pgDb = await PostgresDB.create(pgClient)
  })

  afterEach(async () => {
    try {
      await pgDb.close()
      await pgClient.end({ timeout: 0 })

      await adminClientPG`DROP DATABASE IF EXISTS ${adminClientPG(dbUuid)}`
    } catch (err) {
      console.error('Cleanup error:', err)
    }
  })

  describe('Schema initialization', () => {
    it('should create schema successfully on PostgreSQL', async () => {
      // Schema creation is done in beforeEach via PostgresDB.create()
      // Verify tables exist by querying them
      const tables = await pgClient`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'telegram_bot'
        ORDER BY table_name
      `
      const tableNames = tables.map((t: any) => t.table_name).sort((a, b) => a.localeCompare(b))
      expect(tableNames).toEqual(['channels', 'messages', 'otp', 'replies'])
    })

    it('should use correct rowid type for PostgreSQL', async () => {
      const columns = await pgClient`
        SELECT column_name, data_type, is_identity, identity_generation
        FROM information_schema.columns
        WHERE table_schema = 'telegram_bot' 
        AND table_name = 'channels'
        AND column_name = 'rowid'
      `
      expect(columns.length).toBe(1)
      const rowid = columns[0] as any
      expect(rowid.data_type).toBe('bigint')
      // PostgreSQL uses GENERATED ALWAYS AS IDENTITY (SQL standard)
      expect(rowid.is_identity).toBe('YES')
      expect(rowid.identity_generation).toBe('ALWAYS')
    })
  })

  describe('OTP operations', () => {
    it('should insert and retrieve OTP on PostgreSQL', async () => {
      const otp: OtpRecord = {
        telegramId: 12345,
        telegramUsername: 'testuser',
        code: 'TEST123',
        expires: new Date(Date.now() + 3600000),
        createdAt: new Date()
      }

      await pgDb.insertOtp(otp)
      const retrieved = await pgDb.getOtpByCode('TEST123')

      expect(retrieved).toBeDefined()
      expect(retrieved?.telegramId).toBe(12345)
      expect(retrieved?.telegramUsername).toBe('testuser')
      expect(retrieved?.code).toBe('TEST123')
    })

    it('should get OTP by telegram ID on PostgreSQL', async () => {
      const otp: OtpRecord = {
        telegramId: 67890,
        telegramUsername: 'anotheruser',
        code: 'CODE456',
        expires: new Date(Date.now() + 3600000),
        createdAt: new Date()
      }

      await pgDb.insertOtp(otp)

      const pgRetrieved = await pgDb.getOtpByTelegramId(67890)

      expect(pgRetrieved?.code).toBe('CODE456')
    })

    it('should remove expired OTP on PostgreSQL', async () => {
      const expiredOtp: OtpRecord = {
        telegramId: 11111,
        telegramUsername: 'expired',
        code: 'EXPIRED',
        expires: new Date(Date.now() - 1000), // Expired
        createdAt: new Date()
      }

      await pgDb.insertOtp(expiredOtp)

      await pgDb.removeExpiredOtp()

      const pgRetrieved = await pgDb.getOtpByCode('EXPIRED')

      expect(pgRetrieved).toBeUndefined()
    })
  })

  describe('Channel operations', () => {
    it('should insert and retrieve channels on PostgreSQL', async () => {
      const channel: Omit<ChannelRecord, 'rowId'> = {
        workspace: testWorkspace,
        account: testAccount,
        _id: 'channel1' as any,
        _class: 'class:chunter:Space' as any,
        name: 'Test Channel'
      }

      await pgDb.insertChannel(channel)
      const channels = await pgDb.getChannels(testAccount, testWorkspace)

      expect(channels.length).toBe(1)
      expect(channels[0].name).toBe('Test Channel')
      expect(channels[0]._id).toBe('channel1')
      expect(channels[0].rowId).toBeDefined()
    })

    it('should update channel name on PostgreSQL', async () => {
      const channelId = 'channel2'
      const channel: Omit<ChannelRecord, 'rowId'> = {
        workspace: testWorkspace,
        account: testAccount,
        _id: channelId as any,
        _class: 'class:chunter:Space' as any,
        name: 'Original Name'
      }

      await pgDb.insertChannel(channel)

      const pgChannels = await pgDb.getChannels(testAccount, testWorkspace)
      const pgRowId = pgChannels.find((c) => c._id === channelId)?.rowId

      expect(pgRowId).toBeDefined()

      if (pgRowId != null) {
        await pgDb.updateChannelName(pgRowId, 'Updated Name')
        const updated = await pgDb.getChannel(testAccount, channelId as any)
        expect(updated?.name).toBe('Updated Name')
      }
    })
  })

  describe('Message operations', () => {
    it('should insert and retrieve messages on PostgreSQL', async () => {
      const message: MessageRecord = {
        messageId: 'msg1' as any,
        workspace: testWorkspace,
        account: testAccount,
        telegramMessageId: 1001
      }

      await pgDb.insertMessage(message)
      const retrieved = await pgDb.getMessageByRef(testAccount, 'msg1' as any)

      expect(retrieved).toBeDefined()
      expect(retrieved?.telegramMessageId).toBe(1001)
      expect(retrieved?.messageId).toBe('msg1')
    })

    it('should get message by telegram ID on PostgreSQL', async () => {
      const message: MessageRecord = {
        messageId: 'msg2' as any,
        workspace: testWorkspace,
        account: testAccount,
        telegramMessageId: 2002
      }

      await pgDb.insertMessage(message)

      const pgRetrieved = await pgDb.getMessageByTgId(testAccount, 2002)

      expect(pgRetrieved?.messageId).toBe('msg2')
    })
  })

  describe('Reply operations', () => {
    it('should insert and retrieve replies on PostgreSQL', async () => {
      const reply: ReplyRecord = {
        messageId: 'msg3' as any,
        telegramUserId: 3003,
        replyId: 4004
      }

      await pgDb.insertReply(reply)
      const retrieved = await pgDb.getReply(3003, 4004)

      expect(retrieved).toBeDefined()
      expect(retrieved?.messageId).toBe('msg3')
      expect(retrieved?.telegramUserId).toBe(3003)
      expect(retrieved?.replyId).toBe(4004)
    })
  })
})

async function initPostgreSQL (adminClient: postgres.Sql, dbUuid: string): Promise<void> {
  // Clean up any leftover test databases with prefix 'telegrambotdb' for Postgres
  const existingPgs = await adminClient`
    SELECT datname FROM pg_database WHERE datname LIKE 'telegrambotdb%'
  `
  for (const row of existingPgs) {
    try {
      await adminClient`DROP DATABASE IF EXISTS ${adminClient(row.datname)}`
    } catch (err: any) {
      // Ignore, PostgreSQL says database is being used by other users
    }
  }
  await adminClient`CREATE DATABASE ${adminClient(dbUuid)}`
}
