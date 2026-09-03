//
// Copyright © 2024 Hardcore Engineering Inc.
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
import { type Sql, type TransactionSql } from 'postgres'
import {
  type Data,
  type Version,
  type Person,
  type WorkspaceMemberInfo,
  type AccountRole,
  type WorkspaceUuid,
  type AccountUuid,
  type PersonUuid,
  type PersonId,
  type SocialIdType
} from '@hcengineering/core'

import { getMigrations } from './migrations'
import type {
  DbCollection,
  Query,
  Operations,
  Workspace,
  WorkspaceOperation,
  AccountDB,
  Account,
  OTP,
  WorkspaceInvite,
  AccountEvent,
  SocialId,
  WorkspaceData,
  WorkspaceStatus,
  WorkspaceStatusData,
  WorkspaceInfoWithStatus,
  Sort,
  Mailbox,
  MailboxSecret,
  Integration,
  IntegrationSecret,
  AccountAggregatedInfo,
  AccountsFilter,
  AccountsSortKey,
  AdminAction,
  AdminActionsQuery,
  AdminActionsResult,
  UserProfile,
  Subscription,
  PaymentIntent,
  PaymentOperation,
  PaymentOperationStats,
  PaymentOperationFilter,
  PaymentMonthlyStats,
  WorkspacePurchase,
  WorkspacePurchaseStatus,
  DBFlavor,
  WorkspacePermission,
  AccountWorkspaceBadgeStatus,
  ShortLink,
  WorkspacesPagedQuery,
  WorkspacesPagedResult,
  WorkspacesSummary,
  RegistrationStats,
  WorkspaceActivityPoint,
  WorkspaceMemberDetails,
  AccountActivityStats
} from '../../types'

function toSnakeCase (str: string): string {
  // Preserve leading underscore
  const hasLeadingUnderscore = str.startsWith('_')
  const baseStr = hasLeadingUnderscore ? str.slice(1) : str
  const converted = baseStr.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
  return hasLeadingUnderscore ? '_' + converted : converted
}

function toCamelCase (str: string): string {
  // Preserve leading underscore
  const hasLeadingUnderscore = str.startsWith('_')
  const baseStr = hasLeadingUnderscore ? str.slice(1) : str
  const converted = baseStr.replace(/_([a-z])/g, (match, letter) => letter.toUpperCase())
  return hasLeadingUnderscore ? '_' + converted : converted
}

function convertKeysToCamelCase (obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map((v) => convertKeysToCamelCase(v))
  } else if (obj !== null && typeof obj === 'object') {
    const camelObj: any = {}
    for (const key of Object.keys(obj)) {
      camelObj[toCamelCase(key)] = convertKeysToCamelCase(obj[key])
    }
    return camelObj
  }
  return obj
}

function convertKeysToSnakeCase (obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map((v) => convertKeysToSnakeCase(v))
  } else if (obj !== null && typeof obj === 'object') {
    const snakeObj: any = {}
    for (const key of Object.keys(obj)) {
      snakeObj[toSnakeCase(key)] = convertKeysToSnakeCase(obj[key])
    }
    return snakeObj
  }
  return obj
}

function formatVar (idx: number, type?: string): string {
  return type != null ? `$${idx}::${type}` : `$${idx}`
}

function convertTimestamp (ts: string): number | null {
  const val = Number.parseInt(ts)

  return Number.isNaN(val) ? null : val
}

export interface PostgresDbCollectionOptions<T extends Record<string, any>, K extends keyof T | undefined = undefined> {
  idKey?: K
  ns?: string
  fieldTypes?: Record<string, string>
  timestampFields?: Array<keyof T>
  withRetryClient?: <R>(callback: (client: Sql) => Promise<R>) => Promise<R>
}

export class PostgresDbCollection<T extends Record<string, any>, K extends keyof T | undefined = undefined>
implements DbCollection<T> {
  constructor (
    readonly name: string,
    readonly client: Sql,
    readonly options: PostgresDbCollectionOptions<T, K> = {},
    readonly filterFields: string[] = []
  ) {}

  get ns (): string {
    return this.options.ns ?? ''
  }

  get idKey (): K | undefined {
    return this.options.idKey
  }

  get fieldTypes (): Record<string, string> {
    return this.options.fieldTypes ?? {}
  }

  get timestampFields (): Array<keyof T> {
    return this.options.timestampFields ?? []
  }

  getTableName (): string {
    if (this.ns === '') {
      return this.name
    }

    return `${this.ns}.${this.name}`
  }

  protected buildSelectClause (): string {
    return `SELECT * FROM ${this.getTableName()}`
  }

  protected buildWhereClause (query: Query<T>, lastRefIdx: number = 0): [string, any[]] {
    const filteredQuery = Object.entries(query).reduce<Query<T>>((acc, [key, value]) => {
      if (value !== undefined) {
        acc[key as keyof Query<T>] = value
      }
      return acc
    }, {})

    if (Object.keys(filteredQuery).length === 0) {
      return ['', []]
    }

    const whereChunks: string[] = []
    const values: any[] = []
    let currIdx: number = lastRefIdx

    for (const key of Object.keys(filteredQuery)) {
      const qKey = filteredQuery[key]
      if (qKey === undefined) continue

      const operator = qKey != null && typeof qKey === 'object' ? Object.keys(qKey)[0] : ''
      const castType = this.fieldTypes[key]
      const snakeKey = toSnakeCase(key)
      switch (operator) {
        case '$in': {
          const inVals = Object.values(qKey as object)[0]
          if (inVals.length === 0) {
            whereChunks.push('FALSE')
            break
          }
          const inVars: string[] = []
          for (const val of inVals) {
            currIdx++
            inVars.push(formatVar(currIdx, castType))
            values.push(val)
          }
          whereChunks.push(`"${snakeKey}" IN (${inVars.join(', ')})`)
          break
        }
        case '$lt': {
          currIdx++
          whereChunks.push(`"${snakeKey}" < ${formatVar(currIdx, castType)}`)
          values.push(Object.values(qKey as object)[0])
          break
        }
        case '$lte': {
          currIdx++
          whereChunks.push(`"${snakeKey}" <= ${formatVar(currIdx, castType)}`)
          values.push(Object.values(qKey as object)[0])
          break
        }
        case '$gt': {
          currIdx++
          whereChunks.push(`"${snakeKey}" > ${formatVar(currIdx, castType)}`)
          values.push(Object.values(qKey as object)[0])
          break
        }
        case '$gte': {
          currIdx++
          whereChunks.push(`"${snakeKey}" >= ${formatVar(currIdx, castType)}`)
          values.push(Object.values(qKey as object)[0])
          break
        }
        case '$ne': {
          const val = Object.values(qKey as object)[0]
          if (val === null) {
            whereChunks.push(`"${snakeKey}" IS NOT NULL`)
          } else {
            currIdx++
            whereChunks.push(`"${snakeKey}" != ${formatVar(currIdx, castType)}`)
            values.push(val)
          }
          break
        }
        default: {
          if (qKey !== null) {
            currIdx++
            whereChunks.push(`"${snakeKey}" = ${formatVar(currIdx, castType)}`)
            values.push(qKey)
          } else {
            whereChunks.push(`"${snakeKey}" IS NULL`)
          }
        }
      }
    }

    return [`WHERE ${whereChunks.join(' AND ')}`, values]
  }

  protected buildSortClause (sort: Sort<T>): string {
    const sortChunks: string[] = []

    for (const key of Object.keys(sort)) {
      const snakeKey = toSnakeCase(key)
      sortChunks.push(`"${snakeKey}" ${sort[key] === 'ascending' ? 'ASC' : 'DESC'}`)
    }

    return `ORDER BY ${sortChunks.join(', ')}`
  }

  // Public so raw unsafe() queries can reuse the same timestamp/field mapping the collection does.
  convertToObj (row: unknown): T {
    const res = convertKeysToCamelCase(row)
    for (const field of this.timestampFields) {
      res[field] = convertTimestamp(res[field])
    }
    if (this.filterFields.length > 0) {
      for (const key of Object.keys(res)) {
        if (this.filterFields.includes(key.toLowerCase())) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete res[key]
        }
      }
    }

    return res as T
  }

  async unsafe (sql: string, values: any[], client?: Sql): Promise<any[]> {
    if (client !== undefined) {
      return await client.unsafe(sql, values)
    } else if (this.options.withRetryClient !== undefined) {
      return await this.options.withRetryClient((_client) => _client.unsafe(sql, values))
    } else {
      return await this.client.unsafe(sql, values)
    }
  }

  async exists (query: Query<T>, client?: Sql): Promise<boolean> {
    const [whereClause, whereValues] = this.buildWhereClause(query)
    const sql = `SELECT EXISTS (SELECT 1 FROM ${this.getTableName()} ${whereClause})`

    const result = await this.unsafe(sql, whereValues, client)

    return result[0]?.exists === true
  }

  async find (query: Query<T>, sort?: Sort<T>, limit?: number, client?: Sql): Promise<T[]> {
    const sqlChunks: string[] = [this.buildSelectClause()]
    const [whereClause, whereValues] = this.buildWhereClause(query)

    if (whereClause !== '') {
      sqlChunks.push(whereClause)
    }

    if (sort !== undefined) {
      sqlChunks.push(this.buildSortClause(sort))
    }

    if (limit !== undefined) {
      sqlChunks.push(`LIMIT ${limit}`)
    }

    const finalSql: string = sqlChunks.join(' ')
    const result = await this.unsafe(finalSql, whereValues, client)

    return result.map((row) => this.convertToObj(row))
  }

  async findOne (query: Query<T>, client?: Sql): Promise<T | null> {
    return (await this.find(query, undefined, 1, client))[0] ?? null
  }

  async insertOne (data: Partial<T>, client?: Sql): Promise<K extends keyof T ? T[K] : undefined> {
    const snakeData = convertKeysToSnakeCase(data)
    const keys: string[] = Object.keys(snakeData)
    const values = Object.values(snakeData) as any

    const sql = `INSERT INTO ${this.getTableName()} (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map((_, idx) => `$${idx + 1}`).join(', ')}) RETURNING *`

    const res: any | undefined = await this.unsafe(sql, values, client)
    const idKey = this.idKey

    if (idKey === undefined) {
      return undefined as any
    }

    return res[0][idKey]
  }

  async insertMany (data: Array<Partial<T>>, client?: Sql): Promise<K extends keyof T ? Array<T[K]> : undefined> {
    const snakeData = convertKeysToSnakeCase(data)
    const columns = new Set<string>()
    for (const record of snakeData) {
      Object.keys(record).forEach((k) => columns.add(k))
    }
    const columnsList = Array.from(columns).sort()

    const values: any[] = []
    for (const record of snakeData) {
      const recordValues = columnsList.map((col) => record[col] ?? null)
      values.push(...recordValues)
    }

    const placeholders = snakeData
      .map((_: any, i: number) => `(${columnsList.map((_, j) => `$${i * columnsList.length + j + 1}`).join(', ')})`)
      .join(', ')

    const sql = `
      INSERT INTO ${this.getTableName()}
      (${columnsList.map((k) => `"${k}"`).join(', ')})
      VALUES ${placeholders}
      RETURNING *
    `

    const res: any = await this.unsafe(sql, values, client)
    const idKey = this.idKey

    if (idKey === undefined) {
      return undefined as any
    }

    return res.map((r: any) => r[idKey])
  }

  protected buildUpdateClause (ops: Operations<T>, lastRefIdx: number = 0): [string, any[]] {
    const updateChunks: string[] = []
    const values: any[] = []
    let currIdx: number = lastRefIdx

    for (const key of Object.keys(ops)) {
      switch (key) {
        case '$inc': {
          const inc = ops.$inc as Partial<T>

          for (const incKey of Object.keys(inc)) {
            const snakeKey = toSnakeCase(incKey)
            currIdx++
            updateChunks.push(`"${snakeKey}" = "${snakeKey}" + $${currIdx}`)
            values.push(inc[incKey])
          }
          break
        }
        default: {
          const snakeKey = toSnakeCase(key)
          const castType = this.fieldTypes[key]
          currIdx++
          updateChunks.push(`"${snakeKey}" = ${formatVar(currIdx, castType)}`)
          values.push(convertKeysToSnakeCase(ops[key]))
        }
      }
    }

    return [`SET ${updateChunks.join(', ')}`, values]
  }

  async update (query: Query<T>, ops: Operations<T>, client?: Sql): Promise<void> {
    const sqlChunks: string[] = [`UPDATE ${this.getTableName()}`]
    const [updateClause, updateValues] = this.buildUpdateClause(ops)
    const [whereClause, whereValues] = this.buildWhereClause(query, updateValues.length)

    sqlChunks.push(updateClause)
    if (whereClause !== '') {
      sqlChunks.push(whereClause)
    }

    const finalSql = sqlChunks.join(' ')
    await this.unsafe(finalSql, [...updateValues, ...whereValues], client)
  }

  async deleteMany (query: Query<T>, client?: Sql): Promise<void> {
    const sqlChunks: string[] = [`DELETE FROM ${this.getTableName()}`]
    const [whereClause, whereValues] = this.buildWhereClause(query)

    if (whereClause !== '') {
      sqlChunks.push(whereClause)
    }

    const finalSql = sqlChunks.join(' ')
    await this.unsafe(finalSql, whereValues, client)
  }
}

