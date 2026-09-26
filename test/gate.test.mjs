import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let workspace = null
after(async () => {
  if (workspace !== null) await rm(workspace, { recursive: true, force: true })
})
async function scratch() {
  if (workspace === null) workspace = await mkdtemp(join(tmpdir(), 'tool-schema-minifier-gate-'))
  return workspace
}

/**
 * The gate, pinned by breaking the compressor.
 *
 * `minifyTools` compares every compressed tool against its original before
 * accepting it, and that comparison is this tool's headline claim: "the
 * compressor and the checker are separate code, so a mistake in one is caught
 * by the other." Nothing defended it. The call could be deleted outright and
 * the whole suite stayed green -- because the compressor is correct, so with
 * correct code the gate never has anything to catch and every assertion about
 * it is an assertion about code that does nothing.
 *
 * A guarantee about what happens when other code is wrong can only be tested
 * with code that is wrong. So this test copies the tool, breaks the compressor
 * in one specific way, and asserts that the GATE refuses the result: the run
 * fails, the difference is named, and no artifact reaches disk.
 *
 * The mutation is position-blindness -- routing `properties` through
 * `minifySchema` instead of `minifySchemaMap` -- which makes a parameter named
 * after an annotation keyword get deleted as an annotation. It is the exact
 * mistake `src/schema.mjs` is built around not making.
 *
 * Delete the `compareToolEntries` call from `minifyTools` and this test goes
 * red: the same broken compressor then exits 0 with status `pass` and writes a
 * copy whose `required` list names a parameter the copy no longer declares.
 */

/** A parameter legitimately named after an annotation keyword. */
const FIXTURE = JSON.stringify({
  schemaVersion: '1',
  tools: [{
    name: 'act',
    description: 'Do   a   thing.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string', description: 'The   title   of   the   record.' } },
      required: ['title'],
    },
  }],
})

const POSITION_AWARE = '      setKey(result, key, minifySchemaMap(value, here, { ...state, protectedScope: nodeProtected }, record))'
const POSITION_BLIND = '      setKey(result, key, minifySchema(value, here, { ...state, protectedScope: nodeProtected }, record))'

/** A copy of the tool with its compressor broken, and a fixture to run it on. */
async function brokenCompressor() {
  const directory = join(await scratch(), 'broken')
  await rm(directory, { recursive: true, force: true })
  await cp(join(projectDirectory, 'src'), join(directory, 'src'), { recursive: true })
  await cp(join(projectDirectory, 'bin'), join(directory, 'bin'), { recursive: true })

  const schemaPath = join(directory, 'src', 'schema.mjs')
  const source = await readFile(schemaPath, 'utf8')
  const occurrences = source.split(POSITION_AWARE).length - 1
  assert.equal(
    occurrences, 1,
    'this test breaks the compressor by editing one known line of src/schema.mjs; '
    + 'if that line moved, fix the mutation rather than deleting the test',
  )
  await writeFile(schemaPath, source.replace(POSITION_AWARE, POSITION_BLIND), 'utf8')

  const fixture = join(directory, 'tools.json')
  await writeFile(fixture, FIXTURE, 'utf8')
  return { cli: join(directory, 'bin', 'tool-schema-minifier.mjs'), fixture, out: join(directory, 'copy.json') }
}

async function runCli(cli, args) {
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

test('the gate refuses a copy a broken compressor produced, and writes nothing', async () => {
  const broken = await brokenCompressor()
  const { code, stdout, stderr } = await runCli(broken.cli, [
    'minify', '--tools', broken.fixture, '--out', broken.out, '--drop-annotations',
  ])
  const report = JSON.parse(stdout)
  const ruleIds = report.findings.map((finding) => finding.ruleId)

  assert.equal(report.status, 'fail', JSON.stringify(ruleIds))
  assert.equal(code, 1)
  assert.ok(ruleIds.includes('property-removed'), JSON.stringify(ruleIds))
  assert.ok(ruleIds.includes('equivalence-not-proven'), JSON.stringify(ruleIds))
  assert.equal(report.summary.toolsCompressed, 0)
  assert.equal(await exists(broken.out), false, 'a refused copy must not reach disk')
  assert.match(stderr, /no compressed copy was written/)
})

test('the same fixture is compressed and written by the real compressor', async () => {
  // The control. Without it the test above would pass against a tool that
  // refuses everything, and the fixture would not be shown to be legitimate:
  // `title` here is a parameter name, not an annotation.
  const directory = await scratch()
  const fixture = join(directory, 'control-tools.json')
  const out = join(directory, 'control-copy.json')
  await writeFile(fixture, FIXTURE, 'utf8')

  const { code, stdout } = await runCli(join(projectDirectory, 'bin', 'tool-schema-minifier.mjs'), [
    'minify', '--tools', fixture, '--out', out, '--drop-annotations',
  ])
  assert.equal(JSON.parse(stdout).status, 'pass')
  assert.equal(code, 0)
  const written = JSON.parse(await readFile(out, 'utf8'))
  assert.deepEqual(Object.keys(written.tools[0].inputSchema.properties), ['title'])
  assert.deepEqual(written.tools[0].inputSchema.required, ['title'])
})
