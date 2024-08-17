/**
 * Reading a tool document, and the limits that reading obeys.
 *
 * Every limit here is enforced where it is declared, is wired to a command line
 * flag and to `--config`, and is reported by name when it is reached. A limit
 * that is accepted and quietly ignored is worse than no limit: it turns a real
 * failure into a green run, which has already happened in this catalog.
 *
 * Nothing is ever truncated to fit. A document over a limit is refused whole
 * and the run is incomplete, because a partially read document is evidence
 * about nothing.
 */

import { NAME_LIMIT, decodeUtf8, parseFailureDetail, sanitize } from './text.mjs'
import { isRecord, ownKeys } from './schema.mjs'

export const DOCUMENT_SCHEMA_VERSION = '1'

export const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 4 * 1024 * 1024,
  maxTools: 500,
  maxNodes: 50_000,
  maxDepth: 32,
  maxDescriptionChars: 240,
  maxMillis: 10_000,
})

const LIMIT_FLOORS = Object.freeze({
  maxBytes: 1,
  maxTools: 1,
  maxNodes: 1,
  maxDepth: 1,
  maxDescriptionChars: 8,
  maxMillis: 0,
})

/**
 * The deepest document this tool can actually walk.
 *
 * `measureShape` here uses an explicit stack, but the compressor and the
 * equivalence comparison recurse, so `--max-depth` is the only thing between a
 * deep document and a stack overflow. Raised past what the stack can carry --
 * which the tool's own suggestion text invites, "raise --max-depth
 * deliberately" -- the process died with a bare `RangeError: Maximum call stack
 * size exceeded`, exit 2 and NOTHING on stdout: an input failure wearing the
 * shape of a configuration failure, with no report naming the document.
 *
 * So the depth budget has a ceiling, and asking for more is a configuration
 * error the operator can read. Measured on this platform, nesting 1000 deep is
 * walked comfortably and around 4000 is where the stack gives out; the ceiling
 * keeps a margin of about four, because a stack frame is not the same size on
 * every build. A document deeper than the ceiling is `tools-too-deep`, which is
 * an `incomplete` report on stdout naming the limit -- a diagnosis rather than
 * a crash.
 */
export const LIMIT_CEILINGS = Object.freeze({ maxDepth: 1000 })

/**
 * Validate limit overrides, or throw.
 *
 * An unknown key throws rather than being ignored: a one-character typo in a
 * limit name must not fall back to the default and report a green run. A
 * configuration failure means the run never had a subject, so the command line
 * turns it into exit 2 with an empty stdout and no report at all.
 */
export function validateLimits(overrides = {}) {
  if (!isRecord(overrides)) throw new TypeError('limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const key of ownKeys(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) throw new TypeError(`Unknown limit "${sanitize(key, 60)}"`)
    const value = overrides[key]
    if (!Number.isInteger(value) || value < LIMIT_FLOORS[key]) {
      throw new TypeError(`Limit "${key}" must be an integer of at least ${LIMIT_FLOORS[key]}`)
    }
    if (Object.hasOwn(LIMIT_CEILINGS, key) && value > LIMIT_CEILINGS[key]) {
      throw new TypeError(
        `Limit "${key}" must be an integer of at most ${LIMIT_CEILINGS[key]}: past that this tool `
        + 'cannot walk the document without exhausting the stack, and a crash is not a report.',
      )
    }
    limits[key] = value
  }
  return Object.freeze(limits)
}

/**
 * Depth and node count, measured with an explicit stack.
 *
 * Recursion here would make a deeply nested document a stack overflow rather
 * than a reported limit, which is the difference between a diagnosis and a
 * crash. Counting stops as soon as a limit is passed, so a hostile document
 * cannot make the measurement itself expensive.
 */
export function measureShape(value, limits) {
  let nodes = 0
  let deepest = 0
  const stack = [{ value, depth: 1 }]
  while (stack.length > 0) {
    const { value: current, depth } = stack.pop()
    if (depth > deepest) deepest = depth
    if (deepest > limits.maxDepth) return { nodes, depth: deepest, overDepth: true, overNodes: false }
    if (Array.isArray(current)) {
      nodes += 1
      if (nodes > limits.maxNodes) return { nodes, depth: deepest, overDepth: false, overNodes: true }
      for (const item of current) stack.push({ value: item, depth: depth + 1 })
    } else if (isRecord(current)) {
      nodes += 1
      if (nodes > limits.maxNodes) return { nodes, depth: deepest, overDepth: false, overNodes: true }
      for (const key of ownKeys(current)) stack.push({ value: current[key], depth: depth + 1 })
    }
  }
  return { nodes, depth: deepest, overDepth: false, overNodes: false }
}

const DOCUMENT_KEYS = Object.freeze(['schemaVersion', 'tools'])

/**
 * Decode, parse and bound one document.
 *
 * Returns either the parsed value or a row describing why it was not obtained.
 * Every failure here is a fact about the input, not about the configuration, so
 * it becomes an `incomplete` report rather than an empty stdout.
 */
