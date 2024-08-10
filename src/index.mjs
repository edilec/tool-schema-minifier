/**
 * tool-schema-minifier
 *
 * Produces a compressed copy of a tool-definition document and reports what it
 * saved -- but only after checking that the copy still means the same thing.
 *
 * Four properties are structural rather than incidental:
 *
 * 1. **Equivalence is checked, not assumed.** Every compressed tool is compared
 *    against its original, keyword by keyword, before it is accepted. A tool
 *    whose copy differs in anything that matters keeps its original definition
 *    and the run fails. The compressor and the checker are separate code, so a
 *    mistake in one is caught by the other.
 * 2. **Required parameters, enums and constants are never touched.** They are
 *    copied verbatim and then compared; a difference is an error, not a note.
 * 3. **A description that governs an approval is copied byte for byte.** A
 *    model deciding whether to ask a person first reads that sentence, and a
 *    shortened version of it is a different tool.
 * 4. **The token number is an estimate and says so.** It has no vocabulary and
 *    is not any provider's tokenizer. Bytes are exact; tokens are comparable
 *    between two documents measured here and nowhere else.
 *
 * Nothing is fetched, no model is called, and the only clock is the one the
 * caller injects for its own time budget.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import { DestinationError, assertWritableDestination } from './destination.mjs'
import {
  DEFAULT_LIMITS,
  DOCUMENT_SCHEMA_VERSION,
  normalizeDocument,
  readDocument,
  validateLimits,
} from './document.mjs'
import {
  compareDescription,
  compareSchemas,
  deepCopy,
  deepEqual,
  hasSafetyFlag,
  isApprovalDescription,
  isRecord,
  minifyDescriptionField,
  minifySchema,
  ownKeys,
  pointerSegment,
  setKey,
} from './schema.mjs'
import { measure, savingPerMille } from './tokens.mjs'
import {
  EXCERPT_LIMIT,
  LABEL_LIMIT,
  MESSAGE_LIMIT,
  POINTER_LIMIT,
  byCodeUnit,
  decodeUtf8,
  escapeJsSeparators,
  parseFailureDetail,
  sanitize,
} from './text.mjs'

export const TOOL_ID = 'tool-schema-minifier'
export const REPORT_SCHEMA_VERSION = '1'

export { DEFAULT_LIMITS, DOCUMENT_SCHEMA_VERSION, validateLimits }
export { DestinationError, assertWritableDestination } from './destination.mjs'
export { APPROVAL_MARKERS, isApprovalDescription } from './schema.mjs'
export { estimateTokens } from './tokens.mjs'
// Re-exported so the catalog leak probe can import and exercise it directly; a
// module-local helper can only be read, and reading is weaker than running.
export { parseFailureDetail }

const DEFAULT_SOURCE = 'tools.json'

/** Tool-entry keys this tool understands. Anything else is copied verbatim. */
const TOOL_KEYS = Object.freeze([
  'annotations', 'description', 'inputSchema', 'name', 'outputSchema', 'title',
  'x-approval', 'x-safety-critical',
])

/** Tool-entry keys the `--drop-annotations` transform may remove. */
const TOOL_ANNOTATIONS = Object.freeze(['$comment', 'title'])

/**
 * The authoritative rule severity table.
 *
 * Severity is the entire difference between a run that fails and one that
 * passes. Written as a literal at each construction site it drifts silently, so
 * every finding takes its severity from here and an unknown rule id throws.
 *
 * This table is the source of truth. It is deliberately **not** the test: a
 * table, a documentation page and a hand-written expected map in a test are
 * three declarations agreeing with each other, and one coordinated edit
 * satisfies all three -- a catalog defended that way had forty error rules
 * survive being flipped to warnings. `test/severity-behaviour.test.mjs` drives
 * real documents through the real command line and pins the observable
 * outcome: the status and the exit code.
 *
 * The policy it encodes:
 *
 * - Evidence this tool could not obtain -- an unread document, a refused tool,
 *   a description that is not a string, an expired time budget -- is an error
 *   AND makes the run incomplete. It is never a verdict about the schema.
 * - A difference between an original and its compressed copy is an error and
 *   does NOT make the run incomplete: that is a fact the run established, so
 *   the run fails rather than abstaining.
 * - Work that was done as designed -- an annotation dropped, a description
 *   collapsed, a safety description protected -- is information.
 */
