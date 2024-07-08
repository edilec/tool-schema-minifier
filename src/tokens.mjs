/**
 * A declared, deterministic token estimate.
 *
 * This tool reports how much smaller a compressed copy of a tool schema is. The
 * honest unit for that is bytes, and bytes are reported exactly. Tokens are what
 * a context window is actually spent in, so they are reported too -- but with an
 * estimator, not a tokenizer.
 *
 * **This is not a BPE tokenizer and carries no vocabulary.** It is a
 * pre-tokenizer of the shape `tiktoken` uses (letters, digits and punctuation
 * split apart, with a leading space attached to the run that follows), with a
 * fixed characters-per-token ratio applied to each run instead of a merge
 * table. That means:
 *
 * - The number is comparable between two documents measured by *this* tool.
 * - It is **not** comparable to any provider's billing count, and must not be
 *   used as one. `docs/token-estimate.md` states the same limit, and the README
 *   lists "reproducing a provider's tokenizer" as a non-goal.
 *
 * The ratios are deliberately crude and are the whole model:
 *
 * | run | tokens |
 * | --- | --- |
 * | letters | `ceil(length / 4)` |
 * | digits | `ceil(length / 3)` |
 * | other non-space characters | `length` |
 * | whitespace | `0` for a single space, otherwise `ceil((length - 1) / 8)` |
 *
 * Punctuation counts one token per character because JSON structure is mostly
 * punctuation and BPE merges little of it; a single separating space is free
 * because a BPE vocabulary attaches it to the following word. Every ratio is
 * monotone in length, so shortening a run can never raise its estimate -- which
 * is the property `minifyTools` relies on when it refuses a compression that
 * did not actually save anything.
 */

/**
 * Runs of letters, digits, other visible characters, and whitespace.
 *
 * `u` is required for the property escapes. The alternation is ordered so that
 * whitespace is only matched when it is not part of a following run, which
 * keeps every character in exactly one run and makes the estimate a function of
 * the text alone.
 */
const RUN = /\p{L}+|\p{N}+|[^\s\p{L}\p{N}]+|\s+/gu

const WHITESPACE = /^\s+$/
const LETTERS = /^\p{L}+$/u
const DIGITS = /^\p{N}+$/u

/** Estimated tokens for one string. Pure, and identical on every host. */
export function estimateTokens(text) {
  const value = String(text)
  let total = 0
  for (const match of value.matchAll(RUN)) {
    const run = match[0]
    if (WHITESPACE.test(run)) {
      total += run.length <= 1 ? 0 : Math.ceil((run.length - 1) / 8)
    } else if (LETTERS.test(run)) {
      total += Math.ceil(run.length / 4)
    } else if (DIGITS.test(run)) {
      total += Math.ceil(run.length / 3)
    } else {
      total += run.length
    }
  }
  return total
}

/**
 * What a tool definition costs, measured the way it is actually sent.
 *
 * A tool definition reaches a model as JSON text, so the estimate is taken over
 * its compact JSON serialisation rather than over its descriptions alone. Key
 * order follows the object, which both the original and the compressed copy
 * build in the same order, so the comparison is between like and like.
 */
export function measure(value) {
  const json = JSON.stringify(value) ?? 'null'
  return { bytes: Buffer.byteLength(json, 'utf8'), characters: json.length, tokens: estimateTokens(json) }
}

/**
 * A saving as an integer per mille, rounded half up, or `0` when there was
 * nothing to save.
 *
 * Integers rather than a ratio: a percentage with a fraction invites a float in
 * the report, and two hosts printing the same float is one more thing to have
 * to be sure of. Per mille keeps one useful digit past the percent.
 */
export function savingPerMille(before, after) {
  if (!Number.isFinite(before) || before <= 0) return 0
  return Math.round(((before - after) * 1000) / before)
}
