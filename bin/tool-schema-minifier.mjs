#!/usr/bin/env node

import { isAbsolute, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import {
  LIMIT_CEILINGS,
  formatReport,
  minifyToolFile,
  prepareDestination,
  readConfigFile,
  verifyToolFiles,
  writeArtifactFile,
} from '../src/index.mjs'

const HELP = `tool-schema-minifier

Compress a tool-definition document and report what it saved -- after checking
that the compressed copy still means the same thing.

What is never touched:

  * required parameter lists, enums, consts, types and every other validation
    keyword: copied verbatim, then compared;
  * any description that governs an approval: copied byte for byte. A
    description is protected when its node carries "x-approval" or
    "x-safety-critical", when --protect-tool names its tool, or when its text
    matches the frozen marker list in docs/compression-rules.md;
  * any keyword this tool does not recognise, and everything under it.

What may change: runs of whitespace inside an unprotected description, the
length of an unprotected description (--max-description-chars), and, with
--drop-annotations, the annotation keywords "title", "$comment", "example" and
"examples" in a schema position -- never a parameter that happens to be named
one of those words.

Usage:
  tool-schema-minifier minify --tools FILE [--out FILE] [options]
  tool-schema-minifier verify --tools FILE --candidate FILE [options]

Commands:
  minify   Build the compressed copy, check it, and report the difference.
  verify   Check a compressed copy produced elsewhere against the original.

Options:
  --tools FILE                 The tool-definition document (required)
  --candidate FILE             The compressed copy to check (verify only)
  --out FILE                   Write the compressed copy here (minify only),
                               as compact JSON. Written only when the run
                               passes. The destination's directory is created if
                               it is missing. A symbolic link, a parent that
                               resolves elsewhere, anything that is not a
                               regular file, and any spelling of an input
                               document -- including a hard link to it -- are
                               refused before anything is opened.
  --drop-annotations           Also remove title/$comment/example/examples
  --protect-tool NAME          Treat every description in this tool as
                               approval-governing. May be repeated.
  --config FILE                JSON file of limit overrides: { "limits": {...} }
  --human                      Write the human summary on stdout instead of JSON
  --max-bytes N                Maximum document size (default 4194304)
  --max-tools N                Maximum declared tools (default 500)
  --max-nodes N                Maximum objects and arrays in a document (default 50000)
  --max-depth N                Maximum document nesting depth (default 32,
                               highest accepted 1000)
  --max-description-chars N    Description budget in characters (default 240)
  --max-millis N               Time budget in milliseconds (default 10000)
  -h, --help                   Show this help

stdout carries the JSON report and nothing else unless --human is given, so a
consumer can pipe it straight into a parser. Progress, the mode and the reason a
copy was not written go to stderr.

A flag is accepted once -- a repeated flag is a configuration error, not a
silent last-wins -- except --protect-tool, which is a list. An unknown option is
refused rather than ignored: a typo that falls back to a default is a real
failure reported as a green run. A flag overrides the same limit in --config.

The token number is an ESTIMATE from a declared pre-tokenizer with no
vocabulary. It is comparable between two documents measured by this tool and is
not any provider's billing count. Bytes are exact.

Exit codes:
  0  the copy was checked and is equivalent; nothing protected was changed
  1  the copy is not equivalent to the original, or a protected description,
     required list, enum or parameter changed
  2  invalid usage or configuration (no report on stdout), or evidence that was
     missing, unreadable or bounded out (an "incomplete" report on stdout)
`

const LIMIT_FLAGS = new Map([
  ['--max-bytes', 'maxBytes'],
  ['--max-tools', 'maxTools'],
  ['--max-nodes', 'maxNodes'],
  ['--max-depth', 'maxDepth'],
  ['--max-description-chars', 'maxDescriptionChars'],
  ['--max-millis', 'maxMillis'],
])

const COMMANDS = new Set(['minify', 'verify'])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const [command, ...rest] = argv
  if (command === undefined) throw new Error('a command is required: minify or verify')
  if (!COMMANDS.has(command)) throw new Error(`Unknown command "${command}"`)

  const options = {
    command,
    tools: null,
    candidate: null,
    out: null,
    config: null,
    human: false,
    dropAnnotations: false,
    protectTools: [],
    limits: {},
  }
  const given = new Set()
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]
    const takeValue = (name) => {
      const value = rest[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--human') {
      once(argument)
      options.human = true
    } else if (argument === '--drop-annotations') {
      once(argument)
      options.dropAnnotations = true
    } else if (argument === '--tools') {
      once(argument)
      options.tools = takeValue(argument)
    } else if (argument === '--candidate') {
      once(argument)
      options.candidate = takeValue(argument)
    } else if (argument === '--out') {
      once(argument)
      options.out = takeValue(argument)
    } else if (argument === '--config') {
      once(argument)
      options.config = takeValue(argument)
    } else if (argument === '--protect-tool') {
      // Deliberately repeatable: it names a list, not a setting.
      options.protectTools.push(takeValue(argument))
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      const name = LIMIT_FLAGS.get(argument)
      const floor = argument === '--max-millis' ? 0 : argument === '--max-description-chars' ? 8 : 1
      if (!/^\d+$/.test(raw) || Number(raw) < floor) {
        throw new Error(`${argument} requires an integer of at least ${floor}`)
      }
      // A ceiling is a documented limit like any other. --max-depth has one
      // because the comparison recurses: raised past what the stack carries,
      // the process died with a bare "Maximum call stack size exceeded" and no
      // report at all, which is a crash wearing the shape of a diagnosis.
      const ceiling = Object.hasOwn(LIMIT_CEILINGS, name) ? LIMIT_CEILINGS[name] : null
      if (ceiling !== null && Number(raw) > ceiling) {
        throw new Error(`${argument} requires an integer of at most ${ceiling}; past that this tool cannot walk the document without exhausting the stack`)
      }
      options.limits[name] = Number(raw)
    } else {
      throw new Error(`Unknown option "${argument}"`)
    }
  }

  if (options.tools === null) throw new Error('--tools is required')
  if (command === 'verify') {
    if (options.candidate === null) throw new Error('--candidate is required for verify')
    if (options.out !== null) throw new Error('--out is only meaningful for minify')
  } else if (options.candidate !== null) {
    throw new Error('--candidate is only meaningful for verify')
  }
  return options
}

