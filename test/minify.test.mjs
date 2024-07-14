import assert from 'node:assert/strict'
import test from 'node:test'

import { minifyTools } from '../src/index.mjs'

const encode = (value) => new TextEncoder().encode(JSON.stringify(value))
const run = (document, options = {}) => minifyTools({ bytes: encode(document), source: 'tools.json', ...options })

const SPACED = 'Search   the\n\n   library   for   documents.'

function documentWith(tool) {
  return { schemaVersion: '1', tools: [tool] }
}

const SEARCH = {
  name: 'search',
  title: 'Search',
  description: SPACED,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The   search   text.', minLength: 1 },
      scope: { type: 'string', description: 'Where to look.', enum: ['team', 'personal', 'archive'] },
      mode: { type: 'string', description: 'How to match.', const: 'fuzzy' },
    },
    required: ['query', 'scope'],
    additionalProperties: false,
  },
}

test('a required list survives compression exactly', () => {
  const { report, document } = run(documentWith(SEARCH))
  assert.equal(report.status, 'pass')
  assert.deepEqual(document.tools[0].inputSchema.required, ['query', 'scope'])
})

test('an enum survives compression exactly, values and order', () => {
  const { document } = run(documentWith(SEARCH))
  assert.deepEqual(document.tools[0].inputSchema.properties.scope.enum, ['team', 'personal', 'archive'])
})

test('a const and every other constraint survive compression exactly', () => {
  const { document } = run(documentWith(SEARCH))
  const properties = document.tools[0].inputSchema.properties
  assert.equal(properties.mode.const, 'fuzzy')
  assert.equal(properties.query.minLength, 1)
  assert.equal(document.tools[0].inputSchema.additionalProperties, false)
})

test('an unprotected description is collapsed, and the copy is smaller', () => {
  const { report, document } = run(documentWith(SEARCH))
  assert.equal(document.tools[0].description, 'Search the library for documents.')
  assert.ok(report.summary.tokensAfter < report.summary.tokensBefore)
  assert.equal(report.summary.tokensSaved, report.summary.tokensBefore - report.summary.tokensAfter)
})

/**
 * The acceptance criterion this tool exists for.
 *
 * A description that governs an approval is copied byte for byte -- including
 * the whitespace, which is what makes the assertion a real one rather than a
 * comparison of two collapsed strings.
 */
const APPROVAL_TEXT = 'Permanently  delete the record.\n\nThis is irreversible; ask the person to confirm first.'

test('a description marked x-approval is copied byte for byte', () => {
  const { report, document } = run(documentWith({
    name: 'remove',
    description: APPROVAL_TEXT,
    'x-approval': true,
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Which   record.' } } },
  }))
  assert.equal(document.tools[0].description, APPROVAL_TEXT)
  assert.equal(report.status, 'pass')
})

test('a description under an x-approval node is copied byte for byte too', () => {
  // The protection is a scope, not a single field: once a node is marked, every
  // description inside it is protected, including ones whose own words say
  // nothing alarming.
  const inner = 'Which   record   to   act   on.'
  const { document } = run(documentWith({
    name: 'remove',
    description: 'Act on a record.',
    'x-approval': true,
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: inner } } },
  }))
  assert.equal(document.tools[0].inputSchema.properties.id.description, inner)
})

test('a description is protected by its own words with no flag at all', () => {
  const text = 'Transfer   the   funds.  This cannot be undone.'
  const { document } = run(documentWith({
    name: 'pay',
    description: text,
    inputSchema: { type: 'object', properties: {} },
  }))
  assert.equal(document.tools[0].description, text)
})

test('--protect-tool protects every description in a named tool', () => {
  const text = 'Look   something   up.'
  const plain = { name: 'lookup', description: text, inputSchema: { type: 'object', properties: {} } }
  assert.equal(run(documentWith(plain)).document.tools[0].description, 'Look something up.')
  const protectedRun = run(documentWith(plain), { protectTools: ['lookup'] })
  assert.equal(protectedRun.document.tools[0].description, text)
})

/**
 * Position, not name.
 *
 * `title`, `examples`, `example` and `$comment` are annotations in a schema
 * position. Inside `properties` the same words are parameter names, and a
 * minifier that deletes keys by name deletes the parameters. The required list
 * names one of them, so a name-based minifier also produces a schema that
 * requires a parameter it does not declare.
 */
