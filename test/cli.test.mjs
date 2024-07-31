import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'tool-schema-minifier.mjs')
const EXAMPLE = join(projectDirectory, 'examples', 'tools.json')
const BROKEN = join(projectDirectory, 'examples', 'compressed-broken.json')

let workspace = null
after(async () => {
  if (workspace !== null) await rm(workspace, { recursive: true, force: true })
})
async function scratch() {
  if (workspace === null) workspace = await mkdtemp(join(tmpdir(), 'tool-schema-minifier-cli-'))
  return workspace
}

async function runCli(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], { cwd: projectDirectory })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

const missing = async (path) => {
  try {
    await access(path)
    return false
  } catch {
    return true
  }
}

test('--help explains the tool and exits 0', async () => {
  const { code, stdout } = await runCli(['--help'])
  assert.equal(code, 0)
  assert.match(stdout, /tool-schema-minifier/)
  assert.match(stdout, /Exit codes/)
  assert.match(stdout, /ESTIMATE/)
})

test('stdout carries the JSON report and nothing else', async () => {
  const { code, stdout } = await runCli(['minify', '--tools', EXAMPLE])
  assert.equal(code, 0)
  const report = JSON.parse(stdout)
  assert.equal(report.tool, 'tool-schema-minifier')
})

test('--human writes the summary on stdout instead', async () => {
  const { code, stdout } = await runCli(['minify', '--tools', EXAMPLE, '--human'])
  assert.equal(code, 0)
  assert.match(stdout, /^PASS {2}tool-schema-minifier \(minify\)/)
  assert.throws(() => JSON.parse(stdout))
})

/**
 * Exit 2 has two shapes, and the difference is deliberate.
 *
 * A configuration error means the run never had a subject, so there is nothing
 * to report about and stdout is empty. An input that could not be read means
 * the run had a subject and failed to obtain evidence about it, which is
 * exactly what `incomplete` exists to say -- and a consumer needs the report to
 * know WHICH input was not read.
 */
test('a usage error writes nothing on stdout', async () => {
  for (const args of [[], ['minify'], ['minify', '--tools'], ['minify', '--tools', EXAMPLE, '--nope'], ['fly', '--tools', EXAMPLE]]) {
    const { code, stdout, stderr } = await runCli(args)
    assert.equal(code, 2, JSON.stringify(args))
    assert.equal(stdout, '', JSON.stringify(args))
    assert.ok(stderr.length > 0)
  }
})

test('an unreadable input writes an incomplete report on stdout', async () => {
  const { code, stdout } = await runCli(['minify', '--tools', join(await scratch(), 'absent.json')])
  assert.equal(code, 2)
  const report = JSON.parse(stdout)
  assert.equal(report.status, 'incomplete')
  assert.ok(report.findings.some((finding) => finding.ruleId === 'tools-unreadable'))
})

test('--candidate and --out are refused for the wrong command', async () => {
  const both = await runCli(['minify', '--tools', EXAMPLE, '--candidate', BROKEN])
  assert.equal(both.code, 2)
  assert.equal(both.stdout, '')
  const out = await runCli(['verify', '--tools', EXAMPLE, '--candidate', BROKEN, '--out', join(await scratch(), 'x.json')])
  assert.equal(out.code, 2)
  assert.equal(out.stdout, '')
})

test('the compressed copy is written only for a run that passes', async () => {
  const directory = await scratch()
  const good = join(directory, 'written.json')
  const passing = await runCli(['minify', '--tools', EXAMPLE, '--out', good, '--drop-annotations'])
  assert.equal(passing.code, 0)
  assert.match(passing.stderr, /compressed copy written/)
  assert.ok(JSON.parse(await readFile(good, 'utf8')).tools.length === 3)

  // An incomplete run had a subject and did not finish reading it. Writing a
  // copy then would put a file on disk that looks verified and is not.
  const refused = join(directory, 'not-written.json')
  const incomplete = await runCli(['minify', '--tools', EXAMPLE, '--out', refused, '--max-tools', '1'])
  assert.equal(incomplete.code, 2)
  assert.ok(await missing(refused))
  assert.match(incomplete.stderr, /no compressed copy was written/)
})

/**
 * Where the copy may be written is pinned in `test/destination.test.mjs`: a
 * symbolic link at the destination, a parent that resolves elsewhere, a hard
 * link to an input and a destination that is not a regular file each have a
 * case there, as do the destinations that must still be allowed.
 */

test('two byte-identical documents verify as equivalent', async () => {
  // Reflexivity through the real command line. An empty description made this
  // exit 1 with "the compressed copy of \"act\" is not equivalent to the
  // original", on two files `cmp` calls identical.
  const directory = await scratch()
  const document = JSON.stringify({
    schemaVersion: '1',
    tools: [{
      name: 'act',
      description: 'Do a thing with some records here.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: '' } }, required: ['id'] },
    }],
  })
  const original = join(directory, 'identical-a.json')
  const copy = join(directory, 'identical-b.json')
  await writeFile(original, document, 'utf8')
  await writeFile(copy, document, 'utf8')

  const { code, stdout } = await runCli(['verify', '--tools', original, '--candidate', copy])
  const report = JSON.parse(stdout)
  assert.equal(report.status, 'pass', JSON.stringify(report.findings))
  assert.equal(code, 0)
})

test('a failing verification exits 1 and still writes its report', async () => {
  const { code, stdout } = await runCli(['verify', '--tools', EXAMPLE, '--candidate', BROKEN])
  assert.equal(code, 1)
  const report = JSON.parse(stdout)
  assert.equal(report.status, 'fail')
  assert.ok(report.findings.some((finding) => finding.ruleId === 'required-changed'))
  assert.ok(report.findings.some((finding) => finding.ruleId === 'enum-changed'))
  assert.ok(report.findings.some((finding) => finding.ruleId === 'safety-description-changed'))
  assert.ok(report.findings.some((finding) => finding.ruleId === 'property-removed'))
})

test('the shipped examples are the ones the package claims to run', async () => {
  const passing = await runCli(['minify', '--tools', 'examples/tools.json', '--out', join(await scratch(), 'example.json'), '--drop-annotations'])
  assert.equal(passing.code, 0)
  const failing = await runCli(['verify', '--tools', 'examples/tools.json', '--candidate', 'examples/compressed-broken.json'])
  assert.equal(failing.code, 1)
})
