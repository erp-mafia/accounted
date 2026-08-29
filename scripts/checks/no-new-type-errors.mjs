#!/usr/bin/env node
/**
 * Ratchet guard for TypeScript errors (sibling of no-new-lint-errors.mjs).
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
 * `tsc --noEmit` finds both in about two minutes, and unlike the build it also
 * covers `__tests__` files, which the Next.js build never compiles.
 *
 * ## Why the baseline is keyed by FILE, not by error code
 *
 * The lint ratchet counts per rule, and accepts the tradeoff that fixing one
 * legacy error of a rule lets a new one in. For types that tradeoff is worse:
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
 * Exit code 1 if any file's error count exceeds its baseline.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BASELINE_PATH = path.join(ROOT, 'scripts', 'checks', 'typecheck-baseline.json')

/**
 * This project's graph does not fit in Node's default heap: a bare
 * `tsc --noEmit` dies with "Ineffective mark-compacts near heap limit" after
 * about two minutes of work, which reads like a hang rather than a
 * misconfiguration. The build sets the same flag for the same reason.
 */
const HEAP_MB = 8192

function runTsc() {
  const tscBin = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
  const result = spawnSync(process.execPath, [tscBin, '--noEmit', '--pretty', 'false'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: `--max-old-space-size=${HEAP_MB}` },
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (/Ineffective mark-compacts|JavaScript heap out of memory/.test(output)) {
    console.error(`no-new-type-errors: tsc ran out of memory at ${HEAP_MB} MB. Raise HEAP_MB.`)
    process.exit(2)
  }
  // tsc exits non-zero when errors exist, which is the normal case here.
  return output
}

/** `path/to/file.ts(12,34): error TS2322: ...` */
const ERROR_RE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/

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

const { perFile, locations } = collect(runTsc())
const total = Object.values(perFile).reduce((a, b) => a + b, 0)

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
Fix the new error(s): run \`NODE_OPTIONS=--max-old-space-size=${HEAP_MB} npx tsc --noEmit\` to see them all.
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
