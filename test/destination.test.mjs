import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { DestinationError, assertWritableDestination } from '../src/destination.mjs'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'tool-schema-minifier.mjs')
const EXAMPLE = join(projectDirectory, 'examples', 'tools.json')

let workspace = null
after(async () => {
  if (workspace !== null) await rm(workspace, { recursive: true, force: true })
})

let counter = 0
/** A fresh directory per case, so one case cannot see another's links. */
async function scratch() {
  if (workspace === null) workspace = await mkdtemp(join(tmpdir(), 'tool-schema-minifier-destination-'))
  counter += 1
  const directory = join(workspace, `case-${counter}`)
  await mkdir(directory, { recursive: true })
  return directory
}

async function runCli(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], { cwd: projectDirectory })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

const exists = async (path) => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * The three holes, and each one needs its own check.
 *
 * Measured across this catalog rather than imagined: ten tools accepted a
 * destination that overwrote something they were never asked to touch, and four
 * of them exited 0 saying the write succeeded. Guarding one or two of these is
 * what every one of those tools had already done, so there is a case per row
 * below -- and the allowed cases are not optional, because a guard that refuses
 * everything passes a data-loss test while making the tool useless.
 */

test('a symbolic link AT the destination is refused on sight', async () => {
  const directory = await scratch()
  const precious = join(directory, 'precious.txt')
  await writeFile(precious, 'PRECIOUS\n', 'utf8')
  const destination = join(directory, 'out.json')
  await symlink(precious, destination)

  // realpath() would RESOLVE this link, and resolving is the dangerous act.
  await assert.rejects(
    () => assertWritableDestination(destination, { inputs: [EXAMPLE], label: '--out' }),
    (error) => error instanceof DestinationError && /symbolic link/.test(error.message),
  )
  assert.equal(await readFile(precious, 'utf8'), 'PRECIOUS\n')
})

test('a symlinked PARENT directory is refused against a root', async () => {
  const directory = await scratch()
  const root = join(directory, 'root')
  const outside = join(directory, 'outside')
  await mkdir(root, { recursive: true })
  await mkdir(outside, { recursive: true })
  await symlink(outside, join(root, 'link'))

  // A lexical prefix check passes here: the path starts with the root. Only
  // resolving the parent and comparing the real paths refuses it.
  const destination = join(root, 'link', 'out.json')
  assert.ok(destination.startsWith(root), 'the lexical check this case defeats must pass')
  await assert.rejects(
    () => assertWritableDestination(destination, { root, label: '--out' }),
    (error) => error instanceof DestinationError && /outside the permitted root/.test(error.message),
  )
})

test('a HARD LINK to an input is refused, because it is the same file', async () => {
  const directory = await scratch()
  const input = join(directory, 'tools.json')
  await writeFile(input, await readFile(EXAMPLE, 'utf8'), 'utf8')
  const destination = join(directory, 'copy.json')
  await link(input, destination)

  // No target to resolve and no shared path text: realpath and string
  // comparison both call this a different file. Only dev + ino sees it.
  assert.notEqual(await realpath(destination), await realpath(input))
  await assert.rejects(
    () => assertWritableDestination(destination, { inputs: [input], label: '--out' }),
    (error) => error instanceof DestinationError && /same file as an input/.test(error.message),
  )
})

test('a lexical ".." escape out of the root is refused', async () => {
  const directory = await scratch()
  const root = join(directory, 'root')
  await mkdir(root, { recursive: true })
  await assert.rejects(
    () => assertWritableDestination(join(root, '..', 'escaped.json'), { root, label: '--out' }),
    (error) => error instanceof DestinationError && /outside the permitted root/.test(error.message),
  )
})

test('a destination that is a directory is refused', async () => {
  const directory = await scratch()
  await assert.rejects(
    () => assertWritableDestination(directory, { inputs: [EXAMPLE], label: '--out' }),
    (error) => error instanceof DestinationError && /not a regular file/.test(error.message),
  )
})

test('a destination whose directory does not exist is refused', async () => {
  const directory = await scratch()
  await assert.rejects(
    () => assertWritableDestination(join(directory, 'absent', 'out.json'), { label: '--out' }),
    (error) => error instanceof DestinationError && /does not exist/.test(error.message),
  )
})

/**
 * The allowed cases. A guard that refuses everything passes every test above.
 */
test('legitimate destinations are allowed', async () => {
  const directory = await scratch()
  const root = join(directory, 'root')
  const nested = join(root, 'nested')
  await mkdir(nested, { recursive: true })
  const existing = join(directory, 'existing.json')
  await writeFile(existing, '{}\n', 'utf8')

  // 1. a new file beside an input
  assert.equal(
    await assertWritableDestination(join(directory, 'new.json'), { inputs: [EXAMPLE], label: '--out' }),
    join(directory, 'new.json'),
  )
  // 2. an existing regular file that is not an input
  assert.equal(
    await assertWritableDestination(existing, { inputs: [EXAMPLE], label: '--out' }),
    existing,
  )
  // 3. a new file directly inside a declared root
  assert.equal(
    await assertWritableDestination(join(root, 'out.json'), { root, label: '--out' }),
    join(root, 'out.json'),
  )
  // 4. a new file in a real subdirectory of that root
  assert.equal(
    await assertWritableDestination(join(nested, 'out.json'), { root, label: '--out' }),
    join(nested, 'out.json'),
  )
})

