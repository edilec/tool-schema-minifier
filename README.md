# Tool Schema Minifier

Compress a tool-definition document, report what it saved, and refuse the copy
if it no longer means the same thing.

- **Repository:** [edilec/tool-schema-minifier](https://github.com/edilec/tool-schema-minifier)
- **Area:** Prompt & Agent Workflows
- **License:** MIT

## What it does

A long tool list is expensive. The usual way to shorten one is to delete
whatever looks decorative -- and that is how a `required` list, an `enum`
value, or the sentence telling a model to ask a person before deleting
something quietly stops being there.

This tool shortens a tool list the other way round. It applies a small, fixed
set of transforms, and then **compares the copy against the original, keyword by
keyword, before accepting it**. Anything that decides whether an argument is
accepted, and any description that governs an approval, must come through
byte-identical or the copy is refused and the original is kept.

It has two commands:

- `minify` builds the compressed copy, checks it, and reports the difference.
- `verify` checks a compressed copy produced somewhere else -- by hand, by a
  script, by another tool -- against the original. The same gate, the same
  rules. An unprotected description may arrive collapsed or cut short; text
  substituted for it is `description-rewritten`, because a description is what a
  model reads to decide whether to call a tool and whether to ask a person
  first.

Nothing is fetched, no model is called, no network is touched, and the only
clock is the one the command line injects for its own time budget.

## Why it exists

Three properties are hard to get right by inspection and easy to get right by
construction:

1. **A compression nobody checked is a change nobody reviewed.** The compressor
   and the equivalence check are separate code here, so a mistake in one shows
   up as a refused copy rather than as a shipped artifact. `test/gate.test.mjs`
   proves it by breaking the compressor on purpose -- a guarantee about what
   happens when other code is wrong cannot be tested with code that is right.
2. **`title`, `examples`, `example` and `$comment` are annotations *in a schema
   position*.** Inside `properties` the same words are parameter names. A
   minifier that walks the tree deleting keys by name deletes the parameters,
   and a schema that declares a parameter called `title` is not exotic. Every
   transform here knows which position it is standing in, and
   `test/minify.test.mjs` pins it.
3. **The description is the safety interface.** The sentence a model reads
   before deciding whether to ask a person first is not filler. A shortened
   version of it is a different tool.

## Quick start

```sh
# Compress, check, and write the copy (only written when the run passes)
node bin/tool-schema-minifier.mjs minify \
  --tools examples/tools.json \
  --out build/tools.min.json \
  --drop-annotations --human

# Check a copy produced somewhere else -- this one is deliberately broken
node bin/tool-schema-minifier.mjs verify \
  --tools examples/tools.json \
  --candidate examples/compressed-broken.json --human
echo "exit: $?"   # 1

# The machine-readable report, which is what stdout carries by default
node bin/tool-schema-minifier.mjs minify --tools examples/tools.json | jq .summary

npm run check     # lint, tests, both examples, and a packaging dry run
```

`examples/compressed-broken.json` is the failing example. It drops a `required`
list, removes an `enum` value, removes a parameter, and shortens an
approval-governing description -- and the run exits `1` naming each one.

## Input

A JSON document of tool definitions:

```json
{
  "schemaVersion": "1",
  "tools": [
    {
      "name": "delete_document",
      "description": "Permanently delete a document...",
      "x-approval": true,
      "inputSchema": { "type": "object", "properties": {}, "required": [] }
    }
  ]
}
```

`schemaVersion` is optional and defaults to `"1"`, so a `tools/list` response
from an MCP server can be passed straight in. Any other top-level key is
refused rather than ignored: it usually means the document is in a format this
tool does not understand, and guessing would be worse than stopping.

Tool entry keys this tool understands are `name`, `title`, `description`,
`inputSchema`, `outputSchema`, `annotations`, `x-approval` and
`x-safety-critical`. Anything else is copied unchanged and reported as
`tool-key-unrecognized`.

## What may change, and what may not

| May change | Never changes |
| --- | --- |
| runs of whitespace inside an unprotected description | `required`, `enum`, `const`, `type` and every other validation keyword |
| the length of an unprotected description (`--max-description-chars`): its tail is cut, never its content substituted | any parameter, including one named `title` or `examples` |
| `title`, `$comment`, `example`, `examples` in a schema position, with `--drop-annotations` | any description that governs an approval |
| | any keyword this tool does not recognise, and everything under it |
| | `default`, `format`, `pattern`, `$ref`, `$defs` and the rest of the vocabulary |

A description is **protected** -- copied byte for byte, whitespace included --
when any one of these holds:

- its schema node, or the tool entry containing it, carries `"x-approval": true`
  or `"x-safety-critical": true`;
- `--protect-tool NAME` names its tool;
- its text matches the frozen marker list in
  [`docs/compression-rules.md`](./docs/compression-rules.md).

The marker list is a word list, and a word list cannot understand a sentence. It
errs deliberately toward protection: a false positive costs a few bytes and a
false negative costs a safety notice. `x-approval` is the authoritative
mechanism.

## Rules

Fifty-three rules, each with a fixed severity, listed in full in
[`docs/compression-rules.md`](./docs/compression-rules.md). The three classes:

| Class | Severity | Status | Exit |
| --- | --- | --- | ---: |
| evidence not obtained -- unread document, refused tool, expired budget | `error` (and `no-tools-declared`, a `warning`) | `incomplete` | 2 |
| a difference between an original and its copy | `error` | `fail` | 1 |
| work done as designed -- annotation dropped, description collapsed, description protected | `info` / `warning` | `pass` | 0 |

Severity is not defended by the table alone. `test/severity-behaviour.test.mjs`
drives **every one of the fifty-three rules** through the real command line over
a real document and asserts the exit code, because three declarations agreeing
with each other can be edited together and an exit code cannot.

## Reports

stdout carries the JSON report and nothing else, so it can be piped straight
into a parser. `--human` writes the readable summary there instead. Progress,
the mode, and the reason a copy was not written go to stderr.

```json
{
  "schemaVersion": "1",
  "tool": "tool-schema-minifier",
  "status": "pass",
  "summary": { "checked": 3, "errors": 0, "warnings": 0, "tokensBefore": 1177, "tokensAfter": 1057 },
  "findings": []
}
```

Findings are ordered by `(location.pointer, ruleId, message)`, compared by
UTF-16 code unit -- never by `localeCompare` or `Intl.Collator`, whose ICU data
differs between Node builds and would let two correct machines disagree about
the same output. `test/ordering.test.mjs` pins the emitted order with names
whose collated order genuinely differs.

Two runs over the same input produce byte-identical stdout.

## The token number is an estimate

`tokensBefore`, `tokensAfter` and `tokensSaved` come from a declared
pre-tokenizer with **no vocabulary and no merge table**. See
[`docs/token-estimate.md`](./docs/token-estimate.md) for the exact algorithm.

- It is comparable between two documents measured by this tool.
- It is **not** any provider's billing count, and must not be used as one.
- `bytesBefore` and `bytesAfter` are exact.

A compression that does not lower the estimate is refused and the original is
kept, so a compressed copy is never larger than its input.

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | the copy was checked and is equivalent; nothing protected changed |
| `1` | the copy is not equivalent, or a protected description, required list, enum or parameter changed |
| `2` | invalid usage or configuration (**stdout empty**), or evidence missing, unreadable or bounded out (an `incomplete` report on stdout) |

The two shapes of exit 2 are deliberate. A configuration error means the run
never had a subject, so there is nothing to report about. An unreadable input
means the run had a subject and failed to obtain evidence about it, and a
consumer needs the report to know *which* input was not read.

## Limits

Every limit is enforced, wired to a flag and to `--config`, and reported by
name. Nothing is truncated to fit: a document over a limit is refused whole and
the run is `incomplete`.

| Flag | Default | Refuses |
| --- | ---: | --- |
| `--max-bytes` | 4194304 | the document |
| `--max-tools` | 500 | the document |
| `--max-nodes` | 50000 | the document |
| `--max-depth` | 32 | the document |
| `--max-description-chars` | 240 | nothing; it is the description budget |
| `--max-millis` | 10000 | the tools not yet reached |

An unknown limit name, an unknown option, an unknown configuration key and a
repeated flag are all refused rather than ignored: a typo that falls back to a
default is a real failure reported as a green run.

## Non-goals

This tool does **not**:

- reproduce any provider's tokenizer, or produce a billing-accurate token count;
- understand what a description *means*; the approval classifier is a frozen
  word list plus two explicit flags, and nothing more;
- validate a document against a JSON Schema meta-schema, or check that a schema
  is well formed -- an unrecognised keyword is preserved, not judged;
- rewrite, reorder, normalise or "improve" a schema; the only transforms are the
  ones in the table above;
- resolve `$ref`, fetch a remote schema, or contact a network of any kind;
- edit the input document. It is read-only, and the copy goes to a separate
  destination that is checked before anything is opened: a symbolic link at the
  destination, a parent directory that resolves somewhere else, anything that is
  not a regular file, and any spelling of an input -- including a hard link to
  it -- are each refused, and a refused destination is a configuration error
  (exit `2`, empty stdout). The three holes are independent, so each has its own
  check and its own case in `test/destination.test.mjs`;
- decide whether a tool is safe to expose. It reports what changed and what did
  not.

Input content -- names, descriptions, keywords -- is data. A description asking
for different behaviour is text in a document, not an instruction to this tool.

## Repository layout

- `src/` -- implementation (`text`, `tokens`, `destination`, `schema`,
  `document`, `index`)
- `bin/` -- the command line interface
- `test/` -- `node:test`, no dependencies
- `examples/` -- a document that passes and a copy that fails
- `docs/` -- the rule catalog and the token estimator

## Development

Zero runtime dependencies and zero development dependencies. Node 22 or later.

```sh
npm run check
```

## License

MIT. See [LICENSE](./LICENSE).
