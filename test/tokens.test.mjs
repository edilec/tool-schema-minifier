import assert from 'node:assert/strict'
import test from 'node:test'

import { estimateTokens, minifyTools } from '../src/index.mjs'
import { measure, savingPerMille } from '../src/tokens.mjs'

test('the estimate is a pure function of the text', () => {
  const text = 'Delete the record permanently. 12345 {"a": 1}'
  assert.equal(estimateTokens(text), estimateTokens(text))
  assert.equal(estimateTokens(''), 0)
  assert.ok(estimateTokens('a') >= 1)
})

test('shortening text never raises the estimate', () => {
  // The property the compressor depends on: every ratio is monotone in the
  // length of the run it measures, so collapsing whitespace or cutting a
  // description cannot cost more than it saves.
  const base = 'The quick brown fox jumps over the lazy dog, repeatedly and at length.'
  for (let cut = base.length; cut > 0; cut -= 1) {
    assert.ok(estimateTokens(base.slice(0, cut)) <= estimateTokens(base.slice(0, cut + 1) || base))
  }
  assert.ok(estimateTokens('a     b') > estimateTokens('a b'))
})

test('the estimate separates letters, digits and punctuation', () => {
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcde'), 2)
  assert.equal(estimateTokens('123'), 1)
  assert.equal(estimateTokens('1234'), 2)
  assert.equal(estimateTokens('{}'), 2)
  assert.equal(estimateTokens('a b'), 2)
})

test('measure reports exact bytes and characters alongside the estimate', () => {
  const { bytes, characters, tokens } = measure({ a: 'hello' })
  assert.equal(characters, JSON.stringify({ a: 'hello' }).length)
  assert.equal(bytes, Buffer.byteLength(JSON.stringify({ a: 'hello' }), 'utf8'))
  assert.ok(tokens > 0)
})

test('a multi-byte character costs more bytes than characters', () => {
  const { bytes, characters } = measure({ a: String.fromCodePoint(0x1f600) })
  assert.ok(bytes > characters)
})

test('savingPerMille is an integer and never divides by zero', () => {
  assert.equal(savingPerMille(100, 75), 250)
  assert.equal(savingPerMille(0, 0), 0)
  assert.equal(savingPerMille(3, 3), 0)
  assert.ok(Number.isInteger(savingPerMille(7, 3)))
})

test('the reported difference is the difference the report itself states', () => {
  const document = {
    schemaVersion: '1',
    tools: [{
      name: 'act',
      description: 'Do   a   thing   with   generous   spacing.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Which   record.' } } },
    }],
  }
  const { report } = minifyTools({ bytes: new TextEncoder().encode(JSON.stringify(document)), source: 'tools.json' })
  assert.equal(report.summary.tokensSaved, report.summary.tokensBefore - report.summary.tokensAfter)
  assert.ok(report.summary.tokensSaved > 0)
  assert.ok(report.summary.bytesAfter < report.summary.bytesBefore)
  assert.equal(report.summary.tokenSavingPerMille, savingPerMille(report.summary.tokensBefore, report.summary.tokensAfter))
})
