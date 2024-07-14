import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { DEFAULT_LIMITS, minifyTools, validateLimits } from '../src/index.mjs'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'tool-schema-minifier.mjs')

let workspace = null
after(async () => {
  if (workspace !== null) await rm(workspace, { recursive: true, force: true })
})
async function scratch() {
  if (workspace === null) workspace = await mkdtemp(join(tmpdir(), 'tool-schema-minifier-limits-'))
  return workspace
}

let counter = 0
async function writeJson(value) {
  counter += 1
  const path = join(await scratch(), `file-${counter}.json`)
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
  return path
}

async function runCli(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], { cwd: projectDirectory })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

const encode = (value) => new TextEncoder().encode(JSON.stringify(value))
const DOCUMENT = {
  schemaVersion: '1',
  tools: [{
    name: 'act',
    description: `Do   a   thing. ${'word '.repeat(60)}`,
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Which   record.' } } },
  }],
}

test('every documented limit has a default and every default is an integer', () => {
  assert.deepEqual(Object.keys(DEFAULT_LIMITS).sort(), [
    'maxBytes', 'maxDepth', 'maxDescriptionChars', 'maxMillis', 'maxNodes', 'maxTools',
  ])
  for (const value of Object.values(DEFAULT_LIMITS)) assert.ok(Number.isInteger(value) && value >= 0)
})

test('an unknown limit name is refused, not ignored', () => {
  // A one-character typo that fell back to a default would turn a real failure
  // into a green run, which is exactly the defect this rule exists for.
  assert.throws(() => validateLimits({ maxByte: 10 }), TypeError)
  assert.throws(() => validateLimits({ maxbytes: 10 }), TypeError)
})

test('a limit that is not a plausible integer is refused', () => {
  assert.throws(() => validateLimits({ maxBytes: 0 }), TypeError)
  assert.throws(() => validateLimits({ maxTools: 1.5 }), TypeError)
  assert.throws(() => validateLimits({ maxDepth: '4' }), TypeError)
  assert.throws(() => validateLimits({ maxDescriptionChars: 7 }), TypeError)
  assert.doesNotThrow(() => validateLimits({ maxMillis: 0 }))
})

test('an unknown option is refused, not ignored', () => {
  assert.throws(() => minifyTools({ bytes: encode(DOCUMENT), sources: 'tools.json' }), TypeError)
})

test('a clock that is not a function, or does not return a number, is refused', () => {
  assert.throws(() => minifyTools({ bytes: encode(DOCUMENT), clock: 5 }), TypeError)
  assert.throws(() => minifyTools({ bytes: encode(DOCUMENT), clock: () => 'soon' }), TypeError)
})

/** Each limit, driven through the command line flag that is supposed to carry it. */
const FLAGS = [
  ['--max-bytes', '10', 'tools-too-large'],
  ['--max-tools', '0', null],
  ['--max-depth', '2', 'tools-too-deep'],
  ['--max-nodes', '2', 'tools-too-many-nodes'],
  ['--max-millis', '0', 'time-budget-exceeded'],
]

for (const [flag, value, ruleId] of FLAGS) {
  if (ruleId === null) continue
  test(`${flag} is wired to the analysis and reported by name`, async () => {
    const path = await writeJson(DOCUMENT)
    const { code, stdout } = await runCli(['minify', '--tools', path, flag, value])
    const report = JSON.parse(stdout)
    assert.equal(report.status, 'incomplete')
    assert.equal(code, 2)
    const finding = report.findings.find((entry) => entry.ruleId === ruleId)
    assert.ok(finding !== undefined, JSON.stringify(report.findings.map((f) => f.ruleId)))
    assert.match(finding.message, /limit|budget/)
  })
}

test('--max-description-chars is wired and bounds the written copy', async () => {
  const path = await writeJson(DOCUMENT)
  const out = join(await scratch(), 'bounded.json')
  const { code } = await runCli(['minify', '--tools', path, '--out', out, '--max-description-chars', '30'])
  assert.equal(code, 0)
  const written = JSON.parse(await (await import('node:fs/promises')).readFile(out, 'utf8'))
  assert.equal(written.tools[0].description.length, 30)
})