export const RULE_SEVERITY = Object.freeze({
  'annotation-changed': 'error',
  'annotation-dropped': 'info',
  'candidate-malformed': 'error',
  'candidate-not-json': 'error',
  'candidate-not-utf8': 'error',
  'candidate-too-deep': 'error',
  'candidate-too-large': 'error',
  'candidate-too-many-nodes': 'error',
  'candidate-unreadable': 'error',
  'compression-rejected-no-saving': 'info',
  'const-changed': 'error',
  'constraint-changed': 'error',
  'description-collapsed': 'info',
  'description-contains-control': 'warning',
  'description-malformed': 'error',
  'description-protected': 'info',
  'description-removed': 'error',
  'description-rewritten': 'error',
  'description-truncated': 'info',
  'enum-changed': 'error',
  'equivalence-not-proven': 'error',
  'keyword-added': 'error',
  'no-tools-declared': 'warning',
  'nothing-compressed': 'info',
  'property-added': 'error',
  'property-removed': 'error',
  'required-changed': 'error',
  'safety-description-changed': 'error',
  'safety-description-removed': 'error',
  'schema-keyword-unrecognized': 'info',
  'schema-version-unsupported': 'error',
  'structure-changed': 'error',
  'time-budget-exceeded': 'error',
  'too-many-tools': 'error',
  'tool-added-in-candidate': 'error',
  'tool-entry-changed': 'error',
  'tool-key-unrecognized': 'info',
  'tool-malformed': 'error',
  'tool-missing-from-candidate': 'error',
  'tool-name-duplicated': 'error',
  'tool-name-invalid': 'error',
  'tool-schema-missing': 'error',
  'tools-malformed': 'error',
  'tools-not-json': 'error',
  'tools-not-utf8': 'error',
  'tools-too-deep': 'error',
  'tools-too-large': 'error',
  'tools-too-many-nodes': 'error',
  'tools-unreadable': 'error',
  'type-changed': 'error',
  'unknown-document-key': 'error',
  'unknown-keyword-changed': 'error',
  'unknown-keyword-removed': 'error',
})

/**
 * The rules that mean a question was not answered.
 *
 * Each one marks the run `incomplete`, which is what keeps an unread document
 * or a half-finished pass from producing a verdict. `no-tools-declared` is the
 * one that is only a `warning`, so for it this membership is the ONLY thing
 * standing between an empty document and exit 0 --
 * `test/incompleteness.test.mjs` drives every id here through the real entry
 * point, and removing one turns exactly one of those cases red.
 *
 * Deliberately absent: every rule naming a difference between an original and
 * its copy. Those are facts the run established, so they fail the run instead.
 */
export const INCOMPLETE_RULES = Object.freeze([
  'candidate-malformed',
  'candidate-not-json',
  'candidate-not-utf8',
  'candidate-too-deep',
  'candidate-too-large',
  'candidate-too-many-nodes',
  'candidate-unreadable',
  'description-malformed',
  'no-tools-declared',
  'schema-version-unsupported',
  'time-budget-exceeded',
  'too-many-tools',
  'tool-malformed',
  'tool-name-duplicated',
  'tool-name-invalid',
  'tool-schema-missing',
  'tools-malformed',
  'tools-not-json',
  'tools-not-utf8',
  'tools-too-deep',
  'tools-too-large',
  'tools-too-many-nodes',
  'tools-unreadable',
  'unknown-document-key',
])

const INCOMPLETE = new Set(INCOMPLETE_RULES)
const ALLOWED_OPTIONS = Object.freeze([
  'bytes', 'candidateBytes', 'candidateSource', 'clock', 'dropAnnotations', 'limits', 'protectTools', 'source',
])

/**
 * The severity of one rule, or a throw.
 *
 * A rule with no entry is a programming error rather than a finding with a
 * missing severity: the counts would silently drop it and `JSON.stringify`
 * would omit the field, so a new rule added without a table entry would reach a
 * report as a finding nobody could triage. Membership is asked with
 * `Object.hasOwn` because an index lookup answers for `toString` too and would
 * hand back a function as a severity.
 */
export function severityOf(ruleId) {
  if (!Object.hasOwn(RULE_SEVERITY, ruleId)) {
    throw new TypeError(`No severity is declared for rule "${sanitize(String(ruleId), 60)}"`)
  }
  return RULE_SEVERITY[ruleId]
}

/** Every finding is built here, so severity has exactly one source. */
function record(collector, row) {
  const severity = severityOf(row.ruleId)
  collector.rows.push({ ...row, severity, order: collector.rows.length })
  // One site, so "which rules make a run incomplete" is a list a test can
  // enumerate rather than a property scattered through the analysis.
  if (INCOMPLETE.has(row.ruleId)) collector.incomplete = true
}

