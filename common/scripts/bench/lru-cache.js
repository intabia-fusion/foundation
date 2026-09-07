const { doc } = require('./_data')

module.exports = (m) => {
  const LRU = m.LRUCache ?? m.default ?? m
  const cache = new LRU({ max: 1000 })
  for (let i = 0; i < 1000; i++) cache.set(`doc-${i}`, doc(i))
  let n = 0
  return [
    { name: 'get (hit)', run: () => cache.get(`doc-${n++ % 1000}`) },
    { name: 'get (miss)', run: () => cache.get('nope') },
    { name: 'set (evicting)', run: () => cache.set(`new-${n++}`, doc(n)) },
    { name: 'has', run: () => cache.has(`doc-${n++ % 1000}`) }
  ]
}