export class AccountPostgresDbCollection
  extends PostgresDbCollection<Account, 'uuid'>
  implements DbCollection<Account> {
  private readonly passwordKeys = ['hash', 'salt']

  constructor (
    client: Sql,
    ns?: string,
    withRetryClient?: PostgresDbCollectionOptions<Account, 'uuid'>['withRetryClient']
  ) {
    super('account', client, { idKey: 'uuid', ns, withRetryClient })
  }

  getPasswordsTableName (): string {
    const ownName = 'account_passwords'
    if (this.ns === '') {
      return ownName
    }

    return `${this.ns}.${ownName}`
  }

  protected buildSelectClause (): string {
    return `SELECT * FROM (
      SELECT
        a.uuid,
        a.timezone,
        a.locale,
        a.automatic,
        a.max_workspaces,
        a.failed_login_attempts,
        p.hash,
        p.salt
      FROM ${this.getTableName()} as a
        LEFT JOIN ${this.getPasswordsTableName()} as p ON p.account_uuid = a.uuid
    )`
  }

  async find (query: Query<Account>, sort?: Sort<Account>, limit?: number, client?: Sql): Promise<Account[]> {
    if (Object.keys(query).some((k) => this.passwordKeys.includes(k))) {
      throw new Error('Passwords are not allowed in find query conditions')
    }

    const result = await super.find(query, sort, limit, client)

    for (const r of result) {
      if (r.hash != null) {
        r.hash = Buffer.from(Object.values(r.hash))
      }
      if (r.salt != null) {
        r.salt = Buffer.from(Object.values(r.salt))
      }
    }

    return result
  }

  async insertOne (data: Partial<Account>, client?: Sql): Promise<Account['uuid']> {
    if (Object.keys(data).some((k) => this.passwordKeys.includes(k))) {
      throw new Error('Passwords are not allowed in insert query')
    }

    return await super.insertOne(data, client)
  }

  async update (query: Query<Account>, ops: Operations<Account>, client?: Sql): Promise<void> {
    if (Object.keys({ ...ops, ...query }).some((k) => this.passwordKeys.includes(k))) {
      throw new Error('Passwords are not allowed in update query')
    }

    await super.update(query, ops, client)
  }

  async deleteMany (query: Query<Account>, client?: Sql): Promise<void> {
    if (Object.keys(query).some((k) => this.passwordKeys.includes(k))) {
      throw new Error('Passwords are not allowed in delete query')
    }

    const [whereClause, whereValues] = this.buildWhereClause(query)

    // Delete passwords first
    const passwordsSql = `
      DELETE FROM ${this.getPasswordsTableName()}
      WHERE account_uuid IN (
        SELECT uuid FROM ${this.getTableName()} ${whereClause}
      )`
    await this.unsafe(passwordsSql, whereValues, client)

    await super.deleteMany(query, client)
  }
}

export class PostgresAccountDB implements AccountDB {
  private readonly retryOptions = {
    maxAttempts: 5,
    initialDelayMs: 100,
    maxDelayMs: 2000
  }

  readonly wsMembersName = 'workspace_members'
  readonly pendingWorkspaceLockName = '_pending_workspace_lock'

  person: PostgresDbCollection<Person, 'uuid'>
  account: AccountPostgresDbCollection
  socialId: PostgresDbCollection<SocialId, '_id'>
  workspace: PostgresDbCollection<Workspace, 'uuid'>
  workspaceStatus: PostgresDbCollection<WorkspaceStatus>
  accountEvent: PostgresDbCollection<AccountEvent>
  otp: PostgresDbCollection<OTP>
  invite: PostgresDbCollection<WorkspaceInvite, 'id'>
  shortLink: PostgresDbCollection<ShortLink, 'id'>
  mailbox: PostgresDbCollection<Mailbox, 'mailbox'>
  mailboxSecret: PostgresDbCollection<MailboxSecret>
  integration: PostgresDbCollection<Integration>
  integrationSecret: PostgresDbCollection<IntegrationSecret>
  userProfile: PostgresDbCollection<UserProfile, 'personUuid'>
  subscription: PostgresDbCollection<Subscription, 'id'>
  paymentIntent: PostgresDbCollection<PaymentIntent, 'id'>
  paymentOperation: PostgresDbCollection<PaymentOperation, 'id'>
  workspacePurchase: PostgresDbCollection<WorkspacePurchase, 'id'>
  workspacePermission: PostgresDbCollection<WorkspacePermission>
  accountWorkspaceBadgeStatus: PostgresDbCollection<AccountWorkspaceBadgeStatus>
  adminAction: PostgresDbCollection<AdminAction, 'id'>

  constructor (
    readonly client: Sql,
    readonly ns: string = 'global_account',
    readonly dbFlavor: DBFlavor = 'cockroach'
  ) {
    const withRetryClient = this.withRetry
    this.person = new PostgresDbCollection<Person, 'uuid'>('person', client, { ns, idKey: 'uuid', withRetryClient })
    this.account = new AccountPostgresDbCollection(client, ns, withRetryClient)
    this.socialId = new PostgresDbCollection<SocialId, '_id'>('social_id', client, {
      ns,
      idKey: '_id',
      timestampFields: ['createdOn', 'verifiedOn'],
      withRetryClient
    })
    this.workspaceStatus = new PostgresDbCollection<WorkspaceStatus>('workspace_status', client, {
      ns,
      timestampFields: ['lastProcessingTime', 'lastVisit'],
      withRetryClient
    })
    this.workspace = new PostgresDbCollection<Workspace, 'uuid'>('workspace', client, {
      ns,
      idKey: 'uuid',
      timestampFields: ['createdOn'],
      withRetryClient
    })
    this.accountEvent = new PostgresDbCollection<AccountEvent>('account_events', client, {
      ns,
      timestampFields: ['time'],
      withRetryClient
    })
    this.otp = new PostgresDbCollection<OTP>('otp', client, { ns, timestampFields: ['expiresOn', 'createdOn'] })
    this.invite = new PostgresDbCollection<WorkspaceInvite, 'id'>('invite', client, {
      ns,
      idKey: 'id',
      timestampFields: ['expiresOn'],
      withRetryClient
    })
    this.shortLink = new PostgresDbCollection<ShortLink, 'id'>('short_links', client, {
      ns,
      idKey: 'id',
      timestampFields: ['createdAt'],
      withRetryClient
    })
    this.mailbox = new PostgresDbCollection<Mailbox, 'mailbox'>('mailbox', client, { ns, withRetryClient })
    this.mailboxSecret = new PostgresDbCollection<MailboxSecret>('mailbox_secrets', client, { ns, withRetryClient })
    this.integration = new PostgresDbCollection<Integration>('integrations', client, { ns, withRetryClient }, [
      '_def_ws_uuid',
      '_defwsuuid'
    ])
    this.integrationSecret = new PostgresDbCollection<IntegrationSecret>(
      'integration_secrets',
      client,
      {
        ns,
        withRetryClient
      },
      ['_def_ws_uuid', '_defwsuuid']
    )
    this.userProfile = new PostgresDbCollection<UserProfile, 'personUuid'>('user_profile', client, {
      ns,
      idKey: 'personUuid',
      withRetryClient
    })
    this.subscription = new PostgresDbCollection<Subscription, 'id'>('subscription', client, {
      ns,
      idKey: 'id',
      timestampFields: ['periodStart', 'periodEnd', 'trialEnd', 'canceledAt', 'willCancelAt', 'createdOn', 'updatedOn'],
      withRetryClient
    })
    this.paymentIntent = new PostgresDbCollection<PaymentIntent, 'id'>('payment_intent', client, {
      ns,
      idKey: 'id',
      timestampFields: ['heartbeatAt', 'createdOn', 'updatedOn'],
      withRetryClient
    })
    this.paymentOperation = new PostgresDbCollection<PaymentOperation, 'id'>('payment_operation', client, {
      ns,
      idKey: 'id',
      timestampFields: ['createdOn'],
      withRetryClient
    })
    this.workspacePurchase = new PostgresDbCollection<WorkspacePurchase, 'id'>('workspace_purchase', client, {
      ns,
      idKey: 'id',
      timestampFields: ['createdOn'],
      withRetryClient
    })
    this.workspacePermission = new PostgresDbCollection<WorkspacePermission>('workspace_permissions', client, {
      ns,
      timestampFields: ['createdOn'],
      withRetryClient
    })
    this.accountWorkspaceBadgeStatus = new PostgresDbCollection<AccountWorkspaceBadgeStatus>(
      'account_workspace_badge_status',
      client,
      {
        ns,
        timestampFields: ['updatedOn'],
        withRetryClient
      }
    )
    this.adminAction = new PostgresDbCollection<AdminAction, 'id'>('admin_action', client, {
      ns,
      idKey: 'id',
      timestampFields: ['createdOn'],
      withRetryClient
    })
  }

