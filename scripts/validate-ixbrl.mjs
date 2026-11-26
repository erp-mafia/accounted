#!/usr/bin/env node
/**
 * Validate a generated iXBRL årsredovisning against the official taxonomy
 * package using Arelle (https://arelle.org): layer 2 of the validation
 * stack (layer 1 = pre-flight rules engine, layer 3 = Bolagsverket
 * `kontrollera`).
 *
 * Usage:
 *   npm run validate:ixbrl -- path/to/arsredovisning.xhtml [--package <zip>] [--no-calc]
 *
 * The taxonomy package follows the document's schemaRef: a K3 document
 * (se/fr/gaap/k3/...) validates against taxonomi-paket-2026-08-31.zip, the
 * package the K3 registry is generated from; anything else against the
 * 2024-09-12 package the K2 registry comes from. --package overrides.
 *
 * Arelle discovery order:
 *   1. `arelleCmdLine` on PATH (pip install arelle-release)
 *   2. `python -m arelle.CntlrCmdLine`
 *   3. docker image `arelleproject/arelle` (mounts the file + taxonomy package)
 *
 * Arelle is asked for inconsistent duplicate facts (--validateDuplicateFacts
 * inconsistent): a concept tagged more than once for the same context must
 * state values that correspond, as the flerårsöversikt in tkr and the
 * resultaträkning in kronor must (TA §2.7.3).
 *
 * Arelle also checks the sums of the taxonomy's calculation linkbase (--calc
 * c11r, Calculations 1.1 rounding to nearest): a total must equal its rows.
 * The K3 entry point carries no calculation linkbase, so K3 sums go unchecked.
 * The XBRL 2.1 mode (c10) skips the sums that take in a fact tagged twice, as
 * nettoomsättning and resultat efter finansiella poster are, and truncation
 * (c11t) contradicts tkr figures rounded to the nearest thousand.
 *
 * --no-calc leaves the sums out, for an ekonomisk förening's document. The
 * product files that form on paper (ixbrl: false in
 * src/lib/company/forms/se-ekonomisk-forening.ts, and AR-DIGITAL-ENTITY in
 * src/lib/bokslut/arsredovisning/eligibility.ts), and the document, built on
 * the aktiebolag entry point, tags no rows under its bundet eget kapital.
 *
 * Arelle itself exits 0 whatever it finds, so the log is read: any ERROR or
 * CRITICAL message, any inconsistent duplicate facts (which Arelle logs as a
 * warning) and any INCONSISTENCY message (a sum that does not add up) fail the
 * run (exit 1); other warnings are printed and pass.
 * Exits 0 with a notice when Arelle isn't available (CI machines without
 * Python shouldn't hard-fail), 2 on usage errors.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TAXONOMY_DIR = resolve(ROOT, 'docs/reference/bokslut/taxonomi')
const K2_PACKAGE = resolve(TAXONOMY_DIR, 'taxonomi-paket-2024-09-12_rev20250312.zip')
const K3_PACKAGE = resolve(TAXONOMY_DIR, 'taxonomi-paket-2026-08-31.zip')

const args = process.argv.slice(2)
const packageFlag = args.indexOf('--package')
const packageArg = packageFlag === -1 ? null : args[packageFlag + 1]
const noCalc = args.includes('--no-calc')
const fileArg = args.find(
  (arg, index) => !arg.startsWith('--') && (packageFlag === -1 || index !== packageFlag + 1),
)
if (!fileArg || (packageFlag !== -1 && !packageArg)) {
  console.error('Usage: npm run validate:ixbrl -- <file.xhtml> [--package <taxonomy-package.zip>] [--no-calc]')
  process.exit(2)
}
const file = resolve(process.cwd(), fileArg)
if (!existsSync(file)) {
  console.error(`File not found: ${file}`)
  process.exit(2)
}
const isK3 = /xbrl\.taxonomier\.se\/se\/fr\/gaap\/k3\//.test(readFileSync(file, 'utf8'))
const TAXONOMY_PACKAGE = packageArg ? resolve(process.cwd(), packageArg) : isK3 ? K3_PACKAGE : K2_PACKAGE
if (!existsSync(TAXONOMY_PACKAGE)) {
  console.error(`Taxonomy package missing: ${TAXONOMY_PACKAGE}`)
  process.exit(2)
}

const LOG_FORMAT = '[%(levelname)s] [%(messageCode)s] %(message)s'
const arelleArgs = (filePath, packagePath) => [
  '--file',
  filePath,
  '--packages',
  packagePath,
  '--validate',
  '--validateDuplicateFacts',
  'inconsistent',
  ...(noCalc ? [] : ['--calc', 'c11r']),
  '--logLevel',
  'warning',
  '--logFormat',
  LOG_FORMAT,
]

/**
 * Run Arelle, echo its log, and turn ERROR/CRITICAL messages, inconsistent
 * duplicate facts and INCONSISTENCY messages into exit 1.
 */
