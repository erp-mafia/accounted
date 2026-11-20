#!/usr/bin/env node
/**
 * Ratchet guard for TypeScript errors.
 *
 * ## Why this exists
 *
 * `npm test` does not typecheck. Vitest transpiles and throws the types away,
 * so a type error passes the entire 18 000-test suite and only surfaces in
 * `npm run build`, several minutes later. That happened twice on 2026-08-27
 * alone: a widened union in the MCP server that a second declaration in
 * lib/events/types.ts still contradicted, and an `interface` that would not
 * assign into `Record<string, unknown>[]` because interfaces have no implicit
 * index signature. Both were caught by the build. Neither was caught by 18 000
 * green tests, which is exactly the wrong order to learn it in.
 *
 * `tsc --noEmit` finds both, and unlike the build it also covers `__tests__`
 * files, which the Next.js build never compiles.
 *
 * ## Which compiler
 *
 * The check runs TypeScript 7, the native compiler, installed beside the
 * project's `typescript` package under the name `@typescript/native`. It reads
 * the same tsconfig.json. The editor, ESLint and the Next.js build keep using
 * `typescript`: TypeScript 7.0 has no programmatic API for them to call.
 *
 * ## Why the baseline is keyed by FILE, not by error code
 *
 * A per-code budget accepts the tradeoff that fixing one legacy error of a
 * code lets a new one in. For types that tradeoff is too costly:
 * the pre-existing errors are concentrated in a handful of old test files, and
 * TS2322 ("not assignable") is common enough that a per-code budget would
 * silently absorb a real regression somewhere else entirely. Keyed by file, a
 * new error in a previously-clean file trips immediately, which is the case
 * that actually matters.
 *
 * Usage:
 *   node scripts/checks/no-new-type-errors.mjs            # check
 *   node scripts/checks/no-new-type-errors.mjs --update   # re-baseline
 *
 * Exit code 1 if any file's error count exceeds its baseline; exit code 2 if
 * tsc did not produce a complete result (killed, crashed, out of memory, or a
 * failure with no file errors), so a dead tsc can never read as "0 errors".
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BASELINE_PATH = path.join(ROOT, 'scripts', 'checks', 'typecheck-baseline.json')

/**
 * The compiler's own program for this platform, not the `tsc` launcher beside
 * it: the launcher is a Node script that turns a killed compiler into exit
 * status 1, which is also the status for "found type errors".
 */
const TSC_EXE = path.join(
  ROOT,
  'node_modules',
  '@typescript',
  `typescript-${process.platform}-${process.arch}`,
  'lib',
  process.platform === 'win32' ? 'tsc.exe' : 'tsc',
)

/**
 * Type-checker workers. The same number everywhere: a different count can, in
 * rare cases, change which of two equivalent errors is reported, and the
 * baseline counts errors per file. More workers finish sooner and hold more
 * memory.
 */
const CHECKERS = 2

/**
 * The compiler is a Go program, and Go grows its heap to about twice the live
 * data before it collects. On a 16 GB host that doubling is what runs the
 * machine out of memory, not the program itself. GOMEMLIMIT tells the runtime
 * where to start collecting harder instead; it is a soft limit, a check that
 * needs more still finishes. Three quarters of the machine, unless the caller
 * set its own.
 *
 * @param {number} totalBytes
 * @returns {string}
 */
export function memoryLimit(totalBytes) {
  return `${Math.max(1024, Math.floor((totalBytes * 0.75) / (1024 * 1024)))}MiB`
}

function runTsc() {
  if (!fs.existsSync(TSC_EXE)) {
    return { status: null, signal: null, stdout: '', stderr: '', error: new Error(`${path.relative(ROOT, TSC_EXE)} is missing. Run: npm install`) }
  }
  const args = ['--noEmit', '--pretty', 'false', '--checkers', String(CHECKERS), '--diagnostics']
  // CI keeps tsc's incremental state between runs (CHECKS_CACHE_DIR, see
  // .github/workflows/ci.yml). A warm run rechecks only the changed files and their
  // dependents, and the stored diagnostics still report every error in the
  // unchanged ones, so the per-file counts below stay complete.
  if (process.env.CHECKS_CACHE_DIR) {
    const cacheDir = path.resolve(ROOT, process.env.CHECKS_CACHE_DIR)
    fs.mkdirSync(cacheDir, { recursive: true })
    args.push('--incremental', '--tsBuildInfoFile', path.join(cacheDir, 'tsc.tsbuildinfo'))
  }
  return spawnSync(TSC_EXE, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { GOMEMLIMIT: memoryLimit(os.totalmem()), ...process.env },
  })
}

/** `path/to/file.ts(12,34): error TS2322: ...` */
const ERROR_RE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/

/**
 * Decide whether a tsc run is a result the ratchet may compare. tsc exits 0
 * when clean and 2 (1 on some versions) when it found errors; a run killed by
 * a signal, crashed, or out of memory prints partial or no output, and
 * parsing that as "0 errors" let regressions through on 2026-10-11 while the
 * machine was out of memory. A failing exit with no file errors (a config or
 * missing-file error such as TS6053) is not a result either.
 *
 * @param {{ status: number | null, signal?: string | null, stdout?: string | null, stderr?: string | null, error?: Error }} result
 * @returns {{ ok: true, output: string } | { ok: false, message: string }}
 */
