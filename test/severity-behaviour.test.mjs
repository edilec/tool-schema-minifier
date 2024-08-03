import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { RULE_SEVERITY } from '../src/index.mjs'

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin', 'tool-schema-minifier.mjs')

let workspace = null
after(async () => {
  if (workspace !== null) await rm(workspace, { recursive: true, force: true })
})

async function scratch() {
  if (workspace === null) workspace = await mkdtemp(join(tmpdir(), 'tool-schema-minifier-severity-'))
  return workspace
}

let counter = 0
async function writeDocument(document) {
  counter += 1
  const path = join(await scratch(), `document-${counter}.json`)
  await writeFile(path, typeof document === 'string' ? document : JSON.stringify(document), 'utf8')
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

const NEL = String.fromCharCode(0x85)

const tool = (overrides) => ({
  name: 'act',
  description: 'Do   a   thing   with   a   record.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Which   record.' },
      mode: { type: 'string', description: 'How   to   act.', enum: ['fast', 'careful'] },
      confirm: { type: 'boolean', description: 'Set only after a person has approved this deletion.' },
    },
    required: ['id', 'confirm'],
    additionalProperties: false,
  },
  ...overrides,
})

const document = (overrides) => ({ schemaVersion: '1', tools: [tool(overrides)] })

/** A candidate copy of `document()` with one thing changed. */
function candidateWith(mutate) {
  const copy = JSON.parse(JSON.stringify(document()))
  mutate(copy.tools[0])
  return copy
}

const plain = {
  schemaVersion: '1',
  tools: [{ name: 'plain', description: 'A tool.', inputSchema: { type: 'object', properties: {} } }],
}

/**
 * Severity, pinned behaviourally.
 *
 * A frozen table, a documentation page and a hand-written expected map in a
 * test are three declarations agreeing with each other, and one coordinated
 * edit satisfies all three: a catalog defended that way had forty error rules
 * survive being flipped to warnings. So every rule below is driven through the
 * real command line over a real document, and what is asserted is the exit code
 * and the status -- which no edit to a table can change.
 *
 * The three outcome classes, and what they mean:
 *
 * | class | exit | status | meaning |
 * | --- | ---: | --- | --- |
 * | evidence not obtained | 2 | incomplete | the run abstains |
 * | difference established | 1 | fail | the run has a verdict and it is no |
 * | work done as designed | 0 | pass | information about what changed |
 */
