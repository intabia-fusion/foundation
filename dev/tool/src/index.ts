//
// Copyright © 2020, 2021 Anticrm Platform Contributors.
// Copyright © 2021, 2024 Hardcore Engineering Inc.
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
/* eslint-disable @typescript-eslint/no-unused-vars */
import accountPlugin, {
  assignWorkspace,
  createWorkspaceRecord,
  flattenStatus,
  getAccountDB,
  getWorkspaceInfoWithStatusById,
  getWorkspaces,
  getWorkspacesInfoWithStatusByIds,
  signUpByEmail,
  updateWorkspaceInfo,
  createManualSubscription,
  type SubscriptionStatus,
  type SubscriptionType,
  type AccountDB,
  type Workspace
} from '@hcengineering/account'
import { type Account as OldAccount, type Workspace as OldWorkspace } from '@hcengineering/account-service'
import { getWorkspaceClient as getHulylakeClient } from '@hcengineering/hulylake-client'
import { setMetadata } from '@hcengineering/platform'
import {
  createPostgreeDestroyAdapter,
  createPostgresAdapter,
  createPostgresTxAdapter,
  getDBClient,
  shutdownPostgres
} from '@hcengineering/postgres'
import {
  backup,
  analyzeAccountRemap,
  backupDownload,
  backupFind,
  checkBackupIntegrity,
  compactBackup,
  createFileBackupStorage,
  createStorageBackupStorage,
  restore
} from '@hcengineering/server-backup'
import serverClientPlugin, { getAccountClient, getTransactorEndpoint } from '@hcengineering/server-client'
import {
  createBackupPipeline,
  createEmptyBroadcastOps,
  registerAdapterFactory,
  registerDestroyFactory,
  registerServerPlugins,
  registerStringLoaders,
  registerTxAdapterFactory
} from '@hcengineering/server-pipeline'
import serverToken, { decodeToken, generateToken } from '@hcengineering/server-token'
import { createWorkspace, upgradeWorkspace } from '@hcengineering/workspace-service'

import { faker } from '@faker-js/faker'
import { getPlatformQueue } from '@hcengineering/kafka'
import { buildStorageFromConfig, createStorageFromConfig, storageConfigFromEnv } from '@hcengineering/server-storage'
import { Command } from 'commander'
import { updateField } from './workspace'
import { dumpIndexes, syncIndexes } from './indexes'
import { reportSlowSql } from './slowsql'

import { RatingCalculator, ratingEvents, type QueueRatingMessage } from '@hcengineering/pod-rating'

import {
  AccountRole,
  isArchivingMode,
  isDeletingMode,
  MeasureMetricsContext,
  metricsToString,
  SocialIdType,
  systemAccountEmail,
  systemAccountUuid,
  type AccountUuid,
  type Data,
  type Doc,
  type PersonId,
  type PersonUuid,
  type Ref,
  type Tx,
  type Version,
  type WorkspaceDataId,
  type WorkspaceUuid
} from '@hcengineering/core'
import { consoleModelLogger, type MigrateOperation } from '@hcengineering/model'

import { getModelVersion } from '@hcengineering/model-all'
import {
  QueueTopic,
  workspaceEvents,
  type Pipeline,
  type QueueWorkspaceMessage,
  type StorageAdapter
} from '@hcengineering/server-core'
import { getAccountDBUrl, getKvsUrl, getMongoDBUrl, prepareTools, registerToolLocations } from './setup'
// import { fillGithubUsers, fixAccountEmails, renameAccount } from './account'
import { changeConfiguration } from './configuration'

import { performCalendarAccountMigrations } from './calendar'
import { generatePlannerData } from './plannerData'
import {
  ensureGlobalPersonsForLocalAccounts,
  filterMergedAccountsInMembers,
  migrateCreatedModifiedBy,
  migrateMergedAccounts,
  restoreFromv6All,
  restoreTrustedV6Workspace
} from './db'
import { performGithubAccountMigrations } from './github'
import { performGmailAccountMigrations } from './gmail'
import { getToolToken, getWorkspace, getWorkspaceTransactorEndpoint } from './utils'

