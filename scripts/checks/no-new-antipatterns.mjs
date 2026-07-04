#!/usr/bin/env node
/**
 * Ratchet guard against post-audit antipatterns.
 *
 * The audit found two repository-wide problems that are being remediated in
 * dedicated campaigns (A1 = route auth/MFA, D1 = money rounding). Those touch
 * hundreds of sites and won't land in one PR: so this guard makes sure the
 * count can only go DOWN, never up, while the migrations are in flight.
 *
 * Checks:
 *   1. raw-route-auth : an `app/api/**\/route.ts` that calls
 *      `supabase.auth.getUser()` directly instead of going through
 *      `requireAuth()` / `withRouteContext()` (the only guards that enforce
 *      MFA AAL2 on hosted). Tracked as a file-set so a NEW offending route
 *      fails CI even if an old one was fixed in the same PR.
 *   2. naive-ore-round: `Math.round(x * 100) / 100`, which is subtly wrong on
 *      exact-half values (see lib/money.ts `roundOre`). Tracked as a count.
 *      The canonical rounding modules are excluded.
 *   3. direct-jel-insert: a file that inserts into `journal_entry_lines`
 *      outside the sanctioned writers. During the dimensions dual-write window
 *      every line writer must derive cost_center/project via
 *      lineDimensionColumns() from the dimensions JSONB map
 *      (lib/bookkeeping/dimension-resolver.ts): a new direct insert site can
 *      silently diverge the mirror columns. Tracked as a file-set.
 *
 * Usage:
 *   node scripts/checks/no-new-antipatterns.mjs            # check (CI)
 *   node scripts/checks/no-new-antipatterns.mjs --update   # re-baseline after a migration ratchets the count down
 *
 * Exit code 1 if either check regressed past its baseline.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BASELINE_PATH = path.join(ROOT, 'scripts', 'checks', 'antipatterns-baseline.json')

const IGNORE_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage'])
// The sanctioned home of the öre-round implementation: must not count against itself.
const ROUND_EXEMPT = new Set(['lib/money.ts', 'lib/bokslut/rounding.ts'])

const RAW_AUTH_RE = /\.auth\.getUser\(/
// Match the guard at its CALL site, not a bare import, so a file that imports
// withRouteContext but still hand-rolls getUser() on another handler is still
// flagged. withRouteContext is usually called with a generic (`withRouteContext<…>(`),
// so accept either `<` or `(` after the name.
const GUARD_RE = /requireAuth\(|withRouteContext[<(]/
const NAIVE_ROUND_RE = /Math\.round\([^\n]*\*\s*100\s*\)\s*\/\s*100/

function walk(dir, exts, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.well-known') continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!IGNORE_DIRS.has(e.name)) walk(full, exts, out)
    } else if (exts.some((x) => e.name.endsWith(x))) {
      out.push(full)
    }
  }
  return out
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/')

/** Route files that hand-roll auth instead of the MFA-enforcing guard. */
function findRawRouteAuth() {
  const apiDir = path.join(ROOT, 'app', 'api')
  return walk(apiDir, ['route.ts'])
    .filter((f) => {
      const src = fs.readFileSync(f, 'utf8')
      return RAW_AUTH_RE.test(src) && !GUARD_RE.test(src)
    })
    .map(rel)
    .sort()
}

