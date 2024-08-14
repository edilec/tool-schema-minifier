# Compression rules

The catalog of rule ids, their severities, and what each one means.

A rule id is part of the public interface: renaming or removing one is a
breaking change and is recorded in the changelog.

## How severity decides the outcome

Severity is the whole difference between a run that fails and one that passes,
so it is taken from one frozen table in `src/index.mjs` and nowhere else. An
unknown rule id throws rather than producing a finding with no severity.

That table is the **source of truth**, not the guard. A table, this page and a
hand-written expected map in a test are three declarations agreeing with each
other, and one coordinated edit satisfies all three. `test/severity-behaviour.test.mjs`
therefore drives every rule below through the real command line over a real
document and asserts the observable outcome -- `status` and the exit code --
because an exit code cannot be edited.

| Class | Severity | Status | Exit |
| --- | --- | --- | ---: |
| evidence the run did not obtain | `error`, plus one `warning` | `incomplete` | 2 |
| a difference between an original and its copy | `error` | `fail` | 1 |
| work done as designed | `info` / `warning` | `pass` | 0 |

"Incomplete" in the tables below means the rule is a member of
`INCOMPLETE_RULES`, so emitting it makes the run `incomplete` whatever its
severity. For `no-tools-declared` -- the only `warning` in that list -- that
membership is the **only** thing standing between an empty document and exit 0,
which is why `test/incompleteness.test.mjs` drives every member of the list
through a real entry point.

## Reading the document

| Rule | Severity | Incomplete | Meaning |
| --- | --- | --- | --- |
| `tools-unreadable` | error | yes | The tool document could not be opened. |
| `tools-not-utf8` | error | yes | The bytes are not valid UTF-8. Decoding is strict, so nothing is guessed. |
| `tools-not-json` | error | yes | The document is not valid JSON. The detail never reproduces the document. |
| `tools-malformed` | error | yes | The document is not an object with a `tools` array. |
| `tools-too-large` | error | yes | Over `--max-bytes`. The document is refused whole, never truncated. |
| `tools-too-deep` | error | yes | Nests deeper than `--max-depth`, whose highest accepted value is 1000: the comparison recurses, so past that the stack gives out and a crash is not a report. |
| `tools-too-many-nodes` | error | yes | More objects and arrays than `--max-nodes`. |
| `candidate-unreadable` | error | yes | The compressed copy could not be opened (`verify`). |
| `candidate-not-utf8` | error | yes | The copy is not valid UTF-8. |
| `candidate-not-json` | error | yes | The copy is not valid JSON. |
| `candidate-malformed` | error | yes | The copy is not an object with a `tools` array. |
| `candidate-too-large` | error | yes | The copy is over `--max-bytes`. |
| `candidate-too-deep` | error | yes | The copy nests deeper than `--max-depth`. |
| `candidate-too-many-nodes` | error | yes | The copy holds more nodes than `--max-nodes`. |
| `unknown-document-key` | error | yes | A top-level key this tool does not understand. The document may be in another format, so nothing is compressed. |
| `schema-version-unsupported` | error | yes | `schemaVersion` is not `"1"`. |
| `too-many-tools` | error | yes | Over `--max-tools`. |
| `time-budget-exceeded` | error | yes | `--max-millis` ran out. The tools after that point are copied unchanged and are **not** counted as checked. |

## Reading a tool

| Rule | Severity | Incomplete | Meaning |
| --- | --- | --- | --- |
| `tool-malformed` | error | yes | A tool entry is not an object. |
| `tool-name-invalid` | error | yes | A name is missing or is outside `[A-Za-z0-9_.-]{1,128}`. |
| `tool-name-duplicated` | error | yes | Two tools share a name, so neither can be told from the other. |
| `tool-schema-missing` | error | yes | A tool has no `inputSchema` object. |
| `description-malformed` | error | yes | A `description` is not a string, so nothing about it could be checked. |

## The equivalence gate

Every rule here is an `error` and **none** of them makes the run incomplete:
each states a fact the run established, so the run fails rather than abstains.