  getWsMembersTableName (): string {
    return `${this.ns}.${this.wsMembersName}`
  }

  getPendingWorkspaceLockTableName (): string {
    return `${this.ns}.${this.pendingWorkspaceLockName}`
  }

  async init (): Promise<void> {
    await this._init()

    // Apply all the migrations
    for (const migration of this.getMigrations()) {
      await this.migrate(migration[0], migration[1])
    }
  }

  async migrate (name: string, ddl: string): Promise<void> {
    const staleTimeoutMs = 30000
    const retryIntervalMs = 5000
    let migrationComplete = false
    let updateInterval: NodeJS.Timeout | null = null
    let executed = false

    // Every process reopening the account DB replays this list. Reading an applied migration without
    // FOR UPDATE keeps concurrent openers off each other's lock and its retryIntervalMs sleep.
    const applied = await this.client`
      SELECT applied_at, ddl
      FROM ${this.client(this.ns)}._account_applied_migrations
      WHERE identifier = ${name} AND applied_at IS NOT NULL
    `
    if (applied.length > 0) {
      if (applied[0].ddl !== ddl) {
        console.error(
          `Migration ${name} was applied with different DDL than the current build defines. ` +
            'Existing migrations must never be modified — add a new one instead.'
        )
      }
      return
    }

    const executeMigration = async (client: Sql): Promise<void> => {
      updateInterval = setInterval(() => {
        this.client`
          UPDATE ${this.client(this.ns)}._account_applied_migrations
          SET last_processed_at = NOW()
          WHERE identifier = ${name} AND applied_at IS NULL
        `.catch((err) => {
            console.error(`Failed to update last_processed_at for migration ${name}:`, err)
          })
      }, 5000)

      await client.unsafe(ddl)
      executed = true
    }

    try {
      while (!migrationComplete) {
        try {
          executed = false
          await this.client.begin(async (client) => {
            // Only locks if row exists and is not already locked
            const existing = await client`
              SELECT identifier, applied_at, last_processed_at, ddl
              FROM ${this.client(this.ns)}._account_applied_migrations
              WHERE identifier = ${name}
              FOR UPDATE NOWAIT
            `

            if (existing.length > 0) {
              if (existing[0].applied_at !== null) {
                // Already completed. A changed DDL under an applied identifier never re-runs, so the
                // schema silently diverges — warn instead of leaving it to fail at query time.
                if (existing[0].ddl !== ddl) {
                  console.error(
                    `Migration ${name} was applied with different DDL than the current build defines. ` +
                      'Existing migrations must never be modified — add a new one instead.'
                  )
                }
                migrationComplete = true
              } else if (
                existing[0].last_processed_at === null ||
                Date.now() - new Date(existing[0].last_processed_at).getTime() > staleTimeoutMs
              ) {
                // Take over the stale migration
                await client`
                  UPDATE ${this.client(this.ns)}._account_applied_migrations
                  SET last_processed_at = NOW()
                  WHERE identifier = ${name}
                `

                await executeMigration(client)
              }
            } else {
              const res = await client`
                INSERT INTO ${this.client(this.ns)}._account_applied_migrations
                (identifier, ddl, last_processed_at)
                VALUES (${name}, ${ddl}, NOW())
                ON CONFLICT (identifier) DO NOTHING
              `

              if (res.count === 1) {
                // Successfully inserted
                await executeMigration(client)
              }
              // If insert failed (count === 0), another worker got it first, we'll retry the loop
            }
          })

          if (executed) {
            await this.client`
              UPDATE ${this.client(this.ns)}._account_applied_migrations
              SET applied_at = NOW()
              WHERE identifier = ${name}
            `
            console.log(`Applied migration ${name}`)
            migrationComplete = true
          }
        } catch (err: any) {
          if (['55P03', '40001'].includes(err.code)) {
            // newLockNotAvailableError, WriteTooOldError
          } else {
            console.error(`Error in migration ${name}: ${err.code} - ${err.message}`)
          }

          if (updateInterval !== null) {
            clearInterval(updateInterval)
          }
        }

        if (!migrationComplete) {
          await new Promise((resolve) => setTimeout(resolve, retryIntervalMs))
        }
      }
    } finally {
      if (updateInterval !== null) {
        clearInterval(updateInterval)
      }
    }
  }

  async _init (): Promise<void> {
    await this.client.unsafe(
      `
        CREATE SCHEMA IF NOT EXISTS ${this.ns};

        CREATE TABLE IF NOT EXISTS ${this.ns}._account_applied_migrations (
            identifier VARCHAR(255) NOT NULL PRIMARY KEY
          , ddl TEXT NOT NULL
          , applied_at TIMESTAMP WITH TIME ZONE
          , last_processed_at TIMESTAMP WITH TIME ZONE
        );

        ALTER TABLE ${this.ns}._account_applied_migrations
        ADD COLUMN IF NOT EXISTS last_processed_at TIMESTAMP WITH TIME ZONE;
      `
    )

    const constraintsExist = await this.client`
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = ${this.ns}
      AND table_name = '_account_applied_migrations'
      AND column_name = 'applied_at'
      AND (column_default IS NOT NULL OR is_nullable = 'NO')
    `

    if (constraintsExist.length > 0) {
      try {
        await this.client.unsafe(
          `
            ALTER TABLE ${this.ns}._account_applied_migrations
            ALTER COLUMN applied_at DROP DEFAULT;

            ALTER TABLE ${this.ns}._account_applied_migrations
            ALTER COLUMN applied_at DROP NOT NULL;
          `
        )
      } catch (err) {
        // Ignore errors since they likely mean constraints were already removed by another concurrent migration
      }
    }
  }

  withRetry = async <T>(callback: (client: TransactionSql) => Promise<T>): Promise<T> => {
    let attempt = 0
    let delay = this.retryOptions.initialDelayMs

    while (true) {
      try {
        return (await this.client.begin(callback)) as T
      } catch (err: any) {
        attempt++

        if (!this.isRetryableError(err) || attempt >= this.retryOptions.maxAttempts) {
          throw err
        }

        await new Promise((resolve) => setTimeout(resolve, delay))

        delay = Math.min(delay * 2, this.retryOptions.maxDelayMs)
      }
    }
  }

  private isRetryableError (err: any): boolean {
    const msg: string = err?.message ?? ''

    return (
      err.code === '40001' || // Retry transaction
      err.code === '55P03' || // Lock not available
      err.code === 'CONNECTION_CLOSED' || // This error is thrown if the connection was closed without an error.
      err.code === 'CONNECTION_DESTROYED' || // This error is thrown for any queries that were pending when the timeout to sql.end({ timeout: X }) was reached. If the DB client is being closed completely retry will result in CONNECTION_ENDED which is not retried so should be fine.
      msg.includes('RETRY_SERIALIZABLE')
    )
  }

  async createWorkspace (data: WorkspaceData, status: WorkspaceStatusData): Promise<WorkspaceUuid> {
    return await this.withRetry(async (rTx) => {
      const workspaceUuid = await this.workspace.insertOne(data, rTx)
      await this.workspaceStatus.insertOne({ ...status, workspaceUuid }, rTx)

      return workspaceUuid
    })
  }

  async updateAllowReadOnlyGuests (workspaceId: WorkspaceUuid, readOnlyGuestsAllowed: boolean): Promise<void> {
    await this
      .client`UPDATE ${this.client(this.workspace.getTableName())} SET allow_read_only_guest = ${readOnlyGuestsAllowed} WHERE uuid = ${workspaceId}`
  }

  async updateAllowGuestSignUp (workspaceId: WorkspaceUuid, guestSignUpAllowed: boolean): Promise<void> {
    await this
      .client`UPDATE ${this.client(this.workspace.getTableName())} SET allow_guest_sign_up = ${guestSignUpAllowed} WHERE uuid = ${workspaceId}`
  }

  async updatePasswordAgingRule (workspaceId: WorkspaceUuid, days: number | null): Promise<void> {
    await this
      .client`UPDATE ${this.client(this.workspace.getTableName())} SET password_aging_rule = ${days} WHERE uuid = ${workspaceId}`
  }

  async assignWorkspace (accountUuid: AccountUuid, workspaceUuid: WorkspaceUuid, role: AccountRole): Promise<void> {
    await this.withRetry(
      async (rTx) =>
        await rTx`INSERT INTO ${this.client(this.getWsMembersTableName())} (workspace_uuid, account_uuid, role) VALUES (${workspaceUuid}, ${accountUuid}, ${role})`
    )
  }

