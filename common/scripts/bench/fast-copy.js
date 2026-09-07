const { doc, markup, options, docs } = require('./_data')

const docA = doc(1)

module.exports = (m) => {
  const copy = m.copy ?? m.default ?? m
  return [
    { name: 'single doc', run: () => copy(docA) },
    { name: '200 docs', run: () => copy(docs) },
    { name: 'markup tree', run: () => copy(markup) },
    { name: 'view options', run: () => copy(options) }
  ]
}