const CASES = [
  // --- evidence not obtained: exit 2, status incomplete ------------------
  ['tools-unreadable', 2, 'incomplete', async () => ['minify', '--tools', join(await scratch(), 'absent.json')]],
  ['tools-not-utf8', 2, 'incomplete', async () => {
    const path = join(await scratch(), 'not-utf8.json')
    await writeFile(path, Buffer.from([0x7b, 0xff, 0x7d]))
    return ['minify', '--tools', path]
  }],
  ['tools-not-json', 2, 'incomplete', async () => ['minify', '--tools', await writeDocument('{"tools": [')]],
  ['tools-malformed', 2, 'incomplete', async () => ['minify', '--tools', await writeDocument('[]')]],
  ['tools-too-large', 2, 'incomplete', async () => ['minify', '--tools', await writeDocument(plain), '--max-bytes', '10']],
  ['tools-too-deep', 2, 'incomplete', async () => ['minify', '--tools', await writeDocument(plain), '--max-depth', '2']],
  ['tools-too-many-nodes', 2, 'incomplete', async () => ['minify', '--tools', await writeDocument(document()), '--max-nodes', '3']],
  ['unknown-document-key', 2, 'incomplete', async () => ['minify', '--tools', await writeDocument({ ...plain, extra: true })]],
  ['schema-version-unsupported', 2, 'incomplete', async () => ['minify', '--tools', await writeDocument({ ...plain, schemaVersion: '9' })]],
  ['too-many-tools', 2, 'incomplete', async () => ['minify', '--tools', await writeDocument({ schemaVersion: '1', tools: [tool(), { ...tool(), name: 'second' }] }), '--max-tools', '1']],
  ['tool-malformed', 2, 'incomplete', async () => ['minify', '--tools', await writeDocument({ schemaVersion: '1', tools: [7] })]],
  ['tool-name-invalid', 2, 'incomplete', async () => ['minify', '--tools', await writeDocument({ schemaVersion: '1', tools: [{ description: 'No name.', inputSchema: {} }] })]],
  ['tool-name-duplicated', 2, 'incomplete', async () => ['minify', '--tools', await writeDocument({ schemaVersion: '1', tools: [plain.tools[0], plain.tools[0]] })]],
  ['tool-schema-missing', 2, 'incomplete', async () => ['minify', '--tools', await writeDocument({ schemaVersion: '1', tools: [{ name: 'bare', description: 'No schema.' }] })]],
  ['description-malformed', 2, 'incomplete', async () => ['minify', '--tools', await writeDocument({ schemaVersion: '1', tools: [{ name: 'odd', description: 42, inputSchema: { type: 'object', properties: {} } }] })]],
  ['no-tools-declared', 2, 'incomplete', async () => ['minify', '--tools', await writeDocument({ schemaVersion: '1', tools: [] })]],
  ['time-budget-exceeded', 2, 'incomplete', async () => ['minify', '--tools', await writeDocument(document()), '--max-millis', '0']],
  ['candidate-unreadable', 2, 'incomplete', async () => ['verify', '--tools', await writeDocument(document()), '--candidate', join(await scratch(), 'absent-candidate.json')]],
  ['candidate-not-utf8', 2, 'incomplete', async () => {
    const path = join(await scratch(), 'candidate-not-utf8.json')
    await writeFile(path, Buffer.from([0x7b, 0xff, 0x7d]))
    return ['verify', '--tools', await writeDocument(document()), '--candidate', path]
  }],
  ['candidate-not-json', 2, 'incomplete', async () => ['verify', '--tools', await writeDocument(document()), '--candidate', await writeDocument('{')]],
  ['candidate-malformed', 2, 'incomplete', async () => ['verify', '--tools', await writeDocument(document()), '--candidate', await writeDocument('[]')]],
  ['candidate-too-large', 2, 'incomplete', async () => {
    const original = await writeDocument(plain)
    const big = await writeDocument({ schemaVersion: '1', tools: [{ ...plain.tools[0], description: `A tool. ${'word '.repeat(200)}` }] })
    return ['verify', '--tools', original, '--candidate', big, '--max-bytes', String(JSON.stringify(plain).length + 8)]
  }],
  // The limit is shared, so the original has to fit under it and the candidate
  // has to not: `plain` nests five deep and `document()` six.
  ['candidate-too-deep', 2, 'incomplete', async () => ['verify', '--tools', await writeDocument(plain), '--candidate', await writeDocument(document()), '--max-depth', '5']],
  ['candidate-too-many-nodes', 2, 'incomplete', async () => ['verify', '--tools', await writeDocument(plain), '--candidate', await writeDocument(document()), '--max-nodes', '5']],

  // --- difference established: exit 1, status fail -----------------------
  ['required-changed', 1, 'fail', async () => verifyArgs((entry) => { entry.inputSchema.required = ['id'] })],
  ['enum-changed', 1, 'fail', async () => verifyArgs((entry) => { entry.inputSchema.properties.mode.enum = ['fast'] })],
  ['const-changed', 1, 'fail', async () => verifyArgs((entry) => { entry.inputSchema.properties.mode.const = 'fast' }, (entry) => { entry.inputSchema.properties.mode.const = 'careful' })],
  ['type-changed', 1, 'fail', async () => verifyArgs((entry) => { entry.inputSchema.properties.id.type = 'integer' })],
  ['constraint-changed', 1, 'fail', async () => verifyArgs((entry) => { delete entry.inputSchema.additionalProperties })],
  ['property-removed', 1, 'fail', async () => verifyArgs((entry) => { delete entry.inputSchema.properties.mode })],
  ['property-added', 1, 'fail', async () => verifyArgs((entry) => { entry.inputSchema.properties.extra = { type: 'string' } })],
  ['structure-changed', 1, 'fail', async () => verifyArgs((entry) => { entry.inputSchema.properties.mode = true })],
  ['keyword-added', 1, 'fail', async () => verifyArgs((entry) => { entry.inputSchema.minProperties = 1 })],
  ['description-removed', 1, 'fail', async () => verifyArgs((entry) => { delete entry.inputSchema.properties.id.description })],
  ['description-rewritten', 1, 'fail', async () => verifyArgs((entry) => { entry.inputSchema.properties.id.description = 'Entirely different text.' })],
  ['safety-description-changed', 1, 'fail', async () => verifyArgs((entry) => { entry.inputSchema.properties.confirm.description = 'Set to true.' })],
  ['safety-description-removed', 1, 'fail', async () => verifyArgs((entry) => { delete entry.inputSchema.properties.confirm.description })],
  ['annotation-changed', 1, 'fail', async () => verifyArgs((entry) => { entry.inputSchema.title = 'Input' }, (entry) => { entry.inputSchema.title = 'Other' })],
  ['unknown-keyword-changed', 1, 'fail', async () => verifyArgs((entry) => { entry.inputSchema['x-vendor'] = { queue: 'a' } }, (entry) => { entry.inputSchema['x-vendor'] = { queue: 'b' } })],
  ['unknown-keyword-removed', 1, 'fail', async () => verifyArgs((entry) => { entry.inputSchema['x-vendor'] = { queue: 'a' } }, (entry) => { delete entry.inputSchema['x-vendor'] })],
  ['tool-entry-changed', 1, 'fail', async () => verifyArgs((entry) => { entry.annotations = { readOnlyHint: true } }, (entry) => { entry.annotations = { readOnlyHint: false } })],
  ['tool-missing-from-candidate', 1, 'fail', async () => {
    const original = await writeDocument({ schemaVersion: '1', tools: [tool(), { ...tool(), name: 'second' }] })
    return ['verify', '--tools', original, '--candidate', await writeDocument(document())]
  }],
  ['tool-added-in-candidate', 1, 'fail', async () => {
    const candidate = { schemaVersion: '1', tools: [tool(), { ...tool(), name: 'second' }] }
    return ['verify', '--tools', await writeDocument(document()), '--candidate', await writeDocument(candidate)]
  }],
  ['equivalence-not-proven', 1, 'fail', async () => verifyArgs((entry) => { entry.inputSchema.required = ['id'] })],

  // --- work done as designed: exit 0, status pass ------------------------
  ['description-collapsed', 0, 'pass', async () => ['minify', '--tools', await writeDocument(document())]],
  ['description-protected', 0, 'pass', async () => ['minify', '--tools', await writeDocument(document())]],
  ['annotation-dropped', 0, 'pass', async () => ['minify', '--tools', await writeDocument(document({ title: 'Act' })), '--drop-annotations']],
  ['description-truncated', 0, 'pass', async () => ['minify', '--tools', await writeDocument(document({ description: `Do a thing. ${'word '.repeat(60)}` })), '--max-description-chars', '40']],
  ['schema-keyword-unrecognized', 0, 'pass', async () => {
    const entry = tool()
    entry.inputSchema['x-vendor'] = { queue: 'a' }
    return ['minify', '--tools', await writeDocument({ schemaVersion: '1', tools: [entry] })]
  }],
  ['tool-key-unrecognized', 0, 'pass', async () => ['minify', '--tools', await writeDocument(document({ 'x-owner': 'platform' }))]],
  ['description-contains-control', 0, 'pass', async () => ['minify', '--tools', await writeDocument(document({ description: `Do a thing${NEL}quietly.` }))]],
  ['nothing-compressed', 0, 'pass', async () => ['minify', '--tools', await writeDocument(plain)]],
  // One character over the budget: truncation removes two characters of text
  // and adds an ellipsis, so the estimate does not fall. The copy is refused
  // and the original is kept, which is why the copy is never bigger than the
  // input even at the boundary.
  ['compression-rejected-no-saving', 0, 'pass', async () => ['minify', '--tools', await writeDocument({
    schemaVersion: '1',
    tools: [{ name: 'edge', description: 'a'.repeat(21), inputSchema: { type: 'object', properties: {} } }],
  }), '--max-description-chars', '20']],
]

