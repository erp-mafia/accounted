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
 * The same date read off a clock variable is the same bug one line later:
 * `const now = new Date()` and then `now.toISOString().slice(0, 10)`, or a
 * horizon `new Date(now.getTime() + 14 * 86_400_000)` sliced the same way
 * (accounted#18: the deadline status engine, the MCP attention resource,
 * the ledger context, Hem's checklist and the Arkiv meter). The Stockholm
 * form is todayIsoStockholm(now) with addDaysIso / addMonthsIso on the ISO
 * date.
 *
 * Flagged, in app/, components/, extensions/ and lib/ (tests excluded):
 *   - new Date().toISOString().slice(0, 10) / .substring(0, 10)
 *   - new Date().toISOString().split('T')[0]
 *   - toIsoDate(new Date())
 *   - the same slice, substring or split on a clock variable: a name that
 *     starts with `now` or `today` (also as a property, `opts.now`), a name
 *     the file assigns `new Date()` (or `x ?? new Date()`, or a parameter
 *     default), and a name the file assigns `new Date(<clock> ...)` or
 *     `new Date(Date.now() ...)`, the horizon derived from one
 *   - toIsoDate(<clock>) and a one-line local wrapper (a function that only
 *     returns its Date argument's toISOString().slice(0, 10)) called with
 *     `new Date()` or a clock variable
 * A timestamp (the full toISOString()) is not flagged: it carries its zone.
 * A date built from a stored ISO date (`new Date(invoiceDate)`) is not a
 * clock and is not flagged. Not seen: a wrapper exported from another file,
 * and a date assembled from getUTCFullYear() and friends.
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
  // Enable Banking start-date suggestions: clamped to the newest
  // initial_lookback_from_date the backend PATCH handler accepts, which it
  // checks against UTC midnight (index.ts above). A Stockholm "today" would
  // suggest a date the save refuses for an hour after midnight.
  'extensions/general/enable-banking/lib/date-suggestions.ts',
  // Feed backfill date picker: min and max mirror parseBackfillFrom
  // (lib/feed-sync/cursor-window.ts), which pins the start to UTC midnight
  // as a provider cursor and refuses one in the future. A Stockholm max
  // would offer a day the save refuses for an hour after midnight.
  'components/extensions/shared/FeedConnectorPanel.tsx',
])

const SCAN_DIRS = ['app', 'components', 'extensions', 'lib']
const IGNORE_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', '__tests__'])

const UTC_TODAY_RES = [
  /new Date\(\s*\)\.toISOString\(\)\.(?:slice|substring)\(\s*0\s*,\s*10\s*\)/g,
  /new Date\(\s*\)\.toISOString\(\)\.split\(\s*['"`]T['"`]\s*\)\[0\]/g,
  /\btoIsoDate\(\s*new Date\(\s*\)\s*\)/g,
]

const IDENT = String.raw`[A-Za-z_$][\w$]*`
/** `.toISOString()` cut to its date part: slice(0, 10), substring(0, 10) or split('T')[0]. */
const DATE_PART = String.raw`\.toISOString\(\)\.(?:(?:slice|substring)\(\s*0\s*,\s*10\s*\)|split\(\s*['"\x60]T['"\x60]\s*\)\[0\])`
/** A name that reads as the current instant wherever it appears. */
const CLOCK_NAME = /^(?:now|today)/i
/** `x = new Date()`, `x: Date = new Date()`, `x = opts.now ?? new Date()`. */
const CLOCK_DECL = new RegExp(String.raw`\b(${IDENT})\s*(?::\s*Date\s*)?=\s*(?:[^;\n=]*\?\?\s*)?new Date\(\s*\)`, 'g')
/** `x = new Date(<name> ...)` or `x = new Date(Date.now() ...)`: a date derived from another. */
const DERIVED_DECL = new RegExp(String.raw`\b(${IDENT})\s*(?::\s*Date\s*)?=\s*new Date\(\s*(?:(Date\.now)\(\)|(${IDENT}))`, 'g')
/** The date part read off a name, with whether the name is a property (`opts.now`). */
const DATE_PART_ON_NAME = new RegExp(String.raw`(?<![\w$])(\.?)(${IDENT})[!?]?${DATE_PART}`, 'dg')
/** A one-line local wrapper around the date part. */
const WRAPPER_FN = new RegExp(String.raw`function\s+(${IDENT})\s*\(\s*(${IDENT})\s*(?::\s*Date\s*)?\)\s*(?::\s*string\s*)?\{\s*return\s+\2${DATE_PART}`, 'g')
const WRAPPER_ARROW = new RegExp(String.raw`(?:const|let)\s+(${IDENT})\s*=\s*\(\s*(${IDENT})\s*(?::\s*Date\s*)?\)\s*(?::\s*string\s*)?=>\s*\{?\s*(?:return\s+)?\2${DATE_PART}`, 'g')

/** Names in `src` that hold the current instant or a date derived from it. */
function clockNames(src) {
  const names = new Set()
  for (const m of src.matchAll(CLOCK_DECL)) names.add(m[1])
  const derived = [...src.matchAll(DERIVED_DECL)]
  let grew = true
  while (grew) {
    grew = false
    for (const m of derived) {
      if (names.has(m[1])) continue
      if (m[2] || CLOCK_NAME.test(m[3]) || names.has(m[3])) {
        names.add(m[1])
        grew = true
      }
    }
  }
  return names
}

/** Character offsets in `src` of a UTC "today" read off a clock variable or through a wrapper. */
function clockSiteOffsets(src) {
  const offsets = []
  const clocks = clockNames(src)
  const isClock = (name, isProperty) => CLOCK_NAME.test(name) || (!isProperty && clocks.has(name))
  for (const m of src.matchAll(DATE_PART_ON_NAME)) {
    if (isClock(m[2], m[1] === '.')) offsets.push(m.indices[2][0])
  }
  const wrappers = new Set(['toIsoDate'])
  for (const m of src.matchAll(WRAPPER_FN)) wrappers.add(m[1])
  for (const m of src.matchAll(WRAPPER_ARROW)) wrappers.add(m[1])
  for (const wrapper of wrappers) {
    const call = new RegExp(String.raw`(?<![\w$.])${wrapper.replace(/\$/g, '\\$')}\(\s*(?:new Date\(\s*\)|(\.?)(${IDENT}))\s*\)`, 'g')
    for (const m of src.matchAll(call)) {
      if (m[2] === undefined || isClock(m[2], false)) offsets.push(m.index)
    }
  }
  return offsets
}

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
      const lineOf = (offset) => src.slice(0, offset).split('\n').length
      const lines = new Set()
      for (const re of UTC_TODAY_RES) {
        for (const match of src.matchAll(re)) lines.add(lineOf(match.index))
      }
      for (const offset of clockSiteOffsets(src)) lines.add(lineOf(offset))
      for (const line of lines) findings.push({ file, line })
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