/**
 * The label a finding carries.
 *
 * `location.file` is never an absolute host path: a report is an artifact
 * people paste into issues and diff between machines. A document inside the
 * working directory is named relative to it; anything else is named by its base
 * name alone.
 */
function sourceLabel(path) {
  const absolute = resolve(path)
  const fromHere = relative(process.cwd(), absolute)
  if (fromHere === '' || fromHere.startsWith('..') || isAbsolute(fromHere)) return absolute.split(/[\\/]/).pop()
  return fromHere.split('\\').join('/')
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }

  // Configuration is settled before any document is read, so a bad limit or an
  // unusable destination fails with no report at all rather than half way
  // through a run.
  let limits = options.limits
  if (options.config !== null) {
    try {
      limits = { ...await readConfigFile(options.config), ...options.limits }
    } catch (error) {
      process.stderr.write(`--config is not usable: ${error.message}\n`)
      return 2
    }
  }

  let destination = null
  if (options.out !== null) {
    try {
      destination = await prepareDestination(options.out, { inputs: [options.tools], label: '--out' })
    } catch (error) {
      process.stderr.write(`${error.message}\n`)
      return 2
    }
  }

  const shared = {
    source: sourceLabel(options.tools),
    limits,
    protectTools: options.protectTools,
    // The clock the documented time budget is measured with. Wiring it here is
    // the difference between a limit that is enforced and one that is merely
    // written down.
    clock: () => performance.now(),
  }

  let result
  try {
    result = options.command === 'verify'
      ? await verifyToolFiles(options.tools, options.candidate, shared)
      : await minifyToolFile(options.tools, { ...shared, dropAnnotations: options.dropAnnotations })
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  const { report } = result

  if (destination !== null) {
    /**
     * The copy is written only for a run that passed.
     *
     * A run that is `fail` produced a copy this tool refused, and a run that is
     * `incomplete` did not read or check part of the document. Writing either
     * one would put a file on disk that looks like a verified compression and
     * is not, which is precisely the "unknown reported as a pass" shape the
     * contract names first.
     */
    if (report.status === 'pass') {
      try {
        await writeArtifactFile(destination, result.document)
        process.stderr.write(`compressed copy written: ${destination}\n`)
      } catch (error) {
        process.stderr.write(`the compressed copy could not be written: ${error.code ?? error.message}\n`)
        return 2
      }
    } else {
      process.stderr.write(`no compressed copy was written: the run is "${report.status}", not a pass\n`)
    }
  }

  process.stdout.write(options.human ? formatReport(report, result.mode) : `${JSON.stringify(report, null, 2)}\n`)

  if (report.status === 'incomplete') {
    process.stderr.write(
      `incomplete: part of this document was not read or not checked, so this run is not a verdict (mode ${result.mode}).\n`,
    )
    return 2
  }
  return report.status === 'fail' ? 1 : 0
}

process.exitCode = await main(process.argv.slice(2))
