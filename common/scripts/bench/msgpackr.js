const { doc, docs, markup } = require('./_data')

module.exports = (m) => {
  const { pack, unpack } = m
  const docA = doc(1)
  const packedDoc = pack(docA)
  const packedDocs = pack(docs)
  return [
    { name: 'pack single doc', run: () => pack(docA) },
    { name: 'unpack single doc', run: () => unpack(packedDoc) },
    { name: 'pack 200 docs', run: () => pack(docs) },
    { name: 'unpack 200 docs', run: () => unpack(packedDocs) },
    { name: 'pack markup tree', run: () => pack(markup) }
  ]
}
