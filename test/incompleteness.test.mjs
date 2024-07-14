import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  INCOMPLETE_RULES,
  RULE_SEVERITY,
  minifyToolFile,
  minifyTools,
  verifyCandidate,
  verifyToolFiles,
} from '../src/index.mjs'

const encode = (value) => new TextEncoder().encode(JSON.stringify(value))
const bytesOf = (text) => new TextEncoder().encode(text)

const GOOD = {
  schemaVersion: '1',
  tools: [{ name: 'ok', description: 'A   fine   tool.', inputSchema: { type: 'object', properties: {} } }],
}

const BIG = {
  schemaVersion: '1',
  tools: [{ name: 'ok', description: `A fine tool. ${'word '.repeat(200)}`, inputSchema: { type: 'object', properties: {} } }],
}

function nested(depth) {
  let node = { type: 'string' }
  for (let step = 0; step < depth; step += 1) node = { type: 'object', properties: { next: node } }
  return { schemaVersion: '1', tools: [{ name: 'deep', description: 'Deep.', inputSchema: node }] }
}

function wide(count) {
  const properties = {}
  for (let index = 0; index < count; index += 1) properties[`p${index}`] = { type: 'string' }
  return { schemaVersion: '1', tools: [{ name: 'wide', description: 'Wide.', inputSchema: { type: 'object', properties } }] }
}

const minify = (document, options = {}) => minifyTools({ bytes: encode(document), source: 'tools.json', ...options }).report
const verify = (original, candidate, options = {}) => verifyCandidate({
  bytes: encode(original), candidateBytes: encode(candidate), source: 'tools.json', ...options,
}).report

/**
 * Every rule that makes a run incomplete, driven through a real entry point.
 *
 * The point is not that the list is spelled correctly. It is that each id is
 * reachable and that reaching it produces `status: "incomplete"` -- which for
 * `no-tools-declared`, the one warning here, is the ONLY thing standing between
 * an empty document and exit 0. Delete that id from INCOMPLETE_RULES and the
 * `no-tools-declared` case below turns red.
 */
const CASES = new Map([
  ['tools-too-large', () => minify(GOOD, { limits: { maxBytes: 10 } })],
  ['tools-not-utf8', () => minifyTools({ bytes: new Uint8Array([0x7b, 0xff, 0x7d]), source: 'tools.json' }).report],
  ['tools-not-json', () => minifyTools({ bytes: bytesOf('{"tools": ['), source: 'tools.json' }).report],
  ['tools-too-deep', () => minify(nested(40))],
  ['tools-too-many-nodes', () => minify(wide(200), { limits: { maxNodes: 20 } })],
  ['tools-malformed', () => minifyTools({ bytes: bytesOf('[]'), source: 'tools.json' }).report],
  ['unknown-document-key', () => minify({ schemaVersion: '1', tools: [], extra: 1 })],
  ['schema-version-unsupported', () => minify({ schemaVersion: '2', tools: [] })],
  ['too-many-tools', () => minify({
    schemaVersion: '1',
    tools: [GOOD.tools[0], { ...GOOD.tools[0], name: 'ok2' }],
  }, { limits: { maxTools: 1 } })],
  ['tool-malformed', () => minify({ schemaVersion: '1', tools: ['not an object'] })],
  ['tool-name-invalid', () => minify({ schemaVersion: '1', tools: [{ description: 'No name.', inputSchema: {} }] })],
  ['tool-name-duplicated', () => minify({ schemaVersion: '1', tools: [GOOD.tools[0], GOOD.tools[0]] })],
  ['tool-schema-missing', () => minify({ schemaVersion: '1', tools: [{ name: 'bare', description: 'No schema.' }] })],
  ['description-malformed', () => minify({
    schemaVersion: '1',
    tools: [{ name: 'odd', description: 42, inputSchema: { type: 'object', properties: {} } }],
  })],
  ['no-tools-declared', () => minify({ schemaVersion: '1', tools: [] })],
  ['time-budget-exceeded', () => {
    let reading = 0
    return minify(GOOD, { limits: { maxMillis: 5 }, clock: () => { reading += 10; return reading } })
  }],
  // The original has to fit and the candidate has to not: one shared limit, two
  // documents, and the rule has to name the one that was actually refused.
  ['candidate-too-large', () => verify(GOOD, BIG, { limits: { maxBytes: JSON.stringify(GOOD).length + 8 } })],
  ['candidate-not-utf8', () => verifyCandidate({
    bytes: encode(GOOD), candidateBytes: new Uint8Array([0x7b, 0xff, 0x7d]), source: 'tools.json',
  }).report],
  ['candidate-not-json', () => verifyCandidate({
    bytes: encode(GOOD), candidateBytes: bytesOf('{'), source: 'tools.json',
  }).report],
  ['candidate-too-deep', () => verify(GOOD, nested(40))],
  ['candidate-too-many-nodes', () => verify(GOOD, wide(200), { limits: { maxNodes: 20 } })],
  ['candidate-malformed', () => verifyCandidate({
    bytes: encode(GOOD), candidateBytes: bytesOf('[]'), source: 'tools.json',
  }).report],
  ['tools-unreadable', async () => (await minifyToolFile(join(tmpdir(), 'tool-schema-minifier-absent', 'nothing.json'))).report],
  ['candidate-unreadable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tool-schema-minifier-'))
    try {
      const original = join(directory, 'tools.json')
      await writeFile(original, JSON.stringify(GOOD), 'utf8')
      return (await verifyToolFiles(original, join(directory, 'absent.json'))).report
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }],
])

for (const [ruleId, produce] of CASES) {
  test(`${ruleId} makes the run incomplete`, async () => {
    const report = await produce()
    assert.equal(report.status, 'incomplete', JSON.stringify(report.findings.map((f) => f.ruleId)))
    assert.ok(
      report.findings.some((finding) => finding.ruleId === ruleId),
      `expected ${ruleId}, got ${JSON.stringify(report.findings.map((f) => f.ruleId))}`,
    )
  })
}

test('every rule declared incomplete has a case above, and no other rule is listed', () => {
  // A rule added to INCOMPLETE_RULES without a case here, or a case for a rule
  // that is not in the list, both fail. The list is not allowed to grow by
  // accident.
  assert.deepEqual([...CASES.keys()].sort(), [...INCOMPLETE_RULES].sort())
})

test('the warning-severity incomplete rule is the one the list is holding up', () => {
  // `no-tools-declared` is only a warning, so nothing else would stop an empty
  // document reporting a pass. This is the invariant the contract calls "true
  // only by accident" when it is left untested.
  assert.equal(RULE_SEVERITY['no-tools-declared'], 'warning')
  const report = minify({ schemaVersion: '1', tools: [] })
  assert.equal(report.summary.errors, 0)
  assert.equal(report.status, 'incomplete')
})

test('a run stopped by the budget does not report the tools it never checked', () => {
  const document = {
    schemaVersion: '1',
    tools: [
      { name: 'first', description: 'One.', inputSchema: { type: 'object', properties: {} } },
      { name: 'second', description: 'Two.', inputSchema: { type: 'object', properties: {} } },
    ],
  }
  let reading = 0
  const result = minifyTools({
    bytes: encode(document),
    source: 'tools.json',
    limits: { maxMillis: 5 },
    clock: () => { reading += 10; return reading },
  })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.report.summary.checked, 0)
  assert.equal(result.report.summary.toolsCompressed, 0)
  // The copy still holds both tools, unchanged: a tool the budget stopped is
  // copied, never dropped and never reported as compressed.
  assert.equal(result.document.tools.length, 2)
  assert.deepEqual(result.document.tools, document.tools)
})
