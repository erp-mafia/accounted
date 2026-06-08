#!/usr/bin/env node
/**
 * Ratchet guard for ESLint errors (sibling of no-new-antipatterns.mjs).
 *
 * `npm run lint` was never wired into CI, so ~60 pre-existing errors
 * accumulated across the repo. Fixing them all in one PR is churn; gating raw
 * `eslint` would break every PR until then. So: ratchet. Error counts are
 * tracked per rule in a committed baseline and can only go DOWN, never up —
 * a PR introducing a NEW error of any rule fails CI, while legacy errors are
 * burned down independently.
 *
 * Warnings stay advisory (only `--quiet` errors are counted).
 *
 * Known tradeoff: counts are per-rule repo-wide, not per-location — a PR that
 * fixes one legacy error of a rule can absorb one NEW error of the same rule
 * without tripping the gate. Acceptable for a burn-down ratchet; tighten to
 * per-file fingerprints if that ever bites.
 *
 * Usage:
 *   node scripts/checks/no-new-lint-errors.mjs            # check (CI)
 *   node scripts/checks/no-new-lint-errors.mjs --update   # re-baseline after fixing legacy errors
 *
 * Exit code 1 if any rule's error count exceeds its baseline.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BASELINE_PATH = path.join(ROOT, 'scripts', 'checks', 'eslint-baseline.json')

function runEslint() {
  const result = spawnSync(
    'npx',
    ['eslint', '.', '--quiet', '-f', 'json'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  // ESLint exits 1 when errors exist — that's expected; only treat a missing/
  // unparsable report as fatal.
  if (!result.stdout) {
    console.error('no-new-lint-errors: eslint produced no JSON output')
    console.error(result.stderr ?? '')
    process.exit(2)
  }
  try {
    return JSON.parse(result.stdout)
  } catch {
    console.error('no-new-lint-errors: failed to parse eslint JSON output')
    process.exit(2)
  }
}

function collectCounts(report) {
  /** @type {Record<string, number>} */
  const perRule = {}
  /** @type {Record<string, string[]>} */
  const locations = {}
  for (const file of report) {
    for (const msg of file.messages) {
      if (msg.severity !== 2) continue
      const rule = msg.ruleId ?? 'fatal'
      perRule[rule] = (perRule[rule] ?? 0) + 1
      const rel = path.relative(ROOT, file.filePath)
      ;(locations[rule] ??= []).push(`${rel}:${msg.line}:${msg.column}`)
    }
  }
  return { perRule, locations }
}

const { perRule, locations } = collectCounts(runEslint())
const total = Object.values(perRule).reduce((a, b) => a + b, 0)

if (process.argv.includes('--update')) {
  const sorted = Object.fromEntries(Object.entries(perRule).sort(([a], [b]) => a.localeCompare(b)))
  fs.writeFileSync(
    BASELINE_PATH,
    JSON.stringify({ totalErrors: total, perRule: sorted }, null, 2) + '\n',
  )
  console.log(`no-new-lint-errors: baseline updated — ${total} error(s) across ${Object.keys(perRule).length} rule(s).`)
  process.exit(0)
}

if (!fs.existsSync(BASELINE_PATH)) {
  console.error(`no-new-lint-errors: baseline missing at ${path.relative(ROOT, BASELINE_PATH)}.`)
  console.error('Run: node scripts/checks/no-new-lint-errors.mjs --update')
  process.exit(2)
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
const baselineRules = baseline.perRule ?? {}

const regressions = []
for (const [rule, count] of Object.entries(perRule)) {
  const allowed = baselineRules[rule] ?? 0
  if (count > allowed) regressions.push({ rule, count, allowed })
}

if (regressions.length > 0) {
  console.error('no-new-lint-errors: FAILED — new ESLint errors beyond the baseline:\n')
  for (const { rule, count, allowed } of regressions) {
    console.error(`  ${rule}: ${count} (baseline ${allowed})`)
    for (const loc of (locations[rule] ?? []).slice(0, 10)) {
      console.error(`    ${loc}`)
    }
  }
  console.error(`
Fix the new error(s) — run \`npx eslint . --quiet\` locally to see them.
(If you fixed MORE legacy errors than you added and the rule still trips,
re-baseline with: node scripts/checks/no-new-lint-errors.mjs --update)
`)
  process.exit(1)
}

const improved = total < (baseline.totalErrors ?? 0)
console.log(
  `no-new-lint-errors: OK — ${total} error(s), baseline ${baseline.totalErrors}.` +
    (improved
      ? ' Count went DOWN — ratchet it: node scripts/checks/no-new-lint-errors.mjs --update'
      : ''),
)