function createFinding(row, source) {
  const finding = {
    ruleId: row.ruleId,
    severity: row.severity,
    message: sanitize(row.message, MESSAGE_LIMIT),
    location: { file: source, pointer: sanitize(row.pointer, POINTER_LIMIT) },
  }
  if (row.evidence !== undefined && row.evidence !== null) finding.evidence = sanitize(row.evidence, EXCERPT_LIMIT)
  if (row.suggestion !== undefined && row.suggestion !== null) finding.suggestion = sanitize(row.suggestion, MESSAGE_LIMIT)
  return finding
}

/**
 * The documented sort key: `(location.pointer, ruleId, message)`.
 *
 * `location.file` is deliberately not part of it -- every finding in a run names
 * the same source document, so sorting by it would compare a string with
 * itself, and a key that cannot discriminate is not a sort key. Declaration
 * order is the final tiebreak so two findings alike in every other respect keep
 * a fixed order.
 */
export function compareFindingRows(left, right) {
  return byCodeUnit(left.pointer, right.pointer)
    || byCodeUnit(left.ruleId, right.ruleId)
    || byCodeUnit(left.message, right.message)
    || (left.order - right.order)
}

/**
 * The time budget, measured with a clock the caller supplies.
 *
 * `performance.now()` is a monotonic counter, not a wall clock, and the elapsed
 * value never reaches the report: the only thing it can change is whether the
 * budget was spent. A budget of zero would prove nothing about the command
 * line's wiring -- zero is spent before any work begins, so a clock stuck at a
 * constant satisfies it too. What pins the wiring is a nonzero budget the work
 * genuinely outlives, which `test/limits.test.mjs` runs.
 */
function createDeadline(clock, maxMillis) {
  const started = clock()
  if (typeof started !== 'number' || !Number.isFinite(started)) {
    throw new TypeError('clock must return a finite number of milliseconds')
  }
  return { exceeded: () => clock() - started >= maxMillis }
}

function defaultClock() {
  return performance.now()
}

const label = (value) => sanitize(value, LABEL_LIMIT)

function newCounts() {
  return {
    annotationsDropped: 0,
    descriptionsCompressed: 0,
    protectedDescriptions: 0,
    unknownKeywords: 0,
  }
}

function checkOptions(input, allowed) {
  if (!isRecord(input)) throw new TypeError('Options must be an object')
  for (const key of ownKeys(input)) {
    if (!allowed.includes(key)) throw new TypeError(`Unknown option "${sanitize(key, 60)}"`)
  }
}

function protectSet(value) {
  if (value === undefined) return new Set()
  if (!Array.isArray(value) || value.some((name) => typeof name !== 'string')) {
    throw new TypeError('protectTools must be an array of tool names')
  }
  return new Set(value)
}

/**
 * Build the compressed copy of one tool entry.
 *
 * A tool entry is not itself a JSON Schema: `name` is an identifier, and
 * `inputSchema` and `outputSchema` are the schema positions. The tool's own
 * `description` is treated by exactly the same protection rule as a parameter's,
 * because a tool description is the sentence most likely to say "this deletes
 * things".
 */
function minifyToolEntry(entry, pointer, state, record_) {
  const protectedScope = state.protectedScope || hasSafetyFlag(entry)
  const inner = { ...state, protectedScope }
  const result = {}
  for (const key of ownKeys(entry)) {
    const here = `${pointer}/${pointerSegment(key)}`
    const value = entry[key]
    if (key === 'description') {
      setKey(result, key, minifyDescriptionField(value, here, protectedScope, inner, record_))
      continue
    }
    if (TOOL_ANNOTATIONS.includes(key)) {
      if (state.dropAnnotations) {
        record_({
          ruleId: 'annotation-dropped',
          pointer: here,
          message: `The tool annotation "${sanitize(key, 60)}" was removed; it has no effect on validation.`,
        })
        state.counts.annotationsDropped += 1
        continue
      }
      setKey(result, key, deepCopy(value))
      continue
    }
    if (key === 'inputSchema' || key === 'outputSchema') {
      setKey(result, key, minifySchema(value, here, inner, record_))
      continue
    }
    if (!TOOL_KEYS.includes(key)) {
      record_({
        ruleId: 'tool-key-unrecognized',
        pointer: here,
        message: `The tool entry key "${sanitize(key, 60)}" is not recognised, so it and everything under it were copied unchanged.`,
      })
      state.counts.unknownKeywords += 1
    }
    setKey(result, key, deepCopy(value))
  }
  return result
}

/**
 * Compare one original tool entry with a candidate copy.
 *
 * This is the gate. `minifyTools` runs it over its own output before accepting
 * anything, and `verifyCandidate` runs the same function over a copy produced
 * somewhere else. One implementation, so a copy this tool wrote and a copy a
 * person wrote are held to the same standard.
 */
