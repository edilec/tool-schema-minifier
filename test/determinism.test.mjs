import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'tool-schema-minifier.mjs')

let workspace = null
after(async () => {
  if (workspace !== null) await rm(workspace, { recursive: true, force: true })
})
async function scratch() {
  if (workspace === null) workspace = await mkdtemp(join(tmpdir(), 'tool-schema-minifier-determinism-'))
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

const EXAMPLE = join(projectDirectory, 'examples', 'tools.json')
const BROKEN = join(projectDirectory, 'examples', 'compressed-broken.json')

test('two runs over the same document produce byte-identical stdout', async () => {
  const first = await runCli(['minify', '--tools', EXAMPLE, '--drop-annotations'])
  const second = await runCli(['minify', '--tools', EXAMPLE, '--drop-annotations'])
  assert.equal(first.code, 0)
  assert.equal(first.stdout, second.stdout)
  assert.ok(first.stdout.length > 0)
})

test('two verification runs produce byte-identical stdout', async () => {
  const first = await runCli(['verify', '--tools', EXAMPLE, '--candidate', BROKEN])
  const second = await runCli(['verify', '--tools', EXAMPLE, '--candidate', BROKEN])
  assert.equal(first.code, 1)
  assert.equal(first.stdout, second.stdout)
})

test('two written copies are byte-identical', async () => {
  const directory = await scratch()
  const one = join(directory, 'one.json')
  const two = join(directory, 'two.json')
  await runCli(['minify', '--tools', EXAMPLE, '--out', one, '--drop-annotations'])
  await runCli(['minify', '--tools', EXAMPLE, '--out', two, '--drop-annotations'])
  assert.equal(await readFile(one, 'utf8'), await readFile(two, 'utf8'))
})

test('no finding names an absolute host path', async () => {
  // A report is an artifact people paste into issues. `location.file` is
  // relative to the working directory, or a bare base name when the document is
  // outside it.
  const directory = await scratch()
  const outside = join(directory, 'outside.json')
  await writeFile(outside, await readFile(EXAMPLE, 'utf8'), 'utf8')
  const { stdout } = await runCli(['minify', '--tools', outside])
  const report = JSON.parse(stdout)
  assert.equal(report.findings[0].location.file, 'outside.json')
  assert.ok(!stdout.includes(directory), 'the report must not carry the host path')
})

test('a document inside the working directory is named relative to it', async () => {
  const { stdout } = await runCli(['minify', '--tools', 'examples/tools.json'])
  const report = JSON.parse(stdout)
  assert.equal(report.findings[0].location.file, 'examples/tools.json')
})

test('the report envelope is exactly the contract envelope', async () => {
  const { stdout } = await runCli(['minify', '--tools', EXAMPLE])
  const report = JSON.parse(stdout)
  assert.deepEqual(Object.keys(report), ['schemaVersion', 'tool', 'status', 'summary', 'findings'])
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.tool, 'tool-schema-minifier')
  assert.ok(['pass', 'fail', 'incomplete'].includes(report.status))
  for (const [key, value] of Object.entries(report.summary)) {
    assert.ok(Number.isInteger(value), `summary.${key} must be an integer, got ${typeof value}`)
  }
  for (const finding of report.findings) {
    assert.deepEqual(
      Object.keys(finding).filter((key) => !['evidence', 'suggestion'].includes(key)),
      ['ruleId', 'severity', 'message', 'location'],
    )
    assert.ok(['error', 'warning', 'info'].includes(finding.severity))
    assert.deepEqual(Object.keys(finding.location), ['file', 'pointer'])
  }
})
