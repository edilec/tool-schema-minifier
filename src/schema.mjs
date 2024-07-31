/**
 * What a JSON Schema keyword means, what may be compressed, and how two
 * schemas are compared.
 *
 * Three ideas hold this module together:
 *
 * 1. **Position, not name.** `title`, `examples` and `$comment` are annotations
 *    *in a schema position*. Inside `properties` the same words are property
 *    names, and deleting one deletes a parameter. A minifier that walks a tree
 *    deleting keys by name silently changes what a tool accepts, and a schema
 *    declaring a parameter called `title` is not exotic. Every transform here
 *    knows whether it is standing in a schema position or in a map of
 *    arbitrary names.
 * 2. **An unrecognised keyword is not a removable one.** A keyword this module
 *    does not know is copied verbatim, and its subtree is not entered. That is
 *    the only safe reading: an unknown keyword may be a custom applicator, and
 *    nothing here can tell.
 * 3. **The comparison is the gate.** `compareSchemas` is not a debugging aid.
 *    No compressed copy is accepted until the comparison has run over it and
 *    found no difference that matters, so the tool never asserts equivalence it
 *    has not checked.
 */

import { EXCERPT_LIMIT, sanitize } from './text.mjs'

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Assign without letting a document rewrite an object's prototype.
 *
 * `JSON.parse` gives `__proto__` back as an ordinary own property, but plain
 * assignment runs the setter and mutates the prototype instead of storing a
 * key. Every key this module copies comes out of an untrusted document, so
 * every copy goes through here.
 */
export function setKey(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
  return target
}

/** Own enumerable keys, in insertion order, including `__proto__` if present. */
export function ownKeys(record) {
  return Object.keys(record)
}

/**
 * Annotations with no effect on validation. These are the only keywords the
 * `--drop-annotations` transform may remove, and only in a schema position.
 */
export const ANNOTATION_KEYWORDS = Object.freeze(['$comment', 'example', 'examples', 'title'])

/**
 * Annotations that are kept whatever the transform set.
 *
 * `description` is what a model reads to decide whether to call a tool at all,
 * so it is compressed but never deleted. `deprecated`, `readOnly` and
 * `writeOnly` change how a caller is expected to behave.
 */
export const RETAINED_KEYWORDS = Object.freeze(['deprecated', 'description', 'readOnly', 'writeOnly'])

/**
 * Keywords whose value decides whether an argument is accepted, plus the
 * identity and vocabulary keywords that decide how the rest are read. Every one
 * of them must be identical between an original and an accepted copy.
 */
export const VALIDATION_KEYWORDS = Object.freeze([
  '$anchor', '$defs', '$dynamicRef', '$id', '$recursiveRef', '$ref', '$schema', '$vocabulary',
  'additionalItems', 'additionalProperties', 'allOf', 'anyOf', 'const', 'contains', 'contentEncoding',
  'contentMediaType', 'contentSchema', 'default', 'definitions', 'dependencies', 'dependentRequired',
  'dependentSchemas', 'else', 'enum', 'exclusiveMaximum', 'exclusiveMinimum', 'format', 'if', 'items',
  'maxContains', 'maxItems', 'maxLength', 'maxProperties', 'maximum', 'minContains', 'minItems',
  'minLength', 'minProperties', 'minimum', 'multipleOf', 'not', 'nullable', 'oneOf', 'pattern',
  'patternProperties', 'prefixItems', 'properties', 'propertyNames', 'required', 'then', 'type',
  'unevaluatedItems', 'unevaluatedProperties', 'uniqueItems',
])

/** Extension keys a document uses to mark a schema node as approval-governing. */
export const SAFETY_FLAGS = Object.freeze(['x-approval', 'x-safety-critical'])

/** Keywords whose value is itself one schema. */
const SCHEMA_VALUE = new Set([
  'additionalItems', 'additionalProperties', 'contains', 'contentSchema', 'else', 'if', 'not',
  'propertyNames', 'then', 'unevaluatedItems', 'unevaluatedProperties',
])

/** Keywords whose value is an array of schemas. */
const SCHEMA_ARRAY = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])

