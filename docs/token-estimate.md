# The token estimate

## What it is

A declared pre-tokenizer with **no vocabulary and no merge table**.

`tiktoken` and the other BPE tokenizers split text into runs first -- letters,
digits, punctuation, whitespace, with a leading space attached to the run that
follows -- and then apply a merge table learned from a corpus. This tool does
the first half and replaces the second with a fixed ratio per run:

| Run | Tokens |
| --- | --- |
| letters (`\p{L}+`) | `ceil(length / 4)` |
| digits (`\p{N}+`) | `ceil(length / 3)` |
| any other non-space characters | `length` |
| whitespace | `0` for a single space, otherwise `ceil((length - 1) / 8)` |

The estimate is taken over the **compact JSON serialisation of the whole tool
definition**, because that is the form a tool list actually reaches a model in.
Punctuation costs a token per character because JSON structure is mostly
punctuation and a BPE vocabulary merges little of it; a single separating space
is free because a vocabulary attaches it to the word that follows.

## What it is not

It is **not** any provider's tokenizer, and the number must not be used as a
billing count. Two documents measured by this tool are comparable with each
other. A number from this tool and a number from a provider's API are not
comparable at all.

`bytesBefore` and `bytesAfter` are exact UTF-8 byte counts, and `characters` is
an exact UTF-16 code unit count. If you need a number that is true rather than
comparable, use the bytes.

## Why the ratios are monotone

Every ratio in the table is non-decreasing in the length of the run it measures.
That is the property the compressor relies on: collapsing whitespace or cutting
a description can never raise the estimate of the run it changed.

It does not follow that every compression lowers the *total*. Truncation
replaces characters with one ellipsis character, and at the boundary -- a
description one character over the budget -- the ellipsis can cost as much as
the two characters it replaced. So the compressor compares the whole tool before
and after, and a copy that did not lower the estimate is refused with
`compression-rejected-no-saving` and the original is kept.

The consequence worth stating plainly: **no entry in a compressed copy is larger
than the entry it replaces**, in estimated tokens or in exact bytes, at any
budget.

It is stated per ENTRY because the file is not the entries. The copy always
carries the document envelope `{"schemaVersion":"1","tools":[...]}`, so a
document that declared no `schemaVersion` gets one, and where the compression
saves less than the envelope costs the file on disk is larger than the file it
was built from -- measured, a 176-byte input with nothing to collapse produced a
184-byte copy, with `bytesBefore` and `bytesAfter` correctly equal and no saving
claimed. The guarantee is about what happened to the tool definitions, which is
what `bytesBefore` and `bytesAfter` count.

## Reproducibility

The estimator reads nothing but its argument. No clock, no locale, no
environment, no random source. The same text produces the same number on every
host, which is what lets `npm run check` compare two runs byte for byte.
