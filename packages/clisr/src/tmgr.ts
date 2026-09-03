// A task manager client and server using Clisr for communication.
//

import { type MeasureContext } from '@hcengineering/measurements'
import { ClisrServer } from './server'
import { ClisrClient } from './client'
import express, { type Express } from 'express'
import { type ClientConnectEvent } from './types'

/**
 * An easy server -> client task scheduler using Clisr for communication.
 */
export async function createCallbackServer (
  ctx: MeasureContext,
  port: number,
  token: string,
  app: Express = express()
): Promise<ClisrServer> {
  const srv = new ClisrServer(
    ctx,
    async (_token) => {
      return token === _token
    },
    '1.0.0',
    app
  )

  await srv.start(ctx, port)
  return srv
}

export async function createCallbackClient (
  ctx: MeasureContext,
  url: string,
  token: string,
  executor: {
    callback?: (ctx: MeasureContext, task: string, args: any[]) => Promise<any>
    binaryExecutor?: (
      ctx: MeasureContext,
      method: string,
      data: Uint8Array,
      headers?: Record<string, any>
    ) => Promise<Uint8Array | any>
    clientHost?: string
    onConnect?: (event: ClientConnectEvent, data: any) => Promise<void>
    formats?: string[]
  }
): Promise<ClisrClient> {
  const client = new ClisrClient(
    ctx,
    url,
    (data) => {},
    () => token,
    { clientHost: executor.clientHost, onConnect: executor.onConnect, formats: executor.formats }
  )
  client.callbackHandler = executor.callback
  client.binaryHandler = executor.binaryExecutor
  return client
}