/**
 * Keywords whose value is a map from an arbitrary name to a schema. The keys of
 * these maps are names from the document, never keywords -- which is exactly
 * the distinction a name-based minifier loses.
 */
const SCHEMA_MAP = new Set(['$defs', 'definitions', 'dependentSchemas', 'patternProperties', 'properties'])

const ANNOTATIONS = new Set(ANNOTATION_KEYWORDS)
const KNOWN = new Set([...ANNOTATION_KEYWORDS, ...RETAINED_KEYWORDS, ...VALIDATION_KEYWORDS, ...SAFETY_FLAGS])

/**
 * The frozen marker list that decides whether a description governs an
 * approval.
 *
 * It is a word list, and a word list cannot understand a sentence. It is
 * therefore deliberately over-broad: matching protects a description from every
 * transform, so a false positive costs a few bytes and a false negative costs a
 * safety notice. `x-approval` on the node is the authoritative mechanism and
 * `--protect-tool` names whole tools; the list is the floor, not the ceiling.
 * README and `docs/compression-rules.md` say the same, and the non-goals say
 * this tool does not understand what a description means.
 */
export const APPROVAL_MARKERS = Object.freeze([
  'approval', 'approve', 'approved', 'approves', 'authorisation', 'authorise', 'authorised',
  'authorization', 'authorize', 'authorized', 'billing', 'cannot be undone', 'charge', 'confirm',
  'confirmation', 'confirms', 'consent', 'credential', 'credentials', 'dangerous', 'delete', 'deleted',
  'deletes', 'deleting', 'deletion', 'destructive', 'erase', 'irreversible', 'irrevocable', 'password',
  'payment', 'permanent', 'permanently', 'permission', 'permissions', 'privileged', 'purchase',
  'refund', 'revoke', 'secret', 'secrets', 'transfer', 'unsafe', 'wire transfer',
])

const MARKER_PATTERN = new RegExp(`\\b(?:${APPROVAL_MARKERS.join('|')})\\b`, 'i')

/** True when a description's own text marks it as governing an approval. */
export function isApprovalDescription(text) {
  return typeof text === 'string' && MARKER_PATTERN.test(text)
}

/** True when a schema node carries an explicit safety flag. */
export function hasSafetyFlag(node) {
  return isRecord(node) && SAFETY_FLAGS.some((flag) => node[flag] === true)
}

/** Escape one JSON Pointer segment (RFC 6901). */
export function pointerSegment(value) {
  return String(value).split('~').join('~0').split('/').join('~1')
}

/** Deep copy of a JSON value, prototype-safe. */
export function deepCopy(value) {
  if (Array.isArray(value)) return value.map(deepCopy)
  if (!isRecord(value)) return value
  const copy = {}
  for (const key of ownKeys(value)) setKey(copy, key, deepCopy(value[key]))
  return copy
}

/** Structural equality over JSON values. Key order is not significant. */
export function deepEqual(left, right) {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((item, index) => deepEqual(item, right[index]))
  }
  if (!isRecord(left) || !isRecord(right)) {
    // NaN cannot arrive from JSON.parse, so identity is the whole comparison.
    return false
  }
  const leftKeys = ownKeys(left)
  const rightKeys = ownKeys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]))
}