export function compareToolEntries(original, candidate, pointer, options, record_) {
  const protectedScope = Boolean(options?.protectedScope) || hasSafetyFlag(original)
  const inner = { protectedScope, counts: options?.counts }
  for (const key of ownKeys(original)) {
    const here = `${pointer}/${pointerSegment(key)}`
    const left = original[key]
    if (!Object.hasOwn(candidate, key)) {
      if (TOOL_ANNOTATIONS.includes(key)) continue
      if (key === 'description') {
        const wasProtected = protectedScope || isApprovalDescription(left)
        record_(wasProtected
          ? {
            ruleId: 'safety-description-removed',
            pointer: here,
            message: 'The tool description governing an approval is missing from the compressed copy.',
            suggestion: 'Restore it verbatim.',
          }
          : {
            ruleId: 'description-removed',
            pointer: here,
            message: 'The tool description is missing from the compressed copy; descriptions may be shortened but never dropped.',
            suggestion: 'Restore a shortened form of the description.',
          })
        continue
      }
      record_({
        ruleId: 'tool-entry-changed',
        pointer: here,
        message: `The tool entry key "${sanitize(key, 60)}" is missing from the compressed copy.`,
        suggestion: 'Restore it; only annotations may be dropped.',
      })
      continue
    }
    const right = candidate[key]
    if (key === 'description') {
      compareDescription(left, right, here, inner, record_)
      continue
    }
    if (key === 'inputSchema' || key === 'outputSchema') {
      compareSchemas(left, right, here, inner, record_)
      continue
    }
    if (!deepEqual(left, right)) {
      record_({
        ruleId: 'tool-entry-changed',
        pointer: here,
        message: `The tool entry key "${sanitize(key, 60)}" differs between the original and the compressed copy.`,
        suggestion: 'Restore the original value.',
      })
    }
  }
  for (const key of ownKeys(candidate)) {
    if (Object.hasOwn(original, key)) continue
    record_({
      ruleId: 'tool-entry-changed',
      pointer: `${pointer}/${pointerSegment(key)}`,
      message: `The compressed copy adds the tool entry key "${sanitize(key, 60)}", which the original does not have.`,
      suggestion: 'A compressed copy adds nothing.',
    })
  }
}

const EMPTY_TOTALS = Object.freeze({
  tools: 0,
  compressed: 0,
  kept: 0,
  tokensBefore: 0,
  tokensAfter: 0,
  tokensSaved: 0,
  savingPerMille: 0,
  bytesBefore: 0,
  bytesAfter: 0,
})

function finish(collector, state) {
  collector.rows.sort(compareFindingRows)
  const findings = collector.rows.map((row) => createFinding(row, state.source))
  const errors = findings.filter((finding) => finding.severity === 'error').length
  const warnings = findings.filter((finding) => finding.severity === 'warning').length
  const status = collector.incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass'
  const totals = state.totals ?? { ...EMPTY_TOTALS }
  const counts = state.counts ?? newCounts()

  /**
   * The envelope is exactly the one the contract specifies, and `summary`
   * carries integers only. The mode is deliberately not a summary field: the
   * contract allows additional *integer* summary fields, and a string there
   * would be this tool quietly widening a shared schema. It reaches a person
   * through the human summary and stderr, and a caller through the return
   * value of this function.
   */
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: totals.tools,
      errors,
      warnings,
      info: findings.length - errors - warnings,
      toolsCompressed: totals.compressed,
      toolsKept: totals.kept,
      protectedDescriptions: counts.protectedDescriptions,
      descriptionsCompressed: counts.descriptionsCompressed,
      annotationsDropped: counts.annotationsDropped,
      unknownKeywords: counts.unknownKeywords,
      tokensBefore: totals.tokensBefore,
      tokensAfter: totals.tokensAfter,
      tokensSaved: totals.tokensSaved,
      tokenSavingPerMille: totals.savingPerMille,
      bytesBefore: totals.bytesBefore,
      bytesAfter: totals.bytesAfter,
    },
    findings,
  }
  return { report, mode: state.mode, document: state.document ?? null, tools: state.perTool ?? [] }
}

/**
 * Compress the tools in a document supplied as bytes.
 *
 * Configuration errors -- an unknown option, an unknown limit, a limit that is
 * not an integer -- throw. They mean the run never had a subject, so there is
 * nothing to report about, and the command line turns them into exit 2 with an
 * empty stdout. Everything that is a fact about the *document* is a finding.
 */