  async batchAssignWorkspace (data: [AccountUuid, WorkspaceUuid, AccountRole][]): Promise<void> {
    const placeholders = data.map((_: any, i: number) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(', ')
    const values = data.flat()

    const sql = `
      INSERT INTO ${this.getWsMembersTableName()}
      (account_uuid, workspace_uuid, role)
      VALUES ${placeholders}
    `

    await this.withRetry(async (rTx) => await rTx.unsafe(sql, values))
  }

  async unassignWorkspace (accountUuid: AccountUuid, workspaceUuid: WorkspaceUuid): Promise<void> {
    await this.withRetry(
      async (rTx) =>
        await rTx`DELETE FROM ${this.client(this.getWsMembersTableName())} WHERE workspace_uuid = ${workspaceUuid} AND account_uuid = ${accountUuid}`
    )
  }

  async updateWorkspaceRole (accountUuid: AccountUuid, workspaceUuid: WorkspaceUuid, role: AccountRole): Promise<void> {
    await this.withRetry(
      async (rTx) =>
        await rTx`UPDATE ${this.client(this.getWsMembersTableName())} SET role = ${role} WHERE workspace_uuid = ${workspaceUuid} AND account_uuid = ${accountUuid}`
    )
  }

  async getWorkspaceRole (accountUuid: AccountUuid, workspaceUuid: WorkspaceUuid): Promise<AccountRole | null> {
    return await this.withRetry(async (rTx) => {
      const res =
        await rTx`SELECT role FROM ${this.client(this.getWsMembersTableName())} WHERE workspace_uuid = ${workspaceUuid} AND account_uuid = ${accountUuid}`

      return res[0]?.role ?? null
    })
  }

  async getWorkspaceRoles (accountUuid: AccountUuid): Promise<Map<WorkspaceUuid, AccountRole>> {
    return await this.withRetry(async (rTx) => {
      const res =
        await rTx`SELECT workspace_uuid, role FROM ${this.client(this.getWsMembersTableName())} WHERE account_uuid = ${accountUuid}`

      return new Map(res.map((it) => [it.workspace_uuid as WorkspaceUuid, it.role]))
    })
  }

  async getWorkspaceMembers (workspaceUuid: WorkspaceUuid): Promise<WorkspaceMemberInfo[]> {
    return await this.withRetry(async (rTx) => {
      const res: any =
        await rTx`SELECT account_uuid, role FROM ${this.client(this.getWsMembersTableName())} WHERE workspace_uuid = ${workspaceUuid}`

      return res.map((p: any) => ({
        person: p.account_uuid,
        role: p.role
      }))
    })
  }

  async getAccountWorkspaces (accountUuid: AccountUuid): Promise<WorkspaceInfoWithStatus[]> {
    const sql = `SELECT
          w.uuid,
          w.name,
          w.url,
          w.branding,
          w.location,
          w.region,
          w.created_by,
          w.created_on,
          w.billing_account,
          w.password_aging_rule,
          json_build_object(
            'mode', s.mode,
            'processing_progress', s.processing_progress,
            'version_major', s.version_major,
            'version_minor', s.version_minor,
            'version_patch', s.version_patch,
            'last_processing_time', s.last_processing_time,
            'last_visit', s.last_visit,
            'is_disabled', s.is_disabled,
            'processing_attempts', s.processing_attempts,
            'processing_message', s.processing_message,
            'backup_info', s.backup_info,
            'usage_info', s.usage_info
          ) status
           FROM ${this.getWsMembersTableName()} as m
           INNER JOIN ${this.workspace.getTableName()} as w ON m.workspace_uuid = w.uuid
           INNER JOIN ${this.workspaceStatus.getTableName()} as s ON s.workspace_uuid = w.uuid
           WHERE m.account_uuid = $1
           ORDER BY s.last_visit DESC
    `

    return await this.withRetry(async (rTx) => {
      const res: any = await rTx.unsafe(sql, [accountUuid])

      for (const row of res) {
        row.created_on = convertTimestamp(row.created_on)
        row.status.last_processing_time = convertTimestamp(row.status.last_processing_time)
        row.status.last_visit = convertTimestamp(row.status.last_visit)
        row.password_aging_rule = convertTimestamp(row.password_aging_rule)
      }

      return convertKeysToCamelCase(res)
    })
  }

  async getPendingWorkspace (
    region: string,
    version: Data<Version>,
    operation: WorkspaceOperation,
    processingTimeoutMs: number,
    wsLivenessMs?: number
  ): Promise<WorkspaceInfoWithStatus | undefined> {
    const sqlChunks: string[] = [
      `SELECT
          w.uuid,
          w.name,
          w.url,
          w.data_id,
          w.branding,
          w.location,
          w.region,
          w.created_by,
          w.created_on,
          w.billing_account,
          json_build_object(
            'mode', s.mode,
            'processing_progress', s.processing_progress,
            'version_major', s.version_major,
            'version_minor', s.version_minor,
            'version_patch', s.version_patch,
            'last_processing_time', s.last_processing_time,
            'last_visit', s.last_visit,
            'is_disabled', s.is_disabled,
            'processing_attempts', s.processing_attempts,
            'processing_message', s.processing_message,
            'backup_info', s.backup_info,
            'usage_info', s.usage_info
          ) status
           FROM ${this.workspace.getTableName()} as w
           INNER JOIN ${this.workspaceStatus.getTableName()} as s ON s.workspace_uuid = w.uuid
    `
    ]
    const whereChunks: string[] = []
    const values: any[] = []

    const pendingCreationSql = "s.mode IN ('pending-creation', 'creating')"
    const migrationSql =
      "s.mode IN ('migration-backup', 'migration-pending-backup', 'migration-clean', 'migration-pending-clean')"

    const restoringSql = "s.mode IN ('pending-restore', 'restoring')"
    const deletingSql = "s.mode IN ('pending-deletion', 'deleting')"
    const archivingSql =
      "s.mode IN ('archiving-pending-backup', 'archiving-backup', 'archiving-pending-clean', 'archiving-clean')"
    const versionSql =
      '(s.version_major < $1 OR (s.version_major = $1 AND s.version_minor < $2) OR (s.version_major = $1 AND s.version_minor = $2 AND s.version_patch < $3))'
    const pendingUpgradeSql = `(((s.is_disabled = FALSE OR s.is_disabled IS NULL) AND (s.mode = 'active' OR s.mode IS NULL) AND ${versionSql} ${wsLivenessMs !== undefined ? 'AND s.last_visit > $4' : ''}) OR ((s.is_disabled = FALSE OR s.is_disabled IS NULL) AND s.mode = 'upgrading'))`
    let operationSql: string = ''
    switch (operation) {
      case 'create':
        operationSql = pendingCreationSql
        break
      case 'upgrade':
        operationSql = pendingUpgradeSql
        break
      case 'all':
        operationSql = `(${pendingCreationSql} OR ${pendingUpgradeSql})`
        break
      case 'all+backup':
        operationSql = `(${pendingCreationSql} OR ${pendingUpgradeSql} OR ${migrationSql} OR ${archivingSql} OR ${restoringSql} OR ${deletingSql})`
        break
    }

    if (operation !== 'create') {
      values.push(version.major, version.minor, version.patch)

      if (wsLivenessMs !== undefined) {
        values.push(Date.now() - wsLivenessMs)
      }
    }
    whereChunks.push(operationSql)

    // TODO: support returning pending deletion workspaces when we will actually want
    // to clear them with the worker.
    whereChunks.push("s.mode <> 'manual-creation'")
    whereChunks.push('(s.processing_attempts IS NULL OR s.processing_attempts <= 3)')
    whereChunks.push(`(s.last_processing_time IS NULL OR s.last_processing_time < $${values.length + 1})`)
    values.push(Date.now() - processingTimeoutMs)

    if (region !== '') {
      whereChunks.push(`region = $${values.length + 1}`)
      values.push(region)
    } else {
      whereChunks.push("(w.region IS NULL OR w.region = '')")
    }

    sqlChunks.push(`WHERE ${whereChunks.join(' AND ')}`)
    sqlChunks.push('ORDER BY s.last_visit DESC')
    sqlChunks.push('LIMIT 1')

    return await this.withRetry(async (rTx) => {
      await rTx`SELECT 1 FROM ${this.client(this.getPendingWorkspaceLockTableName())} WHERE id = 1 FOR UPDATE;`
      // We must have all the conditions in the DB query and we cannot filter anything in the code
      // because of possible concurrency between account services.
      const res: any = await rTx.unsafe(sqlChunks.join(' '), values)

      if ((res.length ?? 0) > 0) {
        await rTx.unsafe(
          `UPDATE ${this.workspaceStatus.getTableName()} SET processing_attempts = processing_attempts + 1, "last_processing_time" = $1 WHERE workspace_uuid = $2`,
          [Date.now(), res[0].uuid]
        )
      }

      return convertKeysToCamelCase(res[0]) as WorkspaceInfoWithStatus
    })
  }

  async setPassword (accountUuid: AccountUuid, hash: Buffer, salt: Buffer): Promise<void> {
    await this.withRetry(
      async (rTx) =>
        await rTx`INSERT INTO ${this.client(this.account.getPasswordsTableName())} (account_uuid, hash, salt) VALUES (${accountUuid}, ${hash.buffer as any}::bytea, ${salt.buffer as any}::bytea) ON CONFLICT (account_uuid) DO UPDATE SET hash = EXCLUDED.hash, salt = EXCLUDED.salt;`
    )
  }

  async resetPassword (accountUuid: AccountUuid): Promise<void> {
    await this.withRetry(
      async (rTx) =>
        await rTx`DELETE FROM ${this.client(this.account.getPasswordsTableName())} WHERE account_uuid = ${accountUuid}`
    )
  }

  async deleteAccount (accountUuid: AccountUuid): Promise<void> {
    await this.withRetry(async (rTx) => {
      const socialIds = await this.socialId.find({ personUuid: accountUuid }, undefined, undefined, rTx)

      for (const socialIdObj of socialIds) {
        await this.integrationSecret.deleteMany({ socialId: socialIdObj._id }, rTx)
        await this.integration.deleteMany({ socialId: socialIdObj._id }, rTx)
      }

      const mailboxes = await this.mailbox.find({ accountUuid }, undefined, undefined, rTx)

      for (const mailboxObj of mailboxes) {
        await this.mailboxSecret.deleteMany({ mailbox: mailboxObj.mailbox }, rTx)
      }

      await this.mailbox.deleteMany({ accountUuid }, rTx)

      await this.socialId.update({ personUuid: accountUuid }, { verifiedOn: undefined }, rTx)

      // Unassign from all workspaces
      await rTx`DELETE FROM ${this.client(this.getWsMembersTableName())} WHERE account_uuid = ${accountUuid}`

      // This removes the account along with the password if any
      await this.account.deleteMany({ uuid: accountUuid }, rTx)
    })
  }

  /**
   * Purge an unfinished signup: a person row with social ids but no account.
   * Children first - account_events, user_profile and social_id all have FKs to person.
   */
  async deletePerson (personUuid: PersonUuid): Promise<void> {
    await this.withRetry(async (rTx) => {
      const socialIds = await this.socialId.find({ personUuid }, undefined, undefined, rTx)
      for (const socialIdObj of socialIds) {
        await this.integrationSecret.deleteMany({ socialId: socialIdObj._id }, rTx)
        await this.integration.deleteMany({ socialId: socialIdObj._id }, rTx)
      }

      await rTx`DELETE FROM ${this.client(this.getWsMembersTableName())} WHERE account_uuid = ${personUuid}`
      await this.accountEvent.deleteMany({ accountUuid: personUuid as AccountUuid }, rTx)
      await this.userProfile.deleteMany({ personUuid }, rTx)
      await this.socialId.deleteMany({ personUuid }, rTx)
      await this.person.deleteMany({ uuid: personUuid }, rTx)
    })
  }

  async listAccounts (
    search?: string,
    skip?: number,
    limit?: number,
    sort?: AccountsSortKey,
    filter?: AccountsFilter,
    order?: 'asc' | 'desc'
  ): Promise<AccountAggregatedInfo[]> {
    const sqlChunks: string[] = [
      `
      WITH account_data AS (
        SELECT
          p.uuid,
          a.timezone,
          a.locale,
          a.automatic,
          a.max_workspaces,
          (a.uuid IS NOT NULL) as has_account,
          p.first_name,
          p.last_name,
          up.country,
          up.city,
          p.migrated_to,
          (
            SELECT MIN(s.created_on)
            FROM ${this.socialId.getTableName()} s
            WHERE s.person_uuid = p.uuid
          ) as registered_on,
          (
            SELECT jsonb_agg(jsonb_build_object(
              'socialId', i.social_id,
              'kind', i.kind,
              'workspaceUuid', i.workspace_uuid
            ))
            FROM ${this.integration.getTableName()} i
            WHERE i.social_id IN (SELECT _id FROM ${this.socialId.getTableName()} s WHERE s.person_uuid = p.uuid)
          ) as integrations,
          (
            SELECT jsonb_agg(jsonb_build_object(
              '_id', s._id,
              'type', s.type,
              'value', s.value,
              'personUuid', s.person_uuid,
              'createdOn', s.created_on,
              'verifiedOn', s.verified_on,
              'displayValue', s.display_value
            ))
            FROM (
              SELECT * FROM ${this.socialId.getTableName()} s2
              WHERE s2.person_uuid = p.uuid AND s2.is_deleted = FALSE
              ORDER BY s2.created_on ASC NULLS LAST, s2._id
            ) s
          ) as social_ids,
          (
            SELECT s.value
            FROM ${this.socialId.getTableName()} s
            WHERE s.person_uuid = p.uuid AND s.type = 'email' AND s.is_deleted = FALSE
            ORDER BY s.created_on ASC NULLS LAST, s._id
            LIMIT 1
          ) as primary_email,
          (
            SELECT jsonb_agg(jsonb_build_object(
              'uuid', w.uuid,
              'name', w.name,
              'url', w.url,
              'dataId', w.data_id,
              'branding', w.branding,
              'region', w.region,
              'createdBy', w.created_by,
              'createdOn', w.created_on,
              'billingAccount', w.billing_account
            ))
            FROM ${this.workspace.getTableName()} w
            INNER JOIN ${this.getWsMembersTableName()} m ON m.workspace_uuid = w.uuid
            WHERE m.account_uuid = p.uuid
          ) as workspaces,
          (
            SELECT COUNT(*)
            FROM ${this.getWsMembersTableName()} m3
            WHERE m3.account_uuid = p.uuid
          ) as workspaces_count,
          (
            SELECT MAX(ws.last_visit)
            FROM ${this.workspaceStatus.getTableName()} ws
            INNER JOIN ${this.getWsMembersTableName()} m2 ON m2.workspace_uuid = ws.workspace_uuid
            WHERE m2.account_uuid = p.uuid
          ) as last_visit
        FROM ${this.ns}.person p
        LEFT JOIN ${this.account.getTableName()} a ON a.uuid = p.uuid
        LEFT JOIN ${this.userProfile.getTableName()} up ON up.person_uuid = p.uuid
    `
    ]

    const values: any[] = []
    let paramIndex = 1

    if (search !== undefined && search !== '') {
      sqlChunks.push(`
        WHERE
          p.first_name ILIKE $${paramIndex} OR
          p.last_name ILIKE $${paramIndex} OR
          EXISTS (
            SELECT 1 FROM ${this.socialId.getTableName()} s
            WHERE s.person_uuid = p.uuid AND s.value ILIKE $${paramIndex}
          )
      `)
      values.push(`%${search}%`)
      paramIndex++
    }

    // ORDER BY/LIMIT must live on the outer SELECT: row order of a CTE is not guaranteed outside it
    sqlChunks.push(') SELECT * FROM account_data')

    // Filters use the CTE's aggregated columns, so they belong to the outer WHERE.
    // The CTE is person-based, so accounts must be selected explicitly (default behaviour).
    const outerWhere: string[] = [filter?.pendingOnly === true ? 'has_account = FALSE' : 'has_account = TRUE']
    if (filter?.noWorkspaces === true) {
      outerWhere.push('(workspaces IS NULL OR jsonb_array_length(workspaces) = 0)')
    }
    if (filter?.inactiveDays !== undefined) {
      outerWhere.push(`(last_visit IS NULL OR last_visit < $${paramIndex})`)
      values.push(Date.now() - filter.inactiveDays * 24 * 3600 * 1000)
      paramIndex++
    }
    sqlChunks.push(`WHERE ${outerWhere.join(' AND ')}`)

    const orderBy: Record<AccountsSortKey, string> = {
      name: 'first_name',
      lastVisit: 'last_visit',
      registeredOn: 'registered_on',
      // Counting members is an index-only scan; jsonb_array_length would build every workspace
      // object for every row just to measure it (~2x on 50k accounts).
      workspaces: 'workspaces_count',
      email: 'primary_email'
    }
    // Names and emails read A-Z by default, the rest newest/biggest first.
    const dir = order ?? (sort === undefined || sort === 'name' || sort === 'email' ? 'asc' : 'desc')
    const dirSql = dir === 'asc' ? 'ASC' : 'DESC'
    sqlChunks.push(`ORDER BY ${orderBy[sort ?? 'name'] ?? orderBy.name} ${dirSql} NULLS LAST`)

    if (limit !== undefined) {
      sqlChunks.push(`LIMIT $${paramIndex}`)
      values.push(limit)
      paramIndex++
    }

    if (skip !== undefined) {
      sqlChunks.push(`OFFSET $${paramIndex}`)
      values.push(skip)
    }

    return await this.withRetry(async (rTx) => {
      const result = await rTx.unsafe(sqlChunks.join(' '), values)

      return result.map((row: any) => {
        // Handle null arrays
        row.integrations = row.integrations ?? []
        row.social_ids = row.social_ids ?? []
        row.workspaces = row.workspaces ?? []

        const converted = convertKeysToCamelCase(row)

        // Convert timestamp fields
        if (converted.workspaces != null) {
          for (const ws of converted.workspaces) {
            ws.createdOn = convertTimestamp(ws.createdOn)
          }
        }

        if (converted.socialIds != null) {
          for (const sid of converted.socialIds) {
            sid.createdOn = convertTimestamp(sid.createdOn)
            sid.verifiedOn = convertTimestamp(sid.verifiedOn)
          }
        }

        converted.lastVisit = convertTimestamp(converted.lastVisit)
        converted.registeredOn = convertTimestamp(converted.registeredOn)

        return converted as AccountAggregatedInfo
      })
    })
  }

  async listAdminActions (query: AdminActionsQuery): Promise<AdminActionsResult> {
    const table = this.adminAction.getTableName()
    const where: string[] = []
    const args: any[] = []

    if (query.search !== undefined && query.search !== '') {
      args.push(`%${query.search}%`)
      where.push(
        `(actor_email ILIKE $${args.length} OR target ILIKE $${args.length} OR target_label ILIKE $${args.length})`
      )
    }
    if (query.action !== undefined && query.action !== '') {
      args.push(query.action)
      where.push(`action = $${args.length}`)
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

    args.push(Math.min(Math.max(query.limit ?? 50, 1), 1000))
    const limitSql = `LIMIT $${args.length}`
    args.push(Math.max(query.skip ?? 0, 0))
    const offsetSql = `OFFSET $${args.length}`

    const rows = await this.adminAction.unsafe(
      `SELECT *, COUNT(*) OVER() AS total FROM ${table} ${whereSql} ORDER BY created_on DESC ${limitSql} ${offsetSql}`,
      args
    )
    const list = rows as Array<Record<string, any>>
    return {
      actions: list.map((r) => {
        const { total, ...rest } = r
        return this.adminAction.convertToObj(rest)
      }),
      total: list.length > 0 ? Number(list[0].total) : 0
    }
  }

  private workspaceStatusJson (alias: string): string {
    return `json_build_object(
            'mode', ${alias}.mode,
            'processing_progress', ${alias}.processing_progress,
            'version_major', ${alias}.version_major,
            'version_minor', ${alias}.version_minor,
            'version_patch', ${alias}.version_patch,
            'last_processing_time', ${alias}.last_processing_time,
            'last_visit', ${alias}.last_visit,
            'is_disabled', ${alias}.is_disabled,
            'processing_attempts', ${alias}.processing_attempts,
            'processing_message', ${alias}.processing_message,
            'backup_info', ${alias}.backup_info,
            'usage_info', ${alias}.usage_info
          )`
  }

  async listWorkspacesPaged (query: WorkspacesPagedQuery): Promise<WorkspacesPagedResult> {
    const where: string[] = []
    const values: any[] = []
    let idx = 1

    if (query.search !== undefined && query.search !== '') {
      where.push(`(w.name ILIKE $${idx} OR w.url ILIKE $${idx} OR w.uuid::text ILIKE $${idx})`)
      values.push(`%${query.search}%`)
      idx++
    }
    if (query.modes !== undefined && query.modes.length > 0) {
      where.push(`s.mode = ANY($${idx}::text[])`)
      values.push(query.modes)
      idx++
    }
    if (query.region !== undefined) {
      where.push(`COALESCE(w.region, '') = $${idx}`)
      values.push(query.region)
      idx++
    }
    if (query.attemptsGte !== undefined) {
      where.push(`COALESCE(s.processing_attempts, 0) >= $${idx}`)
      values.push(query.attemptsGte)
      idx++
    }
    if (query.billingPlan !== undefined && query.billingPlan !== '') {
      where.push(`bs.plan = $${idx}`)
      values.push(query.billingPlan)
      idx++
    }
    if (query.billingStatus !== undefined && query.billingStatus !== '') {
      where.push(`bs.status = $${idx}`)
      values.push(query.billingStatus)
      idx++
    }
    if (query.billingStatusNot !== undefined && query.billingStatusNot !== '') {
      where.push(`(bs.status IS NULL OR bs.status <> $${idx})`)
      values.push(query.billingStatusNot)
      idx++
    }
    if (query.billingExpired === true) {
      where.push("bs.plan IS NOT NULL AND bs.status NOT IN ('active', 'trialing')")
    }

    // backup_info jsonb keys are snake_case (convertKeysToSnakeCase on write)
    const backupSize = `GREATEST(
      COALESCE((s.backup_info->>'backup_size')::numeric, 0),
      COALESCE((s.backup_info->>'data_size')::numeric, 0) + COALESCE((s.backup_info->>'blobs_size')::numeric, 0)
    )`
    const sortColumns: Record<string, string> = {
      name: 'w.name',
      createdOn: 'w.created_on',
      lastVisit: 's.last_visit',
      backupDate: "COALESCE((s.backup_info->>'last_backup')::bigint, 0)",
      backupSize
    }
    const sortCol = sortColumns[query.sort ?? 'lastVisit'] ?? sortColumns.lastVisit
    const order = query.order === 'asc' ? 'ASC' : 'DESC'
    // Interpolated into SQL: force finite numbers, non-numeric RPC input falls back to defaults
    const limit = Number.isFinite(query.limit) ? Math.min(Math.max(Math.round(query.limit as number), 1), 1000) : 50
    const skip = Number.isFinite(query.skip) ? Math.max(Math.round(query.skip as number), 0) : 0

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    // Current tier subscription (billing): the active/trialing one, else the latest
    const billingJoin = `LEFT JOIN LATERAL (
          SELECT sub.plan, sub.status, sub.period_end
          FROM ${this.subscription.getTableName()} sub
          WHERE sub.workspace_uuid = w.uuid AND sub.type = 'tier'
          ORDER BY CASE WHEN sub.status IN ('active', 'trialing') THEN 0 ELSE 1 END, sub.created_on DESC
          LIMIT 1
        ) bs ON TRUE`
    const sql = `SELECT
          w.uuid, w.name, w.url, w.branding, w.location, w.region,
          w.created_by, w.created_on, w.billing_account, w.disabled_features_override,
          bs.plan AS billing_plan, bs.status AS billing_status, bs.period_end AS billing_period_end,
          ${this.workspaceStatusJson('s')} status,
          COUNT(*) OVER() AS total
        FROM ${this.workspace.getTableName()} w
        INNER JOIN ${this.workspaceStatus.getTableName()} s ON s.workspace_uuid = w.uuid
        ${billingJoin}
        ${whereSql}
        ORDER BY ${sortCol} ${order} NULLS LAST, w.uuid
        LIMIT ${limit} OFFSET ${skip}`

    return await this.withRetry(async (rTx) => {
      const res: any = await rTx.unsafe(sql, values)
      let total = res.length > 0 ? Number(res[0].total) : 0
      if (res.length === 0 && skip > 0) {
        const cnt: any = await rTx.unsafe(
          `SELECT COUNT(*) AS total FROM ${this.workspace.getTableName()} w
           INNER JOIN ${this.workspaceStatus.getTableName()} s ON s.workspace_uuid = w.uuid
           ${billingJoin} ${whereSql}`,
          values
        )
        total = Number(cnt[0].total)
      }
      for (const row of res) {
        delete row.total
        row.created_on = convertTimestamp(row.created_on)
        row.billing_period_end = row.billing_period_end != null ? convertTimestamp(row.billing_period_end) : undefined
        row.status.last_processing_time = convertTimestamp(row.status.last_processing_time)
        row.status.last_visit = convertTimestamp(row.status.last_visit)
      }
      return { workspaces: convertKeysToCamelCase(res), total }
    })
  }

  async getWorkspacesSummary (): Promise<WorkspacesSummary> {
    return await this.withRetry(async (rTx) => {
      const byMode: any = await rTx.unsafe(
        `SELECT COALESCE(s.mode, 'unknown') AS key, COUNT(*) AS count
         FROM ${this.workspaceStatus.getTableName()} s GROUP BY 1`,
        []
      )
      const byRegion: any = await rTx.unsafe(
        `SELECT COALESCE(w.region, '') AS key, COUNT(*) AS count
         FROM ${this.workspace.getTableName()} w
         INNER JOIN ${this.workspaceStatus.getTableName()} s ON s.workspace_uuid = w.uuid
         WHERE s.mode = 'active' GROUP BY 1`,
        []
      )
      const byVersion: any = await rTx.unsafe(
        `SELECT concat(s.version_major, '.', s.version_minor, '.', s.version_patch) AS key, COUNT(*) AS count
         FROM ${this.workspaceStatus.getTableName()} s WHERE s.mode = 'active' GROUP BY 1`,
        []
      )
      const billing: any = await rTx.unsafe(
        `SELECT plan, COUNT(*) AS workspaces, COALESCE(SUM((limits->>'users_limit')::int), 0) AS seats
         FROM ${this.subscription.getTableName()}
         WHERE type = 'tier' AND status IN ('active', 'trialing')
         GROUP BY plan ORDER BY seats DESC`,
        []
      )
      const toRecord = (rows: any[]): Record<string, number> =>
        Object.fromEntries(rows.map((r) => [r.key, Number(r.count)]))
      const modes = toRecord(byMode)
      return {
        total: Object.values(modes).reduce((a, b) => a + b, 0),
        byMode: modes,
        byRegion: toRecord(byRegion),
        byVersion: toRecord(byVersion),
        billing: billing.map((r: any) => ({ plan: r.plan, workspaces: Number(r.workspaces), seats: Number(r.seats) }))
      }
    })
  }

  async getRegistrationStats (from: number, to: number): Promise<RegistrationStats> {
    return await this.withRetry(async (rTx) => {
      const workspaces: any = await rTx.unsafe(
        `SELECT to_char(to_timestamp(created_on / 1000)::date, 'YYYY-MM-DD') AS day, COUNT(*) AS count
         FROM ${this.workspace.getTableName()}
         WHERE created_on >= $1 AND created_on <= $2 GROUP BY 1 ORDER BY 1`,
        [from, to]
      )
      const accounts: any = await rTx.unsafe(
        `SELECT to_char(to_timestamp("time" / 1000)::date, 'YYYY-MM-DD') AS day, COUNT(*) AS count
         FROM ${this.accountEvent.getTableName()}
         WHERE event_type = 'account_created' AND "time" >= $1 AND "time" <= $2 GROUP BY 1 ORDER BY 1`,
        [from, to]
      )
      const toPoints = (rows: any[]): Array<{ day: string, count: number }> =>
        rows.map((r) => ({ day: r.day, count: Number(r.count) }))
      return { workspaces: toPoints(workspaces), accounts: toPoints(accounts) }
    })
  }

  async consumeOtp (socialId: PersonId, code: string): Promise<boolean> {
    // Atomic: delete the row only if it exists and is unexpired; RETURNING tells us if we won.
    return await this.withRetry(async (rTx) => {
      const res: any = await rTx.unsafe(
        `DELETE FROM ${this.otp.getTableName()}
         WHERE social_id = $1 AND code = $2 AND expires_on > $3
         RETURNING code`,
        [socialId, code, Date.now()]
      )
      return res.length > 0
    })
  }

  async getWorkspaceActivityStats (workspace: WorkspaceUuid, from: number): Promise<WorkspaceActivityPoint[]> {
    // Workspace tx table lives in the same PG instance in the current deployment (public.tx).
    // In a multi-instance setup this table is not reachable from the account DB - return empty.
    try {
      return await this.withRetry(async (rTx) => {
        const res: any = await rTx.unsafe(
          `SELECT to_char(date_trunc('week', to_timestamp("modifiedOn" / 1000))::date, 'YYYY-MM-DD') AS week,
                  COUNT(*) AS count
           FROM public.tx
           WHERE "workspaceId" = $1 AND "modifiedOn" >= $2
           GROUP BY 1 ORDER BY 1`,
          [workspace, from]
        )
        return res.map((r: any) => ({ week: r.week, count: Number(r.count) }))
      })
    } catch (err: any) {
      return []
    }
  }

  async getWorkspaceMembersInfo (workspace: WorkspaceUuid): Promise<WorkspaceMemberDetails[]> {
    const baseSql = `SELECT
          m.account_uuid AS account, m.role, p.first_name, p.last_name,
          (SELECT s.value FROM ${this.socialId.getTableName()} s
           WHERE s.person_uuid = m.account_uuid AND s.type = 'email' AND s.is_deleted = FALSE LIMIT 1) AS email
        FROM ${this.getWsMembersTableName()} m
        INNER JOIN ${this.ns}.person p ON p.uuid = m.account_uuid
        WHERE m.workspace_uuid = $1`

    const members: any = await this.withRetry(async (rTx) => await rTx.unsafe(baseSql, [workspace]))
    // Activity comes from public.tx (same PG instance in the current deployment) - best effort.
    // Separate transaction: a failure here must not abort the members query.
    const activity = new Map<string, { last: number, total: number }>()
    try {
      const act: any = await this.withRetry(
        async (rTx) =>
          await rTx.unsafe(
            `SELECT s.person_uuid, MAX(t."modifiedOn") AS last_activity, COUNT(*) AS tx_total
             FROM public.tx t
             INNER JOIN ${this.socialId.getTableName()} s ON s._id::text = t."modifiedBy"
             WHERE t."workspaceId" = $1
             GROUP BY s.person_uuid`,
            [workspace]
          )
      )
      for (const row of act) {
        activity.set(row.person_uuid, { last: Number(row.last_activity), total: Number(row.tx_total) })
      }
    } catch (err: any) {
      // tx table not reachable - members without activity
    }
    const res: WorkspaceMemberDetails[] = members.map((m: any) => ({
      account: m.account,
      role: m.role,
      firstName: m.first_name ?? undefined,
      lastName: m.last_name ?? undefined,
      email: m.email ?? undefined,
      lastActivity: activity.get(m.account)?.last,
      txTotal: activity.get(m.account)?.total ?? 0
    }))
    res.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))
    return res
  }

