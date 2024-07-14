import assert from 'node:assert/strict'
import test from 'node:test'

import { RULE_SEVERITY, compareFindingRows, minifyTools, verifyCandidate } from '../src/index.mjs'

const encode = (value) => new TextEncoder().encode(JSON.stringify(value))

/**
 * Ordering, pinned by what the tool emits rather than by how it is spelled.
 *
 * Grepping the source for `.localeCompare(` is not a determinism test: an
 * `Intl.Collator` drops the forbidden literal and collates exactly as badly, so
 * the grep stays green while the report starts depending on the ICU data of
 * whichever host produced it. Pinning `byCodeUnit` on its own is no better --
 * that pins the helper, and every call site can still be swapped one at a time.
 *
 * So the names below are chosen so that the two orders genuinely disagree, and
 * they are pushed through the real report path:
 *
 * - a collator folds case, so it puts `assets` and `a` before `README` and `Z`;
 * - a collator treats `-` and `_` as ignorable punctuation, so it orders
 *   `a`, `a-b`, `a_b`, `assets` together;
 * - code units give exactly one answer -- R(0x52) < Z(0x5A) < a(0x61), and
 *   within the pointer the separator `/`(0x2F) falls between `-`(0x2D) and
 *   `_`(0x5F), so `a-b` sorts before `a` and `a` before `a_b`.
 *
 * `test/determinism.test.mjs` then shows the same order surviving a second run.
 */
const NAMES = ['README', 'Z', 'a', 'a-b', 'a_b', 'assets']
// Declared in reverse, so document order cannot be mistaken for the sort.
const DECLARED = [...NAMES].reverse()

const CODE_UNIT_POINTER_ORDER = [
  '/tools/0/inputSchema/properties/README/x-vendor',
  '/tools/0/inputSchema/properties/Z/x-vendor',
  '/tools/0/inputSchema/properties/a-b/x-vendor',
  '/tools/0/inputSchema/properties/a/x-vendor',
  '/tools/0/inputSchema/properties/a_b/x-vendor',
  '/tools/0/inputSchema/properties/assets/x-vendor',
]

function documentWithProperties() {
  const properties = {}
  for (const name of DECLARED) {
    properties[name] = { type: 'string', description: 'A parameter.', 'x-vendor': { note: name } }
  }
  return {
    schemaVersion: '1',
    tools: [{ name: 'act', description: 'Do a thing.', inputSchema: { type: 'object', properties } }],
  }
}

test('findings are ordered by pointer in code-unit order, not collated order', () => {
  const { report } = minifyTools({ bytes: encode(documentWithProperties()), source: 'tools.json' })
  const pointers = report.findings
    .filter((finding) => finding.ruleId === 'schema-keyword-unrecognized')
    .map((finding) => finding.location.pointer)
  assert.deepEqual(pointers, CODE_UNIT_POINTER_ORDER)

  // The same list under a collator, to show the two answers really differ. If
  // this ever stops differing the test above has stopped discriminating.
  const collated = [...pointers].sort(new Intl.Collator('en').compare)
  assert.notDeepEqual(collated, pointers)
})

test('the same order holds on the verification path', () => {
  const original = documentWithProperties()
  const candidate = JSON.parse(JSON.stringify(original))
  for (const name of DECLARED) delete candidate.tools[0].inputSchema.properties[name]['x-vendor']
  const { report } = verifyCandidate({
    bytes: encode(original), candidateBytes: encode(candidate), source: 'tools.json',
  })
  const pointers = report.findings
    .filter((finding) => finding.ruleId === 'unknown-keyword-removed')
    .map((finding) => finding.location.pointer)
  assert.deepEqual(pointers, CODE_UNIT_POINTER_ORDER)
})

test('removed parameters are ordered by code unit too', () => {
  const original = documentWithProperties()
  const candidate = JSON.parse(JSON.stringify(original))
  candidate.tools[0].inputSchema.properties = {}
  const { report } = verifyCandidate({
    bytes: encode(original), candidateBytes: encode(candidate), source: 'tools.json',
  })
  const names = report.findings
    .filter((finding) => finding.ruleId === 'property-removed')
    .map((finding) => finding.location.pointer.split('/').pop())
  assert.deepEqual(names, ['README', 'Z', 'a', 'a-b', 'a_b', 'assets'])
  assert.notDeepEqual([...names].sort(new Intl.Collator('en').compare), names)
})

/**
 * The two tiebreaks that no document can make observable.
 *
 * `ruleId` is a closed set over `[a-z-]`, and every ordered pair of it collates
 * exactly as its code units do -- enumerated here rather than assumed, so a
 * rule id added in a spelling where the two disagree fails this test instead of
 * silently making the order machine-dependent.
 *
 * `message` can only break a tie between two findings sharing a pointer AND a
 * rule, which no input reaches today. It is pinned directly on the comparator,
 * which is a unit test and is labelled as one rather than dressed up as a
 * behavioural one.
 */
test('every ordered pair of rule ids collates the way its code units do', () => {
  const ids = Object.keys(RULE_SEVERITY)
  const collator = new Intl.Collator('en')
  for (const left of ids) {
    for (const right of ids) {
      const byUnit = left === right ? 0 : left < right ? -1 : 1
      assert.equal(Math.sign(collator.compare(left, right)), byUnit, `${left} vs ${right}`)
    }
  }
})

test('the message tiebreak orders by code unit (comparator unit test)', () => {
  const rows = [
    { pointer: '/a', ruleId: 'enum-changed', message: 'a_b', order: 0 },
    { pointer: '/a', ruleId: 'enum-changed', message: 'a-b', order: 1 },
  ]
  assert.ok(compareFindingRows(rows[1], rows[0]) < 0)
  assert.ok(compareFindingRows(rows[0], rows[1]) > 0)
})

test('declaration order is the final tiebreak', () => {
  const first = { pointer: '/a', ruleId: 'enum-changed', message: 'same', order: 0 }
  const second = { pointer: '/a', ruleId: 'enum-changed', message: 'same', order: 1 }
  assert.ok(compareFindingRows(first, second) < 0)
})
