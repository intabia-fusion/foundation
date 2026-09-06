const { docs } = require('./_data')

const once = (emitter, event) => new Promise((resolve) => emitter.once(event, resolve))

module.exports = async (m) => {
  const { WebSocketServer, WebSocket } = m
  const server = new WebSocketServer({ port: 0, perMessageDeflate: false })
  server.on('connection', (ws) => ws.on('message', (data) => ws.send(data)))
  await once(server, 'listening')
  const url = `ws://127.0.0.1:${server.address().port}`

  const client = new WebSocket(url)
  client.setMaxListeners(0)
  await once(client, 'open')

  const small = 'x'.repeat(64)
  const large = JSON.stringify(docs) // ~60KB, shape of a real find() response
  const binary = Buffer.from(large)

  const echo = (payload) =>
    new Promise((resolve) => {
      client.once('message', resolve)
      client.send(payload)
    })

  const connectClose = () =>
    new Promise((resolve) => {
      const c = new WebSocket(url)
      c.on('open', () => c.close())
      c.on('close', resolve)
    })

  return {
    cases: [
      { name: 'echo 64B text', run: () => echo(small), async: true, concurrency: 1 },
      { name: 'echo 64B x32 in flight', run: () => echo(small), async: true, concurrency: 32 },
      { name: 'echo 60KB json', run: () => echo(large), async: true, concurrency: 1 },
      { name: 'echo 60KB binary', run: () => echo(binary), async: true, concurrency: 1 },
      { name: 'connect + close', run: connectClose, async: true, concurrency: 1 }
    ],
    teardown: async () => {
      client.close()
      server.close()
    }
  }
}