test('a relative destination is resolved against the working directory', async () => {
  const directory = await scratch()
  const previous = process.cwd()
  process.chdir(directory)
  try {
    // process.cwd() rather than `directory`: on this platform the temporary
    // directory is itself reached through a symbolic link, and cwd is the real
    // path -- which is exactly what `resolve` will have used.
    assert.equal(await assertWritableDestination('out.json', { label: '--out' }), join(process.cwd(), 'out.json'))
  } finally {
    process.chdir(previous)
  }
})

/**
 * The same three holes through the command line, which is where a destroyed
 * file actually happens. Before this guard, the first case below exited 0 with
 * "compressed copy written" on stderr and the linked file overwritten.
 */
test('the command line refuses a symlinked destination and destroys nothing', async () => {
  const directory = await scratch()
  const precious = join(directory, 'precious.txt')
  await writeFile(precious, 'PRECIOUS\n', 'utf8')
  const destination = join(directory, 'out.json')
  await symlink(precious, destination)

  const { code, stdout, stderr } = await runCli(['minify', '--tools', EXAMPLE, '--out', destination, '--drop-annotations'])
  assert.equal(code, 2)
  assert.equal(stdout, '', 'a refused destination is a configuration error: empty stdout')
  assert.match(stderr, /--out is a symbolic link/)
  assert.equal(await readFile(precious, 'utf8'), 'PRECIOUS\n')
})

test('the command line refuses a hard link to the input document', async () => {
  const directory = await scratch()
  const input = join(directory, 'tools.json')
  const original = await readFile(EXAMPLE, 'utf8')
  await writeFile(input, original, 'utf8')
  const destination = join(directory, 'hard.json')
  await link(input, destination)

  const { code, stdout, stderr } = await runCli(['minify', '--tools', input, '--out', destination, '--drop-annotations'])
  assert.equal(code, 2)
  assert.equal(stdout, '')
  assert.match(stderr, /same file as an input/)
  assert.equal(await readFile(input, 'utf8'), original, 'the input this tool read is untouched')
})

test('the command line refuses the input document named directly, or through a link', async () => {
  const directory = await scratch()
  const input = join(directory, 'tools.json')
  const original = await readFile(EXAMPLE, 'utf8')
  await writeFile(input, original, 'utf8')

  const direct = await runCli(['minify', '--tools', input, '--out', input])
  assert.equal(direct.code, 2)
  assert.equal(direct.stdout, '')
  assert.match(direct.stderr, /same file as an input/)

  // A symbolic link pointing at the input is refused for being a link at all,
  // before it is resolved -- which is the only safe order.
  const alias = join(directory, 'alias.json')
  await symlink(input, alias)
  const throughLink = await runCli(['minify', '--tools', input, '--out', alias])
  assert.equal(throughLink.code, 2)
  assert.equal(throughLink.stdout, '')
  assert.match(throughLink.stderr, /symbolic link/)
  assert.equal(await readFile(input, 'utf8'), original)
})

test('the command line refuses a destination that is a directory', async () => {
  const directory = await scratch()
  const { code, stdout, stderr } = await runCli(['minify', '--tools', EXAMPLE, '--out', directory])
  assert.equal(code, 2)
  assert.equal(stdout, '')
  assert.match(stderr, /not a regular file/)
})

test('the command line still writes an ordinary destination, creating its directory', async () => {
  const directory = await scratch()
  const destination = join(directory, 'made', 'here', 'copy.json')
  const { code, stderr } = await runCli(['minify', '--tools', EXAMPLE, '--out', destination, '--drop-annotations'])
  assert.equal(code, 0)
  assert.match(stderr, /compressed copy written/)
  assert.ok(await exists(destination))
  assert.equal(JSON.parse(await readFile(destination, 'utf8')).tools.length, 3)
})

test('the command line overwrites an ordinary existing file at the destination', async () => {
  const directory = await scratch()
  const destination = join(directory, 'copy.json')
  await writeFile(destination, 'stale\n', 'utf8')
  const { code } = await runCli(['minify', '--tools', EXAMPLE, '--out', destination, '--drop-annotations'])
  assert.equal(code, 0)
  assert.equal(JSON.parse(await readFile(destination, 'utf8')).tools.length, 3)
})

/**
 * A missing INPUT is not a broken destination.
 *
 * The destination check used to stat the input, so `--out` plus a document that
 * is not there produced a configuration error blaming `--out`, with stdout
 * empty and no report at all. The contract requires the opposite: the run had a
 * subject and failed to obtain evidence about it, so a consumer needs the
 * report to know WHICH input was not read.
 */
test('a missing input with --out still writes an incomplete report on stdout', async () => {
  const directory = await scratch()
  const { code, stdout, stderr } = await runCli([
    'minify', '--tools', join(directory, 'absent.json'), '--out', join(directory, 'out.json'),
  ])
  assert.equal(code, 2)
  const report = JSON.parse(stdout)
  assert.equal(report.status, 'incomplete')
  assert.ok(report.findings.some((finding) => finding.ruleId === 'tools-unreadable'))
  assert.doesNotMatch(stderr, /--out is not usable/)
  assert.equal(await exists(join(directory, 'out.json')), false)
})
