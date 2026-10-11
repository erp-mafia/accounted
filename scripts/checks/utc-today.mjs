#!/usr/bin/env node
/**
 * Guard: "today" computed as the UTC calendar date.
 *
 * `new Date().toISOString().slice(0, 10)` (and its `.split('T')[0]` twin) is
 * the UTC date, which lags the Swedish calendar day by one between midnight
 * and 01:00/02:00 Stockholm time. Used as a default entry date, payment date,
 * "is this period over yet" cutoff or report as-of date, it books, filters
 * and labels against yesterday. In October 2026 the same expression stood in
 * for "today" at about a hundred sites, next to three helpers that already
 * did it right (todayIsoStockholm, getSwedishLocalDate, swedishToday): the
 * definition lived everywhere, so the bug did too. todayIsoStockholm() from
 * lib/dates/iso is the one definition; this check keeps the inline form out.
 *
 * Flagged, in app/, components/, extensions/ and lib/ (tests excluded):
 *   - new Date().toISOString().slice(0, 10) / .substring(0, 10)
 *   - new Date().toISOString().split('T')[0]
 *   - toIsoDate(new Date())
 * A timestamp (the full toISOString()) is not flagged: it carries its zone.
 *
 * UTC_TODAY_ALLOWED lists files where the UTC date is the right one, each
 * with its reason. It may only shrink.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const UTC_TODAY_ALLOWED = new Set([
  // Enable Banking date_to for transaction fetches: an upper bound sent to
  // the bank's API, not a business date in the books. Banks outside the
  // Swedish zone reject a date_to in their future, which the Stockholm date
  // is for an hour after midnight.
  'extensions/general/enable-banking/index.ts',
  'app/api/extensions/enable-banking/sync/cron/route.ts',
])

const SCAN_DIRS = ['app', 'components', 'extensions', 'lib']
const IGNORE_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', '__tests__'])

const UTC_TODAY_RES = [
  /new Date\(\s*\)\.toISOString\(\)\.(?:slice|substring)\(\s*0\s*,\s*10\s*\)/g,
  /new Date\(\s*\)\.toISOString\(\)\.split\(\s*['"`]T['"`]\s*\)\[0\]/g,
  /\btoIsoDate\(\s*new Date\(\s*\)\s*\)/g,
]

function* walk(dir) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) yield full
  }
}

/** [{ file, line }] for every inline UTC "today" under `root` (the src directory). */
export function findUtcTodaySites(root) {
  const findings = []
  for (const dir of SCAN_DIRS) {
    for (const full of walk(path.join(root, dir))) {
      const file = path.relative(root, full).split(path.sep).join('/')
      const src = fs.readFileSync(full, 'utf8')
      for (const re of UTC_TODAY_RES) {
        for (const match of src.matchAll(re)) {
          findings.push({ file, line: src.slice(0, match.index).split('\n').length })
        }
      }
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
  const findings = findUtcTodaySites(root).filter((f) => !UTC_TODAY_ALLOWED.has(f.file))
  for (const f of findings) console.log(`${f.file}:${f.line}`)
  console.log(`${findings.length} UTC "today" site(s) outside the allowlist`)
  process.exit(findings.length ? 1 : 0)
}
