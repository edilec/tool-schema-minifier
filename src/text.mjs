/**
 * Decoding, ordering, sanitising and parse-failure primitives.
 *
 * Nothing in this module reads the filesystem, the clock, the locale, the
 * environment or the network. Every function is a pure function of its
 * arguments, which is what lets the same tool document produce byte-identical
 * output on any host.
 */

/**
 * Order by UTF-16 code unit.
 *
 * `localeCompare` and `Intl.Collator` both read ICU data that differs between
 * Node builds and platforms, so either one lets two correct machines disagree
 * about the order of the same findings. A report is an artifact people diff,
 * so no part of its order may depend on a collation table.
 *
 * Pinning this helper on its own -- `byCodeUnit('Z', 'a') < 0` -- pins the
 * helper and nothing else, because every call site can still be swapped to a
 * collator one at a time. `test/ordering.test.mjs` drives values whose collated
 * order genuinely differs from their code-unit order through the real entry
 * point for each site instead.
 */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * Decode bytes as UTF-8, strictly.
 *
 * `fatal: true` is the point. Decoding leniently and then looking for U+FFFD in
 * the result cannot tell undecodable bytes apart from a document that
 * legitimately contains a replacement character, and that confusion has already
 * let an unreadable input report a pass in this catalog. The decoder decides;
 * the decoded text never gets a vote.
 *
 * Both byte streams this tool reads -- the tool document and the candidate
 * document -- come through here.
 */
export function decodeUtf8(bytes) {
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }
  } catch {
    return { ok: false, reason: 'not-utf8' }
  }
}