  async getAccountActivityStats (account: AccountUuid, from: number): Promise<AccountActivityStats> {
    try {
      return await this.withRetry(async (rTx) => {
        const byWs: any = await rTx.unsafe(
          `SELECT t."workspaceId" AS workspace, w.name, w.url, COUNT(*) AS count, MAX(t."modifiedOn") AS last_tx
           FROM public.tx t
           INNER JOIN ${this.socialId.getTableName()} s ON s._id::text = t."modifiedBy" AND s.person_uuid = $1
           LEFT JOIN ${this.workspace.getTableName()} w ON w.uuid = t."workspaceId"
           GROUP BY 1, w.name, w.url
           ORDER BY count DESC`,
          [account]
        )
        const weekly: any = await rTx.unsafe(
          `SELECT to_char(date_trunc('week', to_timestamp(t."modifiedOn" / 1000))::date, 'YYYY-MM-DD') AS week,
                  COUNT(*) AS count
           FROM public.tx t
           INNER JOIN ${this.socialId.getTableName()} s ON s._id::text = t."modifiedBy" AND s.person_uuid = $1
           WHERE t."modifiedOn" >= $2
           GROUP BY 1 ORDER BY 1`,
          [account, from]
        )
        return {
          workspaces: byWs.map((r: any) => ({
            workspace: r.workspace,
            name: r.name ?? undefined,
            url: r.url ?? undefined,
            count: Number(r.count),
            lastTx: Number(r.last_tx)
          })),
          weekly: weekly.map((r: any) => ({ week: r.week, count: Number(r.count) }))
        }
      })
    } catch (err: any) {
      return { workspaces: [], weekly: [] }
    }
  }