export function readDocument(bytes, limits, subject) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError(`${subject} bytes must be a Uint8Array`)
  if (bytes.byteLength > limits.maxBytes) {
    return {
      ok: false,
      ruleId: `${subject}-too-large`,
      message: `The ${subject} document is ${bytes.byteLength} bytes, over the maxBytes limit of ${limits.maxBytes}; it was not read.`,
      suggestion: 'Raise --max-bytes deliberately, or split the document.',
    }
  }
  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    return {
      ok: false,
      ruleId: `${subject}-not-utf8`,
      message: `The ${subject} document is not valid UTF-8, so nothing about it was read.`,
      suggestion: 'Re-encode the document as UTF-8.',
    }
  }
  let parsed
  try {
    parsed = JSON.parse(decoded.text)
  } catch (error) {
    return {
      ok: false,
      ruleId: `${subject}-not-json`,
      // The detail comes from parseFailureDetail, which never carries document
      // text: V8's own message quotes the input back and would walk a
      // credential onto stdout past every other precaution.
      message: `The ${subject} document is not valid JSON: ${sanitize(parseFailureDetail(error), 160)}.`,
      suggestion: 'Fix the JSON syntax and run again.',
    }
  }
  const shape = measureShape(parsed, limits)
  if (shape.overDepth) {
    return {
      ok: false,
      ruleId: `${subject}-too-deep`,
      message: `The ${subject} document nests deeper than the maxDepth limit of ${limits.maxDepth}; it was not read.`,
      suggestion: `Raise --max-depth deliberately, up to the supported maximum of ${LIMIT_CEILINGS.maxDepth}, or flatten the schema.`,
    }
  }
  if (shape.overNodes) {
    return {
      ok: false,
      ruleId: `${subject}-too-many-nodes`,
      message: `The ${subject} document holds more than the maxNodes limit of ${limits.maxNodes} objects and arrays; it was not read.`,
      suggestion: 'Raise --max-nodes deliberately, or split the document.',
    }
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      ruleId: `${subject}-malformed`,
      message: `The ${subject} document must be a JSON object with a "tools" array.`,
      suggestion: 'Wrap the tool list as { "tools": [ ... ] }.',
    }
  }
  return { ok: true, value: parsed, nodes: shape.nodes, depth: shape.depth }
}

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/

/**
 * Turn a parsed document into the tool list, recording every defect.
 *
 * `stopped` means the document could not be read far enough to compare
 * anything. A refused tool is not compressed and not counted as checked: it is
 * a question the run did not answer.
 */
export function normalizeDocument(parsed, limits, subject, record) {
  for (const key of ownKeys(parsed)) {
    if (DOCUMENT_KEYS.includes(key)) continue
    record({
      ruleId: 'unknown-document-key',
      pointer: `/${key.split('~').join('~0').split('/').join('~1')}`,
      message: `The ${subject} document declares "${sanitize(key, 60)}", which this tool does not understand; the document may be in another format, so nothing was compressed.`,
      suggestion: 'Remove the key, or convert the document to { "schemaVersion": "1", "tools": [ ... ] }.',
    })
    return { stopped: true, tools: [] }
  }

  const version = parsed.schemaVersion
  if (version !== undefined && version !== DOCUMENT_SCHEMA_VERSION) {
    record({
      ruleId: 'schema-version-unsupported',
      pointer: '/schemaVersion',
      message: `This tool reads schemaVersion "${DOCUMENT_SCHEMA_VERSION}"; the ${subject} document declares "${sanitize(String(version), 40)}".`,
      suggestion: 'Convert the document, or run a version of this tool that understands it.',
    })
    return { stopped: true, tools: [] }
  }

  const declared = parsed.tools
  if (!Array.isArray(declared)) {
    record({
      ruleId: `${subject}-malformed`,
      pointer: '/tools',
      message: `The ${subject} document has no "tools" array, so no tool schema was read.`,
      suggestion: 'Declare the tools as { "tools": [ { "name": "...", "inputSchema": { ... } } ] }.',
    })
    return { stopped: true, tools: [] }
  }

  if (declared.length > limits.maxTools) {
    record({
      ruleId: 'too-many-tools',
      pointer: '/tools',
      message: `The ${subject} document declares ${declared.length} tools, over the maxTools limit of ${limits.maxTools}; none were compressed.`,
      suggestion: 'Raise --max-tools deliberately, or split the document.',
    })
    return { stopped: true, tools: [] }
  }

  const tools = []
  const seen = new Set()
  declared.forEach((entry, index) => {
    const pointer = `/tools/${index}`
    if (!isRecord(entry)) {
      record({
        ruleId: 'tool-malformed',
        pointer,
        message: 'A tool entry is not an object, so it was not read.',
        suggestion: 'Declare each tool as an object with a name and an inputSchema.',
      })
      return
    }
    const name = entry.name
    if (typeof name !== 'string' || !TOOL_NAME.test(name)) {
      record({
        ruleId: 'tool-name-invalid',
        pointer: `${pointer}/name`,
        message: 'A tool name is missing or is not 1 to 128 characters of letters, digits, underscore, dot or hyphen, so the tool was not read.',
        suggestion: 'Give the tool a name matching [A-Za-z0-9_.-]{1,128}.',
      })
      return
    }
    if (seen.has(name)) {
      record({
        ruleId: 'tool-name-duplicated',
        pointer: `${pointer}/name`,
        message: `Two tools are called "${sanitize(name, NAME_LIMIT)}"; a duplicate name makes the pair impossible to tell apart, so neither entry was compressed.`,
        suggestion: 'Give every tool a distinct name.',
      })
      return
    }
    seen.add(name)
    if (!isRecord(entry.inputSchema)) {
      record({
        ruleId: 'tool-schema-missing',
        pointer: `${pointer}/inputSchema`,
        message: `The tool "${sanitize(name, NAME_LIMIT)}" has no inputSchema object, so nothing about its parameters was read.`,
        suggestion: 'Declare an inputSchema object, even if it is { "type": "object" }.',
      })
      return
    }
    tools.push({ name, index, pointer, entry })
  })

  return { stopped: false, tools }
}