export function minifyTools(input = {}) {
  checkOptions(input, ALLOWED_OPTIONS)
  const limits = validateLimits(input.limits)
  const source = label(input.source ?? DEFAULT_SOURCE) || DEFAULT_SOURCE
  const clock = input.clock ?? defaultClock
  if (typeof clock !== 'function') throw new TypeError('clock must be a function returning elapsed milliseconds')
  if (input.dropAnnotations !== undefined && typeof input.dropAnnotations !== 'boolean') {
    throw new TypeError('dropAnnotations must be a boolean')
  }
  const protect = protectSet(input.protectTools)

  const collector = { rows: [], incomplete: false }
  const counts = newCounts()
  const state = { source, mode: 'minify', counts, totals: { ...EMPTY_TOTALS }, document: null, perTool: [] }
  const deadline = createDeadline(clock, limits.maxMillis)

  const document = readDocument(input.bytes, limits, 'tools')
  if (!document.ok) {
    record(collector, { ruleId: document.ruleId, pointer: '/', message: document.message, suggestion: document.suggestion })
    return finish(collector, state)
  }

  const normalized = normalizeDocument(document.value, limits, 'tools', (row) => record(collector, row))
  if (normalized.stopped) return finish(collector, state)

  /**
   * Green on no evidence is a defect, not a clean bill of health. A document
   * that declares no usable tool was read rather than checked. The finding is
   * only a warning, so its membership of INCOMPLETE_RULES is the only thing
   * between an empty document and exit 0.
   */
  if (normalized.tools.length === 0) {
    record(collector, {
      ruleId: 'no-tools-declared',
      pointer: '/tools',
      message: 'No usable tool was read from this document, so nothing was compressed and nothing was checked.',
      suggestion: 'Declare at least one tool with a name and an inputSchema.',
    })
    return finish(collector, state)
  }

  const emitted = []
  for (const tool of normalized.tools) {
    /**
     * The budget is checked before each tool, and a tool the budget stopped is
     * NOT compressed and NOT counted as checked. An expired budget that left a
     * half-finished pass looking complete is the exact defect this contract
     * names first: unknown is never a pass.
     */
    if (deadline.exceeded()) {
      record(collector, {
        ruleId: 'time-budget-exceeded',
        pointer: tool.pointer,
        message: `The run exceeded the maxMillis budget of ${limits.maxMillis} before reaching every tool; the tools after this point were copied unchanged and were not checked.`,
        suggestion: 'Raise --max-millis deliberately, or compress fewer tools at once.',
      })
      for (const remaining of normalized.tools.slice(normalized.tools.indexOf(tool))) {
        emitted.push(deepCopy(remaining.entry))
      }
      break
    }

    const toolState = {
      dropAnnotations: input.dropAnnotations === true,
      maxDescriptionChars: limits.maxDescriptionChars,
      protectedScope: protect.has(tool.name),
      counts,
    }
    const pending = []
    const compressed = minifyToolEntry(tool.entry, tool.pointer, toolState, (row) => pending.push(row))

    /**
     * The gate. Nothing is accepted until this comparison has run over it and
     * found no difference that matters. The compressor and the comparison are
     * separate code with separate tables, so a mistake in one shows up here
     * rather than in a shipped artifact.
     */
    const differences = []
    compareToolEntries(tool.entry, compressed, tool.pointer, { protectedScope: protect.has(tool.name) }, (row) => differences.push(row))

    // Recorded whatever the gate decides: an observation about the document --
    // a description that is not a string, a keyword nobody recognised -- is a
    // fact about the input, and losing it because the copy was refused would
    // hide the one thing that might explain why.
    for (const row of pending) record(collector, row)

    const before = measure(tool.entry)
    if (differences.length > 0) {
      for (const difference of differences) record(collector, difference)
      record(collector, {
        ruleId: 'equivalence-not-proven',
        pointer: tool.pointer,
        message: `The compressed copy of "${sanitize(tool.name, 60)}" is not equivalent to the original, so the original was kept.`,
        suggestion: 'Report this: a compressed copy that fails this tool own check is a defect in the compressor, not in the document.',
      })
      emitted.push(deepCopy(tool.entry))
      state.totals.kept += 1
      addTotals(state.totals, before, before)
      state.perTool.push({ name: tool.name, compressed: false, reason: 'not-equivalent', tokensBefore: before.tokens, tokensAfter: before.tokens })
      continue
    }

    const after = measure(compressed)
    if (after.tokens >= before.tokens || after.bytes > before.bytes) {
      /**
       * A compression that did not shrink anything is refused, in EITHER unit.
       *
       * The estimate is monotone in the length of every run it measures, but
       * truncation replaces characters with an ellipsis -- one character, three
       * bytes -- so one character over the budget a copy can cost fewer tokens
       * and MORE bytes than the original. Bytes are the exact number this tool
       * reports, so a copy that grows them is not a compression whatever the
       * estimate says, and the original is kept. That is what makes "a
       * compressed copy is never larger than its input" true of every entry
       * rather than true on average.
       */
      record(collector, {
        ruleId: 'compression-rejected-no-saving',
        pointer: tool.pointer,
        message: after.bytes > before.bytes
          ? `Compressing "${sanitize(tool.name, 60)}" would have grown the definition from ${before.bytes} to ${after.bytes} bytes, so the original was kept.`
          : `Compressing "${sanitize(tool.name, 60)}" saved no estimated tokens, so the original definition was kept.`,
      })
      emitted.push(deepCopy(tool.entry))
      state.totals.kept += 1
      addTotals(state.totals, before, before)
      state.perTool.push({ name: tool.name, compressed: false, reason: 'no-saving', tokensBefore: before.tokens, tokensAfter: before.tokens })
      continue
    }

    emitted.push(compressed)
    state.totals.compressed += 1
    addTotals(state.totals, before, after)
    state.perTool.push({ name: tool.name, compressed: true, reason: 'accepted', tokensBefore: before.tokens, tokensAfter: after.tokens })
  }

  state.totals.tools = state.perTool.length
  state.totals.tokensSaved = state.totals.tokensBefore - state.totals.tokensAfter
  state.totals.savingPerMille = savingPerMille(state.totals.tokensBefore, state.totals.tokensAfter)
  if (state.totals.compressed === 0 && state.totals.tools > 0) {
    record(collector, {
      ruleId: 'nothing-compressed',
      pointer: '/tools',
      message: 'No tool was compressed; the copy is identical to the input.',
    })
  }
  state.document = { schemaVersion: DOCUMENT_SCHEMA_VERSION, tools: emitted }
  return finish(collector, state)
}