function runArelle(cmd, argv, label) {
  const sums = noCalc ? ', sums not checked' : ''
  console.log(`Validating ${basename(file)} against ${basename(TAXONOMY_PACKAGE)} with ${label}${sums} …`)
  const run = spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  if (output.trim()) process.stdout.write(output.endsWith('\n') ? output : `${output}\n`)
  const lines = output.split('\n')
  const errors = lines.filter((line) => /^\[(ERROR|CRITICAL)\]/.test(line)).length
  // Logged as a warning: `[WARNING] [arelle:duplicateFacts] Duplicate fact set ...`.
  const duplicates = lines.filter((line) => /^\[[A-Z-]+\] \[arelle:duplicateFacts\]/.test(line)).length
  // Their own level: `[INCONSISTENCY] [calc11e:inconsistentCalculationUsingRounding] ...`.
  const inconsistencies = lines.filter((line) => /^\[INCONSISTENCY\]/.test(line)).length
  if ((run.status ?? 1) !== 0) return 1
  if (errors > 0 || duplicates > 0 || inconsistencies > 0) {
    console.error(
      `Arelle reported ${errors} error(s), ${duplicates} set(s) of inconsistent duplicate facts and ${inconsistencies} inconsistency(ies).`,
    )
    return 1
  }
  console.log('Arelle: no errors.')
  return 0
}

function available(cmd, probeArgs) {
  const probe = spawnSync(cmd, probeArgs, { encoding: 'utf8', shell: false })
  return !probe.error && probe.status === 0
}

let status = null
if (available('arelleCmdLine', ['--version'])) {
  status = runArelle('arelleCmdLine', arelleArgs(file, TAXONOMY_PACKAGE), 'arelleCmdLine')
} else if (available('python', ['-c', 'import arelle'])) {
  status = runArelle('python', ['-m', 'arelle.CntlrCmdLine', ...arelleArgs(file, TAXONOMY_PACKAGE)], 'python -m arelle.CntlrCmdLine')
} else if (available('docker', ['--version'])) {
  status = runArelle(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      `${dirname(file)}:/data`,
      '-v',
      `${dirname(TAXONOMY_PACKAGE)}:/taxonomy`,
      'arelleproject/arelle',
      // The image's entrypoint execs the command it is given, so Arelle is
      // started the way the image's docs start it.
      'python',
      'arelleCmdLine.py',
      ...arelleArgs(`/data/${basename(file)}`, `/taxonomy/${basename(TAXONOMY_PACKAGE)}`),
    ],
    'docker image arelleproject/arelle',
  )
}

if (status === null) {
  console.log(
    'Arelle is not installed: skipping schema validation.\n' +
      'Install with: pip install arelle-release  (or use the arelleproject/arelle docker image).',
  )
  process.exit(0)
}

process.exit(status)
