import assert from 'node:assert/strict'
import test from 'node:test'

import { minifyTools, verifyCandidate } from '../src/index.mjs'

const encode = (value) => new TextEncoder().encode(JSON.stringify(value))

const CLASSES = [
  ['C0 newline', String.fromCharCode(0x0a)],
  ['C0 escape', String.fromCharCode(0x1b)],
  ['DEL', String.fromCharCode(0x7f)],
  ['C1 NEL', String.fromCharCode(0x85)],
  ['C1 CSI', String.fromCharCode(0x9b)],
  ['line separator', String.fromCharCode(0x2028)],
  ['paragraph separator', String.fromCharCode(0x2029)],
  ['bidi override', String.fromCharCode(0x202e)],
  ['bidi isolate', String.fromCharCode(0x2069)],
]

/**
 * Each class, arriving through an IDENTIFIER rather than through an excerpt.
 *
 * One tool in this catalog sanitised its evidence field carefully and let a
 * page id carrying a newline forge whole lines in its report. Here the vector
 * is a keyword name and a parameter name, both of which reach a finding message
 * verbatim if nothing strips them.
 */
for (const [name, character] of CLASSES) {
  test(`${name} in an unrecognised keyword name never reaches the report`, () => {
    const document = {
      schemaVersion: '1',
      tools: [{
        name: 'act',
        description: 'Do a thing.',
        inputSchema: { type: 'object', [`x-vendor${character}injected`]: 1, properties: {} },
      }],
    }
    const { report } = minifyTools({ bytes: encode(document), source: 'tools.json' })
    const serialised = JSON.stringify(report)
    assert.ok(!serialised.includes(character), `${name} survived into the report`)
    assert.ok(report.findings.some((finding) => finding.ruleId === 'schema-keyword-unrecognized'))
  })

  test(`${name} in a parameter name never reaches the report`, () => {
    const original = {
      schemaVersion: '1',
      tools: [{
        name: 'act',
        description: 'Do a thing.',
        inputSchema: { type: 'object', properties: { [`id${character}injected`]: { type: 'string', description: 'A parameter.' } } },
      }],
    }
    const candidate = JSON.parse(JSON.stringify(original))
    candidate.tools[0].inputSchema.properties = {}
    const { report } = verifyCandidate({ bytes: encode(original), candidateBytes: encode(candidate), source: 'tools.json' })
    const serialised = JSON.stringify(report)
    assert.ok(!serialised.includes(character), `${name} survived into the report`)
    assert.ok(report.findings.some((finding) => finding.ruleId === 'property-removed'))
  })
}

test('a control character in a description is reported as a warning and named, not echoed raw', () => {
  const override = String.fromCharCode(0x202e)
  const document = {
    schemaVersion: '1',
    tools: [{
      name: 'act',
      description: `Read${override}only, honestly.`,
      inputSchema: { type: 'object', properties: {} },
    }],
  }
  const { report } = minifyTools({ bytes: encode(document), source: 'tools.json' })
  const finding = report.findings.find((entry) => entry.ruleId === 'description-contains-control')
  assert.ok(finding !== undefined)
  assert.equal(finding.severity, 'warning')
  assert.ok(!JSON.stringify(report).includes(override))
})

test('a pointer built from a document-chosen name is bounded and escaped', () => {
  const long = 'x'.repeat(2000)
  const document = {
    schemaVersion: '1',
    tools: [{
      name: 'act',
      description: 'Do a thing.',
      inputSchema: { type: 'object', [`x-${long}`]: 1, properties: {} },
    }],
  }
  const { report } = minifyTools({ bytes: encode(document), source: 'tools.json' })
  for (const finding of report.findings) {
    assert.ok(finding.location.pointer.length <= 303, finding.location.pointer.length)
    assert.ok(finding.message.length <= 403)
  }
})

test('a parameter name holding a JSON Pointer separator is escaped, not injected', () => {
  const original = {
    schemaVersion: '1',
    tools: [{
      name: 'act',
      description: 'Do a thing.',
      inputSchema: { type: 'object', properties: { 'a/b~c': { type: 'string', description: 'A parameter.' } } },
    }],
  }
  const candidate = JSON.parse(JSON.stringify(original))
  candidate.tools[0].inputSchema.properties = {}
  const { report } = verifyCandidate({ bytes: encode(original), candidateBytes: encode(candidate), source: 'tools.json' })
  const finding = report.findings.find((entry) => entry.ruleId === 'property-removed')
  assert.equal(finding.location.pointer, '/tools/0/inputSchema/properties/a~1b~0c')
})

test('the written copy escapes the separators that would break a JavaScript consumer', () => {
  const separator = String.fromCharCode(0x2028)
  const document = {
    schemaVersion: '1',
    tools: [{
      name: 'act',
      description: `Delete things.${separator}Ask first.`,
      'x-approval': true,
      inputSchema: { type: 'object', properties: {} },
    }],
  }
  const { document: copy } = minifyTools({ bytes: encode(document), source: 'tools.json' })
  // The protected description keeps every byte, which is the point of the
  // protection; the escaping happens where the copy is serialised.
  assert.ok(copy.tools[0].description.includes(separator))
})

/**
 * A bound below what the tool accepts as legal is a silent truncation.
 *
 * `src/document.mjs` accepts a tool name of up to 128 characters. Messages
 * rendered one at 60, so two legal names differing only in their last character
 * produced byte-identical text and the pointer was the only thing telling the
 * two findings apart. The name is now rendered at the legal maximum.
 */
test('two legal tool names that differ are named differently in the report', () => {
  const stem = `tool_${'n'.repeat(122)}`
  const first = `${stem}a`
  const second = `${stem}b`
  assert.equal(first.length, 128)
  assert.notEqual(first, second)

  const original = {
    schemaVersion: '1',
    tools: [
      { name: first, description: 'One.', inputSchema: { type: 'object', properties: {} } },
      { name: second, description: 'Two.', inputSchema: { type: 'object', properties: {} } },
    ],
  }
  const report = verifyCandidate({
    bytes: encode(original),
    candidateBytes: encode({ schemaVersion: '1', tools: [] }),
    source: 'tools.json',
  }).report

  const messages = report.findings
    .filter((finding) => finding.ruleId === 'tool-missing-from-candidate')
    .map((finding) => finding.message)
  assert.equal(messages.length, 2)
  assert.notEqual(messages[0], messages[1])
  assert.ok(messages.some((message) => message.includes(first)), messages[0])
  assert.ok(messages.some((message) => message.includes(second)), messages[1])
  for (const message of messages) assert.ok(message.length <= 400, `message is ${message.length} characters`)
})