export function judgeTscRun(result) {
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.error) return { ok: false, message: `tsc could not run: ${result.error.message}` }
  if (/fatal error: runtime: out of memory|cannot allocate memory/.test(output)) {
    return { ok: false, message: 'tsc ran out of memory before it finished; partial output is not a result.' }
  }
  // A crash of the compiler itself exits with status 2, like a run that found
  // errors, and may come after some file errors were already printed.
  const crash = /^(?:fatal error|panic): .*$/m.exec(output)
  if (crash) {
    return { ok: false, message: `tsc crashed before it finished (${crash[0].trim()}); partial output is not a result.` }
  }
  if (result.signal) {
    return { ok: false, message: `tsc was killed by ${result.signal} before it finished; partial output is not a result. Rerun when the machine has memory to spare.` }
  }
  if (result.status !== 0 && result.status !== 1 && result.status !== 2) {
    return { ok: false, message: `tsc exited with status ${result.status}, neither a clean run (0) nor a run with type errors (2).` }
  }
  if (result.status !== 0 && !output.split('\n').some((line) => ERROR_RE.test(line.trim()))) {
    const head = output.trim().split('\n').slice(0, 5).join('\n') || '(no output)'
    return { ok: false, message: `tsc failed (status ${result.status}) without reporting any file errors:\n${head}` }
  }
  return { ok: true, output }
}

/**
 * What the run cost, from the lines `--diagnostics` prints.
 *
 * @param {string} output
 * @returns {string} for example "71.3 s, 9.6 GB", or "" when the lines are missing
 */
export function describeCost(output) {
  const seconds = /^Total time:\s+([\d.]+)s$/m.exec(output)
  const kilobytes = /^Memory used:\s+(\d+)K$/m.exec(output)
  const parts = []
  if (seconds) parts.push(`${Number(seconds[1]).toFixed(1)} s`)
  if (kilobytes) parts.push(`${(Number(kilobytes[1]) / (1024 * 1024)).toFixed(1)} GB`)
  return parts.join(', ')
}

function collect(output) {
  /** @type {Record<string, number>} */
  const perFile = {}
  /** @type {Record<string, string[]>} */
  const locations = {}
  for (const line of output.split('\n')) {
    const match = ERROR_RE.exec(line.trim())
    if (!match) continue
    const [, file, lineNo, col, code, message] = match
    const rel = path.relative(ROOT, path.resolve(ROOT, file)).split(path.sep).join('/')
    perFile[rel] = (perFile[rel] ?? 0) + 1
    ;(locations[rel] ??= []).push(`${rel}:${lineNo}:${col} ${code} ${message}`)
  }
  return { perFile, locations }
}

function main() {
  const run = judgeTscRun(runTsc())
  if (!run.ok) {
    console.error(`no-new-type-errors: ${run.message}`)
    process.exit(2)
  }
  const { perFile, locations } = collect(run.output)
  const total = Object.values(perFile).reduce((a, b) => a + b, 0)
  const cost = describeCost(run.output)
  if (cost) console.log(`no-new-type-errors: tsc took ${cost}.`)

  if (process.argv.includes('--update')) {
    const sorted = Object.fromEntries(Object.entries(perFile).sort(([a], [b]) => a.localeCompare(b)))
    fs.writeFileSync(
      BASELINE_PATH,
      JSON.stringify({ totalErrors: total, perFile: sorted }, null, 2) + '\n',
    )
    console.log(
      `no-new-type-errors: baseline updated: ${total} error(s) across ${Object.keys(perFile).length} file(s).`,
    )
    process.exit(0)
  }

  if (!fs.existsSync(BASELINE_PATH)) {
    console.error(`no-new-type-errors: baseline missing at ${path.relative(ROOT, BASELINE_PATH)}.`)
    console.error('Run: node scripts/checks/no-new-type-errors.mjs --update')
    process.exit(2)
  }

  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
  const baselineFiles = baseline.perFile ?? {}

  const regressions = []
  for (const [file, count] of Object.entries(perFile)) {
    const allowed = baselineFiles[file] ?? 0
    if (count > allowed) regressions.push({ file, count, allowed })
  }

  if (regressions.length > 0) {
    console.error('no-new-type-errors: FAILED: new TypeScript errors beyond the baseline:\n')
    for (const { file, count, allowed } of regressions) {
      console.error(`  ${file}: ${count} (baseline ${allowed})`)
      for (const loc of (locations[file] ?? []).slice(0, 10)) {
        console.error(`    ${loc}`)
      }
    }
    console.error(`
Fix the new error(s): run \`npx --package=@typescript/native tsc --noEmit\` to see them all.
(If you fixed MORE legacy errors than you added and a file still trips,
re-baseline with: node scripts/checks/no-new-type-errors.mjs --update)
`)
    process.exit(1)
  }

  const improved = total < (baseline.totalErrors ?? 0)
  console.log(
    `no-new-type-errors: OK: ${total} error(s), baseline ${baseline.totalErrors}.` +
      (improved
        ? ' Count went DOWN: ratchet it: node scripts/checks/no-new-type-errors.mjs --update'
        : ''),
  )
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main()
