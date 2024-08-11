import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
  if (workspace === null) workspace = await mkdtemp(join(tmpdir(), 'tool-schema-minifier-artifact-'))
  return workspace
}

let counter = 0
async function writeDocument(document) {
  counter += 1
  const path = join(await scratch(), `document-${counter}.json`)
  // Compact, which is what the byte figures are measured on and what the copy
  // is written as: comparing a compact copy against a pretty-printed input
  // would flatter the copy by whatever the indentation cost.
  await writeFile(path, JSON.stringify(document), 'utf8')
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

const WORDY = {
  schemaVersion: '1',
  tools: [
    {
      name: 'search',
      description: 'Search   the   archive   for   matching   records.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What   to   search   for.' },
          limit: { type: 'integer', description: 'How   many   records   to   return.', maximum: 50 },
        },
        required: ['query'],
      },
    },
  ],
}

/**
 * The report's byte figures describe the file the tool actually writes.
 *
 * `bytesBefore` and `bytesAfter` were measured on the compact serialisation
 * while the copy was written pretty-printed, so a 182 -> 170 byte "saving" put
 * a 366-byte file on disk next to a 214-byte input: 71% larger, reported as a
 * compression. At scale a 4,036,283-byte input produced a 4,154,854-byte copy.
 */
test('bytesAfter is exactly the bytes of the entries that were written', async () => {
  const input = await writeDocument(WORDY)
  const out = join(await scratch(), 'measured.json')
  const { code, stdout } = await runCli(['minify', '--tools', input, '--out', out])
  assert.equal(code, 0)
  const summary = JSON.parse(stdout).summary

  const written = JSON.parse(await readFile(out, 'utf8'))
  const bytes = written.tools.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry), 'utf8'), 0)
  assert.equal(bytes, summary.bytesAfter)
  assert.ok(summary.bytesAfter < summary.bytesBefore, JSON.stringify(summary))
})

test('the written copy is not larger than the document it compressed', async () => {
  const input = await writeDocument(WORDY)
  const out = join(await scratch(), 'not-larger.json')
  assert.equal((await runCli(['minify', '--tools', input, '--out', out])).code, 0)
  const before = (await stat(input)).size
  const after = (await stat(out)).size
  assert.ok(after <= before, `the copy is ${after} bytes and the input is ${before}`)
})

/**
 * The boundary where a shorter string costs more bytes.
 *
 * Truncation drops characters and appends one ellipsis -- one character, three
 * bytes in UTF-8. One character over the budget, with punctuation at the cut,
 * the estimate falls by a token while the exact byte count rises. The token
 * rule alone accepted that, so the copy really was larger than its input.
 */
test('a compression that would grow the bytes is refused and the original kept', async () => {
  const document = {
    schemaVersion: '1',
    tools: [{ name: 'edge', description: `${'a'.repeat(19)}!!`, inputSchema: { type: 'object', properties: {} } }],
  }
  const input = await writeDocument(document)
  const out = join(await scratch(), 'edge.json')
  const { code, stdout } = await runCli(['minify', '--tools', input, '--out', out, '--max-description-chars', '20'])
  assert.equal(code, 0)
  const report = JSON.parse(stdout)
  const rejected = report.findings.find((finding) => finding.ruleId === 'compression-rejected-no-saving')
  assert.ok(rejected !== undefined, JSON.stringify(report.findings.map((finding) => finding.ruleId)))
  assert.match(rejected.message, /grown the definition from 101 to 102 bytes/)
  assert.equal(report.summary.bytesAfter, report.summary.bytesBefore)
  assert.equal(report.summary.toolsCompressed, 0)

  const written = JSON.parse(await readFile(out, 'utf8'))
  assert.deepEqual(written.tools[0], document.tools[0], 'the original definition is kept verbatim')
})

/**
 * U+2028 and U+2029 are escaped on the way into the file.
 *
 * They are ordinary characters to JSON and LINE TERMINATORS to ECMAScript, and
 * `JSON.stringify` leaves them raw. A minified tool list is exactly the kind of
 * artifact that gets pasted into a JavaScript module, where one of these breaks
 * the module at load. The CHANGELOG has promised this since 0.1.0 and nothing
 * tested it: the escaping could be deleted and all 211 tests stayed green.
 *
 * The description below is protected -- it says "delete" -- so it is copied byte
 * for byte and the separator really does reach the artifact. That is the case
 * where the escaping matters: an unprotected description has its whitespace
 * collapsed, and these two characters are whitespace to a JavaScript regex.
 */
for (const [name, code] of [['U+2028', 0x2028], ['U+2029', 0x2029]]) {
  test(`${name} in a protected description is escaped in the written copy`, async () => {
    const separator = String.fromCharCode(code)
    const description = `Permanently delete a record.${separator}Ask a person first.`
    const input = await writeDocument({
      schemaVersion: '1',
      tools: [{ name: 'remove', description, inputSchema: { type: 'object', properties: {} } }],
    })
    const out = join(await scratch(), `separator-${code.toString(16)}.json`)
    const { code: exit } = await runCli(['minify', '--tools', input, '--out', out])
    assert.equal(exit, 0)

    const bytes = await readFile(out)
    // The raw character, as UTF-8, must not be in the file...
    const raw = Buffer.from(separator, 'utf8')
    assert.equal(bytes.includes(raw), false, `a raw ${name} reached the artifact`)
    // ...and its JSON escape must be, spelled out rather than interpreted.
    const text = bytes.toString('utf8')
    assert.ok(text.includes(`\\u${code.toString(16)}`), text)
    // Escaping changes no JSON value: the description parses back identical.
    assert.equal(JSON.parse(text).tools[0].description, description)
  })
}