// Sanctioned journal_entry_lines insert sites. engine/storno write mirrors via
// dimension-resolver; sie-import and sandbox seed write neither dims nor
// mirrors (DB defaults keep them consistent).
const JEL_INSERT_SANCTIONED = new Set([
  'lib/bookkeeping/engine.ts',
  'lib/core/bookkeeping/storno-service.ts',
  'lib/import/sie-import.ts',
  'app/api/sandbox/seed/route.ts',
])
// Matches an insert CHAINED on the lines table (`.from('journal_entry_lines').insert(`,
// with optional whitespace/newlines in the chain): select-only readers don't count.
const JEL_INSERT_CHAIN_RE = /\.from\(\s*['"]journal_entry_lines['"]\s*\)\s*\.\s*(insert|upsert)\(/

/** Files that insert into journal_entry_lines outside the sanctioned writers. */
function findDirectJelInserts() {
  const files = [
    ...walk(path.join(ROOT, 'lib'), ['.ts', '.tsx']),
    ...walk(path.join(ROOT, 'app'), ['.ts', '.tsx']),
    ...walk(path.join(ROOT, 'extensions'), ['.ts', '.tsx']),
  ]
  return files
    .filter((f) => {
      const r = rel(f)
      if (JEL_INSERT_SANCTIONED.has(r)) return false
      if (r.includes('__tests__/') || r.endsWith('.test.ts')) return false
      return JEL_INSERT_CHAIN_RE.test(fs.readFileSync(f, 'utf8'))
    })
    .map(rel)
    .sort()
}

/** Count of naive Math.round(x*100)/100 occurrences (lines) across source. */
function countNaiveRound() {
  const files = [
    ...walk(path.join(ROOT, 'lib'), ['.ts', '.tsx']),
    ...walk(path.join(ROOT, 'app'), ['.ts', '.tsx']),
    ...walk(path.join(ROOT, 'components'), ['.ts', '.tsx']),
    ...walk(path.join(ROOT, 'extensions'), ['.ts', '.tsx']),
  ]
  let count = 0
  for (const f of files) {
    if (ROUND_EXEMPT.has(rel(f))) continue
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (NAIVE_ROUND_RE.test(line)) count++
    }
  }
  return count
}

const current = {
  rawRouteAuth: findRawRouteAuth(),
  naiveOreRound: countNaiveRound(),
  directJelInsert: findDirectJelInserts(),
}

const isUpdate = process.argv.includes('--update')

if (isUpdate) {
  const baseline = {
    _comment:
      'Ratchet baseline for scripts/checks/no-new-antipatterns.mjs. These counts may only decrease. Re-run with --update after a migration lowers them. Goal: both reach 0 (A1 route-auth campaign, D1 rounding codemod).',
    rawRouteAuth: { count: current.rawRouteAuth.length, files: current.rawRouteAuth },
    naiveOreRound: { count: current.naiveOreRound },
  }
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n')
  console.log(
    `Baseline written: ${current.rawRouteAuth.length} raw-route-auth files, ${current.naiveOreRound} naive-ore-round occurrences.`,
  )
  process.exit(0)
}

if (!fs.existsSync(BASELINE_PATH)) {
  console.error('No baseline found. Run: node scripts/checks/no-new-antipatterns.mjs --update')
  process.exit(1)
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
let failed = false

// 1. raw-route-auth: any file not in the baseline set is a NEW violation.
const baselineSet = new Set(baseline.rawRouteAuth.files)
const newAuthFiles = current.rawRouteAuth.filter((f) => !baselineSet.has(f))
const fixedAuthFiles = baseline.rawRouteAuth.files.filter((f) => !current.rawRouteAuth.includes(f))
if (newAuthFiles.length) {
  failed = true
  console.error(
    `\n✗ raw-route-auth: ${newAuthFiles.length} new route(s) call supabase.auth.getUser() directly ` +
      `instead of requireAuth()/withRouteContext() (skips MFA AAL2 enforcement):`,
  )
  newAuthFiles.forEach((f) => console.error(`    ${f}`))
  console.error('  → wrap the route in withRouteContext (or call requireAuth) so MFA is enforced.')
}

// 1b. direct-jel-insert: allowlist lives in this file (JEL_INSERT_SANCTIONED),
// no baseline: any unsanctioned insert site is a hard failure.
if (current.directJelInsert.length) {
  failed = true
  console.error(
    `\n✗ direct-jel-insert: ${current.directJelInsert.length} file(s) insert into journal_entry_lines ` +
      `outside the sanctioned writers:`,
  )
  current.directJelInsert.forEach((f) => console.error(`    ${f}`))
  console.error(
    '  → route line writes through lib/bookkeeping/engine.ts, or derive cost_center/project via\n' +
      '    lineDimensionColumns() (lib/bookkeeping/dimension-resolver.ts) and add the file to\n' +
      '    JEL_INSERT_SANCTIONED in this script with a justification.',
  )
}

// 2. naive-ore-round: count may not increase.
if (current.naiveOreRound > baseline.naiveOreRound.count) {
  failed = true
  console.error(
    `\n✗ naive-ore-round: ${current.naiveOreRound} occurrences of Math.round(x*100)/100 ` +
      `(baseline ${baseline.naiveOreRound.count}, +${current.naiveOreRound - baseline.naiveOreRound.count}).`,
  )
  console.error('  → import roundOre from @/lib/money instead.')
}

// Report ratchet-down progress (informational, never fails).
if (fixedAuthFiles.length || current.naiveOreRound < baseline.naiveOreRound.count) {
  console.log('\n✓ Progress since baseline:')
  if (fixedAuthFiles.length) console.log(`    raw-route-auth: -${fixedAuthFiles.length} file(s)`)
  if (current.naiveOreRound < baseline.naiveOreRound.count)
    console.log(`    naive-ore-round: -${baseline.naiveOreRound.count - current.naiveOreRound} occurrence(s)`)
  console.log('    Run with --update to ratchet the baseline down and lock in the gains.')
}

if (failed) {
  console.error('\nAntipattern guard failed: see above.')
  process.exit(1)
}
console.log(
  `\n✓ Antipattern guard passed (raw-route-auth: ${current.rawRouteAuth.length}, naive-ore-round: ${current.naiveOreRound}, direct-jel-insert: 0).`,
)