test('parameters named after annotation keywords are not deleted as annotations', () => {
  const tool = {
    name: 'awkward',
    description: 'A   tool   with   awkward   parameter   names.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'A parameter called title.' },
        examples: { type: 'array', description: 'A parameter called examples.', items: { type: 'string' } },
        example: { type: 'string', description: 'A parameter called example.' },
        $comment: { type: 'string', description: 'A parameter called $comment.' },
      },
      required: ['title', '$comment'],
    },
  }
  const { report, document } = run(documentWith(tool), { dropAnnotations: true })
  assert.equal(report.status, 'pass')
  const properties = document.tools[0].inputSchema.properties
  assert.deepEqual(Object.keys(properties), ['title', 'examples', 'example', '$comment'])
  assert.deepEqual(document.tools[0].inputSchema.required, ['title', '$comment'])
})

test('annotations in a schema position are dropped only when asked', () => {
  const tool = {
    name: 'annotated',
    description: 'Something   with   annotations.',
    inputSchema: {
      type: 'object',
      title: 'Input',
      $comment: 'internal note',
      properties: { id: { type: 'string', title: 'Identifier', examples: ['abc'], description: 'The   id.' } },
    },
  }
  const kept = run(documentWith(tool)).document.tools[0].inputSchema
  assert.equal(kept.title, 'Input')
  assert.deepEqual(kept.properties.id.examples, ['abc'])

  const dropped = run(documentWith(tool), { dropAnnotations: true }).document.tools[0].inputSchema
  assert.ok(!Object.hasOwn(dropped, 'title'))
  assert.ok(!Object.hasOwn(dropped, '$comment'))
  assert.ok(!Object.hasOwn(dropped.properties.id, 'examples'))
  assert.equal(dropped.properties.id.type, 'string')
})

test('an unrecognised keyword and everything under it are copied unchanged', () => {
  const routing = { queue: 'exports', description: 'This   description   is   inside   an   unknown   keyword.' }
  const { report, document } = run(documentWith({
    name: 'export',
    description: 'Export   something.',
    inputSchema: { type: 'object', 'x-routing': routing, properties: {} },
  }), { dropAnnotations: true })
  assert.deepEqual(document.tools[0].inputSchema['x-routing'], routing)
  assert.equal(report.summary.unknownKeywords, 1)
  assert.ok(report.findings.some((finding) => finding.ruleId === 'schema-keyword-unrecognized'))
})

test('a description is shortened to the budget but never removed', () => {
  const long = `${'word '.repeat(200)}end`
  const { document } = run(documentWith({
    name: 'verbose',
    description: long,
    inputSchema: { type: 'object', properties: {} },
  }), { limits: { maxDescriptionChars: 40 } })
  const written = document.tools[0].description
  assert.equal(written.length, 40)
  assert.ok(written.startsWith('word word'))
  assert.notEqual(written.trim(), '')
})

test('a protected description is never shortened, whatever the budget', () => {
  const long = `Deleting this is irreversible. ${'word '.repeat(200)}end`
  const { document } = run(documentWith({
    name: 'verbose',
    description: long,
    inputSchema: { type: 'object', properties: {} },
  }), { limits: { maxDescriptionChars: 40 } })
  assert.equal(document.tools[0].description, long)
})

test('compressing twice changes nothing the second time', () => {
  const first = run(documentWith(SEARCH), { dropAnnotations: true })
  const second = minifyTools({ bytes: encode(first.document), source: 'tools.json', dropAnnotations: true })
  assert.equal(second.report.status, 'pass')
  assert.deepEqual(second.document, first.document)
  assert.equal(second.report.summary.toolsCompressed, 0)
  assert.ok(second.report.findings.some((finding) => finding.ruleId === 'nothing-compressed'))
})

test('a document key naming an object prototype does not become a prototype', () => {
  // JSON.parse hands `__proto__` back as an ordinary own property; plain
  // assignment would run the setter instead of storing a key.
  const bytes = new TextEncoder().encode(
    '{"schemaVersion":"1","tools":[{"name":"p","description":"A   tool.","inputSchema":{"type":"object","properties":{"__proto__":{"type":"string","description":"An   awkward   parameter."}}}}]}',
  )
  const { document } = minifyTools({ bytes, source: 'tools.json' })
  const properties = document.tools[0].inputSchema.properties
  assert.ok(Object.hasOwn(properties, '__proto__'))
  assert.equal(Object.getPrototypeOf(properties), Object.prototype)
  assert.equal({}.type, undefined)
})