function addTotals(totals, before, after) {
  totals.tokensBefore += before.tokens
  totals.tokensAfter += after.tokens
  totals.bytesBefore += before.bytes
  totals.bytesAfter += after.bytes
}

/**
 * Check a compressed copy somebody else produced.
 *
 * Same gate, different subject. This is the mode that answers "is it safe to
 * ship this shortened tool list", which is a question worth asking of a copy
 * whatever produced it.
 */
export function verifyCandidate(input = {}) {
  checkOptions(input, ALLOWED_OPTIONS)
  const limits = validateLimits(input.limits)
  const source = label(input.source ?? DEFAULT_SOURCE) || DEFAULT_SOURCE
  const clock = input.clock ?? defaultClock
  if (typeof clock !== 'function') throw new TypeError('clock must be a function returning elapsed milliseconds')
  const protect = protectSet(input.protectTools)

  const collector = { rows: [], incomplete: false }
  const counts = newCounts()
  const state = { source, mode: 'verify', counts, totals: { ...EMPTY_TOTALS }, document: null, perTool: [] }
  const deadline = createDeadline(clock, limits.maxMillis)

  const original = readDocument(input.bytes, limits, 'tools')
  if (!original.ok) {
    record(collector, { ruleId: original.ruleId, pointer: '/', message: original.message, suggestion: original.suggestion })
    return finish(collector, state)
  }
  const candidate = readDocument(input.candidateBytes, limits, 'candidate')
  if (!candidate.ok) {
    record(collector, { ruleId: candidate.ruleId, pointer: '/', message: candidate.message, suggestion: candidate.suggestion })
    return finish(collector, state)
  }

  const left = normalizeDocument(original.value, limits, 'tools', (row) => record(collector, row))
  if (left.stopped) return finish(collector, state)
  const right = normalizeDocument(candidate.value, limits, 'candidate', (row) => record(collector, row))
  if (right.stopped) return finish(collector, state)

  if (left.tools.length === 0) {
    record(collector, {
      ruleId: 'no-tools-declared',
      pointer: '/tools',
      message: 'No usable tool was read from the original document, so nothing was compared.',
      suggestion: 'Declare at least one tool with a name and an inputSchema.',
    })
    return finish(collector, state)
  }

  const candidateByName = new Map(right.tools.map((tool) => [tool.name, tool]))
  for (const tool of left.tools) {
    if (deadline.exceeded()) {
      record(collector, {
        ruleId: 'time-budget-exceeded',
        pointer: tool.pointer,
        message: `The run exceeded the maxMillis budget of ${limits.maxMillis} before comparing every tool; the tools after this point were not checked.`,
        suggestion: 'Raise --max-millis deliberately, or compare fewer tools at once.',
      })
      break
    }
    const match = candidateByName.get(tool.name)
    if (match === undefined) {
      record(collector, {
        ruleId: 'tool-missing-from-candidate',
        pointer: tool.pointer,
        message: `The tool "${sanitize(tool.name, 60)}" is missing from the compressed copy.`,
        suggestion: 'Restore the tool; a compressed copy drops annotations, not tools.',
      })
      state.perTool.push({ name: tool.name, compressed: false, reason: 'missing', tokensBefore: measure(tool.entry).tokens, tokensAfter: 0 })
      state.totals.kept += 1
      continue
    }
    candidateByName.delete(tool.name)
    const differences = []
    compareToolEntries(tool.entry, match.entry, tool.pointer, { protectedScope: protect.has(tool.name), counts }, (row) => differences.push(row))
    for (const difference of differences) record(collector, difference)
    const before = measure(tool.entry)
    const after = measure(match.entry)
    addTotals(state.totals, before, after)
    const equivalent = differences.length === 0
    if (!equivalent) {
      record(collector, {
        ruleId: 'equivalence-not-proven',
        pointer: tool.pointer,
        message: `The compressed copy of "${sanitize(tool.name, 60)}" is not equivalent to the original.`,
        suggestion: 'Fix the copy, or regenerate it with this tool minify command.',
      })
    }
    if (equivalent) state.totals.compressed += 1
    else state.totals.kept += 1
    state.perTool.push({
      name: tool.name,
      compressed: equivalent,
      reason: equivalent ? 'equivalent' : 'not-equivalent',
      tokensBefore: before.tokens,
      tokensAfter: after.tokens,
    })
  }

  for (const extra of candidateByName.values()) {
    record(collector, {
      ruleId: 'tool-added-in-candidate',
      pointer: extra.pointer,
      message: `The compressed copy declares "${sanitize(extra.name, 60)}", which the original does not.`,
      suggestion: 'Remove it; a compressed copy adds nothing.',
    })
  }

  state.totals.tools = state.perTool.length
  state.totals.tokensSaved = state.totals.tokensBefore - state.totals.tokensAfter
  state.totals.savingPerMille = savingPerMille(state.totals.tokensBefore, state.totals.tokensAfter)
  return finish(collector, state)
}