const CONTROL_PROBE = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}`
  + `${String.fromCharCode(11)}${String.fromCharCode(12)}`
  + `${String.fromCharCode(14)}-${String.fromCharCode(31)}`
  + `${String.fromCharCode(127)}-${String.fromCharCode(0x9f)}`
  + `${String.fromCharCode(0x200e)}${String.fromCharCode(0x200f)}`
  + `${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}`
  + `${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}`
  + `${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`,
)

/** True when a string carries a character that forges or hides a line. */
export function hasControlCharacter(value) {
  return typeof value === 'string' && CONTROL_PROBE.test(value)
}

/** The single character that marks a truncated description. */
const ELLIPSIS = String.fromCharCode(0x2026)

/**
 * Compress one description: collapse whitespace, then truncate to the budget.
 *
 * Truncation cuts to `limit - 1` and appends one ellipsis character, so the
 * result is never longer than the limit. That still does not guarantee a
 * smaller token estimate at the boundary, which is why the caller compares the
 * whole tool before and after and rejects a compression that did not save.
 */
export function compressDescription(text, limit) {
  const flattened = String(text).replace(/\s+/g, ' ').trim()
  if (flattened.length <= limit) return { text: flattened, truncated: false }
  return { text: `${flattened.slice(0, Math.max(1, limit - 1))}${ELLIPSIS}`, truncated: true }
}

/**
 * Walk one schema position and build the compressed copy.
 *
 * `record` receives a row for every observation; `state.protectedScope` is true
 * once an enclosing tool or node has been marked safety-critical, and never
 * turns back off inside that subtree.
 */
export function minifySchema(node, pointer, state, record) {
  if (Array.isArray(node)) {
    // A schema position holding an array is not a schema; keep it exactly.
    return deepCopy(node)
  }
  if (!isRecord(node)) return node

  const nodeProtected = state.protectedScope || hasSafetyFlag(node)
  const result = {}

  for (const key of ownKeys(node)) {
    const value = node[key]
    const here = `${pointer}/${pointerSegment(key)}`

    if (ANNOTATIONS.has(key)) {
      if (state.dropAnnotations) {
        record({ ruleId: 'annotation-dropped', pointer: here, message: `The annotation "${sanitize(key, 60)}" was removed; it has no effect on validation.` })
        state.counts.annotationsDropped += 1
        continue
      }
      setKey(result, key, deepCopy(value))
      continue
    }

    if (key === 'description') {
      setKey(result, key, minifyDescriptionField(value, here, nodeProtected, state, record))
      continue
    }

    if (key === 'properties' || key === 'patternProperties' || key === '$defs'
      || key === 'definitions' || key === 'dependentSchemas') {
      setKey(result, key, minifySchemaMap(value, here, { ...state, protectedScope: nodeProtected }, record))
      continue
    }

    if (key === 'items') {
      setKey(result, key, Array.isArray(value)
        ? value.map((item, index) => minifySchema(item, `${here}/${index}`, { ...state, protectedScope: nodeProtected }, record))
        : minifySchema(value, here, { ...state, protectedScope: nodeProtected }, record))
      continue
    }

    if (SCHEMA_ARRAY.has(key) && Array.isArray(value)) {
      setKey(result, key, value.map((item, index) => minifySchema(item, `${here}/${index}`, { ...state, protectedScope: nodeProtected }, record)))
      continue
    }

    if (SCHEMA_VALUE.has(key)) {
      setKey(result, key, minifySchema(value, here, { ...state, protectedScope: nodeProtected }, record))
      continue
    }

    if (key === 'dependencies' && isRecord(value)) {
      // Draft-07 `dependencies` mixes two shapes: an array of property names,
      // and a schema. Only the schema half is a schema position.
      const copy = {}
      for (const name of ownKeys(value)) {
        const dependency = value[name]
        setKey(copy, name, isRecord(dependency)
          ? minifySchema(dependency, `${here}/${pointerSegment(name)}`, { ...state, protectedScope: nodeProtected }, record)
          : deepCopy(dependency))
      }
      setKey(result, key, copy)
      continue
    }

    if (!KNOWN.has(key)) {
      record({
        ruleId: 'schema-keyword-unrecognized',
        pointer: here,
        message: `The keyword "${sanitize(key, 60)}" is not recognised, so it and everything under it were copied unchanged.`,
        suggestion: 'No action is needed unless the keyword should be understood by this tool.',
      })
      state.counts.unknownKeywords += 1
    }

    setKey(result, key, deepCopy(value))
  }

  return result
}

function minifySchemaMap(value, pointer, state, record) {
  if (!isRecord(value)) return deepCopy(value)
  const copy = {}
  for (const name of ownKeys(value)) {
    // `name` is a property name from the document, never a keyword. This is the
    // line that keeps a parameter called `title` from being deleted as an
    // annotation.
    setKey(copy, name, minifySchema(value[name], `${pointer}/${pointerSegment(name)}`, state, record))
  }
  return copy
}

/**
 * Compress one `description` field, or keep it byte for byte.
 *
 * Exported because a tool entry carries a description of its own that is not
 * inside a JSON Schema, and it must be treated by exactly the same rule as one
 * that is -- a single site, so "which descriptions are protected" has one
 * answer rather than two that can drift apart.
 */
export function minifyDescriptionField(value, pointer, nodeProtected, state, record) {
  if (typeof value !== 'string') {
    // A non-string description is not this tool's to correct; it is copied and
    // reported, because a schema this tool did not understand is not evidence
    // of anything.
    record({
      ruleId: 'description-malformed',
      pointer,
      message: 'The description is not a string, so it was copied unchanged and nothing about it was checked.',
      suggestion: 'Make the description a string, or remove it.',
    })
    return deepCopy(value)
  }
  if (hasControlCharacter(value)) {
    record({
      ruleId: 'description-contains-control',
      pointer,
      message: 'The description carries a control, bidi or line-separator character that can forge or hide text where the tool list is displayed.',
      evidence: sanitize(value, EXCERPT_LIMIT),
      suggestion: 'Remove the character at its source; this tool copies a protected description byte for byte and will not rewrite it.',
    })
  }

  const protectedHere = nodeProtected || isApprovalDescription(value)
  if (protectedHere) {
    state.counts.protectedDescriptions += 1
    record({
      ruleId: 'description-protected',
      pointer,
      message: 'The description governs an approval, so it was copied byte for byte and no transform was applied to it.',
    })
    return value
  }

  const compressed = compressDescription(value, state.maxDescriptionChars)
  if (compressed.text !== value) {
    state.counts.descriptionsCompressed += 1
    record({
      ruleId: compressed.truncated ? 'description-truncated' : 'description-collapsed',
      pointer,
      message: compressed.truncated
        ? `The description was truncated to the ${state.maxDescriptionChars} character budget.`
        : 'Runs of whitespace in the description were collapsed to single spaces.',
    })
  }
  return compressed.text
}

/**
 * Compare an original schema with a candidate and record every difference that
 * a compressed copy is not allowed to have.
 *
 * What a copy MAY differ in, and nothing else:
 *
 * - an annotation (`title`, `$comment`, `example`, `examples`) may be absent;
 * - an unprotected `description` may hold different text, as long as it is
 *   still a non-empty string.
 *
 * Everything else -- every validation keyword, every property name, every
 * protected description, every keyword this module does not recognise -- must
 * be identical, and a difference is recorded with the pointer where it is.
 */
export function compareSchemas(original, candidate, pointer, state, record) {
  if (!isRecord(original) || !isRecord(candidate)) {
    if (!deepEqual(original, candidate)) {
      record({
        ruleId: 'structure-changed',
        pointer,
        message: 'The compressed copy has a different shape here than the original.',
      })
    }
    return
  }

  const nodeProtected = state.protectedScope || hasSafetyFlag(original)
  const inner = { ...state, protectedScope: nodeProtected }

  for (const key of ownKeys(original)) {
    const here = `${pointer}/${pointerSegment(key)}`
    const present = Object.hasOwn(candidate, key)
    const left = original[key]
    const right = candidate[key]

    if (!present) {
      if (ANNOTATIONS.has(key)) continue
      record(missingRow(key, here, left, nodeProtected))
      continue
    }

    if (key === 'description') {
      compareDescription(left, right, here, inner, record)
      continue
    }
    if (key === 'required') {
      if (!sameNameSet(left, right)) {
        record({
          ruleId: 'required-changed',
          pointer: here,
          message: `The required parameter list differs: the original requires ${describeNames(left)} and the copy requires ${describeNames(right)}.`,
          suggestion: 'Restore the original required list; a dropped requirement silently makes a parameter optional.',
        })
      }
      continue
    }
    if (key === 'enum' || key === 'const' || key === 'type') {
      if (!deepEqual(left, right)) {
        record({
          ruleId: key === 'enum' ? 'enum-changed' : key === 'const' ? 'const-changed' : 'type-changed',
          pointer: here,
          message: `The "${key}" constraint differs between the original and the compressed copy.`,
          suggestion: 'Restore the original constraint; this is what decides which values are accepted.',
        })
      }
      continue
    }
    if (SCHEMA_MAP.has(key)) {
      compareSchemaMap(left, right, here, inner, record)
      continue
    }
    if (key === 'items' && (Array.isArray(left) || Array.isArray(right))) {
      compareSchemaList(left, right, here, inner, record)
      continue
    }
    if (SCHEMA_ARRAY.has(key)) {
      compareSchemaList(left, right, here, inner, record)
      continue
    }
    if (SCHEMA_VALUE.has(key) || key === 'items') {
      compareSchemas(left, right, here, inner, record)
      continue
    }
    if (key === 'dependencies' && isRecord(left)) {
      compareSchemaMap(left, right, here, inner, record)
      continue
    }
    if (!deepEqual(left, right)) {
      record({
        ruleId: ANNOTATIONS.has(key) ? 'annotation-changed'
          : KNOWN.has(key) ? 'constraint-changed' : 'unknown-keyword-changed',
        pointer: here,
        message: `The keyword "${sanitize(key, 60)}" differs between the original and the compressed copy.`,
        suggestion: 'Restore the original value; only annotations may be dropped and only unprotected descriptions may be rewritten.',
      })
    }
  }

  for (const key of ownKeys(candidate)) {
    if (Object.hasOwn(original, key)) continue
    record({
      ruleId: 'keyword-added',
      pointer: `${pointer}/${pointerSegment(key)}`,
      message: `The compressed copy adds "${sanitize(key, 60)}", which the original does not have.`,
      suggestion: 'A compressed copy may drop annotations and shorten descriptions; it may not add anything.',
    })
  }
}

function missingRow(key, here, left, nodeProtected) {
  if (key === 'description') {
    const protectedHere = nodeProtected || isApprovalDescription(left)
    return protectedHere
      ? {
        ruleId: 'safety-description-removed',
        pointer: here,
        message: 'A description governing an approval is missing from the compressed copy.',
        suggestion: 'Restore it verbatim; an approval notice removed from a tool list cannot be recovered by the caller.',
      }
      : {
        ruleId: 'description-removed',
        pointer: here,
        message: 'A description is missing from the compressed copy; descriptions may be shortened but never dropped.',
        suggestion: 'Restore a shortened form of the description.',
      }
  }
  if (key === 'required') {
    return {
      ruleId: 'required-changed',
      pointer: here,
      message: 'The required parameter list is missing from the compressed copy.',
      suggestion: 'Restore the original required list.',
    }
  }
  if (key === 'enum') {
    return { ruleId: 'enum-changed', pointer: here, message: 'An enum is missing from the compressed copy.', suggestion: 'Restore the enum exactly.' }
  }
  if (key === 'const') return { ruleId: 'const-changed', pointer: here, message: 'A const is missing from the compressed copy.', suggestion: 'Restore the const.' }
  if (key === 'type') return { ruleId: 'type-changed', pointer: here, message: 'A type is missing from the compressed copy.', suggestion: 'Restore the type.' }
  if (KNOWN.has(key)) {
    return {
      ruleId: 'constraint-changed',
      pointer: here,
      message: `The keyword "${sanitize(key, 60)}" is missing from the compressed copy.`,
      suggestion: 'Restore it; only annotations may be dropped.',
    }
  }
  return {
    ruleId: 'unknown-keyword-removed',
    pointer: here,
    message: `The unrecognised keyword "${sanitize(key, 60)}" is missing from the compressed copy; an unrecognised keyword may be an applicator and is never safe to drop.`,
    suggestion: 'Restore it verbatim.',
  }
}

/**
 * Compare one `description` field. Exported for the same reason as above.
 *
 * `state.counts`, when present, is where a protected description that survived
 * intact is counted -- so a verification run can report how many approval
 * notices it actually checked, rather than reporting nothing and looking as if
 * it checked none.
 */
export function compareDescription(left, right, here, state, record) {
  const protectedHere = Boolean(state?.protectedScope) || isApprovalDescription(left)
  if (protectedHere) {
    if (state?.counts !== undefined) state.counts.protectedDescriptions += 1
    if (left !== right) {
      record({
        ruleId: 'safety-description-changed',
        pointer: here,
        message: 'A description governing an approval is not byte-identical in the compressed copy.',
        suggestion: 'Copy an approval-governing description verbatim; it is the text a caller relies on to ask first.',
      })
    }
    return
  }
  if (typeof left !== 'string') {
    // A description that was never a string is not text this tool can shorten,
    // so the only rule it can hold the copy to is that it did not change. The
    // minify pass reports the malformed description separately and marks the
    // run incomplete; this branch exists so the comparison does not turn that
    // into a false difference.
    if (!deepEqual(left, right)) {
      record({
        ruleId: 'constraint-changed',
        pointer: here,
        message: 'The description differs between the original and the compressed copy, and the original is not a string.',
        suggestion: 'Make the description a string, or copy it unchanged.',
      })
    }
    return
  }
  if (typeof right !== 'string') {
    record({
      ruleId: 'description-removed',
      pointer: here,
      message: 'The description is not a string in the compressed copy; descriptions may be shortened but never removed.',
      suggestion: 'Restore a shortened form of the description as a string.',
    })
    return
  }
  /**
   * "Emptied" is a claim about what the COPY did, so what the original held
   * decides it.
   *
   * Asking only whether the copy is empty made this relation non-reflexive:
   * two byte-identical documents were declared not equivalent, and `minify`
   * refused to compress at all, whenever any description was `""` or
   * whitespace -- which a real `tools/list` response carries. The finding also
   * said the copy had emptied a description the copy had never touched.
   */
  if (right.trim() === '' && left.trim() !== '') {
    record({
      ruleId: 'description-removed',
      pointer: here,
      message: 'A description was emptied in the compressed copy; descriptions may be shortened but never removed.',
      suggestion: 'Restore a shortened form of the description.',
    })
  }
}

function compareSchemaMap(left, right, here, state, record) {
  if (!isRecord(left) || !isRecord(right)) {
    if (!deepEqual(left, right)) {
      record({ ruleId: 'structure-changed', pointer: here, message: 'The compressed copy has a different shape here than the original.' })
    }
    return
  }
  for (const name of ownKeys(left)) {
    const at = `${here}/${pointerSegment(name)}`
    if (!Object.hasOwn(right, name)) {
      record({
        ruleId: 'property-removed',
        pointer: at,
        message: `The parameter "${sanitize(name, 60)}" is missing from the compressed copy.`,
        suggestion: 'Restore the parameter; removing one changes what the tool accepts.',
      })
      continue
    }
    compareSchemas(left[name], right[name], at, state, record)
  }
  for (const name of ownKeys(right)) {
    if (Object.hasOwn(left, name)) continue
    record({
      ruleId: 'property-added',
      pointer: `${here}/${pointerSegment(name)}`,
      message: `The compressed copy adds the parameter "${sanitize(name, 60)}", which the original does not have.`,
      suggestion: 'Remove it; a compressed copy adds nothing.',
    })
  }
}

function compareSchemaList(left, right, here, state, record) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    if (!deepEqual(left, right)) {
      record({ ruleId: 'structure-changed', pointer: here, message: 'The compressed copy has a different number of subschemas here than the original.' })
    }
    return
  }
  left.forEach((item, index) => compareSchemas(item, right[index], `${here}/${index}`, state, record))
}

function sameNameSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return deepEqual(left, right)
  if (left.length !== right.length) return false
  const sorted = (list) => [...list].map(String).sort((a, b) => (a === b ? 0 : a < b ? -1 : 1))
  return deepEqual(sorted(left), sorted(right))
}

function describeNames(value) {
  if (!Array.isArray(value)) return 'a value that is not a list'
  if (value.length === 0) return 'nothing'
  return value.map((name) => `"${sanitize(name, 40)}"`).join(', ')
}