test('--max-tools is wired', async () => {
  const path = await writeJson({ schemaVersion: '1', tools: [DOCUMENT.tools[0], { ...DOCUMENT.tools[0], name: 'second' }] })
  const { code, stdout } = await runCli(['minify', '--tools', path, '--max-tools', '1'])
  assert.equal(code, 2)
  assert.ok(JSON.parse(stdout).findings.some((finding) => finding.ruleId === 'too-many-tools'))
})

/**
 * The case that actually pins the clock wiring.
 *
 * `--max-millis 0` is satisfied by a clock stuck at a constant -- `0 - 0 >= 0`
 * -- so it proves the flag is read and nothing more. A nonzero budget that the
 * work genuinely outlives is what proves a real clock reaches the analysis:
 * replace the CLI's clock with a constant and this run reports a pass.
 */
test('a nonzero time budget the work outlives is enforced by the command line', async () => {
  const tools = []
  for (let index = 0; index < 400; index += 1) {
    tools.push({
      name: `tool_${index}`,
      description: 'word   '.repeat(80),
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(
          Array.from({ length: 10 }, (_, position) => [`p${position}`, { type: 'string', description: 'A   parameter.' }]),
        ),
      },
    })
  }
  const path = await writeJson({ schemaVersion: '1', tools })
  const { code, stdout } = await runCli(['minify', '--tools', path, '--max-millis', '1'])
  const report = JSON.parse(stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(code, 2)
  assert.ok(report.findings.some((finding) => finding.ruleId === 'time-budget-exceeded'))
})

test('--config carries limits, and a flag overrides the same limit', async () => {
  const path = await writeJson(DOCUMENT)
  const config = await writeJson({ limits: { maxBytes: 10 } })
  const refused = await runCli(['minify', '--tools', path, '--config', config])
  assert.equal(refused.code, 2)
  assert.ok(JSON.parse(refused.stdout).findings.some((finding) => finding.ruleId === 'tools-too-large'))

  const overridden = await runCli(['minify', '--tools', path, '--config', config, '--max-bytes', '4194304'])
  assert.equal(overridden.code, 0)
  assert.equal(JSON.parse(overridden.stdout).status, 'pass')
})

test('an unknown configuration key fails the run with no report at all', async () => {
  const path = await writeJson(DOCUMENT)
  const config = await writeJson({ limit: { maxBytes: 10 } })
  const { code, stdout, stderr } = await runCli(['minify', '--tools', path, '--config', config])
  assert.equal(code, 2)
  assert.equal(stdout, '')
  assert.match(stderr, /unknown configuration key/)
})

test('an unknown limit inside --config fails the run with no report at all', async () => {
  const path = await writeJson(DOCUMENT)
  const config = await writeJson({ limits: { maxByte: 10 } })
  const { code, stdout } = await runCli(['minify', '--tools', path, '--config', config])
  assert.equal(code, 2)
  assert.equal(stdout, '')
})

test('a configuration that is not JSON never echoes its own contents', async () => {
  const path = await writeJson(DOCUMENT)
  const config = await writeJson('AKIAIOSFODNN7EXAMPLE')
  const { code, stdout, stderr } = await runCli(['minify', '--tools', path, '--config', config])
  assert.equal(code, 2)
  assert.equal(stdout, '')
  assert.ok(!stderr.includes('AKIAIOSFODNN7EXAMPLE'), stderr)
})

test('a repeated flag is a configuration error rather than a silent last-wins', async () => {
  const path = await writeJson(DOCUMENT)
  const { code, stdout } = await runCli(['minify', '--tools', path, '--max-tools', '10', '--max-tools', '1'])
  assert.equal(code, 2)
  assert.equal(stdout, '')
})

test('--protect-tool is deliberately repeatable', async () => {
  const path = await writeJson(DOCUMENT)
  const { code } = await runCli(['minify', '--tools', path, '--protect-tool', 'act', '--protect-tool', 'other'])
  assert.equal(code, 0)
})