async function readBytes(path) {
  return new Uint8Array(await readFile(path))
}

function unreadable(ruleId, source, mode, error) {
  const collector = { rows: [], incomplete: false }
  record(collector, {
    ruleId,
    pointer: '/',
    message: `The document could not be read: ${sanitize(String(error.code ?? error.message), 80)}.`,
    suggestion: 'Check the path and the file permissions.',
  })
  return finish(collector, { source, mode, counts: newCounts(), totals: { ...EMPTY_TOTALS }, document: null, perTool: [] })
}

/**
 * Compress the tools in a file.
 *
 * A file that could not be read is an input failure, not a configuration
 * failure: the run had a subject and failed to obtain evidence about it, which
 * is exactly what `incomplete` exists to say, and a consumer needs the report
 * to know which input was not read.
 */
export async function minifyToolFile(path, options = {}) {
  let bytes
  try {
    bytes = await readBytes(path)
  } catch (error) {
    return unreadable('tools-unreadable', label(options.source ?? DEFAULT_SOURCE) || DEFAULT_SOURCE, 'minify', error)
  }
  return minifyTools({ ...options, bytes })
}

/** Check a compressed copy on disk against the original on disk. */
export async function verifyToolFiles(originalPath, candidatePath, options = {}) {
  const source = label(options.source ?? DEFAULT_SOURCE) || DEFAULT_SOURCE
  let bytes
  try {
    bytes = await readBytes(originalPath)
  } catch (error) {
    return unreadable('tools-unreadable', source, 'verify', error)
  }
  let candidateBytes
  try {
    candidateBytes = await readBytes(candidatePath)
  } catch (error) {
    return unreadable('candidate-unreadable', source, 'verify', error)
  }
  return verifyCandidate({ ...options, bytes, candidateBytes })
}

/** The configuration file is small by contract; anything larger is a mistake. */
export const CONFIG_MAX_BYTES = 65536
const CONFIG_KEYS = Object.freeze(['limits'])

/**
 * Read limit overrides from a configuration file.
 *
 * This is the tool's third byte stream and it is decoded exactly as strictly as
 * the other two. A tool in this catalog hardened its data path and left its
 * configuration path lossy, so a mangled byte in a limit silently became a
 * different limit. Every failure here throws: a configuration that could not be
 * read means the run never had a subject, which is exit 2 with an empty stdout.
 */