| Rule | Meaning |
| --- | --- |
| `required-changed` | The `required` set differs. Compared as a set, so a reorder is allowed and a dropped requirement is not. |
| `enum-changed` | An `enum` differs in values or in order. |
| `const-changed` | A `const` differs. |
| `type-changed` | A `type` differs. |
| `constraint-changed` | Any other recognised validation keyword differs or is missing. |
| `property-removed` | A parameter present in the original is missing from the copy. |
| `property-added` | The copy declares a parameter the original does not. |
| `structure-changed` | A schema position has a different shape -- an object replaced by a boolean, an applicator array of a different length. |
| `keyword-added` | The copy adds a keyword the original does not have. |
| `annotation-changed` | An annotation is present in both and differs. Dropping one is allowed; rewriting one is not. |
| `unknown-keyword-changed` | An unrecognised keyword differs. It may be an applicator, so it is never safe to change. |
| `unknown-keyword-removed` | An unrecognised keyword is missing from the copy. |
| `description-removed` | An unprotected description is missing from the copy, is not a string, or was emptied by it. Emptied means the original held text and the copy does not: a description that was already empty in the original is not something the copy did, and reporting it made two identical documents non-equivalent. |
| `description-rewritten` | An unprotected description in the copy is different text rather than a shorter form of the original. A copy may collapse runs of whitespace and cut the tail; it may not substitute content. |
| `safety-description-changed` | A description governing an approval is not byte-identical. |
| `safety-description-removed` | A description governing an approval is missing. |
| `tool-entry-changed` | A tool entry key outside the schema differs, is missing, or was added. |
| `tool-missing-from-candidate` | The copy does not declare a tool the original does. |
| `tool-added-in-candidate` | The copy declares a tool the original does not. |
| `equivalence-not-proven` | Emitted once per tool whose comparison found any of the above. In `minify` the original is kept. |

## Work done as designed

| Rule | Severity | Meaning |
| --- | --- | --- |
| `description-collapsed` | info | Runs of whitespace in an unprotected description became single spaces. |
| `description-truncated` | info | An unprotected description was cut to `--max-description-chars`. |
| `description-protected` | info | A description governing an approval was copied byte for byte. |
| `annotation-dropped` | info | `title`, `$comment`, `example` or `examples` was removed from a schema position, with `--drop-annotations`. |
| `schema-keyword-unrecognized` | info | A keyword this tool does not know was copied unchanged, and its subtree was not entered. |
| `tool-key-unrecognized` | info | A tool entry key this tool does not know was copied unchanged. |
| `compression-rejected-no-saving` | info | The copy did not lower the token estimate, or would have raised the exact byte count, so the original was kept. Truncation appends an ellipsis -- one character, three bytes -- so at the boundary a shorter description can cost more bytes. |
| `nothing-compressed` | info | No tool was compressed; the copy is identical to the input. |
| `description-contains-control` | warning | A description carries a control, bidi or line-separator character that can forge or hide text where the tool list is displayed. The character is reported by class, never echoed raw, and a protected description is still copied unchanged -- this tool does not silently rewrite text it has said it will not touch. |

## When a description is protected

A protected description is copied byte for byte, whitespace included, and any
difference in a copy is `safety-description-changed`. A description is protected
when **any** of these holds:

1. its schema node carries `"x-approval": true` or `"x-safety-critical": true`;
2. an enclosing node or the tool entry carries one of those flags -- protection
   is a scope, not a single field;
3. `--protect-tool NAME` names the tool;
4. its own text matches the marker list below, case-insensitively, on a word
   boundary.

### The marker list

```
approval        approve       approved      approves      authorisation
authorise       authorised    authorization authorize     authorized
billing         cannot be undone            charge        confirm
confirmation    confirms      consent       credential    credentials
dangerous       delete        deleted       deletes       deleting
deletion        destructive   erase         irreversible  irrevocable
password        payment       permanent     permanently   permission
permissions     privileged    purchase      refund        revoke
secret          secrets       transfer      unsafe        wire transfer
```

This is a word list, and a word list cannot understand a sentence. It is
deliberately over-broad, because matching costs a few bytes and missing costs a
safety notice. It is the floor, not the ceiling: `x-approval` is the
authoritative mechanism, and the README lists "understanding what a description
means" as a non-goal.

## Position, not name

`title`, `$comment`, `example` and `examples` are annotations **in a schema
position**. In `properties`, `patternProperties`, `$defs`, `definitions` and
`dependentSchemas` the same words are names chosen by the document, and deleting
one deletes a parameter.

The keyword tables in `src/schema.mjs` say which positions hold a schema
(`items`, `not`, `if`, `then`, `else`, `contains`, `propertyNames`,
`additionalProperties`, `additionalItems`, `unevaluatedItems`,
`unevaluatedProperties`, `contentSchema`), which hold an array of schemas
(`allOf`, `anyOf`, `oneOf`, `prefixItems`), and which hold a map of names to
schemas. `dependencies` is handled as the two shapes it can take. Everything
else is copied verbatim and not entered.
