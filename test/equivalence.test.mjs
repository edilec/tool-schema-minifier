import assert from 'node:assert/strict'
import test from 'node:test'

import { minifyTools, verifyCandidate } from '../src/index.mjs'

const encode = (value) => new TextEncoder().encode(JSON.stringify(value))

const ORIGINAL = {
  schemaVersion: '1',
  tools: [
    {
      name: 'publish',
      title: 'Publish',
      description: 'Publish a draft to the public site.',
      inputSchema: {
        type: 'object',
        title: 'Publish input',
        properties: {
          draftId: { type: 'string', description: 'Which   draft.', pattern: '^d_[0-9]+$' },
          channel: { type: 'string', description: 'Where   to   publish.', enum: ['web', 'email', 'feed'] },
          notify: { type: 'boolean', description: 'Tell   subscribers.', default: true },
          confirm: {
            type: 'boolean',
            description: 'Set only after a person has approved this publication.',
          },
        },
        required: ['draftId', 'channel', 'confirm'],
        additionalProperties: false,
        'x-vendor': { queue: 'publish' },
      },
    },
  ],
}

/** A copy that changes exactly one thing, built from the real minified copy. */
function candidateWith(mutate) {
  const { document } = minifyTools({ bytes: encode(ORIGINAL), source: 'tools.json', dropAnnotations: true })
  const copy = JSON.parse(JSON.stringify(document))
  mutate(copy.tools[0])
  return copy
}

function verify(candidate) {
  return verifyCandidate({
    bytes: encode(ORIGINAL),
    candidateBytes: encode(candidate),
    source: 'tools.json',
  }).report
}

function ruleIds(report) {
  return report.findings.map((finding) => finding.ruleId)
}

test('the copy this tool produces passes its own gate', () => {
  const { document } = minifyTools({ bytes: encode(ORIGINAL), source: 'tools.json', dropAnnotations: true })
  const report = verify(document)
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.toolsCompressed, 1)
})

/**
 * Each row is a difference a compressed copy is not allowed to have, the rule
 * that must name it, and the pointer it must be reported at. Driving them
 * through `verifyCandidate` -- the real entry point -- rather than asserting on
 * a table means a rule that stops being applied fails here, not just a rule
 * that is spelled differently.
 */
const DIFFERENCES = [
  ['a dropped requirement', (tool) => { tool.inputSchema.required = ['draftId', 'channel'] }, 'required-changed', '/tools/0/inputSchema/required'],
  ['a reordered requirement is allowed', (tool) => { tool.inputSchema.required = ['confirm', 'channel', 'draftId'] }, null, null],
  ['a removed enum value', (tool) => { tool.inputSchema.properties.channel.enum = ['web', 'email'] }, 'enum-changed', '/tools/0/inputSchema/properties/channel/enum'],
  ['a reordered enum', (tool) => { tool.inputSchema.properties.channel.enum = ['feed', 'web', 'email'] }, 'enum-changed', '/tools/0/inputSchema/properties/channel/enum'],
  ['a changed type', (tool) => { tool.inputSchema.properties.notify.type = 'string' }, 'type-changed', '/tools/0/inputSchema/properties/notify/type'],
  ['a loosened pattern', (tool) => { tool.inputSchema.properties.draftId.pattern = '.*' }, 'constraint-changed', '/tools/0/inputSchema/properties/draftId/pattern'],
  ['a dropped constraint', (tool) => { delete tool.inputSchema.additionalProperties }, 'constraint-changed', '/tools/0/inputSchema/additionalProperties'],
  ['a removed parameter', (tool) => { delete tool.inputSchema.properties.notify }, 'property-removed', '/tools/0/inputSchema/properties/notify'],
  ['an added parameter', (tool) => { tool.inputSchema.properties.extra = { type: 'string' } }, 'property-added', '/tools/0/inputSchema/properties/extra'],
  ['a rewritten approval description', (tool) => { tool.inputSchema.properties.confirm.description = 'Set to true.' }, 'safety-description-changed', '/tools/0/inputSchema/properties/confirm/description'],
  ['a removed approval description', (tool) => { delete tool.inputSchema.properties.confirm.description }, 'safety-description-removed', '/tools/0/inputSchema/properties/confirm/description'],
  ['an emptied ordinary description', (tool) => { tool.inputSchema.properties.notify.description = '   ' }, 'description-removed', '/tools/0/inputSchema/properties/notify/description'],
  ['a removed ordinary description', (tool) => { delete tool.inputSchema.properties.notify.description }, 'description-removed', '/tools/0/inputSchema/properties/notify/description'],
  ['a dropped unrecognised keyword', (tool) => { delete tool.inputSchema['x-vendor'] }, 'unknown-keyword-removed', '/tools/0/inputSchema/x-vendor'],
  ['a changed unrecognised keyword', (tool) => { tool.inputSchema['x-vendor'] = { queue: 'other' } }, 'unknown-keyword-changed', '/tools/0/inputSchema/x-vendor'],
  ['an added keyword', (tool) => { tool.inputSchema.minProperties = 1 }, 'keyword-added', '/tools/0/inputSchema/minProperties'],
  ['a schema replaced by a boolean', (tool) => { tool.inputSchema.properties.notify = true }, 'structure-changed', '/tools/0/inputSchema/properties/notify'],
  ['a changed tool name is a different tool', (tool) => { tool.name = 'publish_v2' }, 'tool-missing-from-candidate', '/tools/0'],
]

for (const [name, mutate, expectedRule, expectedPointer] of DIFFERENCES) {
  test(`verify reports ${name}`, () => {
    const report = verify(candidateWith(mutate))
    if (expectedRule === null) {
      assert.equal(report.status, 'pass', JSON.stringify(ruleIds(report)))
      return
    }
    assert.equal(report.status, 'fail', JSON.stringify(ruleIds(report)))
    const match = report.findings.find((finding) => finding.ruleId === expectedRule)
    assert.ok(match !== undefined, `expected ${expectedRule}, got ${JSON.stringify(ruleIds(report))}`)
    assert.equal(match.location.pointer, expectedPointer)
    assert.equal(match.severity, 'error')
  })
}

test('an annotation may be dropped and an ordinary description rewritten', () => {
  const report = verify(candidateWith((tool) => {
    tool.inputSchema.properties.notify.description = 'Tell people.'
  }))
  assert.equal(report.status, 'pass', JSON.stringify(ruleIds(report)))
})

test('a tool the original does not declare is refused', () => {
  const candidate = candidateWith(() => {})
  candidate.tools.push({ name: 'sneak', description: 'An extra tool.', inputSchema: { type: 'object', properties: {} } })
  const report = verify(candidate)
  assert.equal(report.status, 'fail')
  assert.ok(ruleIds(report).includes('tool-added-in-candidate'))
})

test('every rejected tool is also named by equivalence-not-proven', () => {
  const report = verify(candidateWith((tool) => { tool.inputSchema.required = [] }))
  const gate = report.findings.find((finding) => finding.ruleId === 'equivalence-not-proven')
  assert.ok(gate !== undefined)
  assert.equal(gate.location.pointer, '/tools/0')
  assert.equal(report.summary.toolsCompressed, 0)
})