  async generatePersonUuid (): Promise<PersonUuid> {
    const res = await this.client`SELECT gen_random_uuid();`

    return res[0].gen_random_uuid as PersonUuid
  }

  async ensurePerson (
    socialType: SocialIdType,
    socialValue: string,
    firstName: string,
    lastName: string
  ): Promise<{ uuid: PersonUuid, socialId: PersonId }> {
    // Atomic find-or-create of (person + social_id) keyed by (socialType, socialValue).
    // Uses INSERT ... ON CONFLICT DO NOTHING which is supported by both PostgreSQL
    // and CockroachDB. Avoids pg_advisory_xact_lock which CockroachDB does not support.
    // Flow:
    //   1. Check for existing social_id (optimistic fast path, no writes).
    //   2. If absent, insert person, then insert social_id ON CONFLICT DO NOTHING.
    //   3. If the social_id insert hit a conflict, the orphan person we just inserted
    //      is rolled back inside the same transaction by deleting it, and we read the
    //      winning row. The FK from social_id.person_uuid won't block the delete
    //      because no one outside this transaction can see our orphan person yet.
    const personTable = this.person.getTableName()
    const socialIdTable = this.socialId.getTableName()
    return await this.withRetry(async (tx) => {
      const existing = await tx.unsafe(
        `SELECT _id, person_uuid FROM ${socialIdTable} WHERE type = $1 AND value = $2 LIMIT 1`,
        [socialType, socialValue]
      )
      if (existing.length > 0) {
        return {
          uuid: existing[0].person_uuid as PersonUuid,
          socialId: existing[0]._id as PersonId
        }
      }

      const personRow = await tx.unsafe(
        `INSERT INTO ${personTable} (first_name, last_name) VALUES ($1, $2) RETURNING uuid`,
        [firstName, lastName]
      )
      const personUuid = personRow[0].uuid as PersonUuid

      const socialIdRow = await tx.unsafe(
        `INSERT INTO ${socialIdTable} (type, value, person_uuid) VALUES ($1, $2, $3)
         ON CONFLICT (type, value) DO NOTHING
         RETURNING _id`,
        [socialType, socialValue, personUuid]
      )

      if (socialIdRow.length > 0) {
        return {
          uuid: personUuid,
          socialId: socialIdRow[0]._id as PersonId
        }
      }

      // Concurrent caller won the race. Roll back our orphan person and return the winner.
      await tx.unsafe(`DELETE FROM ${personTable} WHERE uuid = $1`, [personUuid])

      const winner = await tx.unsafe(
        `SELECT _id, person_uuid FROM ${socialIdTable} WHERE type = $1 AND value = $2 LIMIT 1`,
        [socialType, socialValue]
      )
      if (winner.length === 0) {
        throw new Error(
          `ensurePerson: social_id conflict resolved but winning row is missing for ${socialType}:${socialValue}`
        )
      }
      return {
        uuid: winner[0].person_uuid as PersonUuid,
        socialId: winner[0]._id as PersonId
      }
    })
  }

