import assert from 'node:assert/strict'
import test from 'node:test'

import { byCodeUnit, decodeUtf8, escapeJsSeparators, sanitize } from '../src/text.mjs'

test('byCodeUnit orders by code unit, which collation does not', () => {
  // A collator folds case and ignores punctuation, so it answers the opposite
  // way for both of these pairs. Code units give exactly one answer on every
  // host: Z(0x5A) < a(0x61), and -(0x2D) < _(0x5F).
  assert.ok(byCodeUnit('Z', 'a') < 0)
  assert.ok(byCodeUnit('a-b', 'a_b') < 0)
  assert.equal(byCodeUnit('same', 'same'), 0)
})

test('decoding is strict: invalid UTF-8 is refused rather than replaced', () => {
  // 0xFF is not a legal UTF-8 byte anywhere. A lenient decoder turns it into
  // U+FFFD, which is indistinguishable from a document that contains U+FFFD on
  // purpose -- the confusion that let an unreadable input report a pass.
  assert.equal(decodeUtf8(new Uint8Array([0x7b, 0xff, 0x7d])).ok, false)
  const honest = new TextEncoder().encode(`{"a":"${String.fromCharCode(0xfffd)}"}`)
  const decoded = decodeUtf8(honest)
  assert.equal(decoded.ok, true)
  assert.ok(decoded.text.includes(String.fromCharCode(0xfffd)))
})

/**
 * Every class named in the contract, tested separately.
 *
 * Four tools in this catalog stripped C0 and the line separators and let the C1
 * range through, so each row here is a class that was actually missed
 * somewhere, not a theoretical one.
 */
const CLASSES = [
  ['C0 newline', String.fromCharCode(0x0a)],
  ['C0 escape', String.fromCharCode(0x1b)],
  ['DEL', String.fromCharCode(0x7f)],
  ['C1 NEL', String.fromCharCode(0x85)],
  ['C1 CSI', String.fromCharCode(0x9b)],
  ['line separator', String.fromCharCode(0x2028)],
  ['paragraph separator', String.fromCharCode(0x2029)],
  ['bidi LRM', String.fromCharCode(0x200e)],
  ['bidi RLO', String.fromCharCode(0x202e)],
  ['bidi isolate', String.fromCharCode(0x2066)],
]

for (const [name, character] of CLASSES) {
  test(`sanitize removes ${name}`, () => {
    const cleaned = sanitize(`before${character}after`)
    assert.equal(cleaned, 'before after')
    assert.ok(!cleaned.includes(character))
  })
}

test('sanitize bounds the length and marks that it did', () => {
  const long = 'x'.repeat(500)
  assert.equal(sanitize(long, 10), `${'x'.repeat(10)}...`)
  assert.equal(sanitize('short', 10), 'short')
})

test('sanitize refuses a limit that is not a positive integer', () => {
  assert.throws(() => sanitize('a', 0), TypeError)
  assert.throws(() => sanitize('a', 1.5), TypeError)
})

test('the written artifact escapes the two separators JSON leaves raw', () => {
  // JSON.stringify emits U+2028 and U+2029 unescaped: they are ordinary
  // characters to JSON and line terminators to ECMAScript, so a description
  // carrying one breaks any JavaScript module that embeds the copy.
  const separator = String.fromCharCode(0x2028)
  const raw = JSON.stringify({ description: `a${separator}b` })
  assert.ok(raw.includes(separator), 'JSON.stringify is expected to leave it raw')
  const escaped = escapeJsSeparators(raw)
  assert.ok(!escaped.includes(separator))
  assert.equal(JSON.parse(escaped).description, `a${separator}b`)
})
