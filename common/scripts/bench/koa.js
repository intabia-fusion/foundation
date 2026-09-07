const { docs } = require('./_data')

module.exports = async (m) => {
  const Koa = m.default ?? m
  const app = new Koa()
  app.use(async (ctx, next) => {
    ctx.set('x-bench', '1')
    await next()
  })
  app.use(async (ctx) => {
    if (ctx.path === '/docs') {
      ctx.body = docs
    } else if (ctx.path === '/ping') {
      ctx.body = { ok: true }
    } else {
      ctx.status = 404
      ctx.body = { error: 'not found' }
    }
  })

  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const hit = async (path) => {
    const res = await fetch(base + path)
    await res.arrayBuffer()
  }

  return {
    cases: [
      { name: 'GET /ping', run: () => hit('/ping'), async: true, concurrency: 1 },
      { name: 'GET /ping x32 in flight', run: () => hit('/ping'), async: true, concurrency: 32 },
      { name: 'GET 200 docs json', run: () => hit('/docs'), async: true, concurrency: 1 },
      { name: 'GET 404', run: () => hit('/nope'), async: true, concurrency: 1 }
    ],
    teardown: async () => {
      await new Promise((resolve) => server.close(resolve))
    }
  }
}