  protected getMigrations (): [string, string][] {
    return getMigrations(this.ns, this.dbFlavor)
  }

  async batchAssignWorkspacePermission (
    workspaceId: WorkspaceUuid,
    accountIds: AccountUuid[],
    permission: string
  ): Promise<void> {
    if (accountIds.length === 0) {
      return
    }

    const now = Date.now()
    await this.withRetry(async (rTx) => {
      for (const accountId of accountIds) {
        await rTx`
          INSERT INTO ${this.client(this.workspacePermission.getTableName())}
          (workspace_uuid, account_uuid, permission, created_on)
          VALUES (${workspaceId}, ${accountId}, ${permission}, ${now})
          ON CONFLICT (workspace_uuid, account_uuid, permission) DO NOTHING
        `
      }
    })
  }

  async batchRevokeWorkspacePermission (
    workspaceId: WorkspaceUuid,
    accountIds: AccountUuid[],
    permission: string
  ): Promise<void> {
    if (accountIds.length === 0) {
      return
    }

    await this.withRetry(async (rTx) => {
      await rTx`
        DELETE FROM ${this.client(this.workspacePermission.getTableName())}
        WHERE workspace_uuid = ${workspaceId}
          AND permission = ${permission}
          AND account_uuid = ANY(${accountIds}::uuid[])
      `
    })
  }

  async hasWorkspacePermission (
    accountId: AccountUuid,
    workspaceId: WorkspaceUuid,
    permission: string
  ): Promise<boolean> {
    const result = await this.workspacePermission.findOne({
      workspaceUuid: workspaceId,
      accountUuid: accountId,
      permission
    })
    return result !== undefined
  }

  async getWorkspacePermissions (accountId: AccountUuid, permission: string): Promise<WorkspaceUuid[]> {
    const results = await this.workspacePermission.find({
      accountUuid: accountId,
      permission
    })
    return results.map((r) => r.workspaceUuid)
  }

  async getWorkspaceUsersWithPermission (workspaceId: WorkspaceUuid, permission: string): Promise<AccountUuid[]> {
    const results = await this.workspacePermission.find({
      workspaceUuid: workspaceId,
      permission
    })
    return results.map((r) => r.accountUuid)
  }

  async getAccountWorkspaceBadgeStatuses (accountId: AccountUuid): Promise<AccountWorkspaceBadgeStatus[]> {
    return await this.accountWorkspaceBadgeStatus.find({ accountUuid: accountId })
  }

  async setAccountWorkspaceBadgeStatus (
    accountId: AccountUuid,
    workspaceId: WorkspaceUuid,
    hasUnread: boolean
  ): Promise<void> {
    const updatedOn = Date.now()
    const sql = `
      INSERT INTO ${this.accountWorkspaceBadgeStatus.getTableName()} (account_uuid, workspace_uuid, has_unread, updated_on)
      SELECT $1::uuid, $2::uuid, $3::boolean, $4::bigint
      WHERE EXISTS (
        SELECT 1 FROM ${this.getWsMembersTableName()} wm 
        WHERE wm.account_uuid = $1::uuid AND wm.workspace_uuid = $2::uuid
      )
      ON CONFLICT (account_uuid, workspace_uuid) DO UPDATE SET has_unread = EXCLUDED.has_unread, updated_on = EXCLUDED.updated_on
    `
    await this.accountWorkspaceBadgeStatus.unsafe(sql, [accountId, workspaceId, hasUnread, updatedOn])
  }

  async batchWorkspaceBadgeStatuses (
    data: Array<{ accountId: AccountUuid, workspaceId: WorkspaceUuid, hasUnread: boolean }>
  ): Promise<void> {
    if (data.length === 0) return
    const updatedOn = Date.now()

    const values: any[] = []
    const rows = data
      .map((d: any, i: number) => {
        values.push(d.accountId, d.workspaceId, d.hasUnread, updatedOn)
        return `($${i * 4 + 1}::uuid, $${i * 4 + 2}::uuid, $${i * 4 + 3}::boolean, $${i * 4 + 4}::bigint)`
      })
      .join(', ')

    const sql = `
      INSERT INTO ${this.accountWorkspaceBadgeStatus.getTableName()} (account_uuid, workspace_uuid, has_unread, updated_on)
      SELECT v.account_uuid, v.workspace_uuid, v.has_unread, v.updated_on
      FROM (VALUES ${rows}) AS v(account_uuid, workspace_uuid, has_unread, updated_on)
      WHERE EXISTS (
        SELECT 1 FROM ${this.getWsMembersTableName()} wm 
        WHERE wm.account_uuid = v.account_uuid AND wm.workspace_uuid = v.workspace_uuid
      )
      ON CONFLICT (account_uuid, workspace_uuid) DO UPDATE SET has_unread = EXCLUDED.has_unread, updated_on = EXCLUDED.updated_on
    `
    await this.accountWorkspaceBadgeStatus.unsafe(sql, values)
  }

  async claimIntent (
    claimKey: string,
    provider: string,
    ctx?: { subscriptionId?: string, workspaceUuid?: string, amount?: number, orderFingerprint?: string }
  ): Promise<{ claimed: boolean, intent: PaymentIntent }> {
    const table = this.paymentIntent.getTableName()
    // Atomic claim: insert, or do nothing if claim_key already exists.
    // Works identically on CockroachDB and PostgreSQL (ON CONFLICT ... DO NOTHING RETURNING).
    const inserted = await this.paymentIntent.unsafe(
      `INSERT INTO ${table} (claim_key, provider, status, amount, heartbeat_at, subscription_id, workspace_uuid, order_fingerprint)
       VALUES ($1, $2, 'pending', $3, current_epoch_ms(), $4, $5, $6)
       ON CONFLICT (claim_key) DO NOTHING
       RETURNING *`,
      [
        claimKey,
        provider,
        ctx?.amount ?? null,
        ctx?.subscriptionId ?? null,
        ctx?.workspaceUuid ?? null,
        ctx?.orderFingerprint ?? null
      ]
    )
    if (inserted.length > 0) {
      return { claimed: true, intent: this.paymentIntent.convertToObj(inserted[0]) }
    }
    // Conflict: another caller already claimed this key — return the existing intent.
    const existing = await this.paymentIntent.unsafe(`SELECT * FROM ${table} WHERE claim_key = $1`, [claimKey])
    return { claimed: false, intent: this.paymentIntent.convertToObj(existing[0]) }
  }

  // Link a checkout intent to its charge (payment_id) + save URL for reuse; webhook releases by payment_id.
  async setIntentPayment (intentId: string, paymentId: string, paymentUrl?: string): Promise<void> {
    const table = this.paymentIntent.getTableName()
    await this.paymentIntent.unsafe(
      `UPDATE ${table} SET payment_id = $2, payment_url = $3, updated_on = current_epoch_ms()
       WHERE id = $1`,
      [intentId, paymentId, paymentUrl ?? null]
    )
  }

  // Release a checkout claim (scoped to 'checkout:%' so a renew ledger row is never deleted). Idempotent.
  async deleteCheckoutIntentByPaymentId (paymentId: string, provider: string): Promise<void> {
    const table = this.paymentIntent.getTableName()
    await this.paymentIntent.unsafe(
      `DELETE FROM ${table}
       WHERE payment_id = $1 AND provider = $2 AND claim_key LIKE 'checkout:%'`,
      [paymentId, provider]
    )
  }

