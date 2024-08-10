# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Rule ids are part of the public interface: renaming or removing one is a
breaking change and is recorded here.

## [Unreleased]

### Added

- `description-rewritten` (error): an unprotected description in a copy that is
  different text rather than a shorter form of the original. `verify` used to
  require only that it be a non-empty string, so a copy could substitute
  arbitrary caller-chosen text for any description the marker list did not
  protect -- a tool's own top-level description included -- and still be
  reported equivalent with exit `0` and no findings at all. The permitted forms
  are now exactly the two the README's table lists: whitespace collapsed, and
  the tail cut with or without the ellipsis this tool writes.

### Fixed

- The written copy can no longer be larger than the input while the report
  announces a saving. `bytesBefore` / `bytesAfter` were measured on the compact
  serialisation and the file was written pretty-printed, so a reported 182 ->
  170 byte saving put a 366-byte file beside a 214-byte input, and a 4,036,283
  byte input produced a 4,154,854 byte copy. The copy is now written compact,
  which is the form those numbers measure.
- A compression that would raise the exact byte count is refused as well as one
  that does not lower the token estimate. Truncation appends an ellipsis -- one
  character, three bytes -- so one character over the budget a copy could cost
  fewer tokens and more bytes, and be accepted.
- The equivalence gate is pinned. `minifyTools` ran `compareToolEntries` over
  its own output before accepting it, but the call could be deleted outright and
  every test stayed green -- because a correct compressor gives the gate nothing
  to catch. `test/gate.test.mjs` copies the tool, makes its compressor
  position-blind, and asserts that the gate refuses the result: status `fail`,
  exit 1, `property-removed`, and no artifact on disk. With the gate deleted
  that same broken compressor exits 0 with status `pass` and writes a copy whose
  `required` list names a parameter it no longer declares.
- Equivalence is reflexive again. `compareDescription` asked only whether the
  CANDIDATE description was empty, so any document carrying `"description": ""`
  or a whitespace-only description -- which a real MCP `tools/list` response
  does -- was declared not equivalent to a byte-identical copy of itself:
  `verify` exited `1` on two files `cmp` calls identical, `minify` refused to
  compress and told the operator to report a compressor defect that does not
  exist. "Emptied" is a claim about what the copy did, so the original now
  decides it. A description the copy really did empty is still
  `description-removed`.

- `--out` no longer writes through a **symbolic link at the destination**. The
  link was resolved and followed, so a run could destroy an unrelated file and
  exit `0` reporting `compressed copy written`. The destination is now inspected
  with `lstat` and refused on sight, before anything is opened, and the parent
  directory is resolved rather than compared as text. A hard link to an input
  was already refused and still is. `test/destination.test.mjs` has a case per
  hole and a case per legitimate destination, and each check is proved to bite
  by removing it.
- A missing input document no longer reports a broken `--out`. The destination
  check stat'ed the input, so `minify --tools absent.json --out copy.json`
  exited `2` with an **empty stdout** blaming `--out`; the contract requires an
  input that could not be read to produce an `incomplete` report on stdout
  naming that input, which is what it now does.

### Changed

- The directory named by `--out` is created if it is missing, before the
  destination is checked, so the check runs against the real parent.

## [0.1.0]

### Added

- `minifyTools`, `minifyToolFile`, `verifyCandidate` and `verifyToolFiles`:
  compress a tool-definition document, or check a compressed copy produced
  elsewhere against its original.
- A semantic equivalence gate that runs **before** any compression is accepted.
  The compressor and the comparison are separate code with separate keyword
  tables, so a mistake in one is caught by the other. A tool whose copy differs
  keeps its original definition and the run fails.
- Byte-for-byte retention of every description that governs an approval, where
  protection comes from `x-approval` / `x-safety-critical` on the node or the
  tool, from `--protect-tool`, or from a frozen marker list documented in
  `docs/compression-rules.md`.
- Position-aware transforms: `title`, `$comment`, `example` and `examples` are
  annotations in a schema position and parameter names inside `properties`,
  `patternProperties`, `$defs`, `definitions` and `dependentSchemas`. A
  parameter named after an annotation keyword is never deleted.
- Verbatim preservation of any keyword this tool does not recognise, and of
  everything under it: an unrecognised keyword may be an applicator.
- A declared token estimator with no vocabulary, documented in
  `docs/token-estimate.md`, reported alongside exact byte counts. A compression
  that does not lower the estimate is refused, so a copy is never larger than
  its input.
- `tool-schema-minifier` command line interface with `minify` and `verify`,
  `--tools`, `--candidate`, `--out`, `--drop-annotations`, `--protect-tool`,
  `--config`, `--human`, `--help` and the six documented limit flags.
- Fifty-two rules with severities pinned in one frozen table and behaviourally
  in `test/severity-behaviour.test.mjs`, which drives every rule through the
  real command line and asserts the exit code; twenty-four of them make the run
  `incomplete`.
- Six explicit limits -- bytes, tools, nodes, depth, description characters and
  milliseconds -- each enforced, each wired to a flag and to `--config`, and
  each reported by name. Nothing is truncated to fit.
- A compressed copy is written only for a run that passes, never over the input
  document, and never over a hard or symbolic link to it: the destination is
  compared by device and inode rather than by path text.
- U+2028 and U+2029 are escaped when the copy is serialised, so a description
  carrying one cannot break a JavaScript consumer that embeds it.
- Control, C1 and bidi characters are stripped from every document-derived
  string on its way into a report -- keyword names and parameter names included,
  not only excerpts.
- `parseFailureDetail`, exported, which describes a JSON parse failure without
  reproducing the document V8 quotes back in its own message.

### Notes

- The report envelope is exactly the one in the Edilec report contract, and
  `summary` carries integers only. The run mode reaches a person through the
  human summary and stderr, and a caller through the return value.
- Ordering is by UTF-16 code unit everywhere, never by `localeCompare` or
  `Intl.Collator`.
