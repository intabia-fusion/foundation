const { doc, docs } = require('./_data')

// Client and server share this process, so ~24 ops/ms is the undici ceiling, not the router's:
// concurrency 32 and 128 give the same number. Treat differences under ~10% as noise.
module.exports = async (m) => {
  const express = m.default ?? m
  const app = express()
  app.use(express.json({ limit: '5mb' }))
  app.get('/ping', (req, res) => {
    res.json({ ok: true })
  })
  app.get('/docs/:id/attachments/:attachment', (req, res) => {
    res.json({ id: req.params.id, attachment: req.params.attachment, q: req.query.limit })
  })
  app.get('/docs', (req, res) => {
    res.json(docs)
  })
  app.post('/echo', (req, res) => {
    res.json({ received: req.body._id })
  })

  // routing cost only shows up with a realistic table size
  for (let i = 0; i < 40; i++) {
    app.get(`/api/v1/resource${i}/:id`, (req, res) => {
      res.json({ i, id: req.params.id })
    })
  }

  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const body = JSON.stringify(doc(1))
  const headers = { 'content-type': 'application/json' }
  const hit = async (path, init) => {
    const res = await fetch(base + path, init)
    await res.arrayBuffer()
  }

  return {
    cases: [
      { name: 'GET /ping', run: () => hit('/ping'), async: true, concurrency: 1 },
      { name: 'GET /ping x32 in flight', run: () => hit('/ping'), async: true, concurrency: 32 },
      { name: 'GET params + query', run: () => hit('/docs/doc-1/attachments/a-2?limit=10'), async: true, concurrency: 1 },
      { name: 'GET 200 docs json', run: () => hit('/docs'), async: true, concurrency: 1 },
      { name: 'POST json body', run: () => hit('/echo', { method: 'POST', headers, body }), async: true, concurrency: 1 },
      { name: 'GET 404', run: () => hit('/nope'), async: true, concurrency: 1 },
      { name: 'GET 41st route', run: () => hit('/api/v1/resource39/x'), async: true, concurrency: 1 },
      { name: 'GET 41st route x32', run: () => hit('/api/v1/resource39/x'), async: true, concurrency: 32 },
      { name: 'GET /ping x128 in flight', run: () => hit('/ping'), async: true, concurrency: 128 }
    ],
    teardown: async () => {
      await new Promise((resolve) => server.close(resolve))
    }
  }
}