  // Release a checkout claim by intent id — for a claim that failed before issuing a payment (no
  // payment_id yet), so a retry gets a clean claim immediately instead of waiting out the lease. Idempotent.
  async deleteCheckoutIntentById (intentId: string): Promise<void> {
    const table = this.paymentIntent.getTableName()
    await this.paymentIntent.unsafe(`DELETE FROM ${table} WHERE id = $1 AND claim_key LIKE 'checkout:%'`, [intentId])
  }

  // Append an immutable payment-operation audit row (never updated/deleted).
  async logPaymentOperation (op: PaymentOperation): Promise<void> {
    const table = this.paymentOperation.getTableName()
    await this.paymentOperation.unsafe(
      `INSERT INTO ${table}
        (provider, operation, status, payment_id, order_id, subscription_id, workspace_uuid, account_uuid,
         action_id, actor, amount, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
      [
        op.provider,
        op.operation,
        op.status ?? null,
        op.paymentId ?? null,
        op.orderId ?? null,
        op.subscriptionId ?? null,
        op.workspaceUuid ?? null,
        op.accountUuid ?? null,
        op.actionId ?? null,
        op.actor ?? null,
        op.amount ?? null,
        // Single JSON encoding: the driver serializes the object, $10::jsonb casts it.
        op.raw ?? null
      ]
    )
  }

  // List ledger operations, newest first, with optional filters + pagination — for the admin page.
  async getPaymentOperations (filter: PaymentOperationFilter): Promise<PaymentOperation[]> {
    const table = this.paymentOperation.getTableName()
    const where: string[] = []
    const args: any[] = []
    if (filter.from !== undefined) {
      args.push(filter.from)
      where.push(`created_on >= $${args.length}`)
    }
    if (filter.to !== undefined) {
      args.push(filter.to)
      where.push(`created_on < $${args.length}`)
    }
    if (filter.workspaceUuid !== undefined) {
      args.push(filter.workspaceUuid)
      where.push(`workspace_uuid = $${args.length}`)
    }
    if (filter.operation !== undefined) {
      args.push(filter.operation)
      where.push(`operation = $${args.length}`)
    }
    if (filter.status !== undefined) {
      args.push(filter.status)
      where.push(`status = $${args.length}`)
    }
    if (filter.provider !== undefined) {
      args.push(filter.provider)
      where.push(`provider = $${args.length}`)
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    args.push(Math.min(filter.limit ?? 100, 500))
    const limitSql = `LIMIT $${args.length}`
    args.push(filter.offset ?? 0)
    const offsetSql = `OFFSET $${args.length}`
    const rows = await this.paymentOperation.unsafe(
      `SELECT * FROM ${table} ${whereSql} ORDER BY created_on DESC ${limitSql} ${offsetSql}`,
      args
    )
    return (rows as Array<Record<string, any>>).map((r) => this.paymentOperation.convertToObj(r))
  }

  // Aggregate operations in [from, to) for the daily billing summary: per-workspace charge counts,
  // total charged amount, and error count (failed/rejected). Read-only.
  async getPaymentOperationStats (from: number, to: number): Promise<PaymentOperationStats> {
    const table = this.paymentOperation.getTableName()
    const rows = await this.paymentOperation.unsafe(
      `SELECT workspace_uuid, operation, status, amount, payment_id FROM ${table}
       WHERE created_on >= $1 AND created_on < $2`,
      [from, to]
    )
    const byWorkspace = new Map<string, { charges: number, amount: number, errors: number }>()
    let totalCharges = 0
    let totalAmount = 0
    let totalErrors = 0
    // Webhooks are delivered at-least-once: count each (payment, status) charge only once.
    const seenCharges = new Set<string>()
    for (const r of rows as Array<Record<string, any>>) {
      const ws = (r.workspace_uuid as string) ?? 'unknown'
      const entry = byWorkspace.get(ws) ?? { charges: 0, amount: 0, errors: 0 }
      const status = (r.status as string) ?? ''
      // Real charged money: tbank confirms via the webhook row (init_charge stays NEW).
      let isCharge =
        (r.operation === 'webhook' && status === 'CONFIRMED') ||
        (r.operation === 'charge_recurrent' && status === 'success') ||
        (r.operation === 'init_charge' && status === 'CONFIRMED')
      if (isCharge && r.payment_id != null) {
        const key = `${r.payment_id}|${r.operation}|${status}|${r.amount ?? ''}`
        if (seenCharges.has(key)) isCharge = false
        seenCharges.add(key)
      }
      const isError = status === 'REJECTED' || status === 'failed' || status === 'REVERSED'
      if (isCharge) {
        entry.charges++
        entry.amount += Number(r.amount ?? 0)
        totalCharges++
        totalAmount += Number(r.amount ?? 0)
      }
      if (isError) {
        entry.errors++
        totalErrors++
      }
      byWorkspace.set(ws, entry)
    }
    return {
      from,
      to,
      totalCharges,
      totalAmount,
      totalErrors,
      workspaces: Array.from(byWorkspace.entries()).map(([workspaceUuid, s]) => ({ workspaceUuid, ...s }))
    }
  }

  // Per-calendar-month (UTC) ledger aggregation for the admin finance view. Read-only.
  async getPaymentMonthlyStats (from: number, to: number): Promise<PaymentMonthlyStats[]> {
    const table = this.paymentOperation.getTableName()
    const rows = await this.paymentOperation.unsafe(
      `SELECT created_on, operation, status, amount, payment_id FROM ${table}
       WHERE created_on >= $1 AND created_on < $2`,
      [from, to]
    )
    const byMonth = new Map<string, PaymentMonthlyStats>()
    // Webhooks are delivered at-least-once: count each (payment, status) charge only once.
    const seenCharges = new Set<string>()
    for (const r of rows as Array<Record<string, any>>) {
      const month = new Date(Number(r.created_on)).toISOString().slice(0, 7)
      const entry = byMonth.get(month) ?? { month, charges: 0, amount: 0, errors: 0, cancels: 0, refunds: 0 }
      const status = (r.status as string) ?? ''
      // Real charged money: tbank confirms via the webhook row (init_charge stays NEW).
      let isCharge =
        (r.operation === 'webhook' && status === 'CONFIRMED') ||
        (r.operation === 'charge_recurrent' && status === 'success') ||
        (r.operation === 'init_charge' && status === 'CONFIRMED')
      if (isCharge && r.payment_id != null) {
        const key = `${r.payment_id}|${r.operation}|${status}|${r.amount ?? ''}`
        if (seenCharges.has(key)) isCharge = false
        seenCharges.add(key)
      }
      if (isCharge) {
        entry.charges++
        entry.amount += Number(r.amount ?? 0)
      }
      if (status === 'REJECTED' || status === 'failed' || status === 'REVERSED') {
        entry.errors++
      }
      if (r.operation === 'cancel') entry.cancels++
      if (r.operation === 'refund' || status === 'REFUNDED') entry.refunds++
      byMonth.set(month, entry)
    }
    return Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month))
  }

  // Insert a purchase row, returns the generated id. Idempotent by (payment_id, provider):
  // a concurrent duplicate hits the unique index and returns the existing row's id.
  async createPurchase (p: WorkspacePurchase): Promise<string> {
    const table = this.workspacePurchase.getTableName()
    const rows = await this.workspacePurchase.unsafe(
      `INSERT INTO ${table}
        (workspace_uuid, account_uuid, sku, category, status, amount, payment_id, provider, raw, activated_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       ON CONFLICT (payment_id, provider) WHERE payment_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        p.workspaceUuid,
        p.accountUuid,
        p.sku,
        p.category ?? null,
        p.status,
        p.amount ?? null,
        p.paymentId ?? null,
        p.provider ?? null,
        p.raw ?? null,
        p.activatedOn ?? null
      ]
    )
    const inserted = (rows as Array<Record<string, any>>)[0]?.id as string | undefined
    if (inserted !== undefined) return inserted

    const existing = await this.workspacePurchase.unsafe(
      `SELECT id FROM ${table} WHERE payment_id = $1 AND provider = $2`,
      [p.paymentId ?? null, p.provider ?? null]
    )
    const id = (existing as Array<Record<string, any>>)[0]?.id as string | undefined
    if (id === undefined) {
      throw new Error(`failed to create purchase for payment ${p.paymentId ?? ''}`)
    }
    return id
  }

  async updatePurchaseStatus (id: string, status: WorkspacePurchaseStatus, activatedOn?: number): Promise<void> {
    const table = this.workspacePurchase.getTableName()
    await this.workspacePurchase.unsafe(
      `UPDATE ${table} SET status = $2, activated_on = COALESCE($3, activated_on) WHERE id = $1`,
      [id, status, activatedOn ?? null]
    )
  }

  async getPurchases (workspace: WorkspaceUuid): Promise<WorkspacePurchase[]> {
    const table = this.workspacePurchase.getTableName()
    const rows = await this.workspacePurchase.unsafe(
      `SELECT * FROM ${table} WHERE workspace_uuid = $1 ORDER BY created_on DESC`,
      [workspace]
    )
    // The table's own converter, not the generic camel-case one: it restores column types
    // (created_on/activated_on), which the UI otherwise renders as "Invalid date".
    return (rows as Array<Record<string, any>>).map((r) => this.workspacePurchase.convertToObj(r))
  }

  // Lease heartbeat: refresh while the charge is in flight so other pods see the claimer is alive.
  // Uses DB clock (current_epoch_ms) so lease comparisons never depend on per-pod wall clocks.
  async heartbeatChargeIntent (intentId: string): Promise<void> {
    const table = this.paymentIntent.getTableName()
    await this.paymentIntent.unsafe(
      `UPDATE ${table} SET heartbeat_at = current_epoch_ms(), updated_on = current_epoch_ms()
       WHERE id = $1 AND status = 'pending'`,
      [intentId]
    )
  }

  // Take over an orphaned pending intent: only succeeds if it is still pending AND its lease expired
  // (heartbeat older than leaseMs, by DB clock). Atomic — only one pod wins the takeover.
  async reclaimStaleChargeIntent (intentId: string, leaseMs: number): Promise<boolean> {
    const table = this.paymentIntent.getTableName()
    const res = await this.paymentIntent.unsafe(
      `UPDATE ${table} SET heartbeat_at = current_epoch_ms(), updated_on = current_epoch_ms()
       WHERE id = $1 AND status = 'pending'
         AND (heartbeat_at IS NULL OR heartbeat_at < current_epoch_ms() - $2)
       RETURNING id`,
      [intentId, leaseMs]
    )
    return res.length > 0
  }
}
