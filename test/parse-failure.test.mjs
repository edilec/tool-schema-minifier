import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFailureDetail } from '../src/index.mjs'

const CANARY = 'AKIAIOSFODNN7EXAMPLE'

function detailFor(document) {
  try {
    JSON.parse(document)
  } catch (error) {
    return parseFailureDetail(error)
  }
  throw new Error('the document was expected to be unparseable')
}

/**
 * The case that found the bug in nineteen of thirty-eight tools.
 *
 * A document whose own text reads `at position 1` makes V8 emit
 * `Unexpected token 'a', "at position 1" is not valid JSON`. A helper that
 * looks for the offset before recognising the quoting shape matches that phrase
 * INSIDE the quoted span and returns the document back out.
 */
test('a document that reads "at position 1" is not sliced back out', () => {
  const detail = detailFor('at position 1')
  assert.ok(!detail.includes('at position 1'), detail)
  assert.ok(!detail.includes('"'), detail)
})

test('the quoting shape is recognised before the offset, not after it', () => {
  // Not only "nothing leaked": WHICH branch answered. The backstop catches an
  // offset-first helper too, but it answers the generic sentence and the
  // diagnostic is gone. Pinning the exact sentence is what makes the ordering
  // itself observable, so swapping the two branches turns this red rather than
  // silently degrading every message about a document containing that phrase.
  assert.equal(detailFor('at position 1'), "unexpected token 'a' at the start of the document")
})

test('the backstop catches a wording whose branches would have leaked', () => {
  // A shape neither branch recognises as quoting, but where the offset branch
  // keeps a prefix that still carries the quoted span. Only the closing double
  // quote check stops this one, which is why it is not redundant.
  const invented = { message: `Bad value "${CANARY}" in JSON at position 12` }
  const detail = parseFailureDetail(invented)
  assert.ok(!detail.includes(CANARY), detail)
  assert.equal(detail, 'the document could not be parsed as JSON')
})

test('a document that is only a credential is never reproduced', () => {
  const detail = detailFor(CANARY)
  assert.ok(!detail.includes(CANARY), detail)
  assert.ok(!detail.includes('AKIA'), detail)
})

test('a long document with a sensitive prefix is never reproduced', () => {
  const detail = detailFor(`${CANARY} ${'filler '.repeat(400)}`)
  assert.ok(!detail.includes(CANARY), detail)
  assert.ok(!detail.includes('"'), detail)
})

test('a quoted span containing a newline is still recognised', () => {
  // Without the `s` flag the quoting pattern does not match across the newline.
  // The backstop still stops the leak, so "nothing leaked" does not pin the
  // flag -- what pins it is the sentence the quoting branch produces, which a
  // non-dotAll pattern cannot reach.
  const detail = detailFor(`${CANARY}\n${CANARY}`)
  assert.ok(!detail.includes(CANARY), detail)
  assert.ok(!detail.includes('"'), detail)
  assert.equal(detailFor('a\nb'), "unexpected token 'a' at the start of the document")
})

test('the genuinely safe form still reports position, line and column', () => {
  // A helper that answered the generic sentence for everything would pass every
  // leak test above while destroying the diagnostic. V8 gives an offset with no
  // quoted span here, and the offset says nothing about the content.
  const detail = detailFor('{"alpha":1,"beta" 2}')
  assert.match(detail, /at position \d+/)
  assert.match(detail, /line \d+ column \d+/)
  assert.ok(!detail.includes('alpha'), detail)
})

test('an empty document keeps its own wording', () => {
  assert.equal(detailFor(''), 'Unexpected end of JSON input')
})

test('a wording this helper has never seen still cannot carry a snippet', () => {
  // The backstop, exercised directly: whatever the branches concluded, a
  // surviving double quote means a surviving snippet.
  const invented = { message: `Some future V8 sentence about "${CANARY}" that nothing here parses` }
  const detail = parseFailureDetail(invented)
  assert.ok(!detail.includes(CANARY), detail)
  assert.equal(detail, 'the document could not be parsed as JSON')
})

test('a document whose text reads "at position 1" inside a longer document is safe too', () => {
  const detail = detailFor('{"note": "at position 1", }')
  assert.ok(!detail.includes('note'), detail)
  assert.ok(!detail.includes('"'), detail)
})