import { createRestClient } from '@hcengineering/api-client'
import { sendTransactorEvent } from '@hcengineering/server-tool'
import { existsSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { restoreMarkupRefs } from './markup'
import { restoreGithubIntegrations } from './restoreGithub'

const colorConstants = {
  colorRed: '\u001b[31m',
  colorBlue: '\u001b[34m',
  colorWhiteCyan: '\u001b[37;46m',
  colorRedYellow: '\u001b[31;43m',
  colorPing: '\u001b[38;5;201m',
  colorLavander: '\u001b[38;5;147m',
  colorAqua: '\u001b[38;2;145;231;255m',
  colorPencil: '\u001b[38;2;253;182;0m',
  reset: '\u001b[0m'
}

// Register close on process exit.
process.on('exit', () => {
  shutdownPostgres().catch((err) => {
    console.error(err)
  })
})

export { prepareTools, registerToolLocations } from './setup'

export type PrepareTools = () => {
  dbUrl: string
  txes: Tx[]
  version: Data<Version>
  migrateOperations: [string, MigrateOperation][]
}

let runtimeReady = false

/**
 * Adapters, server plugins and process-level handlers are global: register them once even when
 * several programs are built in the same process (see buildToolProgram).
 */
function initToolRuntime (toolCtx: MeasureMetricsContext): void {
  if (runtimeReady) return
  runtimeReady = true

  registerTxAdapterFactory('postgresql', createPostgresTxAdapter, true)
  registerAdapterFactory('postgresql', createPostgresAdapter, true)
  registerDestroyFactory('postgresql', createPostgreeDestroyAdapter, true)

  registerServerPlugins()
  registerStringLoaders()

  process.on('unhandledRejection', (reason, promise) => {
    toolCtx.error('Unhandled Rejection at:', { reason, promise })
  })

  process.on('uncaughtException', (error, origin) => {
    toolCtx.error('Uncaught Exception at:', { origin, error })
  })
}

/**
 * @public
 */
export function devTool (prepareTools: PrepareTools, extendProgram?: (prog: Command) => void): void {
  buildToolProgram(prepareTools, extendProgram).parse(process.argv)
}

/**
 * Runs a single tool command in the current process; env is read per command, so callers may point
 * separate commands at different regions. Commander throws instead of exiting the embedder.
 * @public
 */
export async function runToolCommand (args: string[]): Promise<void> {
  registerToolLocations()
  const program = buildToolProgram(prepareTools)
  // Commander resolves a bad argument on the sub-command, so every one of them needs the override.
  for (const cmd of [program, ...program.commands]) {
    cmd.exitOverride()
  }
  await program.parseAsync(['node', 'tool', ...args])
}

/**
 * Builds a fresh command tree. Commander keeps parsed options on the command objects, so embedders
 * running commands concurrently must build one program per invocation.
 * @public
 */
export function buildToolProgram (prepareTools: PrepareTools, extendProgram?: (prog: Command) => void): Command {
  const toolCtx = new MeasureMetricsContext('tool', {})
  const program = new Command()

  initToolRuntime(toolCtx)

  const serverSecret = process.env.SERVER_SECRET
  if (serverSecret === undefined) {
    throw new Error('please provide server secret')
  }

  const accountsUrl = process.env.ACCOUNTS_URL
  if (accountsUrl === undefined) {
    throw new Error('please provide accounts url.')
  }

  const transactorUrl = process.env.TRANSACTOR_URL
  if (
    transactorUrl === undefined &&
    process.env.REGION_CONFIG === undefined &&
    process.env.REGION_CONFIG_JSON === undefined
  ) {
    console.error('please provide transactor url or REGION_CONFIG/REGION_CONFIG_JSON.')
  }

  setMetadata(accountPlugin.metadata.Transactors, transactorUrl)
  setMetadata(serverClientPlugin.metadata.Endpoint, accountsUrl)
  setMetadata(serverToken.metadata.Secret, serverSecret)
  setMetadata(serverToken.metadata.Service, 'tool')

  async function withAccountDatabase (
    f: (db: AccountDB) => Promise<any>,
    dbOverride?: string,
    nsOverride?: string
  ): Promise<void> {
    const uri = dbOverride ?? getAccountDBUrl()
    const ns = nsOverride ?? process.env.ACCOUNT_DB_NS

    const [accountDb, closeAccountsDb] = await getAccountDB(uri, ns)
    try {
      await f(accountDb)
    } catch (err: any) {
      console.error(err)
    }
    closeAccountsDb()
  }

  async function withStorage (f: (storageAdapter: StorageAdapter) => Promise<any>): Promise<void> {
    const adapter = buildStorageFromConfig(storageConfigFromEnv())
    try {
      await f(adapter)
    } catch (err: any) {
      console.error(err)
    }
    await adapter.close()
  }

  program.version('0.0.1')

  program.command('version').action(() => {
    console.log(
      `tools git_version: ${process.env.GIT_REVISION ?? ''} model_version: ${process.env.MODEL_VERSION ?? ''} ${JSON.stringify(getModelVersion())}`
    )
  })

  // create-account john.appleseed@gmail.com --password 123 --workspace workspace --fullname "John Appleseed"
  program
    .command('create-account <email>')
    .description('create user and corresponding account in master database')
    .requiredOption('-p, --password <password>', 'user password')
    .requiredOption('-f, --first <first>', 'first name')
    .requiredOption('-l, --last <last>', 'last name')
    .option('-n, --notconfirmed', 'creates not confirmed account', false)
    .action(async (email: string, cmd: { password: string, first: string, last: string, notconfirmed: boolean }) => {
      await withAccountDatabase(async (db) => {
        console.log(`creating account ${cmd.first} ${cmd.last} (${email})...`)
        await signUpByEmail(toolCtx, db, null, email, cmd.password, cmd.first, cmd.last, !cmd.notconfirmed)
      })
    })

  // program
  // .command('reset-account <email>')
  // .description('create user and corresponding account in master database')
  // .option('-p, --password <password>', 'new user password')
  // .action(async (email: string, cmd) => {
  //   await withAccountDatabase(async (db) => {
  //     console.log(`update account ${email} ${cmd.first as string} ${cmd.last as string}...`)
  //     await replacePassword(db, email, cmd.password)
  //   })
  // })

  // program
  // .command('reset-email <email> <newEmail>')
  // .description('rename account in accounts and all workspaces')
  // .action(async (email: string, newEmail: string, cmd) => {
  //   await withAccountDatabase(async (db) => {
  //     console.log(`update account ${email} to ${newEmail}`)
  //     await renameAccount(toolCtx, db, accountsUrl, email, newEmail)
  //   })
  // })

  // program
  // .command('fix-email <email> <newEmail>')
  // .description('fix email in all workspaces to be proper one')
  // .action(async (email: string, newEmail: string, cmd) => {
  //   await withAccountDatabase(async (db) => {
  //     console.log(`update account ${email} to ${newEmail}`)
  //     await fixAccountEmails(toolCtx, db, accountsUrl, email, newEmail)
  //   })
  // })

  // program
  // .command('compact-db-mongo')
  // .description('compact all db collections')
  // .option('-w, --workspace <workspace>', 'A selected "workspace" only', '')
  // .action(async (cmd: { workspace: string }) => {
  //   const dbUrl = getMongoDBUrl()
  //   await withAccountDatabase(async (db) => {
  //     console.log('compacting db ...')
  //     let gtotal: number = 0
  //     const client = getMongoClient(dbUrl)
  //     const _client = await client.getClient()
  //     try {
  //       const workspaces = await listWorkspacesPure(db)
  //       for (const workspace of workspaces) {
  //         if (cmd.workspace !== '' && workspace.workspace !== cmd.workspace) {
  //           continue
  //         }
  //         let total: number = 0
  //         const wsDb = getWorkspaceMongoDB(_client, { name: workspace.workspace })
  //         const collections = wsDb.listCollections()
  //         while (true) {
  //           const collInfo = await collections.next()
  //           if (collInfo === null) {
  //             break
  //           }
  //           const result = await wsDb.command({ compact: collInfo.name })
  //           total += result.bytesFreed
  //         }
  //         gtotal += total
  //         console.log('total feed for db', workspace.workspaceName, Math.round(total / (1024 * 1024)))
  //       }
  //       console.log('global total feed', Math.round(gtotal / (1024 * 1024)))
  //     } catch (err: any) {
  //       console.error(err)
  //     } finally {
  //       client.close()
  //     }
  //   })
  // })

  program
    .command('assign-workspace <email> <workspace>')
    .description('assign workspace')
    .action(async (email: string, workspace: string, cmd) => {
      await withAccountDatabase(async (db) => {
        console.log(`assigning user ${email} to ${workspace}...`)
        try {
          const ws = await getWorkspace(db, workspace)
          if (ws === null) {
            throw new Error(`Workspace ${workspace} not found`)
          }

          await assignWorkspace(toolCtx, db, null, getToolToken(), {
            email,
            workspaceUuid: ws.uuid,
            role: AccountRole.User
          })
        } catch (err: any) {
          console.error(err)
        }
      })
    })

  // program
  // .command('show-user <email>')
  // .description('show user')
  // .action(async (email) => {
  //   await withAccountDatabase(async (db) => {
  //     const info = await getAccount(db, email)
  //     console.log(info)
  //   })
  // })

  program
    .command('create-workspace <name> <owner_social_id>')
    .description('create workspace')
    .option('-i, --init <ws>', 'Init from workspace')
    .option('-r, --region <region>', 'Region')
    .option('-d, --dataId <dataId>', 'DataId for workspace')
    .option('-b, --branding <key>', 'Branding key')
    .action(
      async (
        name,
        socialString,
        cmd: { account: string, init?: string, branding?: string, region?: string, dataId?: string }
      ) => {
        const { txes, version, migrateOperations } = prepareTools()
        await withAccountDatabase(async (db) => {
          const measureCtx = new MeasureMetricsContext('create-workspace', {})
          const brandingObj =
            cmd.branding !== undefined || cmd.init !== undefined ? { key: cmd.branding, initWorkspace: cmd.init } : null
          const socialId = await db.socialId.findOne({ key: socialString as PersonId })
          if (socialId == null) {
            throw new Error(`Social id ${socialString} not found`)
          }

          const res = await createWorkspaceRecord(
            measureCtx,
            db,
            brandingObj,
            name,
            socialId.personUuid,
            cmd.region,
            'manual-creation',
            cmd.dataId as WorkspaceDataId
          )
          const wsInfo = await getWorkspaceInfoWithStatusById(db, res.workspaceUuid)

          if (wsInfo == null) {
            throw new Error(`Created workspace record ${res.workspaceUuid} not found`)
          }
          const coreWsInfo = flattenStatus(wsInfo)
          const accountClient = getAccountClient(getToolToken())

          const queue = getPlatformQueue('tool', cmd.region)
          const wsProducer = queue.getProducer<QueueWorkspaceMessage>(toolCtx, QueueTopic.Workspace)

          await createWorkspace(
            measureCtx,
            version,
            brandingObj,
            coreWsInfo,
            txes,
            migrateOperations,
            accountClient,
            wsProducer,
            undefined,
            true
          )
          await updateWorkspaceInfo(measureCtx, db, brandingObj, getToolToken(), {
            workspaceUuid: res.workspaceUuid,
            event: 'create-done',
            version,
            progress: 100
          })

          await wsProducer.send(measureCtx, res.workspaceUuid, [workspaceEvents.created()])
          await queue.shutdown()
          console.log(queue)
        })
      }
    )

  program
    .command('set-user-role <email> <workspace> <role>')
    .description('set user role')
    .action(async (email: string, workspace: string, role: AccountRole, cmd) => {
      console.log(`set user ${email} role for ${workspace}...`)
      await withAccountDatabase(async (db) => {
        const rolesArray = ['DocGuest', 'GUEST', 'USER', 'MAINTAINER', 'OWNER']
        if (!rolesArray.includes(role)) {
          throw new Error(`Invalid role ${role}. Valid roles are ${rolesArray.join(', ')}`)
        }

        const ws = await getWorkspace(db, workspace)
        if (ws === null) {
          throw new Error(`Workspace ${workspace} not found`)
        }

        await assignWorkspace(toolCtx, db, null, getToolToken(), { email, workspaceUuid: ws.uuid, role })
      })
    })

  program
    .command('set-workspace-plan <workspace> <plan>')
    .description('create manual active tier subscription with limits (0 = unlimited)')
    .option('--type <type>', 'subscription type', 'tier')
    .option('--status <status>', 'subscription status (active|past_due|canceled|expired)', 'active')
    .option('--users <n>', 'usersLimit', '0')
    .option('--storage <gb>', 'storageLimitGB', '0')
    .option('--traffic <gb>', 'trafficLimitGB', '0')
    .option('--tokens <n>', 'tokenLimit', '0')
    .option('--meeting-minutes <n>', 'meetingMinutesLimit', '0')
    .option('--window-month <n>', 'windowMonthLimit (billed tokens, 0 = unlimited)', '0')
    .action(
      async (
        workspace: string,
        plan: string,
        cmd: {
          type: string
          status: string
          users: string
          storage: string
          traffic: string
          tokens: string
          meetingMinutes: string
          windowMonth: string
        }
      ) => {
        await withAccountDatabase(async (db) => {
          const ws = await getWorkspace(db, workspace)
          if (ws === null) {
            throw new Error(`Workspace ${workspace} not found`)
          }
          const limits = {
            usersLimit: parseInt(cmd.users),
            storageLimitGB: parseFloat(cmd.storage), // fractional GB allowed (e.g. 0.05 = 50MB)
            trafficLimitGB: parseFloat(cmd.traffic),
            tokenLimit: parseInt(cmd.tokens),
            meetingMinutesLimit: parseInt(cmd.meetingMinutes),
            windowMonthLimit: parseInt(cmd.windowMonth)
          }
          // Direct DB write: the CLI holds no admin token. Same code path as the admin RPC.
          const queue = getPlatformQueue('tool', ws.region ?? '')
          setMetadata(
            accountPlugin.metadata.WorkspaceQueue,
            queue.getProducer<QueueWorkspaceMessage>(toolCtx, QueueTopic.Workspace)
          )
          try {
            await createManualSubscription(toolCtx, db, systemAccountUuid, {
              workspaceUuid: ws.uuid,
              plan,
              type: cmd.type as SubscriptionType,
              status: cmd.status as SubscriptionStatus,
              limits
            })
          } finally {
            await queue.shutdown()
          }
          console.log(`plan '${plan}' (${cmd.status}) set for workspace '${workspace}'`, limits)
        })
      }
    )

  program
    .command('show-workspace-plan <workspace>')
    .description('show workspace subscriptions and limits')
    .option('--all', 'include inactive subscriptions', false)
    .action(async (workspace: string, cmd: { all: boolean }) => {
      await withAccountDatabase(async (db) => {
        const ws = await getWorkspace(db, workspace)
        if (ws === null) {
          throw new Error(`Workspace ${workspace} not found`)
        }
        const accountClient = getAccountClient(getToolToken())
        const subs = await accountClient.getSubscriptions(ws.uuid, !cmd.all)
        for (const s of subs) {
          console.log(
            `${s.type}/${s.plan} status=${s.status} provider=${s.provider} limits=${JSON.stringify(s.limits ?? {})}`
          )
        }
        if (subs.length === 0) {
          console.log('no subscriptions (all limits unlimited)')
        }
      })
    })

  // program
  // .command('set-user-admin <email> <role>')
  // .description('set user role')
  // .action(async (email: string, role: string) => {
  //   console.log(`set user ${email} admin...`)
  //   await withAccountDatabase(async (db) => {
  //     await setAccountAdmin(db, email, role === 'true')
  //   })
  // })

  async function doUpgrade (
    toolCtx: MeasureMetricsContext,
    workspace: WorkspaceUuid,
    forceUpdate: boolean,
    forceIndexes: boolean
  ): Promise<void> {
    const { version, txes, migrateOperations } = prepareTools()

    await withAccountDatabase(async (db) => {
      const info = await getWorkspace(db, workspace)
      if (info === null) {
        throw new Error(`workspace ${workspace} not found`)
      }

      const wsInfo = await getWorkspaceInfoWithStatusById(db, info.uuid)
      if (wsInfo === null) {
        throw new Error(`workspace ${workspace} not found`)
      }

      const coreWsInfo = flattenStatus(wsInfo)
      const measureCtx = new MeasureMetricsContext('upgrade-workspace', {})
      const accountClient = getAccountClient(getToolToken(wsInfo.uuid))
      const queue = getPlatformQueue('tool', info.region)
      const wsProducer = queue.getProducer<QueueWorkspaceMessage>(toolCtx, QueueTopic.Workspace)
      await upgradeWorkspace(
        measureCtx,
        version,
        txes,
        migrateOperations,
        accountClient,
        coreWsInfo,
        consoleModelLogger,
        wsProducer,
        async () => {},
        forceUpdate,
        forceIndexes,
        true
      )

      await updateWorkspaceInfo(measureCtx, db, null, getToolToken(), {
        workspaceUuid: info.uuid,
        event: 'upgrade-done',
        version,
        progress: 100
      })

      console.log(metricsToString(measureCtx.metrics, 'upgrade', 60))

      await wsProducer.send(measureCtx, info.uuid, [workspaceEvents.upgraded()])
      await queue.shutdown()
      console.log('upgrade-workspace done')
    })
  }

  program
    .command('upgrade-workspace <name>')
    .description('upgrade workspace')
    .option('-f|--force [force]', 'Force update', true)
    .option('-i|--indexes [indexes]', 'Force indexes rebuild', false)
    .action(async (workspace, cmd: { force: boolean, indexes: boolean }) => {
      await doUpgrade(toolCtx, workspace, cmd.force, cmd.indexes)
    })

  // program
  // .command('upgrade')
  // .description('upgrade')
  // .option('-l|--logs <logs>', 'Default logs folder', './logs')
  // .option('-i|--ignore [ignore]', 'Ignore workspaces', '')
  // .option('-r|--region [region]', 'Region of workspaces', '')
  // .option(
  //   '-c|--console',
  //   'Display all information into console(default will create logs folder with {workspace}.log files',
  //   false
  // )
  // .option('-f|--force [force]', 'Force update', false)
  // .action(async (cmd: { logs: string, force: boolean, console: boolean, ignore: string, region: string }) => {
  //   const { version, txes, migrateOperations } = prepareTools()
  //   await withAccountDatabase(async (db) => {
  //     const workspaces = (await listWorkspacesRaw(db, cmd.region)).filter((ws) => !cmd.ignore.includes(ws.workspace))
  //     workspaces.sort((a, b) => b.lastVisit - a.lastVisit)
  //     const measureCtx = new MeasureMetricsContext('upgrade', {})

  //     for (const ws of workspaces) {
  //       console.warn('UPGRADING', ws.workspaceName)
  //       const logger = cmd.console
  //         ? consoleModelLogger
  //         : new FileModelLogger(path.join(cmd.logs, `${ws.workspace}.log`))

  //       try {
  //         await upgradeWorkspace(
  //           measureCtx,
  //           version,
  //           txes,
  //           migrateOperations,
  //           ws,
  //           logger,
  //           async () => {},
  //           cmd.force,
  //           false,
  //           true
  //         )

  //         await updateWorkspace(db, ws, {
  //           mode: 'active',
  //           progress: 100,
  //           version,
  //           attempts: 0
  //         })
  //       } catch (err: any) {
  //         toolCtx.error('failed to upgrade', { err, workspace: ws.workspace, workspaceName: ws.workspaceName })
  //         continue
  //       }
  //     }
  //     console.log('upgrade done')
  //   })
  // })

  // program
  // .command('list-unused-workspaces')
  // .description('list unused workspaces. Without it will only mark them disabled')
  // .option('-t|--timeout [timeout]', 'Timeout in days', '60')
  // .action(async (cmd: { disable: boolean, exclude: string, timeout: string }) => {
  //   await withAccountDatabase(async (db) => {
  //     const workspaces = new Map((await listWorkspacesPure(db)).map((p) => [p._id.toString(), p]))

  //     const accounts = await listAccounts(db)

  //     const _timeout = parseInt(cmd.timeout) ?? 7

  //     let used = 0
  //     let unused = 0

  //     for (const a of accounts) {
  //       const authored = a.workspaces
  //         .map((it) => workspaces.get(it.toString()))
  //         .filter((it) => it !== undefined && it.createdBy?.trim() === a.email?.trim()) as Workspace[]
  //       authored.sort((a, b) => b.lastVisit - a.lastVisit)
  //       if (authored.length > 0) {
  //         const lastLoginDays = Math.floor((Date.now() - a.lastVisit) / 1000 / 3600 / 24)
  //         toolCtx.info(a.email, {
  //           workspaces: a.workspaces.length,
  //           firstName: a.first,
  //           lastName: a.last,
  //           lastLoginDays
  //         })
  //         for (const ws of authored) {
  //           const lastVisitDays = Math.floor((Date.now() - ws.lastVisit) / 1000 / 3600 / 24)

  //           if (lastVisitDays > _timeout) {
  //             unused++
  //             toolCtx.warn('  --- unused', {
  //               url: ws.workspaceUrl,
  //               id: ws.workspace,
  //               lastVisitDays
  //             })
  //           } else {
  //             used++
  //             toolCtx.warn('  +++ used', {
  //               url: ws.workspaceUrl,
  //               id: ws.workspace,
  //               createdBy: ws.createdBy,
  //               lastVisitDays
  //             })
  //           }
  //         }
  //       }
  //     }

  //     console.log('Used: ', used, 'Unused: ', unused)
  //   })
  // })

  // program
  //   .command('archive-workspaces')
  //   .description('Archive and delete non visited workspaces...')
  //   .option('-r|--remove [remove]', 'Pass to remove all data', false)
  //   .option('--region [region]', 'Pass to remove all data', '')
  //   .option('-t|--timeout [timeout]', 'Timeout in days', '60')
  //   .option('-w|--workspace [workspace]', 'Force backup of selected workspace', '')
  //   .action(
  //     async (cmd: {
  //       disable: boolean
  //       exclude: string
  //       timeout: string
  //       remove: boolean
  //       workspace: string
  //       region: string
  //     }) => {
  //       const { dbUrl, txes } = prepareTools()
  //       await withAccountDatabase(async (db) => {
  //         const workspaces = (await listWorkspacesPure(db))
  //           .sort((a, b) => a.lastVisit - b.lastVisit)
  //           .filter((it) => cmd.workspace === '' || cmd.workspace === it.workspace)

  //         const _timeout = parseInt(cmd.timeout) ?? 7

  //         let unused = 0
  //         for (const ws of workspaces) {
  //           const lastVisitDays = Math.floor((Date.now() - ws.lastVisit) / 1000 / 3600 / 24)

  //           if (lastVisitDays > _timeout && isActiveMode(ws.mode)) {
  //             unused++
  //             toolCtx.warn('--- unused', {
  //               url: ws.workspaceUrl,
  //               id: ws.workspace,
  //               lastVisitDays,
  //               mode: ws.mode
  //             })
  //             try {
  //               await backupWorkspace(
  //                 toolCtx,
  //                 ws,
  //                 (dbUrl, storageAdapter) => {
  //                   const factory: PipelineFactory = createBackupPipeline(toolCtx, dbUrl, txes, {
  //                     externalStorage: storageAdapter,
  //                     usePassedCtx: true
  //                   })
  //                   return factory
  //                 },
  //                 (ctx, dbUrls, workspace, branding, externalStorage) => {
  //                   return getConfig(ctx, dbUrls, ctx, {
  //                     externalStorage,
  //                     disableTriggers: true
  //                   })
  //                 },
  //                 cmd.region,
  //                 5000, // 5 gigabytes per blob
  //                 async (storage, workspaceStorage) => {
  //                   if (cmd.remove) {
  //                     await updateArchiveInfo(toolCtx, db, ws.workspace, true)
  //                     const files = await workspaceStorage.listStream(toolCtx, { name: ws.workspace })

  //                     while (true) {
  //                       const docs = await files.next()
  //                       if (docs.length === 0) {
  //                         break
  //                       }
  //                       await workspaceStorage.remove(
  //                         toolCtx,
  //                         { name: ws.workspace },
  //                         docs.map((it) => it._id)
  //                       )
  //                     }

  // program
  //   .command('backup-all')
  //   .description('Backup all workspaces...')
  //   .option('--region [region]', 'Force backup of selected workspace', '')
  //   .option('-w|--workspace [workspace]', 'Force backup of selected workspace', '')
  //   .action(async (cmd: { workspace: string, region: string }) => {
  //     const { txes } = prepareTools()
  //     await withAccountDatabase(async (db) => {
  //       const workspaces = (await listWorkspacesPure(db))
  //         .sort((a, b) => a.lastVisit - b.lastVisit)
  //         .filter((it) => cmd.workspace === '' || cmd.workspace === it.workspace)

  //       let processed = 0

  //       // We need to update workspaces with missing workspaceUrl
  //       for (const ws of workspaces) {
  //         try {
  //           if (
  //             await backupWorkspace(
  //               toolCtx,
  //               ws,
  //               (dbUrl, storageAdapter) => {
  //                 const factory: PipelineFactory = createBackupPipeline(toolCtx, dbUrl, txes, {
  //                   externalStorage: storageAdapter,
  //                   usePassedCtx: true
  //                 })
  //                 return factory
  //               },
  //               (ctx, dbUrls, workspace, branding, externalStorage) => {
  //                 return getConfig(ctx, dbUrls, ctx, {
  //                   externalStorage,
  //                   disableTriggers: true
  //                 })
  //               },
  //               cmd.region,
  //               100,
  //             )
  //           ) {
  //             processed++
  //           }
  //         } catch (err: any) {
  //           toolCtx.error('Failed to backup workspace', { workspace: ws.workspace })
  //         }
  //       }
  //       console.log('Processed workspaces', processed)
  //     })
  //   })

  // program
  // .command('drop-workspace <name>')
  // .description('drop workspace')
  // .option('--full [full]', 'Force remove all data', false)
  // .action(async (workspace, cmd: { full: boolean }) => {
  //   const { dbUrl } = prepareTools()

  //   await withStorage(async (storageAdapter) => {
  //     await withAccountDatabase(async (db) => {
  //       const ws = await getWorkspaceById(db, workspace)
  //       if (ws === null) {
  //         console.log('no workspace exists')
  //         return
  //       }
  //       if (cmd.full) {
  //         await dropWorkspaceFull(toolCtx, db, dbUrl, null, workspace, storageAdapter)
  //       } else {
  //         await dropWorkspace(toolCtx, db, null, workspace)
  //       }
  //     })
  //   })
  // })

  // program
  // .command('drop-workspace-by-email <email>')
  // .description('drop workspace')
  // .option('--full [full]', 'Force remove all data', false)
  // .action(async (email, cmd: { full: boolean }) => {
  //   const { dbUrl } = prepareTools()
  //   await withStorage(async (storageAdapter) => {
  //     await withAccountDatabase(async (db) => {
  //       for (const workspace of await listWorkspacesByAccount(db, email)) {
  //         if (cmd.full) {
  //           await dropWorkspaceFull(toolCtx, db, dbUrl, null, workspace.workspace, storageAdapter)
  //         } else {
  //           await dropWorkspace(toolCtx, db, null, workspace.workspace)
  //         }
  //       }
  //     })
  //   })
  // })
  // program
  // .command('list-workspace-by-email <email>')
  // .description('drop workspace')
  // .option('--full [full]', 'Force remove all data', false)
  // .action(async (email, cmd: { full: boolean }) => {
  //   await withAccountDatabase(async (db) => {
  //     for (const workspace of await listWorkspacesByAccount(db, email)) {
  //       console.log(workspace.workspace, workspace.workspaceUrl, workspace.workspaceName)
  //     }
  //   })
  // })

  // program
  // .command('drop-workspace-last-visit')
  // .description('drop old workspaces')
  // .action(async (cmd: any) => {
  //   const { dbUrl } = prepareTools()

  //   await withStorage(async (storageAdapter) => {
  //     await withAccountDatabase(async (db) => {
  //       const workspacesJSON = await listWorkspacesPure(db)
  //       for (const ws of workspacesJSON) {
  //         const lastVisit = Math.floor((Date.now() - ws.lastVisit) / 1000 / 3600 / 24)
  //         if (lastVisit > 60) {
  //           await dropWorkspaceFull(toolCtx, db, dbUrl, null, ws.workspace, storageAdapter)
  //         }
  //       }
  //     })
  //   })
  // })

  // program
  // .command('list-workspaces')
  // .description('List workspaces')
  // .option('-e|--expired [expired]', 'Show only expired', false)
  // .action(async (cmd: { expired: boolean }) => {
  //   const { version } = prepareTools()
  //   await withAccountDatabase(async (db) => {
  //     const workspacesJSON = await listWorkspacesPure(db)
  //     for (const ws of workspacesJSON) {
  //       let lastVisit = Math.floor((Date.now() - ws.lastVisit) / 1000 / 3600 / 24)
  //       if (cmd.expired && lastVisit <= 7) {
  //         continue
  //       }
  //       console.log(
  //         colorConstants.colorBlue +
  //           '####################################################################################################' +
  //           colorConstants.reset
  //       )
  //       console.log('id:', colorConstants.colorWhiteCyan + ws.workspace + colorConstants.reset)
  //       console.log('url:', ws.workspaceUrl, 'name:', ws.workspaceName)
  //       console.log(
  //         'version:',
  //         ws.version !== undefined ? versionToString(ws.version) : 'not-set',
  //         !deepEqual(ws.version, version) ? `upgrade to ${versionToString(version)} is required` : ''
  //       )
  //       console.log('disabled:', ws.disabled)
  //       console.log('mode:', ws.mode)
  //       console.log('created by:', ws.createdBy)
  //       console.log('members:', (ws.accounts ?? []).length)
  //       if (Number.isNaN(lastVisit)) {
  //         lastVisit = 365
  //       }
  //       if (lastVisit > 30) {
  //         console.log(colorConstants.colorRed + `last visit: ${lastVisit} days ago` + colorConstants.reset)
  //       } else if (lastVisit > 7) {
  //         console.log(colorConstants.colorRedYellow + `last visit: ${lastVisit} days ago` + colorConstants.reset)
  //       } else {
  //         console.log('last visit:', lastVisit, 'days ago')
  //       }
  //     }

  //     console.log('latest model version:', JSON.stringify(version))
  //   })
  // })

  // program.command('fix-person-accounts-mongo').action(async () => {
  // const { version } = prepareTools()
  // const mongodbUri = getMongoDBUrl()
  // await withAccountDatabase(async (db) => {
  //   const ws = await listWorkspacesPure(db)
  //   const client = getMongoClient(mongodbUri)
  //   const _client = await client.getClient()
  //   try {
  //     for (const w of ws) {
  //       const wsDb = getWorkspaceMongoDB(_client, { name: w.workspace })
  //       await wsDb.collection('tx').updateMany(
  //         {
  //           objectClass: contact.class.PersonAccount,
  //           objectSpace: null
  //         },
  //         { $set: { objectSpace: core.space.Model } }
  //       )
  //     }
  //   } finally {
  //     client.close()
  //   }

  //   console.log('latest model version:', JSON.stringify(version))
  // })
  // })

  // program
  // .command('show-accounts')
  // .description('Show accounts')
  // .action(async () => {
  //   await withAccountDatabase(async (db) => {
  //     const workspaces = await listWorkspacesPure(db)
  //     const accounts = await listAccounts(db)
  //     for (const a of accounts) {
  //       const wss = a.workspaces.map((it) => it.toString())
  //       console.info(
  //         a.email,
  //         a.confirmed,
  //         workspaces.filter((it) => wss.includes(it._id.toString())).map((it) => it.workspaceUrl ?? it.workspace)
  //       )
  //     }
  //   })
  // })

  // program
  // .command('drop-account <name>')
  // .description('drop account')
  // .action(async (email: string, cmd) => {
  //   await withAccountDatabase(async (db) => {
  //     await dropAccount(toolCtx, db, null, email)
  //   })
  // })

  program
    .command('backup <dirName> <workspace>')
    .description('dump workspace transactions, blobs and accounts')
    .option('-i, --include <include>', 'A list of ; separated domain names to include during backup', '*')
    .option('-s, --skip <skip>', 'A list of ; separated domain names to skip during backup', '')
    .option('--full', 'Full recheck', false)
    .option(
      '--ct, --contentTypes <contentTypes>',
      'A list of ; separated content types for blobs to skip download if size >= limit',
      ''
    )
    .option('--bl, --blobLimit <blobLimit>', 'A blob size limit in megabytes (default 5mb)', '5')
    .option('-f, --force', 'Force backup', false)
    .option('-t, --timeout <timeout>', 'Connect timeout in seconds', '30')
    .option('-k, --keepSnapshots <keepSnapshots>', 'Keep snapshots for days', '78')
    .option('--fv, --fullVerify', 'Full verification', false)
    .action(
      async (
        dirName: string,
        workspace: string,
        cmd: {
          skip: string
          force: boolean
          timeout: string
          include: string
          blobLimit: string
          contentTypes: string
          full: boolean
          keepSnapshots: string
          fullVerify: boolean
        }
      ) => {
        toolCtx.info('backup: opening storage', { dirName })
        const storage = await createFileBackupStorage(dirName)
        toolCtx.info('backup: connecting to account db')
        await withAccountDatabase(async (db) => {
          const { txes, dbUrl } = prepareTools()
          toolCtx.info('backup: looking up workspace', { workspace })
          const ws = await getWorkspace(db, workspace)
          if (ws === null) {
            throw new Error(`workspace ${workspace} not found`)
          }
          toolCtx.info('backup: workspace found', { uuid: ws.uuid, url: ws.url, dataId: ws.dataId })
          const wsIds = {
            uuid: ws.uuid,
            dataId: ws.dataId,
            url: ws.url
          }
          const storageConfig = storageConfigFromEnv()

          const workspaceStorage: StorageAdapter = buildStorageFromConfig(storageConfig)

          let pipeline: Pipeline | undefined
          try {
            toolCtx.info('backup: creating pipeline')
            pipeline = await createBackupPipeline(toolCtx, dbUrl, txes, {
              externalStorage: workspaceStorage,
              usePassedCtx: true
            })(
              toolCtx,
              {
                uuid: ws.uuid,
                url: ws.url ?? '',
                dataId: ws.dataId
              },
              createEmptyBroadcastOps(),
              null
            )
            if (pipeline === undefined) {
              toolCtx.error('failed to restore, pipeline is undefined', { workspace })
              return
            }
            toolCtx.info('backup: pipeline ready')
            const include = cmd.include === '*' ? undefined : new Set(cmd.include.split(';').map((it) => it.trim()))

            if (include != null && include.has('account.socialId')) {
              include.add('channel')
            }
            if (include != null && include.has('account.person')) {
              include.add('contact')
            }
            toolCtx.info('OPT', { include: include != null ? Array.from(include) : '', skip: cmd.skip })
            toolCtx.info('backup: starting')
            await backup(toolCtx, pipeline, wsIds, storage, db, {
              force: cmd.force,
              include,
              skipDomains: (cmd.skip ?? '').split(';').map((it) => it.trim()),
              timeout: 0,
              connectTimeout: parseInt(cmd.timeout) * 1000,
              blobDownloadLimit: parseInt(cmd.blobLimit),
              skipBlobContentTypes: cmd.contentTypes
                .split(';')
                .map((it) => it.trim())
                .filter((it) => it.length > 0),
              keepSnapshots: parseInt(cmd.keepSnapshots),
              fullVerify: cmd.fullVerify
            })
          } catch (err: any) {
            toolCtx.error('Failed to backup workspace', { err, workspace })
          } finally {
            if (pipeline !== undefined) {
              await pipeline.close()
            }
            await workspaceStorage.close()
          }
        })
      }
    )
  program
    .command('backup-find <dirName> <fileId>')
    .description('dump workspace transactions and minio resources')
    .option('-d, --domain <domain>', 'Check only domain')
    .option('-a, --all', 'Show all versions', false)
    .action(async (dirName: string, fileId: string, cmd: { domain: string | undefined, all: boolean }) => {
      const storage = await createFileBackupStorage(dirName)
      console.log(cmd.all)
      await backupFind(storage, fileId as unknown as Ref<Doc>, cmd.all, cmd.domain)
    })

  program
    .command('backup-compact <dirName>')
    .description('Compact a given backup, will create one snapshot clean unused resources')
    .option('-f, --force', 'Force compact.', false)
    .option(
      '--ct, --contentTypes <contentTypes>',
      'A list of ; separated content types for blobs to exclude from backup',
      'video/;application/octet-stream;audio/;image/'
    )
    .option('-k, --keepSnapshots <keepSnapshots>', 'Keep snapshots for days', '14')
    .action(async (dirName: string, cmd: { force: boolean, contentTypes: string, keepSnapshots: string }) => {
      const storage = await createFileBackupStorage(dirName)
      await compactBackup(toolCtx, storage, cmd.force, {
        blobLimit: 5, // 5 MB
        skipContentTypes: cmd.contentTypes.split(';')
      })
    })
  program
    .command('backup-check <dirName>')
    .description('Compact a given backup, will create one snapshot clean unused resources')
    .action(async (dirName: string, cmd: any) => {
      const storage = await createFileBackupStorage(dirName)
      await checkBackupIntegrity(toolCtx, storage)
    })

  program
    .command('backup-check-all')
    .description('Check Backup integrity')
    .option('-r|--region [region]', 'Timeout in days', '')
    .option('-w|--workspace [workspace]', 'Force backup of selected workspace', '')
    .option('-s|--skip [skip]', 'A command separated list of workspaces to skip', '')
    .option('-d|--dry [dry]', 'Dry run', false)
    .action(async (cmd: { timeout: string, workspace: string, region: string, dry: boolean, skip: string }) => {
      const bucketName = process.env.BUCKET_NAME
      if (bucketName === '' || bucketName == null) {
        throw new Error('please provide BUCKET_NAME')
      }

      const skipWorkspaces = new Set(cmd.skip.split(',').map((it) => it.trim()))

      const token = generateToken(systemAccountUuid, undefined, {
        service: 'tool'
      })
      const workspaces = (await getAccountClient(token).listWorkspaces(cmd.region))
        .sort((a, b) => {
          const bsize = b.backupInfo?.backupSize ?? 0
          const asize = a.backupInfo?.backupSize ?? 0
          return bsize - asize
        })
        .filter((it) => (cmd.workspace === '' || cmd.workspace === it.url) && !skipWorkspaces.has(it.url))

      const backupStorageConfig = storageConfigFromEnv(process.env.STORAGE)
      const storageAdapter = createStorageFromConfig(backupStorageConfig.storages[0])
      for (const ws of workspaces) {
        const lastVisitDays = Math.floor((Date.now() - (ws.lastVisit ?? 0)) / 1000 / 3600 / 24)

        toolCtx.warn('--- checking workspace backup', {
          url: ws.url,
          id: ws.uuid,
          lastVisitDays,
          backupSize: ws.backupInfo?.blobsSize ?? 0,
          mode: ws.mode
        })
        if (cmd.dry) {
          continue
        }
        try {
          const st = Date.now()

          try {
            const storage = await createStorageBackupStorage(
              toolCtx,
              storageAdapter,
              {
                uuid: 'backup' as WorkspaceUuid,
                url: 'backup',
                dataId: bucketName as WorkspaceDataId
              },
              ws.dataId ?? ws.uuid
            )
            await checkBackupIntegrity(toolCtx, storage)
          } catch (err: any) {
            toolCtx.error('failed to size backup', { err })
          }
          const ed = Date.now()
          toolCtx.warn('--- check complete', {
            time: ed - st
          })
        } catch (err: any) {
          toolCtx.error('Restore of f workspace failedarchive workspace', { workspace: ws.url })
        }
      }
      await storageAdapter.close()
    })

  program
    .command('backup-restore <dirName> <workspace> [date]')
    .option('-m, --merge', 'Enable merge of remote and backup content.', false)
    .option('-p, --parallel <parallel>', 'Enable merge of remote and backup content.', '1')
    .option('-c, --recheck', 'Force hash recheck on server', false)
    .option('-i, --include <include>', 'A list of ; separated domain names to include during backup', '*')
    .option('-s, --skip <skip>', 'A list of ; separated domain names to skip during backup', '')
    .option('--upgrade', 'Upgrade workspace', false)
    .option('--noqueue', 'NoQueue', false)
    .option('--accounts', 'Restore accounts (person/socialId) from backup', false)
    .option('--verify-blobs', 'Download each uploaded blob back and compare content, re-upload on mismatch', false)
    .option('--verify-only', 'Do not upload. Download blobs and compare content, report missing/mismatch', false)
    .option(
      '--history-file <historyFile>',
      'Store blob send info into file. Will skip already send documents.',
      undefined
    )
    .description('dump workspace transactions and minio resources')
    .action(
      async (
        dirName: string,
        workspaceId: string,
        date,
        cmd: {
          merge: boolean
          parallel: string
          recheck: boolean
          include: string
          skip: string
          useStorage: string
          historyFile: string
          upgrade: boolean
          noqueue: boolean
          accounts: boolean
          verifyBlobs: boolean
          verifyOnly: boolean
        }
      ) => {
        await withAccountDatabase(async (db) => {
          const { txes, dbUrl } = prepareTools()
          const ws = await getWorkspace(db, workspaceId)
          if (ws === null) {
            throw new Error(`workspace ${workspaceId} not found`)
          }

          const workspace = ws.uuid
          const wsIds = {
            uuid: ws.uuid,
            dataId: ws.dataId,
            url: ws.url
          }
          const storage = await createFileBackupStorage(dirName)
          const storageConfig = storageConfigFromEnv()

          const queue = !cmd.noqueue ? getPlatformQueue('tool', ws.region) : undefined
          const wsProducer = queue?.getProducer<QueueWorkspaceMessage>(toolCtx, QueueTopic.Workspace)

          // verifyOnly is read-only: no maintenance, no restoring/restored events.
          if (!cmd.verifyOnly) {
            await wsProducer?.send(toolCtx, ws.uuid, [workspaceEvents.restoring()])
          }

          const workspaceStorage: StorageAdapter = buildStorageFromConfig(storageConfig)

          let pipeline: Pipeline | undefined
          try {
            pipeline = await createBackupPipeline(toolCtx, dbUrl, txes, {
              externalStorage: workspaceStorage,
              usePassedCtx: true
            })(
              toolCtx,
              {
                uuid: ws.uuid,
                url: ws.url ?? '',
                dataId: ws.dataId
              },
              createEmptyBroadcastOps(),
              null
            )
            if (pipeline === undefined) {
              toolCtx.error('failed to restore, pipeline is undefined', { workspaceId })
              return
            }
            if (!cmd.verifyOnly) {
              await sendTransactorEvent(workspace, 'force-maintenance')
            }

            await restore(toolCtx, pipeline, wsIds, storage, cmd.accounts ? db : undefined, {
              date: parseInt(date ?? '-1'),
              merge: cmd.merge,
              parallel: parseInt(cmd.parallel ?? '1'),
              recheck: cmd.recheck,
              include: cmd.include === '*' ? undefined : new Set(cmd.include.split(';')),
              skip: new Set(cmd.skip.split(';')),
              historyFile: cmd.historyFile,
              verifyBlobs: cmd.verifyBlobs,
              verifyOnly: cmd.verifyOnly
            })

            if (cmd.verifyOnly) {
              console.log('blob verification complete')
            } else {
              if (cmd.upgrade) {
                await doUpgrade(toolCtx, workspace, true, true)
              } else {
                await sendTransactorEvent(workspace, 'force-close')
              }

              console.log('workspace restored')
              await wsProducer?.send(toolCtx, ws.uuid, [workspaceEvents.restored()])
            }
          } catch (err) {
            toolCtx.error('failed to restore', { err })
          }
          await pipeline?.close()
          await queue?.shutdown()
          await workspaceStorage?.close()
        })
      }
    )

  program
    .command('backup-account-remap <dirName> [date]')
    .description(
      'analyze backup account identities vs target account_db, print report of collisions + remap SQL (run before backup-restore --accounts)'
    )
    .action(async (dirName: string, date) => {
      await withAccountDatabase(async (db) => {
        const storage = await createFileBackupStorage(dirName)
        await analyzeAccountRemap(toolCtx, storage, db, parseInt(date ?? '-1'))
      })
    })

  // program
  // .command('backup-list <dirName>')
  // .description('list snaphost ids for backup')
  // .action(async (dirName: string, cmd) => {
  //   const storage = await createFileBackupStorage(dirName)
  //   await backupList(storage)
  // })

  // program
  // .command('backup-s3 <bucketName> <dirName> <workspace>')
  // .description('dump workspace transactions and minio resources')
  // .action(async (bucketName: string, dirName: string, workspace: string, cmd) => {
  //   await withStorage(async (adapter) => {
  //     const storage = await createStorageBackupStorage(toolCtx, adapter, getWorkspaceId(bucketName), dirName)
  //     const wsid = getWorkspaceId(workspace)
  //     const endpoint = await getTransactorEndpoint(generateToken(systemAccountEmail, wsid), 'external')
  //     await backup(toolCtx, endpoint, wsIds, storage)
  //   })
  // })

  // program
  //   .command('backup-s3-clean <bucketName> <days>')
  //   .description('dump workspace transactions and minio resources')
  //   .action(async (bucketName: string, days: string, cmd) => {
  //     const backupStorageConfig = storageConfigFromEnv(process.env.STORAGE)
  //     const storageAdapter = createStorageFromConfig(backupStorageConfig.storages[0])

  //     const daysInterval = Date.now() - parseInt(days) * 24 * 60 * 60 * 1000
  //     try {
  //       const token = generateToken(systemAccountUuid, undefined, { service: 'tool' })
  //       const accountClient = getAccountClient(token)
  //       const workspaces = (await accountClient.listWorkspaces(null, 'active')).filter((it) => {
  //         const lastBackup = it.backupInfo?.lastBackup ?? 0
  //         if (lastBackup > daysInterval) {
  //           // No backup required, interval not elapsed
  //           return true
  //         }

  //         if (it.lastVisit == null) {
  //           return false
  //         }

  //         return false
  //       })
  //       workspaces.sort((a, b) => {
  //         return (b.backupInfo?.backupSize ?? 0) - (a.backupInfo?.backupSize ?? 0)
  //       })

  //       for (const ws of workspaces) {
  //         const storage = await createStorageBackupStorage(
  //           toolCtx,
  //           storageAdapter,
  //           getWorkspaceId(bucketName),
  //           ws.workspace
  //         )
  //         await backupRemoveLast(storage, daysInterval)
  //         const accountClient = getAccountClient(token)
  //         await accountClient.updateBackupInfo({
  //           backups: ws.backupInfo?.backups ?? 0,
  //           backupSize: ws.backupInfo?.backupSize ?? 0,
  //           blobsSize: ws.backupInfo?.blobsSize ?? 0,
  //           dataSize: ws.backupInfo?.dataSize ?? 0,
  //           lastBackup: daysInterval
  //         })
  //       }
  //     } finally {
  //       await storageAdapter.close()
  //     }
  //   })

  // program
  // .command('backup-clean <dirName> <days>')
  // .description('dump workspace transactions and minio resources')
  // .action(async (dirName: string, days: string, cmd) => {
  //   const daysInterval = Date.now() - parseInt(days) * 24 * 60 * 60 * 1000
  //   const storage = await createFileBackupStorage(dirName)
  //   await backupRemoveLast(storage, daysInterval)
  // })

  program
    .command('backup-s3-compact <bucketName> <dirName>')
    .description('Compact a given backup to just one snapshot')
    .option('-f, --force', 'Force compact.', false)
    .option(
      '--ct, --contentTypes <contentTypes>',
      'A list of ; separated content types for blobs to exclude from backup',
      'video/;application/octet-stream;audio/;image/'
    )
    .action(async (bucketName: string, dirName: string, cmd: { force: boolean, contentTypes: string }) => {
      const backupStorageConfig = storageConfigFromEnv(process.env.STORAGE)
      const storageAdapter = createStorageFromConfig(backupStorageConfig.storages[0])
      const backupIds = { uuid: bucketName as WorkspaceUuid, dataId: bucketName as WorkspaceDataId, url: '' }
      try {
        const storage = await createStorageBackupStorage(toolCtx, storageAdapter, backupIds, dirName)
        await compactBackup(
          toolCtx,
          storage,
          cmd.force,
          {
            blobLimit: 5, // 5 MB
            skipContentTypes: cmd.contentTypes !== undefined ? cmd.contentTypes.split(';') : undefined
          },
          true
        )
      } catch (err: any) {
        toolCtx.error('failed to size backup', { err })
      }
      await storageAdapter.close()
    })
  // program
  // .command('backup-s3-check <bucketName> <dirName>')
  // .description('Compact a given backup to just one snapshot')
  // .action(async (bucketName: string, dirName: string, cmd: any) => {
  //   const backupStorageConfig = storageConfigFromEnv(process.env.STORAGE)
  //   const storageAdapter = createStorageFromConfig(backupStorageConfig.storages[0])
  //   try {
  //     const storage = await createStorageBackupStorage(toolCtx, storageAdapter, getWorkspaceId(bucketName), dirName)
  //     await checkBackupIntegrity(toolCtx, storage)
  //   } catch (err: any) {
  //     toolCtx.error('failed to size backup', { err })
  //   }
  //   await storageAdapter.close()
  // })

  // program
  // .command('backup-s3-restore <bucketName> <dirName> <workspace> [date]')
  // .description('dump workspace transactions and minio resources')
  // .action(async (bucketName: string, dirName: string, workspace: string, date, cmd) => {
  //   const backupStorageConfig = storageConfigFromEnv(process.env.STORAGE)
  //   const storageAdapter = createStorageFromConfig(backupStorageConfig.storages[0])
  //   try {
  //     const storage = await createStorageBackupStorage(toolCtx, storageAdapter, getWorkspaceId(bucketName), dirName)
  //     const wsid = getWorkspaceId(workspace)
  //     const endpoint = await getTransactorEndpoint(generateToken(systemAccountEmail, wsid), 'external')
  //     await restore(toolCtx, endpoint, wsid, storage, {
  //       date: parseInt(date ?? '-1')
  //     })
  //   } catch (err: any) {
  //     toolCtx.error('failed to size backup', { err })
  //   }
  //   await storageAdapter.close()
  // })
  // program
  // .command('backup-s3-list <bucketName> <dirName>')
  // .description('list snaphost ids for backup')
  // .action(async (bucketName: string, dirName: string, cmd) => {
  //   const backupStorageConfig = storageConfigFromEnv(process.env.STORAGE)
  //   const storageAdapter = createStorageFromConfig(backupStorageConfig.storages[0])
  //   try {
  //     const storage = await createStorageBackupStorage(toolCtx, storageAdapter, getWorkspaceId(bucketName), dirName)
  //     await backupList(storage)
  //   } catch (err: any) {
  //     toolCtx.error('failed to size backup', { err })
  //   }
  //   await storageAdapter.close()
  // })

  // program
  // .command('backup-s3-size <bucketName> <dirName>')
  // .description('list snaphost ids for backup')
  // .action(async (bucketName: string, dirName: string, cmd) => {
  //   const backupStorageConfig = storageConfigFromEnv(process.env.STORAGE)
  //   const storageAdapter = createStorageFromConfig(backupStorageConfig.storages[0])
  //   try {
  //     const storage = await createStorageBackupStorage(toolCtx, storageAdapter, getWorkspaceId(bucketName), dirName)
  //     await backupSize(storage)
  //   } catch (err: any) {
  //     toolCtx.error('failed to size backup', { err })
  //   }
  //   await storageAdapter.close()
  // })

  program
    .command('backup-s3-download <bucketName> <dirName> <storeIn>')
    .description('Download a full backup from s3 to local dir')
    .option('-s, --skip <skip>', 'skip downloading of these files', '')
    .action(async (bucketName: string, dirName: string, storeIn: string, cmd) => {
      const backupStorageConfig = storageConfigFromEnv(process.env.STORAGE)
      const storageAdapter = createStorageFromConfig(backupStorageConfig.storages[0])
      const backupIds = { uuid: bucketName as WorkspaceUuid, dataId: bucketName as WorkspaceDataId, url: '' }
      try {
        const storage = await createStorageBackupStorage(toolCtx, storageAdapter, backupIds, dirName)
        console.log('downloading backup...', cmd.skip)
        await backupDownload(storage, storeIn, new Set(cmd.skip.split(';')))
      } catch (err: any) {
        toolCtx.error('failed to download backup', { err })
      }
      await storageAdapter.close()
    })

  // program
  //   .command('copy-s3-datalake')
  //   .description('copy files from s3 to datalake')
  //   .option('-w, --workspace <workspace>', 'Selected workspace only', '')
  //   .option('-c, --concurrency <concurrency>', 'Number of files being processed concurrently', '10')
  //   .option('-s, --skip <number>', 'Number of workspaces to skip', '0')
  //   .option('-e, --existing', 'Copy existing blobs', false)
  //   .action(async (cmd: { workspace: string, concurrency: string, existing: boolean, skip: string }) => {
  //     const params = {
  //       concurrency: parseInt(cmd.concurrency),
  //       existing: cmd.existing
  //     }
  //     const skip = parseInt(cmd.skip)

  //     const storageConfig = storageConfigFromEnv(process.env.STORAGE)

  //     const storages = storageConfig.storages.filter((p) => p.kind === S3_CONFIG_KIND) as S3Config[]
  //     if (storages.length === 0) {
  //       throw new Error('S3 storage config is required')
  //     }

  //     const datalakeConfig = storageConfig.storages.find((p) => p.kind === DATALAKE_CONFIG_KIND)
  //     if (datalakeConfig === undefined) {
  //       throw new Error('Datalake storage config is required')
  //     }

  //     toolCtx.info('using datalake', { datalake: datalakeConfig })

  //     let workspaces: Workspace[] = []
  //     await withAccountDatabase(async (db) => {
  //       workspaces = await listWorkspacesPure(db)
  //       workspaces = workspaces
  //         .filter((p) => isActiveMode(p.mode) || isArchivingMode(p.mode))
  //         .filter((p) => cmd.workspace === '' || p.workspace === cmd.workspace)
  //         // .sort((a, b) => b.lastVisit - a.lastVisit)
  //         .sort((a, b) => {
  //           if (a.backupInfo !== undefined && b.backupInfo !== undefined) {
  //             return b.backupInfo.blobsSize - a.backupInfo.blobsSize
  //           } else if (b.backupInfo !== undefined) {
  //             return 1
  //           } else if (a.backupInfo !== undefined) {
  //             return -1
  //           } else {
  //             return b.lastVisit - a.lastVisit
  //           }
  //         })
  //     })

  //     const count = workspaces.length
  //     console.log('found workspaces', count)

  //     let index = 0
  //     for (const workspace of workspaces) {
  //       index++
  //       if (index <= skip) {
  //         toolCtx.info('processing workspace', { workspace: workspace.workspace, index, count })
  //         continue
  //       }

  //       toolCtx.info('processing workspace', {
  //         workspace: workspace.workspace,
  //         index,
  //         count,
  //         blobsSize: workspace.backupInfo?.blobsSize ?? 0
  //       })
  //       const workspaceId = getWorkspaceId(workspace.workspace)
  //       const token = generateToken(systemAccountEmail, workspaceId)
  //       const datalake = createDatalakeClient(datalakeConfig as DatalakeConfig, token)

  //       for (const config of storages) {
  //         const storage = new S3Service(config)
  //         await copyToDatalake(toolCtx, workspaceId, config, storage, datalake, params)
  //       }
  //     }
  //   })

  // program
  // .command('restore-wiki-content-mongo')
  // .description('restore wiki document contents')
  // .option('-w, --workspace <workspace>', 'Selected workspace only', '')
  // .option('-d, --dryrun', 'Dry run', false)
  // .action(async (cmd: { workspace: string, dryrun: boolean }) => {
  //   const params = {
  //     dryRun: cmd.dryrun
  //   }

  //   const { version } = prepareTools()

  //   let workspaces: Workspace[] = []
  //   await withAccountDatabase(async (db) => {
  //     workspaces = await listWorkspacesPure(db)
  //     workspaces = workspaces
  //       .filter((p) => isActiveMode(p.mode))
  //       .filter((p) => cmd.workspace === '' || p.workspace === cmd.workspace)
  //       .sort((a, b) => b.lastVisit - a.lastVisit)
  //   })

  //   console.log('found workspaces', workspaces.length)

  //   await withStorage(async (storageAdapter) => {
  //     const mongodbUri = getMongoDBUrl()
  //     const client = getMongoClient(mongodbUri)
  //     const _client = await client.getClient()

  //     try {
  //       const count = workspaces.length
  //       let index = 0
  //       for (const workspace of workspaces) {
  //         index++

  //         toolCtx.info('processing workspace', { workspace: workspace.workspace, index, count })
  //         if (workspace.version === undefined || !deepEqual(workspace.version, version)) {
  //           console.log(`upgrade to ${versionToString(version)} is required`)
  //           continue
  //         }

  //         const workspaceId = getWorkspaceId(workspace.workspace)
  //         const workspaceDataId = workspace.dataId ?? workspace.uuid
  //         const wsDb = getWorkspaceMongoDB(_client, { name: workspace.workspace })

  //         await restoreWikiContentMongo(toolCtx, wsDb, workspaceDataId, storageAdapter, params)
  //       }
  //     } finally {
  //       client.close()
  //     }
  //   })
  // })

  // program
  // .command('restore-controlled-content-mongo')
  // .description('restore controlled document contents')
  // .option('-w, --workspace <workspace>', 'Selected workspace only', '')
  // .option('-d, --dryrun', 'Dry run', false)
  // .option('-f, --force', 'Force update', false)
  // .action(async (cmd: { workspace: string, dryrun: boolean, force: boolean }) => {
  //   const params = {
  //     dryRun: cmd.dryrun
  //   }

  //   const { version } = prepareTools()

  //   let workspaces: Workspace[] = []
  //   await withAccountDatabase(async (db) => {
  //     workspaces = await listWorkspacesPure(db)
  //     workspaces = workspaces
  //       .filter((p) => p.mode !== 'archived')
  //       .filter((p) => cmd.workspace === '' || p.workspace === cmd.workspace)
  //       .sort((a, b) => b.lastVisit - a.lastVisit)
  //   })

  //   console.log('found workspaces', workspaces.length)

  //   await withStorage(async (storageAdapter) => {
  //     await withAccountDatabase(async (db) => {
  //       const mongodbUri = getMongoDBUrl()
  //       const client = getMongoClient(mongodbUri)
  //       const _client = await client.getClient()

  //       try {
  //         const count = workspaces.length
  //         let index = 0
  //         for (const workspace of workspaces) {
  //           index++

  //           toolCtx.info('processing workspace', { workspace: workspace.workspace, index, count })

  //           if (!cmd.force && (workspace.version === undefined || !deepEqual(workspace.version, version))) {
  //             console.log(`upgrade to ${versionToString(version)} is required`)
  //             continue
  //           }

  //           const workspaceId = getWorkspaceId(workspace.workspace)
  //           const workspaceDataId = workspace.dataId ?? workspace.uuid
  //           const wsDb = getWorkspaceMongoDB(_client, { name: workspace.workspace })

  //           await restoreControlledDocContentMongo(toolCtx, wsDb, workspaceDataId, storageAdapter, params)
  //         }
  //       } finally {
  //         client.close()
  //       }
  //     })
  //   })
  // })

  // program
  //   .command('restore-markup-ref-mongo')
  //   .description('restore markup document content refs')
  //   .option('-w, --workspace <workspace>', 'Selected workspace only', '')
  //   .option('-f, --force', 'Force update', false)
  //   .action(async (cmd: { workspace: string, force: boolean }) => {
  //     const { txes, version } = prepareTools()

  //     const { hierarchy } = await buildModel(toolCtx, txes)

  //     let workspaces: Workspace[] = []
  //     await withAccountDatabase(async (db) => {
  //       workspaces = await listWorkspacesPure(db)
  //       workspaces = workspaces
  //         .filter((p) => isActiveMode(p.mode))
  //         .filter((p) => cmd.workspace === '' || p.workspace === cmd.workspace)
  //         .sort((a, b) => b.lastVisit - a.lastVisit)
  //     })

  //     console.log('found workspaces', workspaces.length)

  //     await withStorage(async (storageAdapter) => {
  //       const mongodbUri = getMongoDBUrl()
  //       const client = getMongoClient(mongodbUri)
  //       const _client = await client.getClient()

  //       try {
  //         const count = workspaces.length
  //         let index = 0
  //         for (const workspace of workspaces) {
  //           index++

  //           toolCtx.info('processing workspace', {
  //             workspace: workspace.workspace,
  //             version: workspace.version,
  //             index,
  //             count
  //           })

  //           if (!cmd.force && (workspace.version === undefined || !deepEqual(workspace.version, version))) {
  //             console.log(`upgrade to ${versionToString(version)} is required`)
  //             continue
  //           }

  //           const workspaceId = getWorkspaceId(workspace.workspace)
  //           const workspaceDataId = workspace.dataId ?? workspace.uuid
  //           const wsDb = getWorkspaceMongoDB(_client, { name: workspace.workspace })

  //           await restoreMarkupRefsMongo(toolCtx, wsDb, workspaceDataId, hierarchy, storageAdapter)
  //         }
  //       } finally {
  //         client.close()
  //       }
  //     })
  //   })

  // program
  //   .command('confirm-email <email>')
  //   .description('confirm user email')
  //   .action(async (email: string, cmd) => {
  //     await withAccountDatabase(async (db) => {
  //       const account = await getAccount(db, email)
  //       if (account?.confirmed === true) {
  //         console.log(`Already confirmed:${email}`)
  //       } else {
  //         await confirmEmail(db, email)
  //       }
  //     })
  //   })

  // program
  // .command('diff-workspace <workspace>')
  // .description('restore workspace transactions and minio resources from previous dump.')
  // .action(async (workspace: string, cmd) => {
  //   const { dbUrl, txes } = prepareTools()
  //   await diffWorkspace(dbUrl, workspace, txes)
  // })

  // program
  // .command('clear-telegram-history <workspace>')
  // .description('clear telegram history')
  // .option('-w, --workspace <workspace>', 'target workspace')
  // .action(async (workspace: string, cmd) => {
  //   const { dbUrl } = prepareTools()
  //   await withStorage(async (adapter) => {
  //     const telegramDB = process.env.TELEGRAM_DATABASE
  //     if (telegramDB === undefined) {
  //       console.error('please provide TELEGRAM_DATABASE.')
  //       process.exit(1)
  //     }

  //     console.log(`clearing ${workspace} history:`)
  //     await clearTelegramHistory(toolCtx, dbUrl, getWorkspaceId(workspace), telegramDB, adapter)
  //   })
  // })

  // program
  // .command('clear-telegram-all-history')
  // .description('clear telegram history')
  // .action(async (cmd) => {
  //   const { dbUrl } = prepareTools()
  //   await withStorage(async (adapter) => {
  //     await withAccountDatabase(async (db) => {
  //       const telegramDB = process.env.TELEGRAM_DATABASE
  //       if (telegramDB === undefined) {
  //         console.error('please provide TELEGRAM_DATABASE.')
  //         process.exit(1)
  //       }

  //       const workspaces = await listWorkspacesPure(db)

  //       for (const w of workspaces) {
  //         console.log(`clearing ${w.workspace} history:`)
  //         await clearTelegramHistory(toolCtx, dbUrl, getWorkspaceId(w.workspace), telegramDB, adapter)
  //       }
  //     })
  //   })
  // })

  program
    .command('generate-token <name> <workspace>')
    .description('generate token')
    .action(async (name: string, workspace: string) => {
      await withAccountDatabase(async (db) => {
        if (name === systemAccountEmail) {
          name = systemAccountUuid
        }
        const wsByUrl = await db.workspace.findOne({ url: workspace })
        const account = await db.socialId.findOne({ value: name })
        console.log(
          generateToken(account?.personUuid ?? (name as AccountUuid), wsByUrl?.uuid ?? (workspace as WorkspaceUuid))
        )
      })
    })
  program
    .command('profile <endpoint> <mode>')
    .description('Enable or disable profiling')
    .option('-o, --output <output>', 'Output file', 'profile.cpuprofile')
    .action(async (endpoint: string, mode: string, opt: { output: string }) => {
      const token = generateToken(systemAccountUuid, undefined, { service: 'tool' })
      if (mode === 'start') {
        await fetch(`${endpoint}/api/v1/manage?operation=profile-start`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}` }
        })
      } else {
        const resp = await fetch(`${endpoint}/api/v1/manage?operation=profile-stop`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}` }
        })
        if (resp.ok) {
          const bdir = dirname(opt.output)
          if (!existsSync(bdir)) {
            await mkdir(bdir, { recursive: true })
          }
          const bytes = await resp.arrayBuffer()
          console.log('writing to', opt.output)
          await writeFile(opt.output, new Uint8Array(bytes))
        } else {
          console.error('failed to stop profile', resp.headers)
        }
      }
    })

  program
    .command('stats-analytics')
    .description(
      'show the most problematic (slowest/most-called) operations from the stats service. <target> is either a platform base url (e.g. https://platform.intabia.ru, STATS_URL is resolved from its config.json) or a direct stats endpoint'
    )
    .option('-n, --limit <limit>', 'Number of entries to show', '30')
    .option('-s, --sort <sort>', 'Sort key: time | count | avg', 'time')
    .option('--source <source>', 'Filter source: all | client | server', 'all')
    .option('--url <target>', 'Platform URL')
    .option('--json <file>', 'Dump full analytics JSON (with top results/params) to a file instead of printing a table')
    .action(async (opt: { limit: string, sort: string, source: string, url?: string, json?: string }) => {
      const base = (opt.url ?? process.env.PLATFORM_URL ?? '').replace('ws:/', 'http:/').replace(/\/+$/, '')
      if (base === '') {
        throw new Error('please provide PLATFORM_URL or --url')
      }
      let statsUrl = base
      // Try to resolve STATS_URL from the platform config.json. If target is already
      // a stats endpoint config.json won't exist and we fall back to the target as-is.
      try {
        const cfgResp = await fetch(`${base}/config.json`)
        if (cfgResp.ok) {
          const cfg = (await cfgResp.json()) as { STATS_URL?: string }
          if (cfg.STATS_URL !== undefined && cfg.STATS_URL !== '') {
            statsUrl = cfg.STATS_URL.replace(/\/+$/, '')
            console.log(`resolved STATS_URL from config.json: ${statsUrl}`)
          }
        }
      } catch {
        // not a platform base url, use target directly
      }

      const serverSecret = process.env.SERVER_SECRET
      if (serverSecret === undefined) {
        throw new Error('please provide SERVER_SECRET')
      }

      const token = generateToken(systemAccountUuid, undefined, { service: 'tool' }, serverSecret)

      const limit = Math.min(Math.max(parseInt(opt.limit), 1), 1000)
      const url = `${statsUrl}/api/v1/analytics?limit=${limit}&sort=${opt.sort}&source=${opt.source}`
      console.log(`GET ${statsUrl}/api/v1/analytics?limit=${limit}&sort=${opt.sort}&source=${opt.source}`)
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        console.error(`failed to fetch analytics: ${resp.status} ${resp.statusText}\n${text}`)
        console.error(
          '404 usually means: invalid token (SERVER_SECRET does not match the deployed stats secret) or the stats pod predates the /analytics endpoint.'
        )
        return
      }
      const body = (await resp.json()) as {
        entries: Array<{
          service: string
          path: string
          operations: number
          total: number
          avg: number
          top: Array<{ value: number, time?: number, params?: Record<string, any> }>
        }>
        generatedAt: number
        services: number
      }
      if (opt.json !== undefined) {
        await writeFile(opt.json, JSON.stringify(body, null, 2))
        console.log(`wrote ${body.entries.length} entries to ${opt.json}`)
        return
      }
      console.log(
        `Top ${body.entries.length} operations by ${opt.sort} across ${body.services} service(s), source=${opt.source}, generated at ${new Date(body.generatedAt).toISOString()}\n`
      )
      console.log('  #  total(ms)    avg(ms)     ops  service / path')
      console.log('---  ---------  ---------  ------  -------------------------------------------')
      body.entries.forEach((e, i) => {
        const rank = String(i + 1).padStart(3)
        const total = e.total.toFixed(2).padStart(9)
        const avg = e.avg.toFixed(2).padStart(9)
        const ops = String(e.operations).padStart(6)
        console.log(`${rank}  ${total}  ${avg}  ${ops}  ${e.service} / ${e.path}`)
      })
    })

  program
    .command('stats-dump')
    .description(
      'Dump raw per-service statistics trees (with query params) from the stats service into a directory. <target> is a platform base url (STATS_URL resolved from config.json) or a direct stats endpoint'
    )
    .option('-o, --out <dir>', 'Output directory', './profiles/stats-dump')
    .option('--filter <substr>', 'Only dump services whose name contains this substring', '')
    .option('--url <target>', 'Platform URL')
    .action(async (opt: { out: string, filter: string, url?: string }) => {
      const base = (opt.url ?? process.env.PLATFORM_URL ?? '').replace('ws:/', 'http:/').replace(/\/+$/, '')
      if (base === '') {
        throw new Error('please provide PLATFORM_URL or --url')
      }
      let statsUrl = base
      try {
        const cfgResp = await fetch(`${base}/config.json`)
        if (cfgResp.ok) {
          const cfg = (await cfgResp.json()) as { STATS_URL?: string }
          if (cfg.STATS_URL !== undefined && cfg.STATS_URL !== '') {
            statsUrl = cfg.STATS_URL.replace(/\/+$/, '')
            console.log(`resolved STATS_URL from config.json: ${statsUrl}`)
          }
        }
      } catch {
        // not a platform base url, use target directly
      }

      const serverSecret = process.env.SERVER_SECRET
      if (serverSecret === undefined) {
        throw new Error('please provide SERVER_SECRET')
      }
      const token = generateToken(systemAccountUuid, undefined, { service: 'tool' }, serverSecret)

      const overviewResp = await fetch(`${statsUrl}/api/v1/overview`, { headers: { Authorization: `Bearer ${token}` } })
      if (!overviewResp.ok) {
        console.error(`failed to fetch overview: ${overviewResp.status} ${overviewResp.statusText}`)
        return
      }
      const overview = (await overviewResp.json()) as { data?: Record<string, unknown> }
      const allServices = Object.keys(overview.data ?? {})
      const services = opt.filter === '' ? allServices : allServices.filter((s) => s.includes(opt.filter))
      if (services.length === 0) {
        console.error(`no services match filter "${opt.filter}" (total ${allServices.length})`)
        return
      }

      await mkdir(opt.out, { recursive: true })
      await writeFile(join(opt.out, 'overview.json'), JSON.stringify(overview, null, 2))
      console.log(`dumping ${services.length}/${allServices.length} service(s) to ${opt.out}`)

      let ok = 0
      let failed = 0
      for (const service of services) {
        try {
          const resp = await fetch(`${statsUrl}/api/v1/statistics?name=${encodeURIComponent(service)}`, {
            headers: { Authorization: `Bearer ${token}` }
          })
          if (!resp.ok) {
            console.error(`  ${service}: ${resp.status} ${resp.statusText}`)
            failed++
            continue
          }
          const json = await resp.text()
          const file = join(opt.out, `${service.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
          await writeFile(file, json)
          console.log(`  ${service} -> ${file} (${json.length} bytes)`)
          ok++
        } catch (err: any) {
          console.error(`  ${service}: ${err?.message ?? String(err)}`)
          failed++
        }
      }
      console.log(`done: ${ok} dumped, ${failed} failed`)
    })

  program
    .command('stats-slow-sql')
    .description(
      'Find the slowest SQL queries from stats topResults, grouped by normalized shape. Source is --url (live) or --from <dir> (a stats-dump directory)'
    )
    .option('--url <target>', 'Platform URL (live fetch)')
    .option('--from <dir>', 'Read already dumped per-service JSON files from a directory (stats-dump output)')
    .option('--filter <substr>', 'Only include services whose name contains this substring', '')
    .option('-n, --limit <limit>', 'Number of groups to show', '30')
    .option('-s, --sort <sort>', 'Sort key: max | sum | count | avg', 'max')
    .option('--json <file>', 'Write full grouped result (with sample SQL) to a file instead of a table')
    .option('--indexes <file>', 'YAML index dump (from dump-indexes) to check whether queries are covered')
    .option('--missing-only', 'With --indexes: show only query shapes missing a leading-column index', false)
    .action(
      async (opt: {
        url?: string
        from?: string
        filter: string
        limit: string
        sort: string
        json?: string
        indexes?: string
        missingOnly: boolean
      }) => {
        const sort = (['max', 'sum', 'count', 'avg'].includes(opt.sort) ? opt.sort : 'max') as
          | 'max'
          | 'sum'
          | 'count'
          | 'avg'
        const serverSecret = process.env.SERVER_SECRET
        await reportSlowSql({
          url: opt.url ?? process.env.PLATFORM_URL,
          from: opt.from,
          filter: opt.filter,
          limit: Math.min(Math.max(parseInt(opt.limit), 1), 1000),
          sort,
          json: opt.json,
          indexes: opt.indexes,
          missingOnly: opt.missingOnly,
          serverSecret,
          makeToken: () => generateToken(systemAccountUuid, undefined, { service: 'tool' }, serverSecret ?? '')
        })
      }
    )

  program
    .command('generate-persons <workspace>')
    .description('generate a random persons into workspace')
    .option('--admin', 'Generate token with admin access', false)
    .option('--count <count>', 'Number of persons to generate', '1000')
    .action(async (workspace: string, opt: { admin: boolean, count: string }) => {
      const count = parseInt(opt.count)
      const token = generateToken(systemAccountUuid, workspace as WorkspaceUuid, { service: 'tool' })
      const endpoint = await getTransactorEndpoint(token, 'external')
      const client = createRestClient(endpoint, workspace, token)
      for (let i = 0; i < count; i++) {
        const email = `${faker.internet.email()}`
        await client.ensurePerson(SocialIdType.EMAIL, email, faker.person.firstName(), faker.person.lastName())
      }
    })

  program
    .command('generate-planner-data <workspace>')
    .description(
      'populate a workspace with tracker projects/issues, personal todos, work slots and calendar events, ' +
        'for eyeballing Team Planner and the calendar'
    )
    .option('--accounts <emails>', 'comma-separated login emails to use, need at least 3', 'user1,user2,user3')
    .option('--password <password>', 'password for the accounts', '1234')
    .option('--url <url>', 'platform base url', process.env.PLATFORM_URL ?? 'http://localhost:8083')
    .action(async (workspace: string, opt: { accounts: string, password: string, url: string }) => {
      await generatePlannerData({
        workspace,
        platformUrl: opt.url,
        accountEmails: opt.accounts
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
        password: opt.password
      })
    })

  program
    .command('decode-token <token>')
    .description('decode token')
    .action(async (token) => {
      console.log(decodeToken(token))
    })

  // program
  // .command('clean-workspace <workspace>')
  // .description('clean workspace')
  // .option('--recruit', 'Clean recruit', false)
  // .option('--tracker', 'Clean tracker', false)
  // .option('--removedTx', 'Clean removed transactions', false)
  // .action(async (workspace: string, cmd: { recruit: boolean, tracker: boolean, removedTx: boolean }) => {
  //   const { dbUrl } = prepareTools()
  //   await withStorage(async (adapter) => {
  //     const wsid = getWorkspaceId(workspace)
  //     const endpoint = await getTransactorEndpoint(generateToken(systemAccountEmail, wsid), 'external')
  //     await cleanWorkspace(toolCtx, dbUrl, wsid, adapter, endpoint, cmd)
  //   })
  // })
  // program
  // .command('clean-empty-buckets')
  // .option('--prefix [prefix]', 'Prefix', '')
  // .action(async (cmd: { prefix: string }) => {
  //   await withStorage(async (adapter) => {
  //     const buckets = await adapter.listBuckets(toolCtx)
  //     for (const ws of buckets) {
  //       if (ws.name.startsWith(cmd.prefix)) {
  //         console.log('Checking', ws.name)
  //         const l = await ws.list()
  //         const docs = await l.next()
  //         if (docs.length === 0) {
  //           await l.close()
  //           // No data, we could delete it.
  //           console.log('Clean bucket', ws.name)
  //           await ws.delete()
  //         } else {
  //           await l.close()
  //         }
  //       }
  //     }
  //   })
  // })
  // program
  // .command('upload-file <workspace> <local> <remote> <contentType>')
  // .action(async (workspace: string, local: string, remote: string, contentType: string, cmd: any) => {
  //   const wsId: WorkspaceId = {
  //     name: workspace
  //   }
  //   const token = generateToken(systemAccountEmail, wsId)
  //   const endpoint = await getTransactorEndpoint(token)
  //   const blobClient = new BlobClient(endpoint, token, wsId)
  //   const buffer = readFileSync(local)
  //   await blobClient.upload(toolCtx, remote, buffer.length, contentType, buffer)
  // })

  // program
  // .command('download-file <workspace> <remote> <local>')
  // .action(async (workspace: string, remote: string, local: string, cmd: any) => {
  //   const wsId: WorkspaceId = {
  //     name: workspace
  //   }
  //   const token = generateToken(systemAccountEmail, wsId)
  //   const endpoint = await getTransactorEndpoint(token)
  //   const blobClient = new BlobClient(endpoint, token, wsId)
  //   const wrstream = createWriteStream(local)
  //   await blobClient.writeTo(toolCtx, remote, -1, {
  //     write: (buffer, cb) => {
  //       wrstream.write(buffer, cb)
  //     },
  //     end: (cb) => {
  //       wrstream.end(cb)
  //     }
  //   })
  // })

  // program
  // .command('move-files')
  // .option('-w, --workspace <workspace>', 'Selected workspace only', '')
  // .option('-m, --move <move>', 'When set to true, the files will be moved, otherwise copied', 'false')
  // .option('-bl, --blobLimit <blobLimit>', 'A blob size limit in megabytes (default 50mb)', '999999')
  // .option('-c, --concurrency <concurrency>', 'Number of files being processed concurrently', '10')
  // .option('--disabled', 'Include disabled workspaces', false)
  // .action(
  //   async (cmd: { workspace: string, move: string, blobLimit: string, concurrency: string, disabled: boolean }) => {
  //     const params = {
  //       concurrency: parseInt(cmd.concurrency),
  //       move: cmd.move === 'true'
  //     }

  //     await withAccountDatabase(async (db) => {
  //       await withStorage(async (adapter) => {
  //         try {
  //           const exAdapter = adapter as StorageAdapterEx
  //           if (exAdapter.adapters === undefined || exAdapter.adapters.length < 2) {
  //             throw new Error('bad storage config, at least two storage providers are required')
  //           }

  //           console.log('moving files to storage provider', exAdapter.adapters[0].name)

  //           let index = 1
  //           const workspaces = await listWorkspacesPure(db)
  //           workspaces.sort((a, b) => b.lastVisit - a.lastVisit)

  //           const rateLimit = new RateLimiter(10)
  //           for (const workspace of workspaces) {
  //             if (cmd.workspace !== '' && workspace.workspace !== cmd.workspace) {
  //               continue
  //             }
  //             if (!isActiveMode(workspace.mode)) {
  //               console.log('ignore non active workspace', workspace.workspace, workspace.mode)
  //               continue
  //             }
  //             if (workspace.disabled === true && !cmd.disabled) {
  //               console.log('ignore disabled workspace', workspace.workspace)
  //               continue
  //             }

  //             await rateLimit.exec(async () => {
  //               console.log('start', workspace.workspace, index, '/', workspaces.length)
  //               await moveFiles(toolCtx, getWorkspaceId(workspace.workspace), exAdapter, params)
  //               console.log('done', workspace.workspace)
  //               index += 1
  //             })
  //           }
  //           await rateLimit.waitProcessing()
  //         } catch (err: any) {
  //           console.error(err)
  //         }
  //       })
  //     })
  //   }
  // )

  // program
  // .command('show-lost-files-mongo')
  // .option('-w, --workspace <workspace>', 'Selected workspace only', '')
  // .option('--disabled', 'Include disabled workspaces', false)
  // .option('--all', 'Show all files', false)
  // .action(async (cmd: { workspace: string, disabled: boolean, all: boolean }) => {
  //   await withAccountDatabase(async (db) => {
  //     await withStorage(async (adapter) => {
  //       const mongodbUri = getMongoDBUrl()
  //       const client = getMongoClient(mongodbUri)
  //       const _client = await client.getClient()
  //       try {
  //         let index = 1
  //         const workspaces = await listWorkspacesPure(db)
  //         workspaces.sort((a, b) => b.lastVisit - a.lastVisit)

  //         for (const workspace of workspaces) {
  //           if (!isActiveMode(workspace.mode)) {
  //             console.log('ignore non active workspace', workspace.workspace, workspace.mode)
  //             continue
  //           }
  //           if (workspace.disabled === true && !cmd.disabled) {
  //             console.log('ignore disabled workspace', workspace.workspace)
  //             continue
  //           }

  //           if (cmd.workspace !== '' && workspace.workspace !== cmd.workspace) {
  //             continue
  //           }

  //           try {
  //             console.log('start', workspace.workspace, index, '/', workspaces.length)
  //             const workspaceId = getWorkspaceId(workspace.workspace)
  //             const wsDb = getWorkspaceMongoDB(_client, { name: workspace.workspace })
  //             await showLostFiles(toolCtx, workspaceId, wsDb, adapter, { showAll: cmd.all })
  //             console.log('done', workspace.workspace)
  //           } catch (err) {
  //             console.error(err)
  //           }

  //           index += 1
  //         }
  //       } catch (err: any) {
  //         console.error(err)
  //       } finally {
  //         client.close()
  //       }
  //     })
  //   })
  // })

  // program.command('fix-bw-workspace <workspace>').action(async (workspace: string) => {
  // await withStorage(async (adapter) => {
  //   await fixMinioBW(toolCtx, getWorkspaceId(workspace), adapter)
  // })
  // })

  // program
  // .command('clean-removed-transactions <workspace>')
  // .description('clean removed transactions')
  // .action(async (workspace: string, cmd: any) => {
  //   const wsid = getWorkspaceId(workspace)
  //   const token = generateToken(systemAccountEmail, wsid)
  //   const endpoint = await getTransactorEndpoint(token)
  //   await cleanRemovedTransactions(wsid, endpoint)
  // })

  // program
  // .command('clean-archived-spaces <workspace>')
  // .description('clean archived spaces')
  // .action(async (workspace: string, cmd: any) => {
  //   const wsid = getWorkspaceId(workspace)
  //   const token = generateToken(systemAccountEmail, wsid)
  //   const endpoint = await getTransactorEndpoint(token)
  //   await cleanArchivedSpaces(wsid, endpoint)
  // })

  // program
  // .command('chunter-fix-comments <workspace>')
  // .description('chunter-fix-comments')
  // .action(async (workspace: string, cmd: any) => {
  //   const wsid = getWorkspaceId(workspace)
  //   const token = generateToken(systemAccountEmail, wsid)
  //   const endpoint = await getTransactorEndpoint(token)
  //   await fixCommentDoubleIdCreate(wsid, endpoint)
  // })

  // program
  // .command('mixin-show-foreign-attributes <workspace>')
  // .description('mixin-show-foreign-attributes')
  // .option('--mixin <mixin>', 'Mixin class', '')
  // .option('--property <property>', 'Property name', '')
  // .option('--detail <detail>', 'Show details', false)
  // .action(async (workspace: string, cmd: { detail: boolean, mixin: string, property: string }) => {
  //   const wsid = getWorkspaceId(workspace)
  //   const token = generateToken(systemAccountEmail, wsid)
  //   const endpoint = await getTransactorEndpoint(token)
  //   await showMixinForeignAttributes(wsid, endpoint, cmd)
  // })

  // program
  // .command('mixin-fix-foreign-attributes-mongo <workspace>')
  // .description('mixin-fix-foreign-attributes')
  // .option('--mixin <mixin>', 'Mixin class', '')
  // .option('--property <property>', 'Property name', '')
  // .action(async (workspace: string, cmd: { mixin: string, property: string }) => {
  //   const mongodbUri = getMongoDBUrl()
  //   const wsid = getWorkspaceId(workspace)
  //   const token = generateToken(systemAccountEmail, wsid)
  //   const endpoint = await getTransactorEndpoint(token)
  //   FIXME: add dataId
  //   await fixMixinForeignAttributes(mongodbUri, wsid, endpoint, cmd)
  // })

  program
    .command('configure <workspace>')
    .description('list or toggle plugin configuration of a workspace')
    .option('--enable <enable>', 'Enable plugin configuration', '')
    .option('--disable <disable>', 'Disable plugin configuration', '')
    .option('--list', 'List plugin states', false)
    .action(async (workspace: string, cmd: { enable: string, disable: string, list: boolean }) => {
      await withAccountDatabase(async (db) => {
        console.log(JSON.stringify(cmd))
        const ws = await getWorkspace(db, workspace)
        if (ws === null) {
          throw new Error(`workspace ${workspace} not found`)
        }

        await changeConfiguration(ws.uuid, await getWorkspaceTransactorEndpoint(ws.uuid), cmd)
      })
    })

  // program
  // .command('configure-all')
  // .description('configure all spaces')
  // .option('--enable <enable>', 'Enable plugin configuration', '')
  // .option('--disable <disable>', 'Disable plugin configuration', '')
  // .option('--list', 'List plugin states', false)
  // .action(async (cmd: { enable: string, disable: string, list: boolean }) => {
  //   await withAccountDatabase(async (db) => {
  //     console.log('configure all workspaces')
  //     console.log(JSON.stringify(cmd))
  //     const workspaces = await listWorkspacesRaw(db)
  //     for (const ws of workspaces) {
  //       console.log('configure', ws.workspaceName ?? ws.workspace)
  //       const wsid = getWorkspaceId(ws.workspace)
  //       const token = generateToken(systemAccountEmail, wsid)
  //       const endpoint = await getTransactorEndpoint(token)
  //       await changeConfiguration(wsid, endpoint, cmd)
  //     }
  //   })
  // })

  // program
  // .command('optimize-model <workspace>')
  // .description('optimize model')
  // .action(async (workspace: string, cmd: { enable: string, disable: string, list: boolean }) => {
  //   console.log(JSON.stringify(cmd))
  //   const wsid = getWorkspaceId(workspace)
  //   const token = generateToken(systemAccountEmail, wsid)
  //   const endpoint = await getTransactorEndpoint(token)
  //   await optimizeModel(wsid, endpoint)
  // })

  // program
  // .command('benchmark')
  // .description('benchmark')
  // .option('--from <from>', 'Min client count', '10')
  // .option('--steps <steps>', 'Step with client count', '10')
  // .option('--sleep <sleep>', 'Random Delay max between operations', '0')
  // .option('--binary <binary>', 'Use binary data transfer', false)
  // .option('--compression <compression>', 'Use protocol compression', false)
  // .option('--write <write>', 'Perform write operations', false)
  // .option('--workspaces <workspaces>', 'Workspaces to test on, comma separated', '')
  // .option('--mode <mode>', 'A benchmark mode. Supported values: `find-all`, `connect-only` ', 'find-all')
  // .action(
  //   async (cmd: {
  //     from: string
  //     steps: string
  //     sleep: string
  //     workspaces: string
  //     binary: string
  //     compression: string
  //     write: string
  //     mode: 'find-all' | 'connect-only'
  //   }) => {
  //     await withAccountDatabase(async (db) => {
  //       console.log(JSON.stringify(cmd))
  //       if (!['find-all', 'connect-only'].includes(cmd.mode)) {
  //         console.log('wrong mode')
  //         return
  //       }

  //       const allWorkspacesPure = Array.from(await listWorkspacesPure(db))
  //       const allWorkspaces = new Map(allWorkspacesPure.map((it) => [it.workspace, it]))

  //       let workspaces = cmd.workspaces
  //         .split(',')
  //         .map((it) => it.trim())
  //         .filter((it) => it.length > 0)
  //         .map((it) => getWorkspaceId(it))

  //       if (cmd.workspaces.length === 0) {
  //         workspaces = allWorkspacesPure.map((it) => getWorkspaceId(it.workspace))
  //       }
  //       const accounts = new Map(Array.from(await listAccounts(db)).map((it) => [it._id.toString(), it.email]))

  //       const accountWorkspaces = new Map<string, string[]>()
  //       for (const ws of workspaces) {
  //         const wsInfo = allWorkspaces.get(ws.name)
  //         if (wsInfo !== undefined) {
  //           accountWorkspaces.set(
  //             ws.name,
  //             wsInfo.accounts.map((it) => accounts.get(it.toString()) as string)
  //           )
  //         }
  //       }
  //       await benchmark(workspaces, accountWorkspaces, accountsUrl, {
  //         steps: parseInt(cmd.steps),
  //         from: parseInt(cmd.from),
  //         sleep: parseInt(cmd.sleep),
  //         binary: cmd.binary === 'true',
  //         compression: cmd.compression === 'true',
  //         write: cmd.write === 'true',
  //         mode: cmd.mode
  //       })
  //     })
  //   }
  // )
  // program
  // .command('benchmarkWorker')
  // .description('benchmarkWorker')
  // .action(async (cmd: any) => {
  //   console.log(JSON.stringify(cmd))
  //   benchmarkWorker()
  // })

  // program
  // .command('stress <transactor>')
  // .description('stress benchmark')
  // .option('--mode <mode>', 'A benchmark mode. Supported values: `wrong`, `connect-disconnect` ', 'wrong')
  // .action(async (transactor: string, cmd: { mode: StressBenchmarkMode }) => {
  //   await stressBenchmark(transactor, cmd.mode)
  // })

  // program
  // .command('fix-skills-mongo <workspace> <step>')
  // .description('fix skills for workspace')
  // .action(async (workspace: string, step: string) => {
  //   const mongodbUri = getMongoDBUrl()
  //   const wsid = getWorkspaceId(workspace)
  //   const token = generateToken(systemAccountEmail, wsid)
  //   const endpoint = await getTransactorEndpoint(token)
  //   await fixSkills(mongodbUri, wsid, endpoint, step)
  // })

  // program
  // .command('restore-ats-types-mongo <workspace>')
  // .description('Restore recruiting task types for workspace')
  // .action(async (workspace: string) => {
  //   const mongodbUri = getMongoDBUrl()
  //   console.log('Restoring recruiting task types in workspace ', workspace, '...')
  //   const wsid = getWorkspaceId(workspace)
  //   const endpoint = await getTransactorEndpoint(generateToken(systemAccountEmail, wsid), 'external')
  //   await restoreRecruitingTaskTypes(mongodbUri, wsid, endpoint)
  // })

  // program
  // .command('restore-ats-types-2-mongo <workspace>')
  // .description('Restore recruiting task types for workspace 2')
  // .action(async (workspace: string) => {
  //   const mongodbUri = getMongoDBUrl()
  //   console.log('Restoring recruiting task types in workspace ', workspace, '...')
  //   const wsid = getWorkspaceId(workspace)
  //   const endpoint = await getTransactorEndpoint(generateToken(systemAccountEmail, wsid), 'external')
  //   await restoreHrTaskTypesFromUpdates(mongodbUri, wsid, endpoint)
  // })

  program
    .command('change-field <workspace>')
    .description('change field value for the object')
    .requiredOption('--objectId <objectId>', 'objectId')
    .requiredOption('--objectClass <objectClass>')
    .requiredOption('--attribute <attribute>')
    .requiredOption('--type <type>', 'number | string')
    .requiredOption('--value <value>')
    .action(
      async (
        workspace: string,
        cmd: { objectId: string, objectClass: string, type: string, attribute: string, value: string, domain: string }
      ) => {
        await withAccountDatabase(async (db) => {
          const ws = await getWorkspace(db, workspace)
          if (ws === null) {
            throw new Error(`workspace ${workspace} not found`)
          }
          await updateField(ws.uuid, await getWorkspaceTransactorEndpoint(ws.uuid), cmd)
        })
      }
    )

  program
    .command('fulltext-reindex <workspace>')
    .description('reindex workspace')
    .action(async (workspace: string) => {
      const fulltextUrl = process.env.FULLTEXT_URL
      if (fulltextUrl === undefined) {
        throw new Error('please provide FULLTEXT_URL')
      }

      await withAccountDatabase(async (db) => {
        const ws = await getWorkspace(db, workspace)

        if (ws == null) {
          throw new Error(`workspace ${workspace} not found`)
        }

        console.log('reindex workspace', workspace)
        const queue = getPlatformQueue('tool', ws.region)
        const wsProducer = queue.getProducer<QueueWorkspaceMessage>(toolCtx, QueueTopic.Workspace)
        await wsProducer.send(toolCtx, ws.uuid, [workspaceEvents.fullReindex()])
        await queue.shutdown()
        console.log('done', workspace)
      })
    })

  program
    .command('fulltext-reindex-all')
    .description('reindex workspaces')
    .action(async () => {
      const fulltextUrl = process.env.FULLTEXT_URL
      if (fulltextUrl === undefined) {
        throw new Error('please provide FULLTEXT_URL')
      }

      let workspaces: Workspace[] = []

      await withAccountDatabase(async (db) => {
        const statuses = await db.workspaceStatus.find({ mode: 'active', isDisabled: false })
        const statusByWs = new Map(statuses.map((it) => [it.workspaceUuid, it]))

        workspaces = await db.workspace.find({})
        workspaces = workspaces.filter((p) => statusByWs.has(p.uuid))
        workspaces.sort((a, b) => {
          const sa = statusByWs.get(a.uuid)
          const sb = statusByWs.get(b.uuid)
          return (sb?.lastVisit ?? 0) - (sa?.lastVisit ?? 0)
        })
      })

      console.log('found workspaces', workspaces.length)
      for (const ws of workspaces) {
        console.log('reindex workspace', ws)
        const queue = getPlatformQueue('tool', ws.region)
        const wsProducer = queue.getProducer<QueueWorkspaceMessage>(toolCtx, QueueTopic.Workspace)
        await wsProducer.send(toolCtx, ws.uuid, [workspaceEvents.fullReindex()])
        await queue.shutdown()
      }
      console.log('done')
    })

  // program
  //   .command('remove-duplicates-ids-mongo <workspaces>')
  //   .description('remove duplicates ids for futue migration')
  //   .action(async (workspaces: string) => {
  //     const mongodbUri = getMongoDBUrl()
  //     await withStorage(async (adapter) => {
  //       await removeDuplicateIds(toolCtx, mongodbUri, adapter, accountsUrl, workspaces)
  //     })
  //   })

  // program.command('move-to-pg <region>').action(async (region: string) => {
  //   const { dbUrl } = prepareTools()
  //   const mongodbUri = getMongoDBUrl()

  //   await withAccountDatabase(async (db) => {
  //     const workspaces = await listWorkspacesRaw(db)
  //     workspaces.sort((a, b) => b.lastVisit - a.lastVisit)
  //     await moveFromMongoToPG(
  //       db,
  //       mongodbUri,
  //       dbUrl,
  //       workspaces.filter((p) => p.region !== region),
  //       region
  //     )
  //   })
  // })

  // program
  //   .command('move-workspace-to-pg <workspace> <region>')
  //   .option('-i, --include <include>', 'A list of ; separated domain names to include during backup', '*')
  //   .option('-f|--force [force]', 'Force update', false)
  //   .action(
  //     async (
  //       workspace: string,
  //       region: string,
  //       cmd: {
  //         include: string
  //         force: boolean
  //       }
  //     ) => {
  //       const { dbUrl } = prepareTools()
  //       const mongodbUri = getMongoDBUrl()

  //       await withAccountDatabase(async (db) => {
  //         const ws = await getWorkspace(db, workspace)
  //         if (ws === null) {
  //           throw new Error(`workspace ${workspace} not found`)
  //         }
  //         await updateField(ws.uuid, await getWorkspaceTransactorEndpoint(ws.uuid), cmd)
  //       })
  //     }
  //   )

  // program
  // .command('recreate-elastic-indexes-mongo <workspace>')
  // .description('reindex workspace to elastic')
  // .action(async (workspace: string) => {
  //   const mongodbUri = getMongoDBUrl()
  //   const wsid = getWorkspaceId(workspace)
  //   await recreateElastic(mongodbUri, wsid)
  // })

  // program
  // .command('recreate-all-elastic-indexes-mongo')
  // .description('reindex elastic')
  // .action(async () => {
  //   const { dbUrl } = prepareTools()
  //   const mongodbUri = getMongoDBUrl()

  //   await withAccountDatabase(async (db) => {
  //     const workspaces = await listWorkspacesRaw(db)
  //     workspaces.sort((a, b) => b.lastVisit - a.lastVisit)
  //     for (const workspace of workspaces) {
  //       const wsid = getWorkspaceId(workspace.workspace)
  //       await recreateElastic(mongodbUri ?? dbUrl, wsid)
  //     }
  //   })
  // })

  // program
  // .command('remove-duplicates-ids-mongo <workspaces>')
  // .description('remove duplicates ids for futue migration')
  // .action(async (workspaces: string) => {
  //   const mongodbUri = getMongoDBUrl()
  //   await withStorage(async (adapter) => {
  //     await removeDuplicateIds(toolCtx, mongodbUri, adapter, accountsUrl, workspaces)
  //   })
  // })

  // program.command('move-to-pg <region>').action(async (region: string) => {
  // const { dbUrl } = prepareTools()
  // const mongodbUri = getMongoDBUrl()

  // await withAccountDatabase(async (db) => {
  //   const workspaces = await listWorkspacesRaw(db)
  //   workspaces.sort((a, b) => b.lastVisit - a.lastVisit)
  //   await moveFromMongoToPG(
  //     db,
  //     mongodbUri,
  //     dbUrl,
  //     workspaces.filter((p) => p.region !== region),
  //     region
  //   )
  // })
  // })

  // program
  // .command('move-workspace-to-pg <workspace> <region>')
  // .option('-i, --include <include>', 'A list of ; separated domain names to include during backup', '*')
  // .option('-f|--force [force]', 'Force update', false)
  // .action(
  //   async (
  //     workspace: string,
  //     region: string,
  //     cmd: {
  //       include: string
  //       force: boolean
  //     }
  //   ) => {
  //     const { dbUrl } = prepareTools()
  //     const mongodbUri = getMongoDBUrl()

  //     await withAccountDatabase(async (db) => {
  //       const workspaceInfo = await getWorkspaceById(db, workspace)
  //       if (workspaceInfo === null) {
  //         throw new Error(`workspace ${workspace} not found`)
  //       }
  //       if (workspaceInfo.region === region && !cmd.force) {
  //         throw new Error(`workspace ${workspace} is already migrated`)
  //       }
  //       await moveWorkspaceFromMongoToPG(
  //         db,
  //         mongodbUri,
  //         dbUrl,
  //         workspaceInfo,
  //         region,
  //         cmd.include === '*' ? undefined : new Set(cmd.include.split(';').map((it) => it.trim())),
  //         cmd.force
  //       )
  //     })
  //   }
  // )

  program
    .command('migrate-created-modified-by')
    .option('--include-domains <includeDomains>', 'Domains to migrate(comma-separated)')
    .option('--exclude-domains <excludeDomains>', 'Domains to skip migration for(comma-separated)')
    .option('--lifetime <lifetime>', 'Max lifetime for the connection in seconds')
    .option('--batch <batch>', 'Batch size')
    .option('--force <force>', 'Force update', false)
    .option('--max-reconnects <maxReconnects>', 'Max reconnects', '30')
    .option('--max-retries <maxRetries>', 'Max reconnects', '50')
    .option('--workspaces <workspaces>', 'Workspaces to migrate(comma-separated)')
    .action(
      async (cmd: {
        includeDomains?: string
        excludeDomains?: string
        lifetime?: string
        batch?: string
        workspaces?: string
        force: boolean
        maxReconnects: string
        maxRetries: string
      }) => {
        const { dbUrl } = prepareTools()
        const includeDomains = cmd.includeDomains?.split(',').map((d) => d.trim())
        const excludeDomains = cmd.excludeDomains?.split(',').map((d) => d.trim())
        const maxLifetime = cmd.lifetime != null ? parseInt(cmd.lifetime) : undefined
        const batchSize = cmd.batch != null ? parseInt(cmd.batch) : undefined
        const maxReconnects = parseInt(cmd.maxReconnects)
        const maxRetries = parseInt(cmd.maxRetries)
        const wsUuids = cmd.workspaces?.split(',').map((it) => it.trim()) as WorkspaceUuid[]

        await withAccountDatabase(async (accDb) => {
          const rawWorkspaces =
            wsUuids != null && wsUuids.length > 0
              ? await getWorkspacesInfoWithStatusByIds(accDb, wsUuids)
              : await getWorkspaces(accDb, null, null, null)
          const workspaces = rawWorkspaces
            .filter((it) => !isArchivingMode(it.status.mode) && !isDeletingMode(it.status.mode))
            .sort((a, b) => (b.status.lastVisit ?? 0) - (a.status.lastVisit ?? 0))

          toolCtx.info('Workspaces found', { count: workspaces.length })

          for (const workspace of workspaces) {
            await migrateCreatedModifiedBy(
              toolCtx,
              dbUrl,
              workspace,
              includeDomains,
              excludeDomains,
              maxLifetime,
              batchSize,
              cmd.force,
              maxReconnects,
              maxRetries
            )
          }
        })
      }
    )

  program.command('ensure-global-persons-for-local-accounts').action(async () => {
    const { dbUrl } = prepareTools()

    await withAccountDatabase(async (accDb) => {
      await ensureGlobalPersonsForLocalAccounts(toolCtx, dbUrl, accDb)
    }, dbUrl)
  })

  program.command('migrate-merged-accounts').action(async () => {
    const { dbUrl } = prepareTools()

    await withAccountDatabase(async (accDb) => {
      await migrateMergedAccounts(toolCtx, dbUrl, accDb)
    }, dbUrl)
  })

  program.command('filter-merged-accounts-in-members').action(async () => {
    const { dbUrl } = prepareTools()

    await withAccountDatabase(async (accDb) => {
      await filterMergedAccountsInMembers(toolCtx, dbUrl, accDb)
    }, dbUrl)
  })

  program
    .command('dump-indexes <file>')
    .description('Dump indexes for all model domains to single YAML file (grouped by domain)')
    .action(async (file: string) => {
      const { dbUrl, txes } = prepareTools()
      await dumpIndexes(toolCtx, dbUrl, txes, file)
    })

  program
    .command('sync-indexes <file>')
    .description('Create missing indexes from model + YAML file (dry-run by default)')
    .option('--apply', 'actually create missing indexes (otherwise prints SQL only)', false)
    .action(async (file: string, cmd: { apply: boolean }) => {
      const { dbUrl, txes } = prepareTools()
      await syncIndexes(toolCtx, dbUrl, txes, file, cmd.apply)
    })

  // program
  // .command('perfomance')
  // .option('-p, --parallel', '', false)
  // .action(async (cmd: { parallel: boolean }) => {
  //   const { txes, version, migrateOperations } = prepareTools()
  //   await withAccountDatabase(async (db) => {
  //     const email = generateId()
  //     const ws = generateId()
  //     const wsid = getWorkspaceId(ws)
  //     const start = new Date()
  //     const measureCtx = new MeasureMetricsContext('create-workspace', {})
  //     const wsInfo = await createWorkspaceRecord(measureCtx, db, null, email, ws, ws)

  //     // update the record so it's not taken by one of the workers for the next 60 seconds
  //     await updateWorkspace(db, wsInfo, {
  //       mode: 'creating',
  //       progress: 0,
  //       lastProcessingTime: Date.now() + 1000 * 60
  //     })

  //     await createWorkspace(measureCtx, version, null, wsInfo, txes, migrateOperations, undefined, true)

  //     await updateWorkspace(db, wsInfo, {
  //       mode: 'active',
  //       progress: 100,
  //       disabled: false,
  //       version
  //     })
  //     await createAcc(toolCtx, db, null, email, '1234', '', '', true)
  //     await assignAccountToWs(toolCtx, db, null, email, ws, AccountRole.User)
  //     console.log('Workspace created in', new Date().getTime() - start.getTime(), 'ms')
  //     const token = generateToken(systemAccountEmail, wsid)
  //     const endpoint = await getTransactorEndpoint(token, 'external')
  //     await generateWorkspaceData(endpoint, ws, cmd.parallel, email)
  //     await testFindAll(endpoint, ws, email)
  //     await dropWorkspace(toolCtx, db, null, ws)
  //   })
  // })

  // program
  // .command('reset-ws-attempts <name>')
  // .description('Reset workspace creation/upgrade attempts counter')
  // .action(async (workspace) => {
  //   await withAccountDatabase(async (db) => {
  //     const info = await getWorkspaceById(db, workspace)
  //     if (info === null) {
  //       throw new Error(`workspace ${workspace} not found`)
  //     }

  //     await updateWorkspace(db, info, {
  //       attempts: 0
  //     })

  //     console.log('Attempts counter for workspace', workspace, 'has been reset')
  //   })
  // })

  // program
  //   .command('add-controlled-doc-rank-mongo')
  //   .description('add rank to controlled documents')
  //   .option('-w, --workspace <workspace>', 'Selected workspace only', '')
  //   .action(async (cmd: { workspace: string }) => {
  //     const { version } = prepareTools()

  //     let workspaces: Workspace[] = []
  //     await withAccountDatabase(async (db) => {
  //       workspaces = await listWorkspacesPure(db)
  //       workspaces = workspaces
  //         .filter((p) => isActiveMode(p.mode))
  //         .filter((p) => cmd.workspace === '' || p.workspace === cmd.workspace)
  //         .sort((a, b) => b.lastVisit - a.lastVisit)
  //     })

  //     console.log('found workspaces', workspaces.length)

  //     const mongodbUri = getMongoDBUrl()
  //     const client = getMongoClient(mongodbUri)
  //     const _client = await client.getClient()

  //     try {
  //       const count = workspaces.length
  //       let index = 0
  //       for (const workspace of workspaces) {
  //         index++

  //         toolCtx.info('processing workspace', {
  //           workspace: workspace.workspace,
  //           version: workspace.version,
  //           index,
  //           count
  //         })

  //         if (workspace.version === undefined || !deepEqual(workspace.version, version)) {
  //           console.log(`upgrade to ${versionToString(version)} is required`)
  //           continue
  //         }
  //         const workspaceId = getWorkspaceId(workspace.workspace)
  //         const wsDb = getWorkspaceMongoDB(_client, { name: workspace.workspace })

  //         await addControlledDocumentRank(toolCtx, wsDb, workspaceId)
  //       }
  //     } finally {
  //       client.close()
  //     }
  //   })

  // Not needed anymore?
  // program
  //   .command('fill-github-users')
  //   .option('-t, --token <token>', 'Github token to increase the limit of requests to GitHub')
  //   .description('adds github username info to all accounts')
  //   .action(async (cmd: { token?: string }) => {
  //     await withAccountDatabase(async (db) => {
  //       await fillGithubUsers(toolCtx, db, cmd.token)
  //     })
  //   })

  program
    .command('queue-init-topics')
    .description('create required kafka topics')
    .option('--tx <tx>', 'Number of TX partitions', '5')
    .action(async (cmd: { tx: string }) => {
      const queue = getPlatformQueue('tool')
      await queue.createTopics(parseInt(cmd.tx ?? '1'))
    })

  program
    .command('restore-markup-refs')
    .option('--region <region>', 'DB region')
    .action(async (cmd: { region?: string }) => {
      const { dbUrl, txes } = prepareTools()
      const region = cmd.region ?? null

      await withStorage(async (adapter) => {
        await restoreMarkupRefs(dbUrl, txes, adapter, region)
      })
    })

  program
    .command('restore-github-integrations')
    .option('-d, --dryrun', 'Dry run', false)
    .action(async (cmd: { dryrun: boolean }) => {
      const { dbUrl } = prepareTools()

      await restoreGithubIntegrations(dbUrl, cmd.dryrun)
    })

  program
    .command('restore-from-v6-all <dirName>')
    .description('Restore from full v6 dump')
    .action(async (dirName) => {
      const { txes, dbUrl } = prepareTools()

      await withAccountDatabase(async (pgDb) => {
        await restoreFromv6All(toolCtx, pgDb, dirName, txes, dbUrl)
      }, dbUrl)
    })

  program
    .command('restore-v6-from-storage <workspace> <accsRoot>')
    .description('Restore a workspace from v6 backup storage with accounts info')
    .option('-r, --region <region>', 'Region to restore workspace to')
    .option('-b, --branding <branding>', 'Branding to restore workspace with', 'huly')
    .option('-s, --suffix <suffix>', 'Url suffix if conflicting', 'bold')
    .option('-f, --force', 'Force restore if the same uuid', false)
    .action(async (workspace, accsRoot, cmd: { suffix: string, region: string, branding: string, force: boolean }) => {
      const bucketName = process.env.BUCKET_NAME
      if (bucketName === '' || bucketName == null) {
        throw new Error('please provide BUCKET_NAME')
      }

      const backupStorageConfig = storageConfigFromEnv(process.env.BACKUP_STORAGE)
      const backupStorageAdapter = createStorageFromConfig(backupStorageConfig.storages[0])
      const backupIds = { uuid: bucketName as WorkspaceUuid, dataId: bucketName as WorkspaceDataId, url: '' }
      const backupAccsStorage = await createStorageBackupStorage(toolCtx, backupStorageAdapter, backupIds, accsRoot)
      const v6AccountsFile = 'account.accounts.json'
      const v6WorkspacesFile = 'account.workspaces.json'
      const v6InvitesFile = 'account.invites.json'

      if (!(await backupAccsStorage.exists(v6AccountsFile))) {
        toolCtx.error('file not present', { file: v6AccountsFile })
        throw new Error(`${v6AccountsFile} should be present to restore`)
      }
      if (!(await backupAccsStorage.exists(v6WorkspacesFile))) {
        toolCtx.error('file not present', { file: v6WorkspacesFile })
        throw new Error(`${v6WorkspacesFile} should be present to restore`)
      }
      if (!(await backupAccsStorage.exists(v6InvitesFile))) {
        toolCtx.error('file not present', { file: v6InvitesFile })
        throw new Error(`${v6InvitesFile} should be present to restore`)
      }

      const v6Workspaces = JSON.parse((await backupAccsStorage.loadFile(v6WorkspacesFile)).toString()) as OldWorkspace[]
      const v6Workspace = v6Workspaces.find((it) => it.workspace === workspace)

      if (v6Workspace == null) {
        toolCtx.error('workspace not found in the accounts backup', { workspace })
        throw new Error(`workspace ${workspace} not found in the accounts backup`)
      }

      const uniqueWorkspaceAccounts = new Set((v6Workspace.accounts ?? []).map((it) => it.toString()))
      const v6AccountsRaw = JSON.parse((await backupAccsStorage.loadFile(v6AccountsFile)).toString()) as any[]
      const v6WorkspaceAccountsRaw = v6AccountsRaw.filter((acc) => uniqueWorkspaceAccounts.has(acc._id.toString()))

      const v6WorkspaceAccounts: OldAccount[] = []
      for (const rawAccount of v6WorkspaceAccountsRaw) {
        const hashTypedArray = rawAccount.hash != null ? new Uint8Array(rawAccount.hash.data) : null
        const saltTypedArray = new Uint8Array(rawAccount.salt.data)

        v6WorkspaceAccounts.push({
          ...rawAccount,
          hash: hashTypedArray != null ? Buffer.from(hashTypedArray.buffer) : null,
          salt: Buffer.from(saltTypedArray.buffer)
        })
      }

      let v6Invites = JSON.parse((await backupAccsStorage.loadFile(v6InvitesFile)).toString()) as any[]
      v6Invites = v6Invites.filter((invite: any) => invite.workspace.name === v6Workspace.workspace)

      const { txes, dbUrl } = prepareTools()
      const backupWsStorage = await createStorageBackupStorage(
        toolCtx,
        backupStorageAdapter,
        backupIds,
        v6Workspace.uuid ?? v6Workspace.workspace
      )

      const storageConfig = storageConfigFromEnv()
      const workspaceStorage: StorageAdapter = buildStorageFromConfig(storageConfig)
      const { suffix, region, branding, force } = cmd

      await withAccountDatabase(async (pgDb) => {
        await restoreTrustedV6Workspace(
          toolCtx,
          pgDb,
          v6Workspace,
          v6WorkspaceAccounts,
          v6Invites,
          backupWsStorage,
          workspaceStorage,
          txes,
          dbUrl,
          { conflictSuffix: suffix, region, branding, force }
        )
      }, dbUrl)
    })

  program
    .command('calculate-ratings <workspace>')
    .description('Perform a rating re-calculation')
    .option('-q <queue>', 'Send to queue', false)
    .option('-r, --region <region>', 'Region')
    .action(async (workspace: string, cmd: { queue: boolean | undefined, region: string | undefined }) => {
      await withAccountDatabase(async (db) => {
        const { txes, dbUrl } = prepareTools()
        const ws = await getWorkspace(db, workspace)
        if (ws === null) {
          throw new Error(`workspace ${workspace} not found`)
        }

        if (cmd.queue === true) {
          const queue = getPlatformQueue('tool', cmd.region ?? '')
          const ratingQueue = queue.getProducer<QueueRatingMessage>(toolCtx, 'rating')

          await ratingQueue.send(toolCtx, ws.uuid, [ratingEvents.reindex()])

          await queue.shutdown()
        } else {
          const wsIds = {
            uuid: ws.uuid,
            dataId: ws.dataId,
            url: ws.url
          }
          const calculator = await RatingCalculator.create(
            toolCtx,
            txes,
            undefined,
            undefined,
            wsIds,
            dbUrl,
            async () => ''
          )

          await calculator.recalculateAll(toolCtx)

          await calculator.close()
        }
      })
    })

  extendProgram?.(program)

  return program
}