export async function readConfigFile(path) {
  let bytes
  try {
    bytes = await readBytes(path)
  } catch (error) {
    throw new TypeError(`the configuration could not be read: ${sanitize(String(error.code ?? error.message), 80)}`)
  }
  if (bytes.byteLength > CONFIG_MAX_BYTES) {
    throw new TypeError(`the configuration is ${bytes.byteLength} bytes, over the ${CONFIG_MAX_BYTES} byte configuration budget`)
  }
  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) throw new TypeError('the configuration is not valid UTF-8')
  let parsed
  try {
    parsed = JSON.parse(decoded.text)
  } catch (error) {
    // The detail never carries document text: V8's own message quotes the
    // input back, and a configuration file is small enough to be nothing but
    // a credential.
    throw new TypeError(`the configuration is not valid JSON: ${sanitize(parseFailureDetail(error), 160)}`)
  }
  if (!isRecord(parsed)) throw new TypeError('the configuration must be a JSON object')
  for (const key of ownKeys(parsed)) {
    if (!CONFIG_KEYS.includes(key)) throw new TypeError(`unknown configuration key "${sanitize(key, 60)}"`)
  }
  const overrides = parsed.limits === undefined ? {} : parsed.limits
  validateLimits(overrides)
  return overrides
}

/**
 * Settle where the compressed copy may be written, before any document is read.
 *
 * The destination's directory is created first, because a copy written into a
 * directory this run made is ordinary and refusing it would only push people
 * into `mkdir && run`. The guard then runs over the real destination: a
 * symbolic link at it, a parent that resolves somewhere else, a destination
 * that is not a regular file, and a hard link to an input are each refused
 * before anything is opened. See `src/destination.mjs` for why one check does
 * not cover the others.
 *
 * A refused destination is a configuration error: exit 2 with an empty stdout.
 * A missing INPUT is not refused here -- that is a fact about the input, and it
 * belongs in an `incomplete` report on stdout naming the document that was not
 * read.
 */
export async function prepareDestination(outputPath, options = {}) {
  const { inputs = [], root = null, label = '--out' } = options
  const target = resolve(outputPath)
  try {
    await mkdir(dirname(target), { recursive: true })
  } catch (error) {
    throw new DestinationError(`${label} names a directory that could not be created: ${error.code ?? error.message}`)
  }
  return assertWritableDestination(target, { inputs, root, label })
}

/**
 * Write the compressed copy.
 *
 * Two things matter here, and one of them used to be wrong.
 *
 * The copy is serialised COMPACT, which is the form `bytesBefore` and
 * `bytesAfter` are measured on. Pretty-printing it put a file on disk that was
 * 71% LARGER than the input while the report announced a byte saving -- the
 * numbers were exact about a document the tool never wrote. A tool list is sent
 * to a model as compact JSON anyway; readable indentation is what `jq` is for.
 *
 * `escapeJsSeparators` turns U+2028 and U+2029 into their JSON escapes so a
 * description carrying one cannot break a JavaScript module that embeds the
 * copy. It changes no JSON value: the escape and the raw character parse alike.
 */
export async function writeArtifactFile(destination, document) {
  const path = typeof destination === 'string' ? destination : destination.path
  const json = escapeJsSeparators(JSON.stringify(document))
  await writeFile(path, `${json}\n`, 'utf8')
  return path
}

const STATUS_LINE = Object.freeze({
  pass: 'PASS',
  fail: 'FAIL',
  incomplete: 'INCOMPLETE',
})

/**
 * The human summary.
 *
 * Every string in it has already been through `sanitize`, so a tool name
 * carrying a newline cannot forge a line here.
 */
export function formatReport(report, mode = 'minify') {
  const lines = []
  const summary = report.summary
  lines.push(`${STATUS_LINE[report.status]}  ${report.tool} (${sanitize(mode, 20)})`)
  lines.push(`  tools checked        : ${summary.checked}`)
  lines.push(`  compressed / kept    : ${summary.toolsCompressed} / ${summary.toolsKept}`)
  lines.push(`  estimated tokens     : ${summary.tokensBefore} -> ${summary.tokensAfter} (saved ${summary.tokensSaved}, ${(summary.tokenSavingPerMille / 10).toFixed(1)}%)`)
  lines.push(`  bytes                : ${summary.bytesBefore} -> ${summary.bytesAfter}`)
  lines.push(`  protected descriptions: ${summary.protectedDescriptions}`)
  lines.push(`  errors / warnings    : ${summary.errors} / ${summary.warnings}`)
  if (report.findings.length === 0) {
    lines.push('  no findings')
  } else {
    for (const finding of report.findings) {
      lines.push(`  [${finding.severity}] ${finding.ruleId} ${finding.location.pointer}`)
      lines.push(`      ${finding.message}`)
    }
  }
  if (report.status === 'incomplete') {
    lines.push('  this run is not a verdict: part of the document was not read or not checked')
  }
  return `${lines.join('\n')}\n`
}