async function verifyArgs(mutateOriginal, mutateCandidate) {
  const original = JSON.parse(JSON.stringify(document()))
  if (mutateCandidate === undefined) {
    const candidate = candidateWith(mutateOriginal)
    return ['verify', '--tools', await writeDocument(original), '--candidate', await writeDocument(candidate)]
  }
  mutateOriginal(original.tools[0])
  const candidate = JSON.parse(JSON.stringify(original))
  mutateCandidate(candidate.tools[0])
  return ['verify', '--tools', await writeDocument(original), '--candidate', await writeDocument(candidate)]
}

const WHOLE_LIST_RULES = new Set(['tool-missing-from-candidate', 'tool-added-in-candidate'])

for (const [ruleId, expectedExit, expectedStatus, buildArgs] of CASES) {
  test(`${ruleId} exits ${expectedExit} with status ${expectedStatus}`, async () => {
    const { code, stdout } = await runCli(await buildArgs())
    const report = JSON.parse(stdout)
    assert.ok(
      report.findings.some((finding) => finding.ruleId === ruleId),
      `expected ${ruleId}, got ${JSON.stringify(report.findings.map((f) => f.ruleId))}`,
    )
    assert.equal(report.status, expectedStatus)
    assert.equal(code, expectedExit)
    if (expectedExit === 1 && !WHOLE_LIST_RULES.has(ruleId)) {
      // Severity-independent: a tool is counted equivalent only when its
      // comparison found nothing. This assertion survives an edit to the
      // severity table and turns red if the rule stops being emitted at all.
      // The two whole-list rules are excluded because they are about a tool
      // that is present or absent rather than about a tool that was compared.
      assert.equal(report.summary.toolsCompressed, 0)
    }
    assert.equal(report.findings.find((finding) => finding.ruleId === ruleId).severity, RULE_SEVERITY[ruleId])
  })
}

test('every declared rule has a behavioural case', () => {
  // A rule added to the table without a case here fails. The table is the
  // source of truth for severity; this is the guard, and it is an exit code
  // rather than a second copy of the table.
  assert.deepEqual([...new Set(CASES.map(([ruleId]) => ruleId))].sort(), Object.keys(RULE_SEVERITY).sort())
})
