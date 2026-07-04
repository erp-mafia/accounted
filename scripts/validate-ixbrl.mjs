#!/usr/bin/env node
/**
 * Validate a generated iXBRL årsredovisning against the official taxonomy
 * package using Arelle (https://arelle.org): layer 2 of the validation
 * stack (layer 1 = pre-flight rules engine, layer 3 = Bolagsverket
 * `kontrollera`).
 *
 * Usage:
 *   npm run validate:ixbrl -- path/to/arsredovisning.xhtml
 *
 * Arelle discovery order:
 *   1. `arelleCmdLine` on PATH (pip install arelle-release)
 *   2. `python -m arelle.CntlrCmdLine`
 *   3. docker image `arelle/arelle` (mounts the file + taxonomy package)
 *
 * Exits 0 with a notice when Arelle isn't available (CI machines without
 * Python shouldn't hard-fail), 1 on validation errors, 2 on usage errors.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TAXONOMY_PACKAGE = resolve(
  ROOT,
  'dev_docs/bokslut/taxonomi/taxonomi-paket-2024-09-12_rev20250312.zip',
)

const fileArg = process.argv[2]
if (!fileArg) {
  console.error('Usage: npm run validate:ixbrl -- <file.xhtml>')
  process.exit(2)
}
const file = resolve(process.cwd(), fileArg)
if (!existsSync(file)) {
  console.error(`File not found: ${file}`)
  process.exit(2)
}
if (!existsSync(TAXONOMY_PACKAGE)) {
  console.error(`Taxonomy package missing: ${TAXONOMY_PACKAGE}`)
  process.exit(2)
}

const ARELLE_ARGS = [
  '--file',
  file,
  '--packages',
  TAXONOMY_PACKAGE,
  '--validate',
  '--logLevel',
  'warning',
]

function tryRun(cmd, args, label) {
  const probe = spawnSync(cmd, ['--version'], { encoding: 'utf8', shell: false })
  if (probe.error || probe.status !== 0) return null
  console.log(`Validating with ${label} …`)
  const run = spawnSync(cmd, args, { encoding: 'utf8', stdio: 'inherit', shell: false })
  return run.status ?? 1
}

let status = tryRun('arelleCmdLine', ARELLE_ARGS, 'arelleCmdLine')

if (status === null) {
  const probe = spawnSync('python', ['-c', 'import arelle'], { encoding: 'utf8' })
  if (!probe.error && probe.status === 0) {
    console.log('Validating with python -m arelle.CntlrCmdLine …')
    const run = spawnSync('python', ['-m', 'arelle.CntlrCmdLine', ...ARELLE_ARGS], {
      encoding: 'utf8',
      stdio: 'inherit',
    })
    status = run.status ?? 1
  }
}

if (status === null) {
  const probe = spawnSync('docker', ['--version'], { encoding: 'utf8' })
  if (!probe.error && probe.status === 0) {
    console.log('Validating with docker image arelle/arelle …')
    const run = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '-v',
        `${dirname(file)}:/data`,
        '-v',
        `${dirname(TAXONOMY_PACKAGE)}:/taxonomy`,
        'arelle/arelle',
        '--file',
        `/data/${basename(file)}`,
        '--packages',
        `/taxonomy/${basename(TAXONOMY_PACKAGE)}`,
        '--validate',
        '--logLevel',
        'warning',
      ],
      { encoding: 'utf8', stdio: 'inherit' },
    )
    status = run.status ?? 1
  }
}

if (status === null) {
  console.log(
    'Arelle is not installed: skipping schema validation.\n' +
      'Install with: pip install arelle-release  (or use the arelle/arelle docker image).',
  )
  process.exit(0)
}

process.exit(status === 0 ? 0 : 1)
