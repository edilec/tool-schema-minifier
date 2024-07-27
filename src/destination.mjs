/**
 * Where the compressed copy may be written.
 *
 * `--out` is not a safe place to put a path this tool has not checked, and "the
 * caller named it" is not a check: the caller named a path, not the file that
 * path resolves to. Measured across this catalog, ten tools accepted a
 * destination that destroyed a file they were never asked to touch and four of
 * them exited 0 reporting success -- one of them destroyed a file it had just
 * hashed.
 *
 * There are three independent holes, and guarding one or two is what every one
 * of those tools had already done:
 *
 * 1. A SYMLINK AT THE DESTINATION writes wherever the link points, which may be
 *    anywhere on the machine. `realpath` on the destination does not help: it
 *    resolves the link, and resolving is precisely the dangerous act. The link
 *    is refused on sight, by `lstat`, before anything is opened.
 * 2. A SYMLINKED PARENT does the same thing one level up, so the parent is
 *    resolved and compared against the permitted root rather than compared
 *    lexically. A lexical prefix check passes for `root/link/out` where `link`
 *    leaves the root.
 * 3. A HARD LINK TO AN INPUT has no target to resolve and shares no path with
 *    it, so `realpath` and string comparison both say it is a different file.
 *    It is the same file. Only device plus inode sees that.
 *
 * This command line declares no root -- a person may legitimately write the
 * copy anywhere they can write -- so it passes `root: null` and the first and
 * third holes are what refuse a destination in practice. The `root` argument is
 * kept for a library caller that does have a root to confine the copy to, and
 * `test/destination.test.mjs` exercises every row of the table above including
 * both root cases, plus the destinations that must still be ALLOWED: a guard
 * that refuses everything passes a data-loss test while making the tool
 * useless.
 */

import { lstat, realpath, stat } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

/** Raised when a destination cannot be written to safely. The caller exits 2. */
export class DestinationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DestinationError'
  }
}

/**
 * Refuse an output destination that would write somewhere the caller did not
 * name, or over something the caller is reading. Returns the resolved path.
 *
 * An input that cannot be stat'ed is skipped rather than refused: a missing
 * input is a fact about the input, and reporting it is the job of the run and
 * of an `incomplete` report, not of the destination check. Failing here instead
 * produced a configuration error blaming `--out` for a document that was not
 * there, with no report at all on stdout.
 */
export async function assertWritableDestination(destination, options = {}) {
  const { inputs = [], root = null, label = '--out' } = options
  const target = resolve(destination)

  let existing = null
  try {
    existing = await lstat(target)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new DestinationError(`${label} could not be inspected: ${error.code ?? 'unknown error'}`)
    }
  }

  if (existing !== null && existing.isSymbolicLink()) {
    throw new DestinationError(
      `${label} is a symbolic link. Writing through it would put the output wherever `
      + 'the link points, which is not the path you named, so it is refused. '
      + 'Name the real destination.',
    )
  }
  if (existing !== null && !existing.isFile()) {
    throw new DestinationError(`${label} exists and is not a regular file.`)
  }

  let parent
  try {
    parent = await realpath(dirname(target))
  } catch {
    throw new DestinationError(`${label} names a directory that does not exist.`)
  }

  if (root !== null) {
    const base = await realpath(resolve(root))
    if (parent !== base && !parent.startsWith(base + sep)) {
      throw new DestinationError(
        `${label} resolves to ${parent}, which is outside the permitted root. `
        + 'A link or a ".." segment on the way there does not widen it.',
      )
    }
  }

  if (existing === null) return target

  // Same file as an input? Compare identity, not paths.
  for (const input of inputs) {
    let source
    try {
      source = await stat(input)
    } catch {
      continue
    }
    if (source.dev === existing.dev && source.ino === existing.ino) {
      throw new DestinationError(
        `${label} is the same file as an input (they share device ${existing.dev} and `
        + `inode ${existing.ino}, so a hard link does not make them different files). `
        + 'This tool never rewrites what it reads.',
      )
    }
  }
  return target
}
