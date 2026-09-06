// Shared fixtures shaped like real platform payloads.
const doc = (i) => ({
  _id: `doc-${i}`,
  _class: 'tracker:class:Issue',
  space: 'tracker:project:DefaultProject',
  modifiedOn: 1757000000000 + i,
  modifiedBy: 'account-1',
  createdOn: 1756000000000 + i,
  createdBy: 'account-1',
  title: `Issue number ${i} with a reasonably long title`,
  number: i,
  priority: i % 4,
  assignee: i % 3 === 0 ? null : `person-${i % 17}`,
  labels: [`label-${i % 5}`, `label-${i % 7}`],
  estimation: i * 1.5,
  reportedTime: 0,
  status: `tracker:status:${['Backlog', 'Todo', 'InProgress', 'Done'][i % 4]}`
})

const markup = {
  type: 'doc',
  content: Array.from({ length: 40 }, (_, i) => ({
    type: 'paragraph',
    attrs: { textAlign: null },
    content: [{ type: 'text', marks: i % 3 === 0 ? [{ type: 'bold' }] : [], text: `line ${i} of markup content` }]
  }))
}

const query = { space: 'tracker:project:X', status: { $in: ['a', 'b', 'c'] }, modifiedOn: { $gt: 1 }, assignee: null }
const options = { sort: { modifiedOn: -1 }, limit: 200, lookup: { assignee: 'contact:class:Person' }, total: true }
const docs = Array.from({ length: 200 }, (_, i) => doc(i))
const clone = (x) => JSON.parse(JSON.stringify(x))

module.exports = { doc, markup, query, options, docs, clone }
