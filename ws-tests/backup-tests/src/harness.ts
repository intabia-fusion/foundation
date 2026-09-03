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

/**
 * Server-side backup harness. Mirrors what dev/tool does to obtain a backup
 * pipeline, so tests can call backup()/restore() directly against a live stand.
 */

import { getAccountDB, type AccountDB } from '@hcengineering/account'
import { MeasureMetricsContext, type MeasureContext, type WorkspaceIds } from '@hcengineering/core'
import { setMetadata } from '@hcengineering/platform'
import serverClientPlugin from '@hcengineering/server-client'
import { type Pipeline, type StorageAdapter } from '@hcengineering/server-core'
import {
  createPostgreeDestroyAdapter,
  createPostgresAdapter,
  createPostgresTxAdapter,
  shutdownPostgres
} from '@hcengineering/postgres'
import {
  createBackupPipeline,
  createEmptyBroadcastOps,
  registerAdapterFactory,
  registerDestroyFactory,
  registerServerPlugins,
  registerStringLoaders,
  registerTxAdapterFactory
} from '@hcengineering/server-pipeline'
import { buildStorageFromConfig, storageConfigFromEnv } from '@hcengineering/server-storage'
import serverToken from '@hcengineering/server-token'
import { prepareTools } from '@hcengineering/server-tool'
import builder from '@hcengineering/model-all'

let registered = false

/** Adapter/plugin registration is process-global, do it once. */
export function registerBackupTools (): void {
  if (registered) return
  registered = true

  registerTxAdapterFactory('postgresql', createPostgresTxAdapter, true)
  registerAdapterFactory('postgresql', createPostgresAdapter, true)
  registerDestroyFactory('postgresql', createPostgreeDestroyAdapter, true)

  registerServerPlugins()
  registerStringLoaders()

  setMetadata(serverClientPlugin.metadata.Endpoint, env('ACCOUNTS_URL', DEFAULTS.ACCOUNTS_URL))
  setMetadata(serverToken.metadata.Secret, env('SERVER_SECRET', DEFAULTS.SERVER_SECRET))
  setMetadata(serverToken.metadata.Service, 'backup-tests')
}

export async function shutdown (): Promise<void> {
  await shutdownPostgres()
}

/**
 * Host-side defaults for the ws-tests stand. Regions and services share one postgres, each in its own
 * database (ws-tests/postgres-init): workspace data is in region_main, account in postgres.
 */
const DEFAULTS = {
  DB_URL: 'postgresql://postgres:postgres@localhost:5433/region_main',
  ACCOUNT_DB_URL: 'postgresql://postgres:postgres@localhost:5433/postgres',
  ACCOUNTS_URL: 'http://localhost:8083/_account',
  STORAGE_CONFIG: 'datalake|http://localhost:8083/_datalake',
  SERVER_SECRET: 'secret',
  FRONT_URL: 'http://localhost:8083'
}

export function env (name: keyof typeof DEFAULTS | string, def?: string): string {
  const v = process.env[name] ?? def ?? (DEFAULTS as Record<string, string>)[name]
  if (v === undefined) {
    throw new Error(`${name} is required to run backup tests`)
  }
  return v
}

export function createCtx (name = 'backup-tests'): MeasureContext {
  return new MeasureMetricsContext(name, {})
}

export async function withAccountDb<T> (f: (db: AccountDB) => Promise<T>): Promise<T> {
  const [db, close] = await getAccountDB(env('ACCOUNT_DB_URL'), process.env.ACCOUNT_DB_NS)
  try {
    return await f(db)
  } finally {
    close()
  }
}

export interface BackupPipelineHandle {
  pipeline: Pipeline
  storageAdapter: StorageAdapter
  close: () => Promise<void>
}

/** Build a backup pipeline for a workspace, same way dev/tool backup does. */
export async function createPipeline (ctx: MeasureContext, wsIds: WorkspaceIds): Promise<BackupPipelineHandle> {
  registerBackupTools()

  // prepareTools/storageConfigFromEnv read process.env directly and exit on miss.
  process.env.DB_URL = env('DB_URL')
  process.env.STORAGE_CONFIG = env('STORAGE_CONFIG')

  const { txes, dbUrl } = prepareTools(builder().getTxes())
  const storageAdapter = buildStorageFromConfig(storageConfigFromEnv())

  const pipeline = await createBackupPipeline(ctx, dbUrl, txes, {
    externalStorage: storageAdapter,
    usePassedCtx: true
  })(ctx, { uuid: wsIds.uuid, url: wsIds.url ?? '', dataId: wsIds.dataId }, createEmptyBroadcastOps(), null)

  if (pipeline === undefined) {
    throw new Error('failed to create backup pipeline')
  }

  return {
    pipeline,
    storageAdapter,
    close: async () => {
      await pipeline.close()
      await storageAdapter.close()
    }
  }
}
