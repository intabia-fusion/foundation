const { doc, markup, query, options, docs, clone } = require('./_data')

const docsB = clone(docs)
const docsFirstDiffers = clone(docs)
docsFirstDiffers[0].title = 'changed'
const docA = doc(1)
const docB = doc(1)

module.exports = (m) => [
  { name: 'field value: string', run: () => m.deepEqual('tracker:status:InProgress', 'tracker:status:InProgress') },
  { name: 'field value: array[2]', run: () => m.deepEqual(['label-1', 'label-2'], ['label-1', 'label-2']) },
  { name: 'query object', run: () => m.deepEqual(query, clone(query)) },
  { name: 'find options', run: () => m.deepEqual(options, options) },
  { name: 'single doc (15 fields)', run: () => m.deepEqual(docA, docB) },
  { name: '200 docs, equal', run: () => m.deepEqual(docs, docsB) },
  { name: '200 docs, first differs', run: () => m.deepEqual(docs, docsFirstDiffers) },
  { name: 'markup tree (40 nodes)', run: () => m.deepEqual(markup, markup) }
]