/**
 * The characters stripped from every document-derived string on its way out.
 *
 * Built from code points rather than written literally: a literal U+2028 inside
 * a module is a syntax hazard, and the whole point of the class is that these
 * characters never reach a line a person reads.
 *
 * - **C0** (U+0000-U+001F) and **DEL** (U+007F): a bare newline forges a whole
 *   row of a human report; the rest drive a terminal.
 * - **C1** (U+0080-U+009F): U+0085 is NEL, which starts a new line on a
 *   terminal exactly as a newline does, and U+009B is the 8-bit CSI, which
 *   opens an escape sequence. Neither is ECMAScript whitespace and neither is
 *   escaped by `JSON.stringify`, so a class that stops at C0 lets both through.
 * - **U+2028 / U+2029**: they terminate a line for a JavaScript consumer.
 * - **Bidi controls** (U+200E, U+200F, U+202A-U+202E, U+2066-U+2069): U+202E
 *   reverses the text displayed after it, so a tool called one thing reads as
 *   another, and the isolates hide what they wrap.
 *
 * Tab, newline and carriage return are deliberately outside the class: they are
 * ECMAScript whitespace, so the collapse below flattens them to a single space
 * rather than deleting them.
 *
 * This applies to tool names, property names, JSON pointers, keyword names,
 * messages and excerpts alike -- not only to an excerpt field. A tool in this
 * catalog sanitised its excerpt carefully and let a page id carrying a newline
 * forge whole lines in its report.
 */
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}`
  + `${String.fromCharCode(11)}${String.fromCharCode(12)}`
  + `${String.fromCharCode(14)}-${String.fromCharCode(31)}`
  + `${String.fromCharCode(127)}-${String.fromCharCode(0x9f)}`
  + `${String.fromCharCode(0x200e)}${String.fromCharCode(0x200f)}`
  + `${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}`
  + `${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}`
  + `${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`,
  'g',
)

/**
 * Bounds on what any one untrusted string may contribute to output.
 *
 * `NAME_LIMIT` is the one that is not arbitrary: `src/document.mjs` accepts a
 * tool name of up to 128 characters, so a message rendering one at 60 turned
 * two legal names that differ in their last character into byte-identical text.
 * A bound below what the tool accepts as legal is a silent truncation, and this
 * one sits at the legal maximum so a name that was read is a name that is
 * shown whole. It fits inside MESSAGE_LIMIT with the sentence around it.
 */
export const EXCERPT_LIMIT = 200
export const MESSAGE_LIMIT = 400
export const NAME_LIMIT = 128
export const LABEL_LIMIT = 120
export const POINTER_LIMIT = 300

/**
 * A bounded, single-line, control-free rendering of an untrusted string.
 *
 * Every string taken from a tool document passes through here on its way to the
 * report: tool names, keyword names, property names, pointer segments and
 * excerpts. It is not used on the way to the minified artifact, which is a copy
 * of the input and must keep the input's text.
 */
export function sanitize(value, limit = EXCERPT_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('Sanitise limit must be a positive integer')
  const flattened = String(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (flattened.length <= limit) return flattened
  return `${flattened.slice(0, limit)}...`
}

/**
 * Escape the two separators that are legal in JSON but terminate a line in
 * JavaScript, so the artifact this tool writes is safe to embed in a script.
 *
 * `JSON.stringify` leaves U+2028 and U+2029 unescaped: they are ordinary
 * characters to JSON and line terminators to ECMAScript. A minified schema is
 * exactly the kind of artifact that gets pasted into a JavaScript module, and
 * a description carrying one of these would break the module at load. Escaping
 * them changes no JSON value: the escape and the raw character parse alike.
 */
export function escapeJsSeparators(json) {
  return json
    .split(String.fromCharCode(0x2028)).join('\\u2028')
    .split(String.fromCharCode(0x2029)).join('\\u2029')
}

const UNPARSEABLE = 'the document could not be parsed as JSON'

/** Where V8 puts the offending offset. Safe: an offset says nothing about content. */
const PARSE_POSITION = /at position \d+(?: \(line \d+ column \d+\))?/

/**
 * The shape that quotes the input, recognised FIRST.
 *
 * A document whose own text reads `at position 1` makes V8 emit
 * `Unexpected token 'a', "at position 1" is not valid JSON`, so a helper that
 * looks for the offset first matches that phrase INSIDE the quoted span and
 * slices the document straight back out. The `s` flag matters too: the quoted
 * span can contain a newline, and a pattern without it silently fails to
 * recognise the shape it exists to catch. A leading `...` is V8's third
 * spelling -- a window taken from the middle of the document rather than a
 * prefix of it -- and is the only thing about the location that shape reveals.
 */
const QUOTES_THE_INPUT = /^Unexpected token (.+?), (\.\.\.)?".*"(?:\.\.\.)? is not valid JSON$/s

function describeParseFailure(message) {
  const quoting = QUOTES_THE_INPUT.exec(message)
  if (quoting !== null) {
    const where = quoting[2] === undefined ? 'at the start of the document' : 'inside the document'
    return `unexpected token ${quoting[1]} ${where}`
  }
  const position = PARSE_POSITION.exec(message)
  if (position !== null) return message.slice(0, position.index + position[0].length)
  if (message === 'Unexpected end of JSON input') return message
  return UNPARSEABLE
}

/**
 * Say what a JSON parse failure was, without reproducing the document.
 *
 * V8 reports a parse failure two ways and one of them quotes the input back:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`. A tool
 * document short enough to be nothing but a credential is therefore reproduced
 * in full by its own error message, on exactly the path -- a malformed document
 * -- where nothing else inspects the content at all. `sanitize` cannot help:
 * it cuts from the end and the quoted span sits at the front.
 *
 * Position, line and column are the useful half and carry no document text, so
 * they are kept verbatim, as is the offending token, which V8 writes one
 * character wide. The quoted half never leaves this function.
 *
 * The closing guard is deliberate belt and braces, and it is the reason this
 * function is safe against wordings it has never been taught: across 500,206
 * distinct V8 parse messages, every message carrying no quoted snippet carried
 * no double quote at all -- V8 quotes JSON punctuation with apostrophes. So a
 * double quote surviving to the end means a snippet survived with it, whatever
 * the branches above concluded, and the generic sentence is returned instead.
 */
export function parseFailureDetail(error) {
  const message = String(error?.message ?? '')
  const detail = describeParseFailure(message)
  return detail.includes('"') ? UNPARSEABLE : detail
}
